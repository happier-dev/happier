import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mapPiRpcEventToAgentMessages } from '../rpc/eventMapping';
import { attachPiRpcJsonlLineReader } from '../rpc/attachPiRpcJsonlLineReader';
import { parsePiExtensionUserInput } from '../rpc/piExtensionUiRequest';
import {
  PI_SHARED_CONTROL_ADMISSION_FRAME,
  PI_SHARED_CONTROL_BUSY_ERROR,
  PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT,
  PI_SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR,
  PiSharedControlBridgeFrameSchema,
  PiSharedControlHelloSchema,
} from '../sharedControl/piSharedControlProtocol';
import { PI_BRIDGE_CONFIG_PATH_FLAG, PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from './piBridgeExtensionEnv';
import { buildPiBridgeExtensionSource } from './piBridgeExtensionSource';

// Boundaries substituted here: the Pi process API (a fake `pi`/`ctx` driven with event orders
// observed from real Pi 1.5.2 TUI) and the runner (a real loopback `net` server). The generated
// bridge, its socket client, and the RPC decoders that consume its frames run for real.

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type JsonRecord = Record<string, unknown>;

const TOKEN = 'test-capability-token';

type Runner = Readonly<{
  port: number;
  frames: () => JsonRecord[];
  outRecords: () => JsonRecord[];
  errLines: () => string[];
  responses: (id: string) => JsonRecord[];
  send: (command: JsonRecord) => void;
  connected: () => boolean;
  peerEnded: () => boolean;
  dropConnection: () => void;
  close: () => Promise<void>;
}>;

async function startRunner(): Promise<Runner> {
  const server: Server = createServer();
  let connection: Socket | null = null;
  let ended = false;
  const lines: string[] = [];
  server.on('connection', (socket) => {
    connection = socket;
    attachPiRpcJsonlLineReader(socket, (line) => lines.push(line));
    socket.on('end', () => { ended = true; });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const frames = () => lines.map((line) => JSON.parse(line) as JsonRecord);
  const channel = (ch: 'out' | 'err') => frames().filter((frame) => frame.ch === ch).map((frame) => String(frame.line));
  const outRecords = () => channel('out').map((line) => JSON.parse(line) as JsonRecord);
  return {
    port: (server.address() as AddressInfo).port,
    frames,
    outRecords,
    errLines: () => channel('err'),
    responses: (id) => outRecords().filter((record) => record.type === 'response' && record.id === id),
    send: (command) => { connection!.write(`${JSON.stringify(command)}\n`); },
    connected: () => connection !== null,
    peerEnded: () => ended,
    dropConnection: () => { connection?.destroy(); },
    close: () => new Promise<void>((resolve) => {
      connection?.destroy();
      server.close(() => resolve());
    }),
  };
}

function createFakePi(configPath: string) {
  const handlers = new Map<string, Handler[]>();
  const bus = new EventEmitter();
  const state = { idle: true, pendingMessages: false, thinkingLevel: 'medium' };
  const models = [
    { id: 'grok-4.7', provider: 'xai', name: 'Grok 4.7', headers: { Authorization: 'secret' } },
    { id: 'gpt-5', provider: 'openai', name: 'GPT-5' },
  ];
  const api = {
    sendUserMessage: vi.fn<(content: unknown, options?: unknown) => void>(),
    setModel: vi.fn(async (model: JsonRecord) => model.provider !== 'openai'),
    setThinkingLevel: vi.fn((level: string) => { state.thinkingLevel = level; }),
    abort: vi.fn(),
    compact: vi.fn(),
    notify: vi.fn(),
  };
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: '/tmp',
    ui: { notify: api.notify },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pendingMessages,
    abort: api.abort,
    compact: api.compact,
    getContextUsage: () => ({ tokens: 1234, contextWindow: 128_000, percent: 1 }),
    sessionManager: {
      getSessionId: () => 'pi-session-1',
      getSessionFile: () => '/sessions/pi-session-1.jsonl',
    },
    modelRegistry: { find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) },
    model: models[0],
  };
  const pi = {
    registerFlag: () => undefined,
    registerTool: () => undefined,
    getFlag: (name: string) => (name === PI_BRIDGE_CONFIG_PATH_FLAG ? configPath : undefined),
    on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    events: {
      emit: (channel: string, data: unknown) => { bus.emit(channel, data); },
      on: (channel: string, handler: (data: unknown) => void) => {
        bus.on(channel, handler);
        return () => { bus.off(channel, handler); };
      },
    },
    sendUserMessage: api.sendUserMessage,
    getCommands: () => [
      { name: 'ext-cmd', source: 'extension', description: 'an extension command' },
      { name: 'tpl', source: 'prompt' },
    ],
    setModel: api.setModel,
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: api.setThinkingLevel,
  };
  const emit = async (event: string, value: JsonRecord = {}) => {
    let last: unknown;
    for (const handler of handlers.get(event) ?? []) last = await handler({ type: event, ...value }, ctx);
    return last;
  };
  return { pi, ctx, state, api, emit, bus };
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1, output: 2 } });

describe('Pi shared-control bridge (TUI mode)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  async function startBridge(options: { beforeSessionStart?: (fake: ReturnType<typeof createFakePi>) => void } = {}) {
    const runner = await startRunner();
    cleanups.push(() => runner.close());
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-shared-bridge-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      v: 1,
      sessionId: 'happier-session-1',
      directTools: [],
      promptAddition: '',
      launch: { filePath: process.execPath, argPrefix: [], env: {} },
      sharedControl: { host: '127.0.0.1', port: runner.port, token: TOKEN },
    }));
    const extensionPath = join(dir, 'bridge.mjs');
    writeFileSync(extensionPath, buildPiBridgeExtensionSource());
    const mod = await import(`${pathToFileURL(extensionPath).href}?nonce=${Math.random()}`);
    const fake = createFakePi(configPath);
    (mod.default as (pi: unknown) => void)(fake.pi);
    options.beforeSessionStart?.(fake);
    await fake.emit('session_start', { reason: 'startup' });
    await expect.poll(() => runner.frames().length).toBeGreaterThan(0);
    runner.send({ type: PI_SHARED_CONTROL_ADMISSION_FRAME });
    return { runner, ...fake };
  }

  async function sendPrompt(bridge: Awaited<ReturnType<typeof startBridge>>, id: string, message: string) {
    const calls = bridge.api.sendUserMessage.mock.calls.length;
    bridge.runner.send({ id, type: 'prompt', message });
    await expect.poll(() => bridge.api.sendUserMessage.mock.calls.length + bridge.runner.responses(id).length)
      .toBeGreaterThan(calls);
  }

  async function roundTrip(bridge: Awaited<ReturnType<typeof startBridge>>, id: string) {
    bridge.runner.send({ id, type: 'get_state' });
    await expect.poll(() => bridge.runner.responses(id).length).toBe(1);
    return bridge.runner.responses(id)[0]!;
  }

  function userInputMarkers(bridge: Awaited<ReturnType<typeof startBridge>>): string[] {
    return bridge.runner.outRecords().flatMap((record) => {
      const text = parsePiExtensionUserInput(record);
      return text === null ? [] : [text];
    });
  }

  it('A1: opens with a valid hello and never writes to the terminal or the TUI notifier', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const stdout = vi.spyOn(process.stdout, 'write');
    const bridge = await startBridge();
    const [hello] = bridge.runner.frames();
    expect(PiSharedControlHelloSchema.parse(hello)).toEqual({
      type: 'hello', v: 1, token: TOKEN, sessionId: 'pi-session-1', sessionFile: '/sessions/pi-session-1.jsonl',
    });

    await sendPrompt(bridge, 'p1', 'hello');
    expect(bridge.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith('hello', { expandPromptTemplates: true });
    await bridge.emit('agent_start');
    const webMessage = user('hello');
    await bridge.emit('message_start', { message: webMessage });
    await bridge.emit('message_end', { message: webMessage });
    await bridge.emit('input', { source: 'interactive', text: 'steer me', streamingBehavior: 'steer' });
    await bridge.emit('message_end', { message: assistant('hi') });
    await bridge.emit('agent_settled', { aborted: false });
    await roundTrip(bridge, 'sync');

    for (const frame of bridge.runner.frames().slice(1)) expect(() => PiSharedControlBridgeFrameSchema.parse(frame)).not.toThrow();
    expect(bridge.runner.errLines().map((line) => JSON.parse(line))).toEqual([
      { type: PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE, used: 1234, size: 128_000 },
    ]);
    expect(bridge.api.notify).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('A2: projects streaming updates to delta-only RPC records the real mapper turns into model output', async () => {
    const bridge = await startBridge();
    const partial = assistant('Hel');
    await bridge.emit('agent_start');
    await bridge.emit('message_start', { message: partial });
    await bridge.emit('message_update', {
      message: partial,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial },
    });
    await bridge.emit('message_update', {
      message: partial,
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 1,
        partial: { ...partial, content: [...partial.content, { type: 'toolCall', id: 'call-1', name: 'read' }] },
      },
    });
    await bridge.emit('tool_execution_start', { toolCallId: 'call-1', toolName: 'read', args: { path: 'a' } });
    await roundTrip(bridge, 'sync');

    const updates = bridge.runner.outRecords().filter((record) => record.type === 'message_update');
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update).not.toHaveProperty('message');
      expect(update.assistantMessageEvent).not.toHaveProperty('partial');
      expect(update.usage).toEqual({ input: 1, output: 2 });
    }
    expect(updates[1]!.assistantMessageEvent).toMatchObject({ type: 'toolcall_start', id: 'call-1', toolName: 'read' });
    const mapped = bridge.runner.outRecords().flatMap((record) => mapPiRpcEventToAgentMessages(record));
    expect(mapped).toEqual(expect.arrayContaining([
      { type: 'status', status: 'running' },
      { type: 'model-output', textDelta: 'Hel' },
      { type: 'tool-call', callId: 'call-1', toolName: 'read', args: { path: 'a' } },
    ]));
  });

  it('A3: reports busy until Pi settles: the extension agent_end is suppressed and agent_settled ends the run', async () => {
    const bridge = await startBridge();
    await bridge.emit('agent_start');
    await bridge.emit('agent_end', { messages: [] });
    await roundTrip(bridge, 'mid');
    expect(bridge.runner.outRecords().filter((record) => record.type === 'agent_end')).toEqual([]);

    await bridge.emit('agent_settled', { aborted: false });
    await roundTrip(bridge, 'end');
    expect(bridge.runner.outRecords().filter((record) => record.type === 'agent_end')).toEqual([
      { type: 'agent_end', willRetry: false },
    ]);
  });

  it('A4: maps compaction hooks to RPC compaction records and reports isCompacting in between', async () => {
    const bridge = await startBridge();
    await bridge.emit('session_before_compact', { reason: 'threshold', willRetry: false });
    expect((await roundTrip(bridge, 's1')).data).toMatchObject({ isCompacting: true });
    await bridge.emit('session_compact', { reason: 'threshold', willRetry: false, compactionEntry: {}, fromExtension: false });
    expect((await roundTrip(bridge, 's2')).data).toMatchObject({ isCompacting: false });
    await bridge.emit('session_before_compact', { reason: 'manual', willRetry: false });
    await bridge.emit('session_compact_failed', { reason: 'manual', willRetry: false, aborted: false, errorMessage: 'boom', fromExtension: false });
    expect((await roundTrip(bridge, 's3')).data).toMatchObject({ isCompacting: false });

    const phases = bridge.runner.outRecords().flatMap((record) => mapPiRpcEventToAgentMessages(record))
      .map((message) => (message.type === 'event' ? (message.payload as JsonRecord).phase : null));
    expect(phases).toEqual(['started', 'completed', 'started', 'failed']);
    expect(bridge.runner.outRecords().filter((record) => String(record.type).startsWith('compaction_'))).toEqual([
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false },
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorMessage: 'boom' },
    ]);
  });

  it('refuses busy prompts before calling Pi and confirms the call once idle', async () => {
    const bridge = await startBridge();
    bridge.state.idle = false;
    await sendPrompt(bridge, 'busy', 'app input');
    expect(bridge.runner.responses('busy')[0]?.error).toBe(PI_SHARED_CONTROL_BUSY_ERROR);
    expect(bridge.api.sendUserMessage).not.toHaveBeenCalled();

    bridge.state.idle = true;
    bridge.state.pendingMessages = true;
    await sendPrompt(bridge, 'queued', 'app input');
    expect(bridge.runner.responses('queued')[0]?.error).toBe(PI_SHARED_CONTROL_BUSY_ERROR);
    expect(bridge.api.sendUserMessage).not.toHaveBeenCalled();

    bridge.state.pendingMessages = false;
    await sendPrompt(bridge, 'idle', 'app input');
    await expect.poll(() => bridge.runner.responses('idle')).toEqual([
      { id: 'idle', type: 'response', command: 'prompt', success: true, data: { disposition: 'handed_off' } },
    ]);
    expect(bridge.api.sendUserMessage).toHaveBeenCalledExactlyOnceWith('app input', { expandPromptTemplates: true });
  });

  it('projects actual Pi turns and emits no transcript marker for an input Pi consumed', async () => {
    const bridge = await startBridge();
    await sendPrompt(bridge, 'cmd', '/ext-cmd now');
    await roundTrip(bridge, 'handled-by-pi');
    expect(bridge.runner.responses('cmd')[0]?.data).toEqual({ disposition: 'handed_off' });
    expect(userInputMarkers(bridge)).toEqual([]);

    await sendPrompt(bridge, 'app', 'text before extension rewrite');
    for (const text of ['identical committed input', 'identical committed input']) {
      const message = user(text);
      await bridge.emit('message_start', { message });
      await bridge.emit('message_end', { message });
    }
    await roundTrip(bridge, 'two-turns');
    expect(userInputMarkers(bridge)).toEqual(['identical committed input', 'identical committed input']);
  });

  it('A7: terminal user messages reach the runner as the existing observed-input marker', async () => {
    const bridge = await startBridge();
    await bridge.emit('input', { source: 'interactive', text: 'from terminal' });
    await bridge.emit('agent_start');
    const message = { role: 'user', content: [{ type: 'text', text: 'line 1' }, { type: 'image', data: 'x' }, { type: 'text', text: 'line 2' }] };
    await bridge.emit('message_start', { message });
    await bridge.emit('message_end', { message });
    await bridge.emit('message_end', { message: { role: 'user', content: 'string content' } });
    await bridge.emit('message_end', { message: { role: 'user', content: [{ type: 'image', data: 'x' }] } });
    await bridge.emit('message_end', { message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } });
    await roundTrip(bridge, 'sync');
    expect(userInputMarkers(bridge)).toEqual(['line 1\nline 2', 'string content']);
  });

  it('requests active Stop and does not arm a future abort while Pi is idle', async () => {
    const bridge = await startBridge();
    await sendPrompt(bridge, 'preparing', 'paused inside Pi input preparation');
    await roundTrip(bridge, 'preparation');
    bridge.runner.send({ id: 'stop-preparation', type: 'abort' });
    await roundTrip(bridge, 'idle-stop');
    expect(bridge.runner.responses('stop-preparation')[0]).toMatchObject({ success: true });
    expect(bridge.api.abort).not.toHaveBeenCalled();
    expect(bridge.runner.responses('preparing')[0]?.data).toEqual({ disposition: 'handed_off' });

    bridge.state.idle = false;
    await bridge.emit('agent_start');
    bridge.runner.send({ id: 'stop-run', type: 'abort' });
    await roundTrip(bridge, 'busy-stop');
    expect(bridge.runner.responses('stop-run')[0]).toMatchObject({ success: true });
    expect(bridge.api.abort).toHaveBeenCalledOnce();

    bridge.state.idle = true;
    await bridge.emit('agent_settled', { aborted: true });
    await roundTrip(bridge, 'settled');
    expect(bridge.runner.outRecords()).toContainEqual({ type: 'agent_end', willRetry: false });
  });

  it('A9: sets the model and thinking level through Pi, failing when Pi refuses the model', async () => {
    const bridge = await startBridge();
    bridge.runner.send({ id: 'm1', type: 'set_model', provider: 'xai', modelId: 'grok-4.7' });
    await expect.poll(() => bridge.runner.responses('m1')).toEqual([{
      id: 'm1', type: 'response', command: 'set_model', success: true,
      data: { id: 'grok-4.7', provider: 'xai', name: 'Grok 4.7' },
    }]);
    bridge.runner.send({ id: 'm2', type: 'set_model', provider: 'openai', modelId: 'gpt-5' });
    await expect.poll(() => bridge.runner.responses('m2')[0]).toMatchObject({ success: false, error: expect.any(String) });
    bridge.runner.send({ id: 'm3', type: 'set_model', provider: 'nope', modelId: 'missing' });
    await expect.poll(() => bridge.runner.responses('m3')[0]).toMatchObject({ success: false, error: expect.any(String) });
    expect(bridge.api.setModel.mock.calls.map(([model]) => model.id)).toEqual(['grok-4.7', 'gpt-5']);

    bridge.runner.send({ id: 't1', type: 'set_thinking_level', level: 'high' });
    await expect.poll(() => bridge.runner.responses('t1')).toEqual([
      { id: 't1', type: 'response', command: 'set_thinking_level', success: true },
    ]);
    expect((await roundTrip(bridge, 'state')).data).toEqual({
      sessionId: 'pi-session-1',
      sessionFile: '/sessions/pi-session-1.jsonl',
      isStreaming: false,
      isCompacting: false,
      thinkingLevel: 'high',
      model: { id: 'grok-4.7', provider: 'xai', name: 'Grok 4.7' },
    });
  });

  it('A9: answers commands and session stats from the live session', async () => {
    const bridge = await startBridge();
    bridge.runner.send({ id: 'c1', type: 'get_commands' });
    await expect.poll(() => bridge.runner.responses('c1')[0]?.data).toEqual({
      commands: [
        { name: 'ext-cmd', source: 'extension', description: 'an extension command' },
        { name: 'tpl', source: 'prompt' },
      ],
    });
    bridge.runner.send({ id: 's1', type: 'get_session_stats' });
    await expect.poll(() => bridge.runner.responses('s1')[0]?.data).toEqual({
      sessionId: 'pi-session-1',
      contextUsage: { tokens: 1234, contextWindow: 128_000, percent: 1 },
    });
  });

  it('A10: rejects every unsupported command without calling a Pi API', async () => {
    const bridge = await startBridge();
    const unsupported = ['new_session', 'steer', 'follow_up', 'compact', 'switch_session', 'fork', 'bash', 'get_available_models'];
    for (const type of unsupported) bridge.runner.send({ id: `u-${type}`, type, message: 'x' });
    await expect.poll(() => unsupported.every((type) => bridge.runner.responses(`u-${type}`).length === 1)).toBe(true);
    for (const type of unsupported) {
      expect(bridge.runner.responses(`u-${type}`)[0]).toEqual({
        id: `u-${type}`, type: 'response', command: type, success: false, error: PI_SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR,
      });
    }
    for (const fn of Object.values(bridge.api)) expect(fn).not.toHaveBeenCalled();
  });

  it('A11: says bye before a deliberate close and stays inert afterwards', async () => {
    const bridge = await startBridge();
    await bridge.emit('session_shutdown', { reason: 'reload' });
    await expect.poll(() => bridge.runner.peerEnded()).toBe(true);
    expect(bridge.runner.frames().at(-1)).toEqual({ type: 'bye', reason: 'reload' });
    const count = bridge.runner.frames().length;
    await expect(bridge.emit('agent_start')).resolves.toBeUndefined();
    await expect(bridge.emit('message_end', { message: user('late') })).resolves.toBeUndefined();
    await expect(bridge.emit('agent_settled', { aborted: false })).resolves.toBeUndefined();
    expect(bridge.runner.frames()).toHaveLength(count);
  });

  it('A11: goes inert without throwing when the runner connection is lost', async () => {
    const bridge = await startBridge();
    bridge.runner.dropConnection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(bridge.emit('agent_start')).resolves.toBeUndefined();
    await expect(bridge.emit('message_update', {
      message: assistant('x'), assistantMessageEvent: { type: 'text_delta', delta: 'x', partial: assistant('x') },
    })).resolves.toBeUndefined();
    await expect(bridge.emit('message_end', { message: user('after loss') })).resolves.toBeUndefined();
    await expect(bridge.emit('session_shutdown', { reason: 'quit' })).resolves.toBeUndefined();
    expect(bridge.api.notify).not.toHaveBeenCalled();
  });

  it('A12: side-channel lines published before the hello are flushed after it, latest per marker type', async () => {
    const bridge = await startBridge({
      beforeSessionStart: ({ pi }) => {
        pi.events.emit(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT, JSON.stringify({ type: 'happier-pi-model-catalog', models: [{ id: 'old' }] }));
        pi.events.emit(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT, JSON.stringify({ type: 'other-marker', value: 1 }));
        pi.events.emit(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT, JSON.stringify({ type: 'happier-pi-model-catalog', models: [{ id: 'new' }] }));
      },
    });
    await expect.poll(() => bridge.runner.errLines().length).toBe(2);
    expect(bridge.runner.frames()[0]).toMatchObject({ type: 'hello' });
    expect(bridge.runner.errLines().map((line) => JSON.parse(line))).toEqual([
      { type: 'other-marker', value: 1 },
      { type: 'happier-pi-model-catalog', models: [{ id: 'new' }] },
    ]);
    bridge.pi.events.emit(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT, JSON.stringify({ type: 'happier-pi-model-catalog', models: [] }));
    await expect.poll(() => bridge.runner.errLines().length).toBe(3);
  });
});
