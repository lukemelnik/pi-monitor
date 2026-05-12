import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
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
      }),
  );
}

export default function (pi: ExtensionAPI) {
  const instanceId = randomUUID();
  const fileName = `${process.pid}-${instanceId}.json`;
  const filePath = join(liveDir(), fileName);
  const tempPath = `${filePath}.tmp`;

  let state: MonitorState | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let disposed = false;
  let writeInFlight = false;
  let writeAgain = false;
  let lastStreamWriteAt = 0;
  let pruneCounter = 0;
  const activeTools = new Map<string, ActiveTool>();

  const flush = async () => {
    if (!state || disposed) return;

    if (writeInFlight) {
      writeAgain = true;
      return;
    }

    writeInFlight = true;
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
      writeInFlight = false;
      if (writeAgain && !disposed) {
        writeAgain = false;
        void flush();
      }
    }
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
      refreshSessionFields(ctx);
      update({ detail: state.detail }, "now");
    }, HEARTBEAT_MS);

    void flush();
  });

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
    try {
      await unlink(filePath);
    } catch {
      // ignore
    }
    dispose();
  });
}
