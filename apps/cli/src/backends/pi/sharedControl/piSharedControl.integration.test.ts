import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import type { RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';
import type { AgentState } from '@/api/types';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { buildPiBridgeExtensionSource } from '@/backends/pi/bridgeExtension/piBridgeExtensionSource';
import type { PiBridgeSessionConfig } from '@/backends/pi/bridgeExtension/piBridgeSessionConfig';
import { PiRpcBackend } from '@/backends/pi/rpc/PiRpcBackend';
import type { PiRpcChannelOpenSpec } from '@/backends/pi/rpc/piRpcChannel';

import {
  createPiSharedTerminalHost,
  type PiSharedTerminalProcess,
  type PiSharedTerminalSession,
} from './piSharedTerminalHost';

/**
 * Composed shared local control: the real generated bridge (TUI mode) runs inside a real child
 * process standing in for interactive Pi, dials the real shared-terminal host over loopback, and
 * is driven by the real `PiRpcBackend` in attached mode with the real event mapping. Only the Pi
 * launch (the process boundary) is injected.
 *
 * The child is a fake Pi: it parses Pi's CLI flags, loads every `--extension` the runner passed
 * (the bridge plus the runner's model-discovery extension) into a fake `pi`/`ctx` API, and replays
 * the event orders observed from real Pi 1.5.2 TUI (lane-a R1 probe): `input` fires synchronously
 * inside `sendUserMessage`, `agent_start` precedes the user `message_start` (so a web prompt's
 * response follows `agent_start`), the extension `agent_end` precedes `agent_settled`, `/reload`
 * re-imports the extension modules, and `/new` re-runs their factories with a new session id. The
 * test plays the terminal user over the child's IPC channel; the child's stdout/stderr stand for
 * the terminal and must stay untouched.
 */
const FAKE_PI_SOURCE = String.raw`
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const extensionPaths = [];
const flags = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--extension") extensionPaths.push(argv[++index]);
  else if (arg.startsWith("--") && index + 1 < argv.length && !argv[index + 1].startsWith("--")) flags.set(arg.slice(2), argv[++index]);
}

const report = (event) => process.send?.(event);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const models = [{ id: "model-1", provider: "provider-1", name: "Model 1", reasoning: false }];

let sessionId = "pi-session-1";
let idle = true;
let firstTurn = true;
let holdNextRun = false;
let preflightGate = null;
let openPreflightGate = null;
let abortSettleGate = null;
let openAbortSettleGate = null;
let currentRun = null;
let handlers = new Map();
let tools = new Map();
let loads = 0;

const ctx = {
  mode: "tui",
  hasUI: true,
  cwd: process.cwd(),
  ui: { notify: (message) => report({ kind: "notify", message }) },
  isIdle: () => idle,
  hasPendingMessages: () => false,
  abort: () => { report({ kind: "abort" }); currentRun?.abort(); },
  getContextUsage: () => ({ tokens: 1200, contextWindow: 200000, percent: 0.6 }),
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null },
  modelRegistry: {
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models,
    hasConfiguredAuth: () => true,
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getError: () => undefined,
    getAvailable: () => models,
  },
  model: models[0],
};

// Pi isolates extension handler failures and shows them in the TUI; report them instead.
const runHandler = (name, handler, event) => {
  try {
    return Promise.resolve(handler({ type: name, ...event }, ctx)).catch((error) => {
      report({ kind: "extension_error", event: name, message: String(error?.message ?? error) });
    });
  } catch (error) {
    report({ kind: "extension_error", event: name, message: String(error?.message ?? error) });
    return Promise.resolve();
  }
};
const emit = async (name, event = {}) => {
  for (const handler of handlers.get(name) ?? []) await runHandler(name, handler, event);
};
const emitNow = (name, event) => {
  for (const handler of handlers.get(name) ?? []) void runHandler(name, handler, event);
};

async function runAgent(text, hold, immediate = false) {
  let abortRun;
  const aborted = new Promise((resolve) => { abortRun = resolve; });
  let releaseRun;
  const released = new Promise((resolve) => { releaseRun = resolve; });
  const run = { aborted: false, abort: () => { run.aborted = true; abortRun(); }, release: () => releaseRun() };
  currentRun = run;
  if (!immediate) await tick();
  idle = false;
  await emit("before_agent_start", { messageType: "user", prompt: text, systemPrompt: "Pi system prompt" });
  await emit("agent_start");
  if (firstTurn) {
    firstTurn = false;
    const system = { role: "system", content: [{ type: "text", text: "Pi system prompt" }] };
    await emit("message_start", { message: system });
    await emit("message_end", { message: system });
  }
  if (!immediate) await tick();
  const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  await emit("message_start", { message: user });
  if (!immediate) await tick();
  await emit("message_end", { message: user });
  const reply = "echo: " + text;
  const partial = { role: "assistant", content: [{ type: "text", text: "" }], usage: { input: 10, output: 0 } };
  await emit("message_start", { message: partial });
  for (const [index, delta] of [reply.slice(0, 6), reply.slice(6)].entries()) {
    if (index === 1 && hold) {
      report({ kind: "holding", text });
      await Promise.race([released, aborted]);
    }
    if (run.aborted) break;
    partial.content[0].text += delta;
    await emit("message_update", {
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
    });
    if (!immediate) await tick();
  }
  const final = {
    role: "assistant",
    content: [{ type: "text", text: partial.content[0].text }],
    usage: { input: 10, output: 5 },
    stopReason: run.aborted ? "aborted" : "stop",
  };
  await emit("message_end", { message: final });
  await emit("turn_end", { message: final, toolResults: [] });
  await emit("agent_end", { messages: [user, final] });
  if (run.aborted && abortSettleGate) {
    report({ kind: "abort_settle_waiting" });
    await abortSettleGate;
  }
  idle = true;
  currentRun = null;
  await emit("agent_settled", { aborted: run.aborted });
  report({ kind: "settled", text, aborted: run.aborted });
}

function submit(source, text, hold) {
  // Pi emits input synchronously; the run (and isIdle() === false) starts after it returns.
  emitNow("input", { source, text });
  if (source === "extension" && preflightGate) {
    report({ kind: "preflight_waiting", text });
    void preflightGate.then(() => runAgent(text, hold));
    return;
  }
  void runAgent(text, hold);
}

async function loadExtensions(reason) {
  loads += 1;
  const load = loads;
  handlers = new Map();
  tools = new Map();
  const bus = new EventEmitter();
  const pi = {
    registerFlag() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    getFlag: (name) => flags.get(name),
    on: (name, handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: {
      emit: (channel, data) => { bus.emit(channel, data); },
      on: (channel, handler) => { bus.on(channel, handler); return () => bus.off(channel, handler); },
    },
    sendUserMessage: (content, options) => {
      report({ kind: "sendUserMessage", content, options, sessionId });
      const hold = holdNextRun;
      holdNextRun = false;
      submit("extension", content, hold);
    },
    getCommands: () => [],
    setModel: async () => true,
    // Only the bridge's get_state reads this, so it marks the runner querying Pi's state.
    getThinkingLevel: () => {
      report({ kind: "state_read", sessionId, load });
      return "medium";
    },
    setThinkingLevel: () => undefined,
  };
  for (const path of extensionPaths) {
    // /reload re-imports the extension modules; /new re-runs the cached factories.
    const url = pathToFileURL(path).href + (reason === "reload" ? "?load=" + loads : "");
    const module = await import(url);
    module.default(pi);
  }
  await emit("session_start", { reason });
  report({ kind: "session_started", reason, sessionId });
}

process.on("message", async (command) => {
  switch (command.kind) {
    case "probe-happier-capability": {
      let guidance = null;
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await runHandler("before_agent_start", handler, { systemPrompt: "Pi base" });
        guidance = result?.systemPrompt ?? guidance;
      }
      let output = null;
      let error = null;
      try {
        const result = await tools.get("probe_happier_session").execute("probe-1", {}, undefined, undefined, ctx);
        output = result.content[0].text;
      } catch (failure) {
        error = String(failure?.message ?? failure);
      }
      report({ kind: command.kind, sessionId, guidance, output, error });
      break;
    }
    case "type":
      submit("interactive", command.text, command.hold === true);
      break;
    case "hold-next-run":
      holdNextRun = true;
      report({ kind: "armed", command: command.kind });
      break;
    case "release":
      currentRun?.release();
      break;
    case "gate-preflight":
      preflightGate = new Promise((resolve) => { openPreflightGate = resolve; });
      report({ kind: "armed", command: command.kind });
      break;
    case "finish-preflight":
      openPreflightGate?.();
      preflightGate = null;
      break;
    case "gate-abort-settle":
      abortSettleGate = new Promise((resolve) => { openAbortSettleGate = resolve; });
      report({ kind: "armed", command: command.kind });
      break;
    case "settle":
      openAbortSettleGate?.();
      abortSettleGate = null;
      break;
    case "reload":
      await emit("session_shutdown", { reason: "reload" });
      await loadExtensions("reload");
      break;
    case "new":
      await emit("session_shutdown", { reason: "new" });
      sessionId = command.sessionId;
      await loadExtensions("new");
      if (command.text) {
        // Queue the turn's frames behind hello before servicing a get_state request.
        await emit("input", { source: "interactive", text: command.text });
        await runAgent(command.text, false, true);
      }
      break;
    case "quit":
      await emit("session_shutdown", { reason: "quit" });
      process.exit(command.code);
  }
});

await loadExtensions("startup");
`;

type FakePiReport = Readonly<{ kind: string; [field: string]: unknown }>;
/** Shapes how Pi handles what arrives next; acknowledged because IPC is not ordered with the socket. */
type FakePiArming = Readonly<{ kind: 'hold-next-run' | 'gate-preflight' | 'gate-abort-settle' }>;
type FakePiCommand =
  | Readonly<{ kind: 'type'; text: string; hold?: boolean }>
  | Readonly<{ kind: 'release' | 'finish-preflight' | 'settle' | 'reload' | 'probe-happier-capability' }>
  | Readonly<{ kind: 'new'; sessionId: string; text?: string }>
  | Readonly<{ kind: 'quit'; code: number }>;

const WAIT = { timeout: 10_000, interval: 10 } as const;
const BOUND_SESSION_ID = 'pi-session-1';

const cleanups: Array<() => Promise<void> | void> = [];
const untouchedTerminalChecks: Array<() => Promise<void>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    for (const check of untouchedTerminalChecks.splice(0)) await check();
  }
});

/** The Happier session as the host sees it: agent-state writes and agent messages. */
function createSessionPort() {
  let state: AgentState = {};
  const notices: string[] = [];
  const session: PiSharedTerminalSession = {
    sendAgentMessage: vi.fn((_provider, body) => {
      if (body.type === 'message') notices.push(body.message);
    }) as PiSharedTerminalSession['sendAgentMessage'],
    updateAgentState: vi.fn(async (updater: (current: AgentState) => AgentState) => {
      state = updater(state);
    }) as PiSharedTerminalSession['updateAgentState'],
    subscribeToSessionConnectionState: () => () => undefined,
  };
  return { session, notices, localControl: () => state.localControl };
}

async function startSharedTerminal() {
  const dir = createTempDirSync('happier-pi-shared-control-');
  cleanups.push(() => removeTempDirSync(dir));
  const bridgePath = join(dir, 'bridge.mjs');
  writeFileSync(bridgePath, buildPiBridgeExtensionSource());
  const fakePiPath = join(dir, 'fake-pi.mjs');
  writeFileSync(fakePiPath, FAKE_PI_SOURCE);
  const fakeToolPath = join(dir, 'fake-happier-tool.mjs');
  writeFileSync(fakeToolPath, 'console.log(JSON.stringify({ ok: true, data: { output: "bound session tool ran" } }));');

  const reports: FakePiReport[] = [];
  const terminations: RunnerTerminationEvent[] = [];
  const launches: PiRpcChannelOpenSpec[] = [];
  let child: ChildProcess | null = null;
  let terminalOutput = '';

  // Process boundary: interactive Pi in this terminal becomes a node child running the fake Pi.
  const launch = async (spec: PiRpcChannelOpenSpec): Promise<PiSharedTerminalProcess> => {
    launches.push(spec);
    const launched = spawnTestProcess(process.execPath, [fakePiPath, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child = launched;
    launched.stdout?.on('data', (chunk: Buffer) => { terminalOutput += chunk.toString('utf8'); });
    launched.stderr?.on('data', (chunk: Buffer) => { terminalOutput += chunk.toString('utf8'); });
    launched.on('message', (report) => { reports.push(report as FakePiReport); });
    const whenExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      launched.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const whenClosed = new Promise<void>((resolve) => { launched.once('close', () => resolve()); });
    untouchedTerminalChecks.push(async () => {
      await whenClosed;
      // Capture all output, including bytes delivered after exit or written during shutdown.
      expect(terminalOutput).toBe('');
      expect(reports.filter((report) => report.kind === 'notify' || report.kind === 'extension_error')).toEqual([]);
    });
    return {
      whenExited,
      terminate: async () => {
        if (launched.exitCode === null && launched.signalCode === null) launched.kill();
        await whenExited;
      },
    };
  };

  const host = createPiSharedTerminalHost({
    requestRunnerTermination: (event) => terminations.push(event),
    launch,
  });
  cleanups.push(() => host.dispose());

  const sessionConfig: PiBridgeSessionConfig = {
    v: 1,
    sessionId: 'happier-session-1',
    directTools: [{
      name: 'probe_happier_session', title: 'Probe session access', description: 'Test session access',
      inputSchema: { type: 'object' },
      call: { toolName: 'action_execute', actionId: 'session.status.get' },
    }],
    promptAddition: 'Happier session guidance',
    launch: { filePath: process.execPath, argPrefix: [fakeToolPath], env: {} },
    sharedControl: await host.ensureListening(),
  };
  const backend = new PiRpcBackend({
    cwd: dir,
    command: 'pi',
    args: ['--extension', bridgePath],
    env: {},
    happierSessionId: 'happier-session-1',
    toolsBridgeConfigText: JSON.stringify(sessionConfig),
    channelHost: host.channelHost,
  });
  cleanups.push(() => backend.dispose());
  const messages: AgentMessage[] = [];
  backend.onMessage((message) => messages.push(message));

  const port = createSessionPort();
  const { sessionId } = await backend.startSession();
  host.publishLocalControl(port.session);

  const since = (mark: number) => messages.slice(mark);
  const reported = (kind: string) => reports.filter((report) => report.kind === kind);
  return {
    backend,
    sessionId,
    terminations,
    launches,
    notices: port.notices,
    localControl: port.localControl,
    mark: () => messages.length,
    statuses: (mark: number) => since(mark).flatMap((message) => (message.type === 'status' ? [message.status] : [])),
    userRows: (mark: number) => since(mark).flatMap((message) => (message.type === 'user-message' ? [message.text] : [])),
    deltas: (mark: number) => since(mark).flatMap((message) => (
      message.type === 'model-output' && message.textDelta ? [message.textDelta] : []
    )),
    /** Prompts the bridge handed to Pi (`pi.sendUserMessage`): web input that took effect. */
    webPrompts: () => reported('sendUserMessage').map((report) => ({ content: report.content, sessionId: report.sessionId })),
    reported,
    waitForReport: (kind: string, matches: (report: FakePiReport) => boolean = () => true) => vi.waitFor(() => {
      const found = reports.find((report) => report.kind === kind && matches(report));
      expect(found).toBeDefined();
      return found!;
    }, WAIT),
    /** The terminal user acting on Pi. */
    tell: (command: FakePiCommand) => { child!.send(command); },
    arm: async (arming: FakePiArming) => {
      const armed = () => reported('armed').filter((report) => report.command === arming.kind).length;
      const before = armed();
      child!.send(arming);
      await vi.waitFor(() => expect(armed()).toBeGreaterThan(before), WAIT);
    },
    /** One request/response round trip on the bridge connection, ordered after earlier frames. */
    roundTrip: () => backend.discoverCommands({ timeoutMs: 10_000 }),
  };
}

describe('Pi shared local control (bridge in a Pi TUI child, shared-terminal host, attached PiRpcBackend)', () => {
  it('only gives the native session admitted by the host access to Happier tools and guidance', async () => {
    const pi = await startSharedTerminal();
    pi.tell({ kind: 'probe-happier-capability' });
    await expect(pi.waitForReport('probe-happier-capability', (row) => row.sessionId === BOUND_SESSION_ID))
      .resolves.toMatchObject({ guidance: 'Pi base\n\nHappier session guidance', output: '"bound session tool ran"', error: null });

    pi.tell({ kind: 'new', sessionId: 'pi-session-2' });
    await vi.waitFor(() => expect(pi.localControl()?.remoteWritable).toBe(false), WAIT);
    pi.tell({ kind: 'probe-happier-capability' });
    const foreign = await pi.waitForReport('probe-happier-capability', (row) => row.sessionId === 'pi-session-2');
    expect(foreign).toMatchObject({ guidance: null, output: null, error: expect.stringContaining('pi_shared_bridge_unavailable') });
  });

  it('accepts a web prompt at its own start, streams the reply, and never mirrors the web row back', async () => {
    const pi = await startSharedTerminal();
    const mark = pi.mark();

    await pi.backend.sendPrompt(pi.sessionId, 'hello from the web');

    await pi.waitForReport('sendUserMessage', (report) => report.content === 'hello from the web');
    expect(pi.webPrompts()).toEqual([{ content: 'hello from the web', sessionId: BOUND_SESSION_ID }]);
    expect(pi.reported('sendUserMessage')[0]).toMatchObject({ options: { expandPromptTemplates: true } });
    expect(pi.deltas(mark)).toEqual(['echo: ', 'hello from the web']);
    // The web row is committed by Happier's pending queue; Pi's echo of it is not observed input.
    expect(pi.userRows(mark)).toEqual([]);
    expect(pi.statuses(mark)).toEqual(['running', 'idle']);
  });

  it('mirrors terminal input once as provider user input while the terminal turn runs', async () => {
    const pi = await startSharedTerminal();
    const mark = pi.mark();

    pi.tell({ kind: 'type', text: 'typed in the terminal' });

    await vi.waitFor(() => expect(pi.statuses(mark)).toEqual(['running', 'idle']), WAIT);
    expect(pi.userRows(mark)).toEqual(['typed in the terminal']);
    expect(pi.deltas(mark)).toEqual(['echo: ', 'typed in the terminal']);
    expect(pi.webPrompts()).toEqual([]);
  });

  it('holds a web prompt sent during a terminal turn, then runs it once when that turn ends', async () => {
    const pi = await startSharedTerminal();
    const mark = pi.mark();
    pi.tell({ kind: 'type', text: 'long terminal task', hold: true });
    await pi.waitForReport('holding');
    await vi.waitFor(() => expect(pi.statuses(mark)).toEqual(['running']), WAIT);

    const held = pi.backend.sendPromptWithAdmission(pi.sessionId, 'web prompt while the terminal works');
    void held.completion.catch(() => undefined);
    let admitted = false;
    void held.admission.then(() => { admitted = true; });
    // Ordered after the prompt on the bridge connection: its busy refusal has been handled.
    await pi.roundTrip();

    expect(admitted).toBe(false);
    expect(pi.webPrompts()).toEqual([]);

    pi.tell({ kind: 'release' });
    expect((await held.admission).status).toBe('accepted');
    await held.completion;

    await pi.waitForReport('sendUserMessage', (report) => report.content === 'web prompt while the terminal works');
    expect(pi.webPrompts()).toEqual([{ content: 'web prompt while the terminal works', sessionId: BOUND_SESSION_ID }]);
    expect(pi.userRows(mark)).toEqual(['long terminal task']);
    expect(pi.deltas(mark)).toEqual(['echo: ', 'long terminal task', 'echo: ', 'web prompt while the terminal works']);
    expect(pi.statuses(mark)).toEqual(['running', 'idle', 'running', 'idle']);
  });

  it('keeps Stop pending through web input preflight and aborts the run as it starts', async () => {
    const pi = await startSharedTerminal();
    const mark = pi.mark();
    await pi.arm({ kind: 'gate-preflight' });
    const prompt = pi.backend.sendPromptWithAdmission(pi.sessionId, 'web prompt in preflight');
    await pi.waitForReport('preflight_waiting');

    let stopped = false;
    const stop = pi.backend.cancel(pi.sessionId).then(() => { stopped = true; });
    await pi.waitForReport('abort');
    await pi.roundTrip();
    expect(stopped).toBe(false);

    pi.tell({ kind: 'finish-preflight' });
    await expect(prompt.admission).resolves.toMatchObject({ status: 'accepted' });
    await stop;
    expect(await pi.waitForReport('settled')).toMatchObject({ text: 'web prompt in preflight', aborted: true });
    expect(pi.reported('abort')).toHaveLength(2);
    expect(pi.userRows(mark)).toEqual([]);
  });

  it('stops a web run on abort and resolves the abort only once Pi has settled', async () => {
    const pi = await startSharedTerminal();
    await pi.arm({ kind: 'hold-next-run' });
    await pi.arm({ kind: 'gate-abort-settle' });
    const mark = pi.mark();
    const promptOutcome = pi.backend.sendPrompt(pi.sessionId, 'long web task')
      .then(() => 'completed', (error: unknown) => error);
    await pi.waitForReport('holding');

    let abortResolved = false;
    const abort = pi.backend.cancel(pi.sessionId).then(() => { abortResolved = true; });
    await pi.waitForReport('abort_settle_waiting');
    // Every frame Pi sent before it settled has reached the runner.
    await pi.roundTrip();
    expect(pi.reported('abort')).toHaveLength(1);
    expect(abortResolved).toBe(false);

    pi.tell({ kind: 'settle' });
    await abort;

    expect(await promptOutcome).toBe('completed');
    // The child reports over IPC, which is not ordered with the bridge socket.
    expect(await pi.waitForReport('settled')).toEqual({ kind: 'settled', text: 'long web task', aborted: true });
    // The run stopped before the rest of its reply.
    expect(pi.deltas(mark)).toEqual(['echo: ']);

    await pi.backend.sendPrompt(pi.sessionId, 'after the abort');
    await pi.waitForReport('sendUserMessage', (report) => report.content === 'after the abort');
    expect(pi.webPrompts().map((web) => web.content)).toEqual(['long web task', 'after the abort']);
  });

  it('re-attaches after /reload in the same session and keeps both directions working', async () => {
    const pi = await startSharedTerminal();

    pi.tell({ kind: 'reload' });
    // Frames sent between the bye and the re-attach have no consumer by design (no replay); the
    // terminal user acts once the runner has queried the reloaded Pi.
    await pi.waitForReport('state_read', (report) => report.load === 2);

    await pi.backend.sendPrompt(pi.sessionId, 'web prompt after reload');
    await pi.waitForReport('sendUserMessage', (report) => report.content === 'web prompt after reload');
    expect(pi.webPrompts()).toEqual([{ content: 'web prompt after reload', sessionId: BOUND_SESSION_ID }]);

    const mark = pi.mark();
    pi.tell({ kind: 'type', text: 'typed after reload' });
    await vi.waitFor(() => expect(pi.statuses(mark)).toEqual(['running', 'idle']), WAIT);
    expect(pi.userRows(mark)).toEqual(['typed after reload']);
    expect(pi.launches).toHaveLength(1);
    expect(pi.localControl()).toMatchObject({ remoteWritable: true });
  });

  it('fences a terminal that switched to another session, then re-attaches by itself when it returns', async () => {
    const pi = await startSharedTerminal();
    expect(pi.localControl()).toEqual({
      attached: true,
      topology: 'shared',
      remoteWritable: true,
      canAttach: false,
      canDetach: false,
    });

    const switchMark = pi.mark();
    pi.tell({ kind: 'new', sessionId: 'pi-session-2', text: 'typed in the foreign session' });
    await pi.waitForReport('settled', (report) => report.text === 'typed in the foreign session');
    await vi.waitFor(() => expect(pi.localControl()?.remoteWritable).toBe(false), WAIT);
    expect(pi.notices).toHaveLength(1);

    const fenced = pi.backend.sendPromptWithAdmission(pi.sessionId, 'must stay in the bound session');
    void fenced.completion.catch(() => undefined);
    const admission = await fenced.admission;

    expect(admission.status).toBe('rejected_before_effect');
    // Retryable once the terminal is back, not refused for good.
    expect(admission.status !== 'accepted' && admission.error).toMatchObject({ reason: 'provider_unavailable_before_acceptance' });
    expect(pi.webPrompts()).toEqual([]);
    expect(pi.reported('state_read').map((report) => report.sessionId)).not.toContain('pi-session-2');
    expect(pi.userRows(switchMark)).toEqual([]);
    expect(pi.deltas(switchMark)).toEqual([]);
    expect(pi.statuses(switchMark)).toEqual([]);

    // The terminal returns to the bound session (`/resume`); no web action is needed to mirror it.
    pi.tell({ kind: 'new', sessionId: BOUND_SESSION_ID });
    await pi.waitForReport('state_read', (report) => report.sessionId === BOUND_SESSION_ID && report.load === 3);
    await vi.waitFor(() => expect(pi.localControl()?.remoteWritable).toBe(true), WAIT);
    const mark = pi.mark();
    pi.tell({ kind: 'type', text: 'typed after returning' });

    await vi.waitFor(() => expect(pi.statuses(mark)).toEqual(['running', 'idle']), WAIT);
    expect(pi.userRows(mark)).toEqual(['typed after returning']);
    expect(pi.notices).toHaveLength(1);
    expect(pi.launches).toHaveLength(1);
  });

  it('asks the runner to terminate with Pi exit code when Pi exits, and never relaunches it', async () => {
    const pi = await startSharedTerminal();

    pi.tell({ kind: 'quit', code: 4 });

    await vi.waitFor(() => expect(pi.terminations).toEqual([{ kind: 'exit', code: 4 }]), WAIT);
    const late = pi.backend.sendPromptWithAdmission(pi.sessionId, 'after Pi quit');
    void late.completion.catch(() => undefined);
    expect((await late.admission).status).toBe('rejected_before_effect');
    expect(pi.launches).toHaveLength(1);
    expect(pi.webPrompts()).toEqual([]);
  });
});
