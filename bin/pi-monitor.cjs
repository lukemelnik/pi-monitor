#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FALLBACK_VERSION = "0.1.0-dev";
const DEFAULT_TTL_MS = 30_000;
const STATUS_ORDER = { error: 0, aborted: 1, waiting: 2, idle: 3, compacting: 4, working: 5 };
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  inverse: "\x1b[7m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[38;5;245m",
};

function version() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return packageJson.version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function usage() {
  console.log(`pi-monitor: show live Pi agent heartbeats

Usage:
  pi-monitor                 Print a compact table
  pi-monitor --watch         Refresh the table every second

Options:
  --ttl-ms <ms>              Stale heartbeat cutoff (default: ${DEFAULT_TTL_MS})
  --no-prune                 Do not delete stale heartbeat files
  --no-color                 Disable ANSI colors in table/watch output
  --version                  Show version
  --help                     Show this help`);
}

function parseArgs(argv) {
  const opts = {
    ttlMs: DEFAULT_TTL_MS,
    watch: false,
    prune: true,
    color: process.stdout.isTTY,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      console.log(`pi-monitor ${version()}`);
      process.exit(0);
    }
    if (arg === "--watch" || arg === "-w") opts.watch = true;
    else if (arg === "--no-prune") opts.prune = false;
    else if (arg === "--no-color") opts.color = false;
    else if (arg === "--ttl-ms") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--ttl-ms must be a positive number");
      opts.ttlMs = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function liveDir() {
  return path.join(agentDir(), "monitor", "live");
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

function readStates(opts) {
  const dir = liveDir();
  let names = [];

  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const now = Date.now();
  const states = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;

    const file = path.join(dir, name);
    let text;
    let stat;

    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    let state;
    try {
      state = JSON.parse(text);
    } catch {
      if (opts.prune && now - stat.mtimeMs > opts.ttlMs) safeUnlink(file);
      continue;
    }

    const lastHeartbeatAt = Number(state.lastHeartbeatAt || 0);
    const stale = now - Math.max(lastHeartbeatAt, stat.mtimeMs) > opts.ttlMs;
    const alive = isPidAlive(Number(state.pid));

    if (stale || !alive) {
      if (opts.prune) safeUnlink(file);
      continue;
    }

    states.push({ ...state, _file: file, _ageMs: Math.max(0, now - lastHeartbeatAt) });
  }

  const byPid = new Map();
  for (const state of states) {
    const key = String(state.pid);
    const existing = byPid.get(key);
    if (!existing || Number(state.lastHeartbeatAt || 0) > Number(existing.lastHeartbeatAt || 0)) {
      if (existing && opts.prune) safeUnlink(existing._file);
      byPid.set(key, state);
    } else if (opts.prune) {
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

function stripHome(value) {
  const home = os.homedir();
  if (value && value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value || "";
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "").replace(/#\[[^\]]*\]/g, "").length;
}

function truncate(value, width) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return "…";
  return `${Array.from(text).slice(0, width - 1).join("").trimEnd()}…`;
}

function pad(value, width) {
  const text = String(value || "");
  const len = visibleLength(text);
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function statusLabel(status) {
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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatTokenCount(value) {
  const number = finiteNumber(value);
  if (number === null) return "—";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${Math.round(number / 1_000)}k`;
  return String(Math.round(number));
}

function contextPercentFor(state) {
  const percent = finiteNumber(state.contextPercent);
  if (percent === null) return null;
  return Math.max(0, Math.min(100, percent));
}

function contextColorFor(state) {
  const percent = contextPercentFor(state);
  if (percent === null) return ANSI.gray;
  if (percent >= 90) return `${ANSI.red}${ANSI.bold}`;
  if (percent >= 70) return `${ANSI.yellow}${ANSI.bold}`;
  return ANSI.cyan;
}

function contextBar(percent, width) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function contextForTable(state, width) {
  const percent = contextPercentFor(state);
  if (percent === null) return "—";
  if (width < 8) return `${Math.round(percent)}%`;
  const barWidth = Math.max(3, width - 5);
  return `${contextBar(percent, barWidth)} ${Math.round(percent)}%`;
}

function contextForInspector(state) {
  const percent = contextPercentFor(state);
  if (percent === null) return "—";
  return `${contextBar(percent, 28)} ${Math.round(percent)}% • ${formatTokenCount(state.contextTokens)}/${formatTokenCount(state.contextWindow)} tokens`;
}

function detailFor(state) {
  const activeTools = Array.isArray(state.activeTools) ? state.activeTools : [];
  if (activeTools.length > 0) {
    const first = activeTools[0];
    const suffix = first.argsPreview ? `: ${first.argsPreview}` : "";
    return `running ${first.name}${suffix}`;
  }
  if (state.lastError && (state.status === "error" || state.status === "aborted")) return state.lastError;
  return state.detail || state.lastAssistantPreview || stripHome(state.cwd);
}

function summaryFor(state) {
  return state.summaryPreview || "";
}

function projectFor(state) {
  return state.sessionName || state.project || path.basename(state.cwd || "") || String(state.pid);
}

function colorize(value, color, opts) {
  if (!opts.color) return value;
  return `${color}${value}${ANSI.reset}`;
}

function statusColor(status) {
  switch (status) {
    case "error": return `${ANSI.red}${ANSI.bold}`;
    case "aborted": return ANSI.red;
    case "waiting": return `${ANSI.yellow}${ANSI.bold}`;
    case "idle": return ANSI.gray;
    case "working": return ANSI.cyan;
    case "compacting": return ANSI.blue;
    default: return ANSI.reset;
  }
}

function tableLayout(columns) {
  let tmuxWidth = columns >= 120 ? 32 : columns >= 100 ? 24 : columns >= 80 ? 18 : 14;
  let projectWidth = columns >= 120 ? 28 : columns >= 100 ? 22 : columns >= 80 ? 16 : 12;
  let contextWidth = columns >= 88 ? 14 : columns >= 76 ? 7 : 0;
  const minDetailWidth = 6;

  const fixedWidth = () => {
    if (contextWidth > 0) return 28 + tmuxWidth + projectWidth + contextWidth;
    return 27 + tmuxWidth + projectWidth;
  };

  let detailWidth = columns - fixedWidth();
  while (detailWidth < minDetailWidth && projectWidth > 12) {
    projectWidth -= 1;
    detailWidth += 1;
  }
  while (detailWidth < minDetailWidth && tmuxWidth > 14) {
    tmuxWidth -= 1;
    detailWidth += 1;
  }
  if (detailWidth < minDetailWidth && contextWidth > 0) {
    contextWidth = 0;
    detailWidth = columns - fixedWidth();
  }

  return {
    tmuxWidth,
    projectWidth,
    contextWidth,
    detailWidth: Math.max(1, detailWidth),
  };
}

function renderTable(states, opts, selectedIndex = -1) {
  if (states.length === 0) return colorize("No live Pi agents.", ANSI.gray, opts);

  const tmuxInfo = getTmuxInfo();
  const columns = process.stdout.columns || 120;
  const layout = tableLayout(columns);
  const headerParts = [
    pad("", 2),
    pad("STATUS", 8),
    pad("AGE", 4),
    pad("PID", 7),
    pad("TMUX", layout.tmuxWidth),
    pad("PROJECT", layout.projectWidth),
  ];
  if (layout.contextWidth > 0) headerParts.push(pad("CTX", layout.contextWidth));
  headerParts.push("DETAIL");

  const header = colorize(headerParts.join(" "), `${ANSI.gray}${ANSI.bold}`, opts);
  const separator = colorize("─".repeat(Math.max(1, columns)), `${ANSI.gray}${ANSI.dim}`, opts);
  const rows = [];

  states.forEach((state, index) => {
    const selected = index === selectedIndex;
    const cursor = selected ? colorize("›", `${ANSI.yellow}${ANSI.bold}`, opts) : " ";
    const status = colorize(pad(statusLabel(state.status), 8), statusColor(state.status), opts);
    const age = colorize(pad(duration(state._ageMs || 0), 4), ANSI.gray, opts);
    const pid = colorize(pad(String(state.pid || ""), 7), ANSI.gray, opts);
    const tmux = colorize(pad(truncate(tmuxDisplayFor(state, tmuxInfo), layout.tmuxWidth), layout.tmuxWidth), ANSI.magenta, opts);
    const project = pad(truncate(projectFor(state), layout.projectWidth), layout.projectWidth);
    const detail = colorize(truncate(detailFor(state), layout.detailWidth), state.status === "error" ? ANSI.red : ANSI.gray, opts);
    const recapMark = summaryFor(state) ? colorize("•", ANSI.cyan, opts) : " ";
    const rowParts = [`${cursor}${recapMark}`, status, age, pid, tmux, project];

    if (layout.contextWidth > 0) {
      rowParts.push(colorize(pad(truncate(contextForTable(state, layout.contextWidth), layout.contextWidth), layout.contextWidth), contextColorFor(state), opts));
    }
    rowParts.push(detail);
    rows.push(rowParts.join(" "));
    if (index < states.length - 1) rows.push(separator);
  });

  return [header, separator, ...rows].join("\n");
}

function modelFor(state) {
  if (state.provider && state.model) return `${state.provider}/${state.model}`;
  return state.model || state.provider || "";
}

function wrapText(value, width) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  const words = text.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (visibleLength(`${line} ${word}`) <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function renderField(label, value, opts, valueColor = ANSI.gray) {
  if (!value) return "";

  const columns = process.stdout.columns || 120;
  const labelWidth = 7;
  const valueWidth = Math.max(24, columns - labelWidth - 2);
  const lines = wrapText(value, valueWidth);

  return lines.map((line, index) => {
    const fieldLabel = index === 0 ? label : "";
    return `${colorize(pad(fieldLabel, labelWidth), ANSI.gray, opts)} ${colorize(line, valueColor, opts)}`;
  }).join("\n");
}

function renderInspector(state, opts) {
  if (!state) return colorize("No agent selected.", ANSI.gray, opts);

  const tmuxInfo = getTmuxInfo();
  const lines = [
    colorize("Selected", `${ANSI.gray}${ANSI.bold}`, opts),
    renderField("agent", `${statusLabel(state.status)} • ${tmuxDisplayFor(state, tmuxInfo)} • ${projectFor(state)}`, opts),
    renderField("detail", detailFor(state), opts, state.status === "error" ? ANSI.red : ANSI.gray),
    renderField("context", contextForInspector(state), opts, contextColorFor(state)),
    renderField("recap", summaryFor(state), opts, ANSI.cyan),
    renderField("model", modelFor(state), opts),
    renderField("cwd", stripHome(state.cwd), opts),
  ].filter(Boolean);

  return lines.join("\n");
}

function runTmux(args) {
  try {
    return childProcess.execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trimEnd();
  } catch {
    return "";
  }
}

function sanitizeTmuxText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/#\[/g, "[")
    .replace(/^(✅|❌|⚠️?|⏹|⏳) /, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getTmuxInfo() {
  const currentSession = runTmux(["display-message", "-p", "#S"]);
  const output = runTmux(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}"]);
  const panes = new Map();

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, sessionName, windowIndex, windowName, paneIndex] = line.split("\t");
    if (!paneId) continue;
    panes.set(paneId, { sessionName, windowIndex, windowName, paneIndex });
  }

  return { currentSession, panes };
}

function tmuxDisplayFor(state, tmuxInfo) {
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

function jumpToState(state) {
  if (!state?.tmuxPane) return false;

  const tmuxInfo = getTmuxInfo();
  const pane = tmuxInfo.panes.get(state.tmuxPane);
  if (!pane) return false;

  if (pane.sessionName) runTmux(["switch-client", "-t", pane.sessionName]);
  if (pane.sessionName && pane.windowIndex) runTmux(["select-window", "-t", `${pane.sessionName}:${pane.windowIndex}`]);
  runTmux(["select-pane", "-t", state.tmuxPane]);

  return true;
}

function render(opts) {
  const states = readStates(opts);
  return renderTable(states, opts);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (!opts.watch) {
    process.stdout.write(`${render(opts)}\n`);
    return;
  }

  let selectedIndex = 0;
  let currentStates = [];
  let statusMessage = "";

  const draw = () => {
    currentStates = readStates(opts);
    if (selectedIndex >= currentStates.length) selectedIndex = Math.max(0, currentStates.length - 1);

    const selectedState = currentStates[selectedIndex];
    const lines = [
      renderTable(currentStates, opts, currentStates.length > 0 ? selectedIndex : -1),
      colorize("", ANSI.gray, opts),
      renderInspector(selectedState, opts),
      colorize("", ANSI.gray, opts),
      colorize("Keys: j/k or ↑/↓ move • Enter jump to tmux pane • q/Ctrl-C exit", ANSI.gray, opts),
    ];
    if (statusMessage) lines.push(statusMessage);

    process.stdout.write(`\x1b[?25l\x1b[H\x1b[2J${lines.join("\n")}`);
  };

  const cleanup = () => {
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\n");
  };

  const selectPrevious = () => {
    if (currentStates.length === 0) return;
    selectedIndex = Math.max(0, selectedIndex - 1);
    statusMessage = "";
    draw();
  };

  const selectNext = () => {
    if (currentStates.length === 0) return;
    selectedIndex = Math.min(currentStates.length - 1, selectedIndex + 1);
    statusMessage = "";
    draw();
  };

  const jumpToSelected = () => {
    const state = currentStates[selectedIndex];
    if (!state) return;

    if (jumpToState(state)) {
      cleanup();
      process.exit(0);
    }
  };

  draw();
  const timer = setInterval(draw, 1_000);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "\u0003" || key === "q") {
        cleanup();
        process.exit(0);
      } else if (key === "k" || key === "\x1b[A") {
        selectPrevious();
      } else if (key === "j" || key === "\x1b[B") {
        selectNext();
      } else if (key === "\r" || key === "\n") {
        jumpToSelected();
      }
    });
  }

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
