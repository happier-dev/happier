import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { agentEventAttentionImpact, agentEventLocalIdAttentionImpact, resolveIdleCompactionPreference } from '@happier-dev/protocol';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { toNativeAgentUsageObservation } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { normalizeUsageObservation } from '@/usage/usageObservation';
import { createSessionProviderInputConsumer } from './input/sessionProviderInputConsumer';
import { createSessionIdleCompactionScheduler } from './createSessionIdleCompactionScheduler';
import { projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from './transcripts/projectRuntimeTranscriptEvent';
import type { DisposableCodexAppServerClient } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { createCodexNativeEventFixture } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client.test-support';
import { createCodexAppServerRuntime, startCodexAppServerRuntime } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime';
import { createCodexNativeAppServerSessionRuntime } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import { createPiRuntimeOperations } from '../../../../../../packages/plugins/pi/src/agent/runtime/rpc/operations';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { createOpenCodeServerRuntime } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/runtime';
import { createOpenCodeSessionRuntime } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/sessionRuntime';
import type { OpenCodeRuntimeContext } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/runtimeContext';
import type { OpenCodeServerClient } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';
import { AGENT_DEFINITION as OPENCODE_AGENT_DEFINITION } from '../../../../../../packages/plugins/opencode/src/agent/definition';

// Native mixed-unit timestamp parsers need a realistic Unix epoch to distinguish milliseconds.
const turnStartedAtMs = Date.UTC(2026, 10, 1);
const lastNonModelItemAtMs = turnStartedAtMs + 100;

type NativeFixture = Readonly<{
  runtime: AgentSessionRuntime;
  produceUsage(): Promise<void>;
  compactCount(): number;
  statsReadCount?(): number;
  settleCompact(): Promise<void>;
  nextInput(): Promise<void>;
}>;

const send = (runtime: AgentSessionRuntime, turnId: string) => runtime.send({
  inputIds: [turnId], input: { text: 'Continue' }, delivery: { kind: 'newTurn', turnId },
});

async function codexFixture(): Promise<NativeFixture> {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const receipts = createCodexNativeEventFixture();
  const requests: string[] = [];
  // Native JSON-RPC is the external boundary; the app-server owner and public facade remain real.
  const client: DisposableCodexAppServerClient = {
    onNativeEvent: receipts.onNativeEvent,
    launchFeatures: { realtimeConversationAdvertised: false },
    async request(method) {
      requests.push(method);
      if (method === 'thread/start') return { thread: { id: 'main' } };
      if (method === 'turn/start') return { turn: { id: 'next-turn' } };
      return {};
    },
    notify: async () => {},
    registerNotificationHandler(method, handler) { handlers.set(method, handler); return () => { handlers.delete(method); }; },
    registerRequestHandler: () => () => {}, onExit: () => () => {}, dispose: async () => {},
  };
  const core = createCodexAppServerRuntime({ happierSessionId: 'idle-composed', directory: '/workspace',
    host: { baseProcessEnv: {}, logger: { debug() {}, warn() {} }, createClient: async () => client } });
  const runtime = createCodexNativeAppServerSessionRuntime(core, 'idle-composed');
  const notify = async (method: string, params: unknown) => {
    receipts.publish(method, params);
    await handlers.get(method)?.(params);
  };
  await startCodexAppServerRuntime(core);
  return {
    runtime,
    async produceUsage() {
      await notify('turn/started', { threadId: 'main', turn: { id: 'foreground', startedAt: turnStartedAtMs / 1_000 } });
      await notify('item/completed', { threadId: 'main', turnId: 'foreground', completedAtMs: lastNonModelItemAtMs,
        item: { id: 'tool', type: 'commandExecution', status: 'completed' } });
      await notify('thread/tokenUsage/updated', { threadId: 'main', turnId: 'foreground', tokenUsage: {
        total: { inputTokens: 220_000, outputTokens: 2, totalTokens: 220_002 },
        last: { inputTokens: 220_000, outputTokens: 2, totalTokens: 220_002 }, modelContextWindow: 400_000,
      } });
      await notify('turn/completed', { threadId: 'main', turn: { id: 'foreground', status: 'completed' } });
    },
    compactCount: () => requests.filter(method => method === 'thread/compact/start').length,
    async settleCompact() {
      await notify('turn/started', { threadId: 'main', turn: { id: 'compact-turn' } });
      const item = { threadId: 'main', turnId: 'compact-turn', item: { id: 'compact', type: 'contextCompaction' } };
      await notify('item/started', item);
      await notify('item/completed', item);
      await notify('turn/completed', { threadId: 'main', turn: { id: 'compact-turn', status: 'completed' } });
    },
    async nextInput() {
      expect(await send(runtime, 'next-host')).toMatchObject({ status: 'admitted' });
      await notify('turn/completed', { threadId: 'main', turn: { id: 'next-turn', status: 'completed' } });
    },
  };
}

async function piFixture(): Promise<NativeFixture> {
  let listener: ((record: unknown) => void | Promise<void>) | undefined;
  const written: Record<string, JsonValue>[] = [];
  let statsReads = 0;
  const emit = async (record: unknown) => { await listener?.(record); };
  const acknowledge = async (record: Record<string, JsonValue>) => emit({ type: 'response', id: record.id,
    command: record.type, success: true });
  const exit = new Promise<Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>>(() => {});
  // The process JSON stream, executable discovery and persisted stats response are external boundaries.
  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client: {
      subscribe(value) { listener = value; return { dispose() { listener = undefined; } }; },
      async write(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected native RPC object');
        if (value.type === 'get_commands') {
          await emit({ type: 'response', id: value.id, command: value.type, success: true, data: { commands: [] } });
        } else if (value.type === 'get_session_stats') {
          statsReads++;
          await emit({ type: 'response', id: value.id, command: value.type, success: true,
            data: { contextUsage: { tokens: 220_000, contextWindow: 400_000 } } });
        } else { written.push(value); }
      },
      dispose: async () => {},
    },
    process: { pid: 123, write: async () => {}, closeStdin: async () => {}, wait: () => exit,
      onOutput: () => ({ dispose() {} }), dispose: async () => {} },
    wait: () => exit, dispose: async () => {},
  };
  const runtime = await createPiRuntimeOperations({
    cwd: '/tmp/pi-idle-composed', env: {}, sessionId: 'idle-composed', initialSessionId: 'pi-native',
    happierToolsExtension: { extensionPath: '/tmp/pi-tools.js', configPath: '/tmp/pi-tools.json' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    services: { interactions: {
      requestApproval: async () => ({ requestId: 'unused', kind: 'approval', status: 'approved', persistence: 'once' }),
      askQuestions: async () => ({ requestId: 'unused', kind: 'questions', status: 'userCancelled' }),
    }, exec: {
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'pi-cli' }, executablePath: '/tmp/pi' }) },
      run: async () => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode('0.81.1'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }),
      clients: { spawn: async () => handle },
    } },
  });
  const prompt = async (turnId: string) => {
    const pending = send(runtime, turnId);
    await vi.waitFor(() => expect(written.at(-1)?.type).toBe('prompt'));
    await acknowledge(written.at(-1)!);
    expect(await pending).toMatchObject({ status: 'admitted' });
  };
  return {
    runtime,
    async produceUsage() {
      await prompt('foreground');
      await emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
      vi.setSystemTime(lastNonModelItemAtMs);
      await emit({ type: 'tool_execution_end', toolCallId: 'tool', toolName: 'Read', result: {} });
      await emit({ type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      });
      await emit({ type: 'agent_end', willRetry: false });
    },
    compactCount: () => written.filter(record => record.type === 'compact').length,
    statsReadCount: () => statsReads,
    async settleCompact() {
      const command = written.findLast(record => record.type === 'compact');
      if (!command) throw new Error('Expected native compact request');
      await emit({ type: 'compaction_start', reason: 'manual' });
      await acknowledge(command);
      await emit({ type: 'compaction_end', reason: 'manual', aborted: false, result: { summary: 'compacted', firstKeptEntryId: 'entry-after-compaction', tokensBefore: 220_000 } });
    },
    async nextInput() { await prompt('next-host'); await emit({ type: 'agent_end', willRetry: false }); },
  };
}

async function openCodeFixture(): Promise<NativeFixture> {
  const storage = new Map<string, JsonValue>();
  const abort = new AbortController();
  const ctx: OpenCodeRuntimeContext = {
    exec: { systemTools: { resolve: async () => ({ executablePath: '/tmp/opencode' }) } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    abort: { signal: abort.signal, compose: signals => AbortSignal.any(signals) },
    config: { values: {} }, env: { list: () => ({}) },
    managedServices: { dependencies: {} as OpenCodeRuntimeContext['managedServices']['dependencies'],
      supervise: async () => { throw new Error('Unexpected native server spawn'); } },
    ui: { askQuestions: async () => ({ requestId: 'unused', kind: 'questions', status: 'userCancelled' }) },
    sessions: { current: { permissions: { requestDecision: async () => ({ requestId: 'unused', kind: 'approval', status: 'approved', persistence: 'once' }) } }, writeStateField: async () => {} },
    storage: { daemonSession: { get: async key => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, value); } } },
    experimental: { telemetry: { emit() {} } },
  };
  let parentID = '';
  const messages: unknown[] = [];
  let summarizeCount = 0;
  // Only the native HTTP client is replaced, including the server's persisted user row.
  const client = {
    appCommands: async () => [], agentsList: async () => [], providersList: async () => [], appSkills: async () => [],
    sessionCreate: async () => ({ id: 'native' }), sessionUpdatePermissions: async () => {}, sessionSetAgent: async () => {},
    sessionReadAgent: async () => null, sessionSetModel: async () => {}, sessionAbort: async () => {},
    sessionChildInventory: async () => null, sessionStatus: async () => ({ type: 'idle' }),
    sessionMessages: async () => messages, sessionTodo: async () => [], permissionList: async () => [], questionList: async () => [],
    globalConfigGet: async () => ({}), subscribeGlobalEvents: async () => {},
    sessionPromptAsync: async (input: Parameters<OpenCodeServerClient['sessionPromptAsync']>[0]) => {
      parentID = `native-user-${messages.length}`;
      messages.push({ info: { id: parentID, role: 'user', sessionID: input.sessionId, time: { created: Date.now() } }, parts: input.parts });
    },
    sessionSummarize: async () => { summarizeCount++; },
  } as OpenCodeServerClient;
  const operations = createOpenCodeServerRuntime({ ctx, directory: '/workspace', happierSessionId: 'idle-composed', client,
    providerModelId: 'anthropic/sonnet',
    mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
    mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false },
  });
  await operations.openSession({ kind: 'create' });
  const runtime = createOpenCodeSessionRuntime({ operations,
    request: { kind: 'create', sessionId: 'idle-composed', cwd: '/workspace' },
    runtimeCapabilities: { sessionCapabilities: OPENCODE_AGENT_DEFINITION.core.sessionCapabilities },
    disposeOperations: () => operations.resetOrDisposeRuntime(),
  });
  return {
    runtime,
    async produceUsage() {
      expect(await send(runtime, 'foreground')).toMatchObject({ status: 'admitted' });
      const assistant = { info: {
        id: 'assistant', role: 'assistant', sessionID: 'native', parentID, providerID: 'anthropic', modelID: 'sonnet', finish: 'stop',
        time: { created: turnStartedAtMs, completed: lastNonModelItemAtMs },
        tokens: { input: 220_000, output: 2, cache: { read: 0, write: 0 } },
      }, parts: [{ id: 'assistant-text', type: 'text', sessionID: 'native', messageID: 'assistant', text: 'done' }] };
      messages.push(assistant);
      await operations.handleProviderEvent({ type: 'message.updated', properties: { info: assistant.info } });
      await operations.handleProviderEvent({ type: 'message.part.updated', properties: { part: assistant.parts[0] } });
      await operations.handleProviderEvent({ type: 'session.idle', properties: { sessionID: 'native' } });
    },
    compactCount: () => summarizeCount,
    async settleCompact() {}, // The native V1 HTTP result settles summarize, independently of foreground turns.
    async nextInput() { expect(await send(runtime, 'next-host')).toMatchObject({ status: 'admitted' }); },
  };
}

function connectHost(fixture: NativeFixture, provider: 'codex' | 'pi' | 'opencode', preference: 'default' | 'no-window' | 'override') {
  const capability = fixture.runtime.runtimeCapabilities?.sessionCapabilities?.compaction;
  if (!capability?.idle) throw new Error('Native runtime did not publish idle support');
  const resolved = resolveIdleCompactionPreference({ idle: capability.idle,
    ...(preference === 'default' ? {} : { enabled: true }),
    ...(preference === 'override' ? { cacheWindowOverrideMs: 10_000 } : {}),
  });
  let activity: Extract<AgentSessionRuntimeEvent, { kind: 'runtime-activity-snapshot' }>['state'] = 'idle';
  const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
    waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
    readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
    readNativeRuntimeActivitySnapshot: () => ({ state: activity, activeCount: 0 }),
    readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
      identity: { mutationKey: 'activity', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 }, result: 'applied',
      committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
    } }),
    readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
  } });
  const events: AgentSessionRuntimeEvent[] = [];
  const persisted: unknown[] = [];
  const persistedLocalIds: string[] = [];
  const writes: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const session: RuntimeTranscriptProjectionSession = { sessionId: 'idle-composed', enqueueAgentMessageCommitted: async (_provider, body, options) => {
    if (body.type !== 'event') throw new Error('Expected typed compaction event');
    if (!options.localId) throw new Error('Expected persisted compaction identity');
    expect(agentEventAttentionImpact(body.data)).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
    expect(agentEventLocalIdAttentionImpact(options.localId)).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
    persistedLocalIds.push(options.localId);
    persisted.push(body);
    return { persisted: true, delivered: true };
  } };
  const scheduler = createSessionIdleCompactionScheduler({ mode: capability.idle.mode, preference: resolved,
    signal: new AbortController().signal, compact: (request, options) => fixture.runtime.compact!(request, options),
    readLiveWork: () => consumer.readLiveWork(), onError: error => errors.push(error),
  });
  const subscription = fixture.runtime.watch(raw => {
    const event = AgentSessionRuntimeEventSchema.parse(raw);
    events.push(event);
    if (event.kind === 'runtime-activity-snapshot') activity = event.state;
    if (event.kind === 'usage-observed') {
      const observation = normalizeUsageObservation(toNativeAgentUsageObservation(event, provider));
      if (!observation) throw new Error('Native usage failed host capture validation');
      expect(observation.promptCache).toEqual(event.promptCache);
      scheduler.observeUsage({ promptCache: observation.promptCache, ...(observation.contextSnapshot ? { context: observation.contextSnapshot } : {}) });
    }
    if (event.kind === 'context-compaction') writes.push(projectRuntimeTranscriptEvent({ session, provider, event }));
  });
  return { resolved, events, persisted, persistedLocalIds, writes, errors, dispose() { scheduler.dispose(); subscription.dispose(); } };
}

afterEach(() => { vi.useRealTimers(); });

describe.each([
  { provider: 'codex', create: codexFixture },
  { provider: 'pi', create: piFixture },
  { provider: 'opencode', create: openCodeFixture },
] as const)('$provider native usage → strict host bridge → idle scheduler → quiet transcript', ({ provider, create }) => {
  it.each(['default', 'no-window', 'override'] as const)('keeps clock-only usage ineligible unless opted in with a window (%s)', async preference => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(turnStartedAtMs);
    const fixture = await create();
    const host = connectHost(fixture, provider, preference);
    try {
      await fixture.produceUsage();
      await vi.waitFor(() => expect(host.events.some(event => event.kind === 'usage-observed' && event.promptCache)).toBe(true));
      const usage = host.events.findLast(event => event.kind === 'usage-observed' && event.promptCache);
      expect(usage?.kind === 'usage-observed' && usage.promptCache).not.toHaveProperty('ttlMs');
      if (preference === 'override') {
        // OpenCode's settled-message context includes this response's output as well as its prompt.
        expect(usage?.kind === 'usage-observed' && usage.context).toMatchObject({ usedTokens: provider === 'pi' ? 220_000 : 220_002 });
      }
      expect(host.resolved.enabled).toBe(preference !== 'default');
      const foregroundStart = host.events.find(event => event.kind === 'turn-start');
      expect(foregroundStart).toBeDefined();
      await vi.waitFor(() => expect(host.events.filter(event => event.kind === 'turn-complete')).toMatchObject([{ turnId: foregroundStart!.turnId }]));
      expect(host.events.filter(event => event.kind === 'turn-failed')).toEqual([]);
      const beforeIdle = host.events.length;
      const statsReads = fixture.statsReadCount?.();
      if (statsReads !== undefined) expect(statsReads).toBe(1);
      await vi.advanceTimersByTimeAsync(9_100);
      if (preference !== 'override') {
        expect(fixture.compactCount()).toBe(0);
        expect(host.persisted).toEqual([]);
        // A guessed long cache window must not leave dormant work behind either.
        const timers = vi.getTimerCount();
        host.dispose();
        expect(vi.getTimerCount()).toBe(timers);
        return;
      }
      await vi.waitFor(() => expect(fixture.compactCount()).toBe(1));
      if (statsReads !== undefined) expect(fixture.statsReadCount?.()).toBe(statsReads);
      await fixture.settleCompact();
      await vi.waitFor(() => expect(host.events.some(event => event.kind === 'context-compaction' && event.phase === 'completed')).toBe(true));
      await Promise.all(host.writes);
      expect(host.errors).toEqual([]);
      expect(host.persisted).toHaveLength(2);
      expect(host.events.slice(beforeIdle).filter(event => event.kind === 'turn-start' || event.kind === 'turn-complete')).toEqual([]);
      expect(host.events.filter(event => event.kind === 'context-compaction')).toMatchObject([
        { phase: 'started', trigger: 'idle' }, { phase: 'completed', trigger: 'idle' },
      ]);
      const compactions = host.events.filter(event => event.kind === 'context-compaction');
      expect(new Set(compactions.map(event => event.compactionId)).size).toBe(1);
      expect(compactions.every(event => event.turnId === undefined)).toBe(true);
      const lifecycleId = compactions[0]!.compactionId;
      expect(host.persisted).toMatchObject([
        { data: { type: 'context-compaction', phase: 'started', trigger: 'idle', lifecycleId } },
        { data: { type: 'context-compaction', phase: 'completed', trigger: 'idle', lifecycleId } },
      ]);
      expect(new Set(host.persistedLocalIds).size).toBe(2);
      if (provider === 'pi') expect(compactions[1]).toHaveProperty('tokenCountBefore', 220_000);
      else expect(compactions[1]).not.toHaveProperty('tokenCountBefore');
      expect(compactions[1]).not.toHaveProperty('tokenCountAfter');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fixture.compactCount()).toBe(1);
      await fixture.nextInput();
    } finally { host.dispose(); await fixture.runtime.dispose(); }
  });
});
