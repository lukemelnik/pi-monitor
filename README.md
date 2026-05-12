# pi-monitor — live Pi agent monitor

A Pi package that tracks running Pi agents and provides a small CLI for seeing what each one is doing. If an agent was launched inside tmux, the watch UI can jump directly to its pane.

```bash
pi install npm:@lukemelnik/pi-monitor
```

## Features

- **Live agent registry** — each running Pi instance writes a heartbeat with status, cwd, model, session, and active tool info.
- **Interactive monitor** — `pi-monitor --watch` shows live agents and updates once per second.
- **Tmux pane jump** — press `Enter` on an agent launched inside tmux to switch to that pane.
- **Context usage** — shows current context consumption as a compact bar when Pi exposes usage data.
- **Stale cleanup** — dead processes and old heartbeat files are pruned automatically.

## Install

Install from npm:

```bash
pi install npm:@lukemelnik/pi-monitor
```

For local development or testing:

```bash
pi install /absolute/path/to/pi-monitor
```

The package includes both the Pi extension and the `pi-monitor` CLI. A global Pi npm install links the CLI so it can be run directly from your shell.

## Usage

Print a one-shot table:

```bash
pi-monitor
```

Open the interactive watcher:

```bash
pi-monitor --watch
```

Keys in watch mode:

| Key | Action |
|-----|--------|
| `j` / `↓` | Move down |
| `k` / `↑` | Move up |
| `Enter` | Jump to the selected tmux pane, if available |
| `q` / `Ctrl-C` | Exit |

Other options:

```bash
pi-monitor --version
pi-monitor --help
pi-monitor --ttl-ms 60000
pi-monitor --no-color
```

## How it works

The Pi extension runs inside each Pi process and writes one small heartbeat file per live instance:

```text
~/.pi/agent/monitor/live/<pid>-<instanceId>.json
```

The file is overwritten in place every few seconds. Normal shutdown removes it. If Pi crashes, later monitor runs prune stale files and dead PIDs.

The CLI is separate from Pi at runtime. It reads the heartbeat directory, renders the table, and uses tmux only for the optional pane jump action.

## Context usage

When available, context usage is shown in the table and inspector:

```text
CTX  ████░░░░░ 44%
```

Right after startup, reload, or compaction, Pi may not know token usage yet. In that case the monitor shows `—` until usage data is available again.

## Development

```bash
npm run check
```

Release commands:

```bash
npm run release:patch
npm run release:minor
npm run release:major
npm run publish:release
```

`npm version` updates `package.json`, updates `package-lock.json` when present, creates a release commit, and creates a `vX.Y.Z` git tag.

## License

MIT
