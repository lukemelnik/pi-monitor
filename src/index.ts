import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

type MonitorStatus = "idle" | "working" | "waiting" | "error" | "aborted" | "compacting";

type ActiveTool = {
  name: string;
  startedAt: number;
  argsPreview?: string;
};

type MonitorState = {
  schemaVersion: 1;
  pid: number;
  instanceId: string;
  startedAt: number;
  lastHeartbeatAt: number;
  lastUpdatedAt: number;
  cwd: string;
  project: string;
  sessionFile?: string;
  sessionName?: string;
  tmuxPane?: string;
  terminal?: string;
  status: MonitorStatus;
  detail?: string;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  pendingMessages?: boolean;
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
  activeTools: ActiveTool[];
  lastToolName?: string;
  lastStopReason?: string;
  lastError?: string;
  lastUserPreview?: string;
  lastAssistantPreview?: string;
  summaryPreview?: string;
};

const HEARTBEAT_MS = 3_000;
const STALE_MS = 30_000;
const STREAM_WRITE_THROTTLE_MS = 750;
const PREVIEW_LIMIT = 500;
const SESSION_RECAP_ENTRY_TYPES = new Set(["session-synopsis-state", "session-recap-summary"]);

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function liveDir(): string {
  return join(agentDir(), "monitor", "live");
}

function truncate(text: string, max = PREVIEW_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: string; thinking?: string };
      if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      if (typed.type === "thinking" && typeof typed.thinking === "string") return typed.thinking;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function previewArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;

  const input = args as Record<string, unknown>;
  if (typeof input.command === "string") return truncate(input.command, 160);
  if (typeof input.path === "string") return truncate(input.path, 160);
  if (typeof input.query === "string") return truncate(input.query, 160);

  try {
    return truncate(JSON.stringify(args), 160);
  } catch {
    return undefined;
  }
}

function projectName(cwd: string): string {
  return basename(cwd) || cwd;
}

function latestSessionName(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionName() ?? undefined;
}

function latestSummaryPreview(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || !SESSION_RECAP_ENTRY_TYPES.has(entry.customType)) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    const summary = (data as { synopsis?: unknown; summary?: unknown }).synopsis ?? (data as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim()) return truncate(summary);
  }

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "compaction" && typeof entry.summary === "string") {
      return truncate(entry.summary);
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      return truncate(entry.summary);
    }
  }

  return undefined;
}

async function pruneStaleFiles(dir: string, currentFile: string) {
  const now = Date.now();
  let names: string[] = [];

  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = join(dir, name);
        if (file === currentFile) return;

        try {
          const stat = statSync(file);
          if (now - stat.mtimeMs > STALE_MS) await rm(file, { force: true });
        } catch {
          // ignore cleanup races
        }

        return undefined;
      }),
  );
}

type DisplayState = MonitorState & {
  _file: string;
  _ageMs: number;
};

const STATUS_ORDER: Record<string, number> = { error: 0, aborted: 1, waiting: 2, idle: 3, compacting: 4, working: 5 };

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // ignore cleanup races
  }
}

function readMonitorStates(): DisplayState[] {
  let names: string[] = [];

  try {
    names = readdirSync(liveDir());
  } catch {
    return [];
  }

  const now = Date.now();
  const states: DisplayState[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;

    const file = join(liveDir(), name);
    let stat;
    let state: MonitorState;

    try {
      stat = statSync(file);
      state = JSON.parse(readFileSync(file, "utf8")) as MonitorState;
    } catch {
      continue;
    }

    const lastHeartbeatAt = Number(state.lastHeartbeatAt || 0);
    const stale = now - Math.max(lastHeartbeatAt, stat.mtimeMs) > STALE_MS;
    const alive = isPidAlive(Number(state.pid));

    if (stale || !alive) {
      safeUnlink(file);
      continue;
    }

    states.push({ ...state, _file: file, _ageMs: Math.max(0, now - lastHeartbeatAt) });
  }

  const byPid = new Map<number, DisplayState>();
  for (const state of states) {
    const existing = byPid.get(state.pid);
    if (!existing || state.lastHeartbeatAt > existing.lastHeartbeatAt) {
      if (existing) safeUnlink(existing._file);
      byPid.set(state.pid, state);
    } else {
      safeUnlink(state._file);
    }
  }

  const deduped = Array.from(byPid.values());
  deduped.sort((a, b) => {
    const order = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (order !== 0) return order;
    return String(a.project || a.cwd || "").localeCompare(String(b.project || b.cwd || ""));
  });

  return deduped;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateWidth(value: string, width: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return "…";

  let result = "";
  for (const char of text) {
    if (visibleLength(`${result}${char}…`) > width) break;
    result += char;
  }
  return `${result.trimEnd()}…`;
}

function padWidth(value: string, width: number): string {
  const length = visibleLength(value);
  if (length >= width) return value;
  return `${value}${" ".repeat(width - length)}`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "working": return "run";
    case "compacting": return "compact";
    case "waiting": return "wait";
    case "idle": return "idle";
    case "error": return "error";
    case "aborted": return "abort";
    default: return status || "?";
  }
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatTokenCount(value: unknown): string {
  const number = finiteNumber(value);
  if (number === null) return "—";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${Math.round(number / 1_000)}k`;
  return String(Math.round(number));
}

function contextPercentFor(state: DisplayState): number | null {
  const percent = finiteNumber(state.contextPercent);
  if (percent === null) return null;
  return Math.max(0, Math.min(100, percent));
}

function contextBar(percent: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function contextForTable(state: DisplayState, width: number): string {
  const percent = contextPercentFor(state);
  if (percent === null) return "—";
  if (width < 8) return `${Math.round(percent)}%`;
  return `${contextBar(percent, Math.max(3, width - 5))} ${Math.round(percent)}%`;
}

function contextForInspector(state: DisplayState): string {
  const percent = contextPercentFor(state);
  if (percent === null) return "—";
  return `${contextBar(percent, 20)} ${Math.round(percent)}% • ${formatTokenCount(state.contextTokens)}/${formatTokenCount(state.contextWindow)} tokens`;
}

function detailFor(state: DisplayState): string {
  const activeTools = Array.isArray(state.activeTools) ? state.activeTools : [];
  if (activeTools.length > 0) {
    const first = activeTools[0];
    if (!first) return state.detail ?? "running tool";
    return `running ${first.name}${first.argsPreview ? `: ${first.argsPreview}` : ""}`;
  }
  if (state.lastError && (state.status === "error" || state.status === "aborted")) return state.lastError;
  return state.detail || state.lastAssistantPreview || state.cwd;
}

function projectFor(state: DisplayState): string {
  return state.sessionName || state.project || basename(state.cwd || "") || String(state.pid);
}

function modelFor(state: DisplayState): string {
  if (state.provider && state.model) return `${state.provider}/${state.model}`;
  return state.model || state.provider || "";
}

function stripHome(value: string | undefined): string {
  const home = homedir();
  if (value?.startsWith(home)) return `~${value.slice(home.length)}`;
  return value || "";
}

function runTmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trimEnd();
  } catch {
    return "";
  }
}

function sanitizeTmuxText(value: string | undefined): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/#\[/g, "[")
    .replace(/^(✅|❌|⚠️?|⏹|⏳) /, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getTmuxInfo(): { currentSession: string; panes: Map<string, { sessionName?: string; windowIndex?: string; windowName?: string; paneIndex?: string }> } {
  const currentSession = runTmux(["display-message", "-p", "#S"]);
  const output = runTmux(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}"]);
  const panes = new Map<string, { sessionName?: string; windowIndex?: string; windowName?: string; paneIndex?: string }>();

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, sessionName, windowIndex, windowName, paneIndex] = line.split("\t");
    if (!paneId) continue;
    panes.set(paneId, { sessionName, windowIndex, windowName, paneIndex });
  }

  return { currentSession, panes };
}

function tmuxDisplayFor(state: DisplayState, tmuxInfo: ReturnType<typeof getTmuxInfo>): string {
  const pane = state.tmuxPane ? tmuxInfo.panes.get(state.tmuxPane) : undefined;
  if (!pane) return state.tmuxPane || "—";

  const windowName = sanitizeTmuxText(pane.windowName) || "window";
  const paneSuffix = pane.paneIndex ? `.${pane.paneIndex}` : "";
  const windowTarget = `${pane.windowIndex}:${windowName}${paneSuffix}`;

  if (pane.sessionName && pane.sessionName !== tmuxInfo.currentSession) {
    return `${sanitizeTmuxText(pane.sessionName)}:${windowTarget}`;
  }

  return windowTarget;
}

function jumpToState(state: DisplayState): boolean {
  if (!state.tmuxPane) return false;

  const tmuxInfo = getTmuxInfo();
  const pane = tmuxInfo.panes.get(state.tmuxPane);
  if (!pane) return false;

  if (pane.sessionName) runTmux(["switch-client", "-t", pane.sessionName]);
  if (pane.sessionName && pane.windowIndex) runTmux(["select-window", "-t", `${pane.sessionName}:${pane.windowIndex}`]);
  runTmux(["select-pane", "-t", state.tmuxPane]);

  return true;
}

function tableLayout(columns: number): { tmuxWidth: number; projectWidth: number; contextWidth: number; detailWidth: number } {
  let tmuxWidth = columns >= 120 ? 32 : columns >= 100 ? 24 : columns >= 80 ? 18 : 14;
  let projectWidth = columns >= 120 ? 28 : columns >= 100 ? 22 : columns >= 80 ? 16 : 12;
  let contextWidth = columns >= 88 ? 14 : columns >= 76 ? 7 : 0;
  const fixedWidth = () => (contextWidth > 0 ? 28 + tmuxWidth + projectWidth + contextWidth : 27 + tmuxWidth + projectWidth);
  let detailWidth = columns - fixedWidth();

  while (detailWidth < 6 && projectWidth > 12) {
    projectWidth -= 1;
    detailWidth += 1;
  }
  while (detailWidth < 6 && tmuxWidth > 14) {
    tmuxWidth -= 1;
    detailWidth += 1;
  }
  if (detailWidth < 6 && contextWidth > 0) {
    contextWidth = 0;
    detailWidth = columns - fixedWidth();
  }

  return { tmuxWidth, projectWidth, contextWidth, detailWidth: Math.max(1, detailWidth) };
}

export default function (pi: ExtensionAPI) {
  const instanceId = randomUUID();
  const fileName = `${process.pid}-${instanceId}.json`;
  const filePath = join(liveDir(), fileName);
  const tempPath = `${filePath}.tmp`;

  let state: MonitorState | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let disposed = false;
  let writeInFlight: Promise<void> | undefined;
  let writeAgain = false;
  let lastStreamWriteAt = 0;
  let pruneCounter = 0;
  const activeTools = new Map<string, ActiveTool>();

  const flush = (): Promise<void> => {
    if (!state || disposed) return Promise.resolve();

    if (writeInFlight) {
      writeAgain = true;
      return writeInFlight;
    }

    writeInFlight = (async () => {
      try {
        state.lastHeartbeatAt = Date.now();
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tempPath, `${JSON.stringify(state)}\n`, "utf8");
        await rename(tempPath, filePath);

        pruneCounter += 1;
        if (pruneCounter % 20 === 0) await pruneStaleFiles(liveDir(), filePath);
      } catch {
        // Monitoring must never affect the agent.
      } finally {
        writeInFlight = undefined;
        const shouldWriteAgain = writeAgain && !disposed;
        writeAgain = false;
        if (shouldWriteAgain) void flush();
      }
    })();

    return writeInFlight;
  };

  const update = (patch: Partial<MonitorState>, write: "now" | "later" | "stream" = "now") => {
    if (!state || disposed) return;

    state = {
      ...state,
      ...patch,
      lastUpdatedAt: Date.now(),
      activeTools: Array.from(activeTools.values()),
    };

    if (write === "later") return;

    if (write === "stream") {
      const now = Date.now();
      if (now - lastStreamWriteAt < STREAM_WRITE_THROTTLE_MS) return;
      lastStreamWriteAt = now;
    }

    void flush();
  };

  const refreshSessionFields = (ctx: ExtensionContext) => {
    if (!state || disposed) return;

    state.sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    state.sessionName = latestSessionName(ctx);
    state.summaryPreview = latestSummaryPreview(ctx);
    const contextUsage = ctx.getContextUsage();

    state.model = ctx.model?.id;
    state.provider = ctx.model?.provider;
    state.thinkingLevel = pi.getThinkingLevel();
    state.pendingMessages = ctx.hasPendingMessages();
    state.contextTokens = contextUsage?.tokens ?? null;
    state.contextWindow = contextUsage?.contextWindow;
    state.contextPercent = contextUsage?.percent ?? null;
  };

  const updateSessionMetadata = (ctx: ExtensionContext) => {
    refreshSessionFields(ctx);
    if (state) update({ detail: state.detail }, "now");
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
  };

  const processExitCleanup = () => {
    dispose();
  };

  pi.registerCommand("pi-monitor", {
    description: "Show live Pi agents and jump to tmux panes",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      let timer: NodeJS.Timeout | undefined;
      let selectedIndex = 0;

      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const renderStateTable = (states: DisplayState[], width: number): string[] => {
            if (states.length === 0) return [theme.fg("dim", "No live Pi agents.")];

            if (selectedIndex >= states.length) selectedIndex = Math.max(0, states.length - 1);

            const tmuxInfo = getTmuxInfo();
            const layout = tableLayout(width);
            const headerParts = [
              padWidth("", 2),
              padWidth("STATUS", 8),
              padWidth("AGE", 4),
              padWidth("PID", 7),
              padWidth("TMUX", layout.tmuxWidth),
              padWidth("PROJECT", layout.projectWidth),
            ];
            if (layout.contextWidth > 0) headerParts.push(padWidth("CTX", layout.contextWidth));
            headerParts.push("DETAIL");

            const separator = theme.fg("dim", "─".repeat(Math.max(1, width)));
            const lines = [theme.fg("dim", theme.bold(headerParts.join(" "))), separator];

            states.forEach((state, index) => {
              const selected = index === selectedIndex;
              const cursor = selected ? theme.fg("warning", "›") : " ";
              const recapMark = state.summaryPreview ? theme.fg("accent", "•") : " ";
              const statusColor = state.status === "error" || state.status === "aborted"
                ? "error"
                : state.status === "waiting"
                  ? "warning"
                  : state.status === "working"
                    ? "accent"
                    : "muted";
              const contextPercent = contextPercentFor(state);
              const contextColor = contextPercent === null
                ? "dim"
                : contextPercent >= 90
                  ? "error"
                  : contextPercent >= 70
                    ? "warning"
                    : "accent";
              const detailColor = state.status === "error" ? "error" : "dim";
              const rowParts = [
                `${cursor}${recapMark}`,
                theme.fg(statusColor, padWidth(statusLabel(state.status), 8)),
                theme.fg("dim", padWidth(duration(state._ageMs), 4)),
                theme.fg("dim", padWidth(String(state.pid), 7)),
                theme.fg("muted", padWidth(truncateWidth(tmuxDisplayFor(state, tmuxInfo), layout.tmuxWidth), layout.tmuxWidth)),
                padWidth(truncateWidth(projectFor(state), layout.projectWidth), layout.projectWidth),
              ];

              if (layout.contextWidth > 0) {
                rowParts.push(theme.fg(contextColor, padWidth(truncateWidth(contextForTable(state, layout.contextWidth), layout.contextWidth), layout.contextWidth)));
              }

              rowParts.push(theme.fg(detailColor, truncateWidth(detailFor(state), layout.detailWidth)));
              lines.push(rowParts.join(" "));
              if (index < states.length - 1) lines.push(separator);
            });

            return lines;
          };

          const renderField = (label: string, value: string | undefined, width: number, color: "accent" | "dim" | "error" | "muted" | "warning" = "dim"): string | undefined => {
            if (!value) return undefined;
            const labelWidth = 8;
            const available = Math.max(1, width - labelWidth - 1);
            return `${theme.fg("dim", padWidth(label, labelWidth))} ${theme.fg(color, truncateWidth(value, available))}`;
          };

          const component = {
            render(width: number): string[] {
              const states = readMonitorStates();
              const selected = states[selectedIndex];
              const lines = [
                theme.fg("accent", theme.bold(truncateWidth("Pi Monitor", width))),
                ...renderStateTable(states, width),
              ];

              if (selected) {
                const contextPercent = contextPercentFor(selected);
                const contextColor = contextPercent === null ? "dim" : contextPercent >= 90 ? "error" : contextPercent >= 70 ? "warning" : "accent";
                const selectedLines = [
                  "",
                  theme.fg("dim", theme.bold("Selected")),
                  renderField("agent", `${statusLabel(selected.status)} • ${tmuxDisplayFor(selected, getTmuxInfo())} • ${projectFor(selected)}`, width),
                  renderField("detail", detailFor(selected), width, selected.status === "error" ? "error" : "dim"),
                  renderField("context", contextForInspector(selected), width, contextColor),
                  renderField("recap", selected.summaryPreview, width, "accent"),
                  renderField("model", modelFor(selected), width),
                  renderField("cwd", stripHome(selected.cwd), width),
                ].filter((line): line is string => Boolean(line));
                lines.push(...selectedLines);
              }

              lines.push("", theme.fg("dim", truncateWidth("Keys: j/k or ↑/↓ move • Enter jump to tmux pane • q/Esc exit", width)));
              return lines;
            },
            handleInput(data: string): void {
              const states = readMonitorStates();

              if (data === "q" || data === "\u001b" || data === "\u0003") {
                done(undefined);
                return;
              }
              if ((data === "k" || data === "\u001b[A") && states.length > 0) {
                selectedIndex = Math.max(0, selectedIndex - 1);
                tui.requestRender();
                return;
              }
              if ((data === "j" || data === "\u001b[B") && states.length > 0) {
                selectedIndex = Math.min(states.length - 1, selectedIndex + 1);
                tui.requestRender();
                return;
              }
              if (data === "\r" || data === "\n") {
                const selected = states[selectedIndex];
                if (selected && jumpToState(selected)) done(undefined);
              }
            },
            invalidate(): void {},
          };

          timer = setInterval(() => tui.requestRender(), 1_000);
          return component;
        });
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    activeTools.clear();

    const contextUsage = ctx.getContextUsage();

    state = {
      schemaVersion: 1,
      pid: process.pid,
      instanceId,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      lastUpdatedAt: Date.now(),
      cwd: ctx.cwd,
      project: projectName(ctx.cwd),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      sessionName: latestSessionName(ctx),
      tmuxPane: process.env.TMUX_PANE,
      terminal: process.env.TERM_PROGRAM,
      status: ctx.isIdle() ? "idle" : "working",
      detail: ctx.isIdle() ? "idle" : "starting",
      model: ctx.model?.id,
      provider: ctx.model?.provider,
      thinkingLevel: pi.getThinkingLevel(),
      pendingMessages: ctx.hasPendingMessages(),
      contextTokens: contextUsage?.tokens ?? null,
      contextWindow: contextUsage?.contextWindow,
      contextPercent: contextUsage?.percent ?? null,
      activeTools: [],
      summaryPreview: latestSummaryPreview(ctx),
    };

    process.once("exit", processExitCleanup);

    heartbeat = setInterval(() => {
      if (!state || disposed) return;
      update({ detail: state.detail }, "now");
    }, HEARTBEAT_MS);

    void flush();
  });

  // These events postdate the package's Pi 0.73 development types.
  const onModernMetadataEvent = pi.on as unknown as (
    event: "agent_settled" | "session_info_changed",
    handler: (_event: unknown, ctx: ExtensionContext) => void,
  ) => void;
  onModernMetadataEvent("agent_settled", (_event, ctx) => updateSessionMetadata(ctx));
  onModernMetadataEvent("session_info_changed", (_event, ctx) => updateSessionMetadata(ctx));
  pi.on("session_tree", (_event, ctx) => updateSessionMetadata(ctx));
  pi.on("model_select", (_event, ctx) => updateSessionMetadata(ctx));
  pi.on("thinking_level_select", (_event, ctx) => updateSessionMetadata(ctx));

  pi.on("agent_start", async (_event, ctx) => {
    refreshSessionFields(ctx);
    update({ status: "working", detail: "thinking", lastError: undefined, lastStopReason: undefined });
  });

  pi.on("turn_start", async (_event, ctx) => {
    refreshSessionFields(ctx);
    update({ status: "working", detail: "thinking" });
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeTools.set(event.toolCallId, {
      name: event.toolName,
      startedAt: Date.now(),
      argsPreview: previewArgs(event.args),
    });

    refreshSessionFields(ctx);
    update({
      status: "working",
      detail: `running ${event.toolName}`,
      lastToolName: event.toolName,
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeTools.delete(event.toolCallId);
    refreshSessionFields(ctx);

    const patch: Partial<MonitorState> = {
      detail: activeTools.size > 0 ? `running ${Array.from(activeTools.values())[0]?.name ?? "tool"}` : "thinking",
      lastToolName: event.toolName,
    };

    if (event.isError) {
      patch.lastError = `${event.toolName} failed`;
    }

    update(patch);
  });

  pi.on("message_start", async (event, ctx) => {
    refreshSessionFields(ctx);
    if (event.message.role === "user") {
      update({ lastUserPreview: truncate(contentToText(event.message.content)) }, "now");
    }
  });

  pi.on("message_update", async (event, ctx) => {
    refreshSessionFields(ctx);
    if (event.message.role !== "assistant") return;

    const preview = truncate(contentToText(event.message.content));
    if (!preview) return;
    update({ lastAssistantPreview: preview, status: "working", detail: "responding" }, "stream");
  });

  pi.on("message_end", async (event, ctx) => {
    refreshSessionFields(ctx);

    if (event.message.role === "assistant") {
      const preview = truncate(contentToText(event.message.content));
      const patch: Partial<MonitorState> = {
        lastAssistantPreview: preview || state?.lastAssistantPreview,
        lastStopReason: event.message.stopReason,
      };

      if (event.message.stopReason === "error") {
        patch.status = "error";
        patch.detail = "model error";
        patch.lastError = event.message.errorMessage ?? "assistant error";
      } else if (event.message.stopReason === "aborted") {
        patch.status = "aborted";
        patch.detail = "aborted";
      }

      update(patch);
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    refreshSessionFields(ctx);
    update({ status: "compacting", detail: "compacting context" });
  });

  pi.on("session_compact", async (event, ctx) => {
    refreshSessionFields(ctx);
    update({
      status: "working",
      detail: "thinking",
      summaryPreview: truncate(event.compactionEntry.summary),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    refreshSessionFields(ctx);

    const assistantMessages = event.messages.filter((message) => message.role === "assistant");
    const lastAssistant = assistantMessages.at(-1);
    const hasToolError = event.messages.some((message) => message.role === "toolResult" && message.isError);

    if (lastAssistant?.stopReason === "error") {
      update({
        status: "error",
        detail: "model error",
        lastStopReason: lastAssistant.stopReason,
        lastError: lastAssistant.errorMessage ?? "assistant error",
      });
      return;
    }

    if (lastAssistant?.stopReason === "aborted") {
      update({ status: "aborted", detail: "aborted", lastStopReason: lastAssistant.stopReason });
      return;
    }

    if (lastAssistant?.stopReason === "length") {
      update({ status: "error", detail: "stopped at length limit", lastStopReason: lastAssistant.stopReason });
      return;
    }

    update({
      status: "waiting",
      detail: hasToolError ? "finished with tool errors" : "waiting for input",
      lastStopReason: lastAssistant?.stopReason,
      lastError: hasToolError ? state?.lastError : undefined,
    });
  });

  pi.on("session_shutdown", async () => {
    process.removeListener("exit", processExitCleanup);
    dispose();
    await writeInFlight;
    safeUnlink(filePath);
    safeUnlink(tempPath);
  });
}
