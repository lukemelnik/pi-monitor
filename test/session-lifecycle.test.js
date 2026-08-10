import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piMonitor from "../.test-dist/index.js";

const waitForHeartbeatState = async (dir, predicate = () => true) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const files = await readdir(dir);
      const heartbeatFile = files.find((file) => file.endsWith(".json"));
      if (heartbeatFile) {
        const state = JSON.parse(await readFile(join(dir, heartbeatFile), "utf8"));
        if (predicate(state)) return state;
      }
    } catch {
      // The heartbeat write may not have created a complete file yet.
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("expected heartbeat state was not written");
};

test("heartbeat never reuses a stale session context", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-monitor-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervalToken = Symbol("heartbeat");
  const handlers = new Map();
  let heartbeat;
  let heartbeatCleared = false;

  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.setInterval = (callback, delay) => {
    assert.equal(delay, 3_000);
    heartbeat = callback;
    return intervalToken;
  };
  globalThis.clearInterval = (token) => {
    if (token === intervalToken) heartbeatCleared = true;
  };

  try {
    const pi = {
      getThinkingLevel: () => "high",
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: () => {},
    };
    piMonitor(pi);

    let stale = false;
    const sessionManager = {
      getBranch: () => [],
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionName: () => undefined,
    };
    const contextState = {
      cwd: "/tmp/project",
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      isIdle: () => true,
      model: undefined,
      sessionManager,
    };
    const context = new Proxy(contextState, {
      get(target, property, receiver) {
        if (stale) throw new Error("stale extension context accessed");
        return Reflect.get(target, property, receiver);
      },
    });

    const liveDir = join(agentDir, "monitor", "live");
    await handlers.get("session_start")({}, context);
    await waitForHeartbeatState(liveDir);
    assert.equal(typeof heartbeat, "function");

    contextState.model = { id: "new-model", provider: "test-provider" };
    handlers.get("model_select")({}, context);
    const updatedState = await waitForHeartbeatState(liveDir, (state) => state.model === "new-model");
    assert.equal(updatedState.provider, "test-provider");

    stale = true;
    assert.doesNotThrow(() => heartbeat());

    const shutdownResult = handlers.get("session_shutdown")();
    assert.equal(heartbeatCleared, true, "shutdown must clear the timer synchronously");
    assert.doesNotThrow(() => heartbeat(), "a queued heartbeat must be harmless after disposal");
    await shutdownResult;
    const remainingFiles = await readdir(liveDir);
    assert.deepEqual(remainingFiles, [], "shutdown must remove in-flight heartbeat writes");
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { force: true, recursive: true });
  }
});
