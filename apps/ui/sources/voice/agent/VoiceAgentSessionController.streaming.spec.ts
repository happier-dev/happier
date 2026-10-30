import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { FeaturesResponseSchema, ExecutionRunEnsureOrStartRequestSchema, ExecutionRunPublicStateSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { LlmTaskRunnerConfigV1Schema } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { attachAgentPluginSettings } from '@/agents/registry/agentUiSettingLookup';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { storage } from '@/sync/domains/state/storage';
import { parseToken } from '@/utils/auth/parseToken';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { VOICE_TRANSCRIPT_MEMORY_KEY } from '@/voice/persistence/voiceTranscriptMemory';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getRetainedLocalVoiceEffectOutcomes } from '@/voice/tools/localVoiceEffectOutcomeCustody';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const daemonStart = vi.fn(async (_args: unknown) => ({ ok: true, runId: 'm1', created: true }));
const daemonStreamStart = vi.fn(async (_args: unknown) => ({ streamId: 'stream-1' }));
const daemonStreamRead = vi.fn();
const daemonStreamCancel = vi.fn(async (_args: unknown) => ({ ok: true }));
const daemonWelcome = vi.fn(async () => ({ assistantText: 'Welcome!' }));
const daemonCommit = vi.fn(async () => ({ commitText: 'commit' }));
const daemonRunGet = vi.fn(async (..._args: any[]): Promise<any> => ({
  ok: false,
  error: 'Execution run not found',
  errorCode: 'execution_run_not_found',
}));
const daemonRunList = vi.fn(async (..._args: any[]): Promise<any> => ({ runs: [] }));
const daemonRunStop = vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true }));
const retainedRuns = new Map<string, Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>>();

type TurnStreamReadResult = {
  streamId: string;
  events: Array<{ t: 'done'; assistantText: string; actions: unknown[] }>;
  nextCursor: number;
  done: boolean;
};

function trackPromise<T>(promise: Promise<T>): Readonly<{
  isSettled: () => boolean;
  settled: Promise<
    | { status: 'resolved'; value: T }
    | { status: 'rejected'; reason: unknown }
  >;
}> {
  let settled = false;
  const settledPromise = promise.then(
    (value) => {
      settled = true;
      return { status: 'resolved' as const, value };
    },
    (reason) => {
      settled = true;
      return { status: 'rejected' as const, reason };
    },
  );

  return {
    isSettled: () => settled,
    settled: settledPromise,
  };
}

function createLocallyControllableSessionMetadata(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    flavor: 'claude',
    agentRuntimeCapabilitiesV1: {
      localControl: { supported: true },
    },
    ...overrides,
  };
}

function createVoiceControllerState(options: Readonly<{
  sessions?: Record<string, unknown>;
  sessionMessages?: Record<string, unknown>;
  machines?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  voice?: Readonly<{
    providerId?: string;
    streaming?: Readonly<{
      enabled?: boolean;
      turnReadPollIntervalMs?: number;
      turnReadMaxEvents?: number;
      turnStreamTimeoutMs?: number | null;
    }>;
    agent?: Record<string, unknown>;
    networkTimeoutMs?: number;
  }>;
}> = {}): {
  settings: {
    voice: {
      providerId: string;
      providers: {
        local_conversation: {
          schemaVersion: 1;
          config: {
            streaming: {
              enabled: boolean;
              turnReadPollIntervalMs: number;
              turnReadMaxEvents: number;
              turnStreamTimeoutMs: number | null;
            };
            agent: Record<string, unknown>;
            networkTimeoutMs: number;
          };
        };
      };
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  sessions: Record<string, unknown>;
  sessionMessages: Record<string, unknown>;
  machines?: Record<string, unknown>;
} {
  const voice = {
    providerId: options.voice?.providerId ?? 'local_conversation',
    providers: {
      local_conversation: { schemaVersion: 1 as const, config: {
        streaming: {
          enabled: true,
          turnReadPollIntervalMs: 50,
          turnReadMaxEvents: 7,
          turnStreamTimeoutMs: 1200,
          ...(options.voice?.streaming ?? {}),
        },
        agent: {
          backend: 'daemon',
          transcript: { persistenceMode: 'ephemeral', epoch: 0 },
          ...(options.voice?.agent ?? {}),
        },
        networkTimeoutMs: options.voice?.networkTimeoutMs ?? 15_000,
      } },
    },
  };

  return {
    settings: {
      voice,
      ...(options.settings ?? {}),
    },
    sessions: options.sessions ?? {
      sys_voice: {
        id: 'sys_voice',
        active: true,
        modelMode: 'default',
        metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
      },
      s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
    },
    sessionMessages: options.sessionMessages ?? {},
    ...(options.machines ? { machines: options.machines } : {}),
  };
}

function setVoiceControllerState(options?: Parameters<typeof createVoiceControllerState>[0]): void {
  setControllerState(() => createVoiceControllerState(options));
}



let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
const transcriptMemory = createAccountKvHttpFixture();
const requestedPaths: string[] = [];
let hydratedTargetActive = true;
let installerReply: ((method: string, payload: unknown) => Promise<unknown>) | null = null;
const daemonEffects: string[] = [];
let sessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;

function installSessionHttpSnapshot() {
  sessionHttp = createSessionMetadataHttpBoundary(() => Object.fromEntries(
    Object.entries(storage.getState().sessions).map(([id, session]) => [id, createSessionFixture({ ...session,
      metadata: { path: '/test', host: 'test', ...readVoiceSessionOwnerMetadataFromState(storage.getState(), id) },
      active: id === 's1' ? session.active && hydratedTargetActive : session.active,
      updatedAt: session.updatedAt + 1, activeAt: session.activeAt + 1, seq: session.seq + 1,
    })]),
  ));
}

function setControllerState(read: () => any): void {
  const fixture = read();
  const sessions = Object.fromEntries(Object.entries(fixture.sessions ?? {}).map(([id, value]) => [
    id, createSessionFixture({ ...value as Parameters<typeof createSessionFixture>[0], id, serverId: connection.home.id }),
  ]));
  storage.setState({ ...fixture, settings: { experiments: true,
    featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true }, ...fixture.settings }, sessions });
  installSessionHttpSnapshot();
}

installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  // This scoped pool can retain a Socket across cases. The external ACK
  // replacement must survive per-case spy restoration, as the SDK owner does.
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, ...args) => {
    if (event === 'rpc-call') {
      const request = args[0] as { method: string; params: unknown };
      const separator = request.method.indexOf(':');
      const targetId = request.method.slice(0, separator);
      const method = request.method.slice(separator + 1);
      const token = typeof socket.auth === 'object' ? socket.auth.token : null;
      if (typeof token !== 'string') throw new Error('Expected authenticated daemon ACK');
      const scope = { scope: { serverId: connection.home.id, accountId: parseToken(token) } };
      if (installerReply && (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
          || method === RPC_METHODS.CAPABILITIES_DETECT || method === RPC_METHODS.CAPABILITIES_INVOKE)) {
        return { ok: true, result: await installerReply(method, request.params) };
      }
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return { ok: true, result: { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' } };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { ok: true, result: await daemonRunGet(targetId, request.params, scope) };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { ok: true, result: await daemonRunList(targetId, request.params, scope) };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return { ok: true, result: await daemonRunStop(targetId, request.params, scope) };
      try {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
          const admission = ExecutionRunEnsureOrStartRequestSchema.parse(request.params);
          daemonEffects.push('admit');
          const result = await daemonStart({ ...admission.start, sessionId: targetId,
            runId: admission.runId, resume: admission.resume });
          if (result.ok) {
            const key = `${targetId}:${result.runId}`;
            const retained = retainedRuns.get(key) ?? await createRetainedVoiceAgentRpcBoundary({ runId: result.runId });
            // The daemon retains policy from the accepted admission, never from
            // whatever settings the UI happens to have during later recovery.
            await retained.dispatch(method, admission);
            retainedRuns.set(key, retained);
          }
          return { ok: true, result };
        }
        const input = request.params as Record<string, unknown>;
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
          return { ok: true, result: await daemonStreamStart({ ...input, sessionId: targetId }) };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) return { ok: true, result: await daemonStreamRead({ ...input, sessionId: targetId }) };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return { ok: true, result: await daemonStreamCancel({ ...input, sessionId: targetId }) };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) {
          const result = input.actionId === 'voice_agent.welcome' ? await daemonWelcome() : await daemonCommit();
          return { ok: true, result: { ok: true, result } };
        }
      } catch (error) {
        const failure = error as Error & { rpcErrorCode?: string };
        return { ok: true, result: { ok: false, error: failure.message, errorCode: failure.rpcErrorCode } };
      }
      throw new Error(`Unexpected daemon method: ${method}`);
    }
    if (event !== 'update-metadata') throw new Error(`Unexpected socket event: ${event}`);
    const payload = args[0] as { metadata: string; expectedVersion: number };
    return { result: 'success', metadata: payload.metadata, version: payload.expectedVersion + 1 };
  });
});

await loadSyncSingletonForTests();
const { buildVoiceInitialContext } = await import('@/voice/context/buildVoiceInitialContext');
const targetInitialContext = () => {
  const context = buildVoiceInitialContext(VOICE_AGENT_GLOBAL_SESSION_ID, {
    targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
  });
  if (!context) throw new Error('Expected real target Session context');
  return context;
};

describe('VoiceExecutionTransport (streaming)', () => {
  let createVoiceExecutionTransport: () => any;

  beforeAll(async () => {
    await loadSyncSingletonForTests();
    ({ createVoiceExecutionTransport } = await import('@/voice/runtime/execution/VoiceExecutionTransport'));
  }, 60_000);

  beforeEach(async () => {
    transcriptMemory.reset();
    requestedPaths.length = 0;
    daemonEffects.length = 0;
    retainedRuns.clear();
    installerReply = null;
    hydratedTargetActive = true;
    installSessionHttpSnapshot();
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://voice-streaming.example.test',
      request: createSessionReadBatchFetchBoundary(async (url, init) => {
        const memoryResponse = await transcriptMemory.handleFetch(url, init);
        if (memoryResponse) return memoryResponse;
        const path = new URL(String(url)).pathname;
        requestedPaths.push(path);
        const json = (value: unknown) => Response.json(value);
        if (path === '/v1/features' || path === '/v1/features/authenticated') return json(FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }));
        if (path === '/health') return json({ status: 'ok' });
        if (path === '/v2/cursor') return json({ cursor: 0, changesFloor: 0 });
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: storage.getState().settings }, version: 1 });
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
          return createMachineReadBatchResponseFixture(init.body,
            id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        }
        const machineDetail = /^\/v1\/machines\/([^/]+)(\/access)?$/.exec(path);
        if (machineDetail) {
          const machineId = decodeURIComponent(machineDetail[1]);
          const machine = createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' });
          if (!machine.access) throw new Error('Canonical Machine access missing');
          return json(machineDetail[2] ? MachineAccessGrantsListResponseV1Schema.parse({ machineId,
            custodian: machine.access.custodian, access: machine.access, canManage: true,
            grants: [], ownDirectGrant: false, ownAccessSources: [],
          }) : { machine });
        }
        if (path.endsWith('/messages')) return json({ messages: [], hasMore: false });
        if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
        const sessionResponse = sessionHttp.handle(url, init);
        if (sessionResponse) return sessionResponse;
        return new Response('{}', { status: 404 });
      }),
    });
    setVoiceControllerState();
    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionAddress: null, voiceLiveContextSessionAddresses: [], lastFocusedSessionAddress: null } as any);
    daemonRunGet.mockReset();
    daemonRunGet.mockImplementation(async (targetId: string, input: { runId: string }) =>
      retainedRuns.get(`${targetId}:${input.runId}`)?.dispatch(SESSION_RPC_METHODS.EXECUTION_RUN_GET, input)
        ?? { ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' });
    daemonRunList.mockReset();
    daemonRunList.mockResolvedValue({ runs: [] });
    daemonRunStop.mockReset();
    voiceSessionBindingStore.setState((state) => ({
      ...state,
      runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {},
      bindingsByConversationSessionId: {},
    }));
    daemonStart.mockReset();
    daemonStart.mockImplementation(async (_args: unknown) => ({ ok: true, runId: 'm1', created: true }));
    daemonStreamStart.mockClear();
    daemonStreamRead.mockReset();
    daemonStreamRead.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [{ t: 'done', assistantText: 'ok', actions: [] }],
      nextCursor: 1,
      done: true,
    }));
    daemonStreamCancel.mockClear();

    daemonWelcome.mockClear();
    daemonCommit.mockClear();
    daemonRunStop.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await connection?.dispose();
    vi.restoreAllMocks();
  });

  it('uses configured maxEvents when reading the streamed turn', async () => {
    const controller = createVoiceExecutionTransport();

    await controller.sendTurn('s1', 'hello');

    expect(daemonStreamRead).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: 7,
      }),
    );
  });

  it('hydrates the bound target session before starting global local voice', async () => {
    const state = createVoiceControllerState();
    state.sessions['voice-hidden-s1'] = {
      id: 'voice-hidden-s1',
      active: true,
      presence: 'online',
      modelMode: 'default',
      metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
    };
    setControllerState(() => state);
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: { serverId: connection.home.id, sessionId: 'voice-hidden-s1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
      updatedAt: 1,
    });

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(requestedPaths).toContain('/v1/sessions/s1/messages');
    expect(requestedPaths).not.toContain('/v1/sessions/voice-hidden-s1/messages');
  });

  it('refreshes stale bound target state before starting global local voice', async () => {
    const state = {
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        'voice-hidden-s1': {
          id: 'voice-hidden-s1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    };
    setControllerState(() => state);
    hydratedTargetActive = false;
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: { serverId: connection.home.id, sessionId: 'voice-hidden-s1' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
      updatedAt: 1,
    });

    const controller = createVoiceExecutionTransport();

    const turn = controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');
    await turn.catch(() => {});
    expect(storage.getState().sessions.s1.active).toBe(false);
    await expect(turn).rejects.toMatchObject({
      message: 'Target session is inactive. Resume it before starting local voice.',
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
    });

    expect(requestedPaths).toContain('/v2/sessions/s1');
    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('projects execution_run_busy without stopping or redispatching the turn', async () => {
    daemonStart.mockResolvedValueOnce({ ok: true, runId: 'busy-run', created: true });
    daemonStreamStart.mockRejectedValueOnce(
      Object.assign(new Error('Voice agent busy'), { rpcErrorCode: 'execution_run_busy' }),
    );

    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn('s1', 'hello')).rejects.toMatchObject({
      message: 'Voice agent busy',
      rpcErrorCode: 'execution_run_busy',
    });
    expect(daemonRunStop).not.toHaveBeenCalled();
    expect(daemonStart).toHaveBeenCalledTimes(1);
    expect(daemonStreamStart).toHaveBeenCalledTimes(1);
  });

  it('aborts and settles the active turn before clearing its retained effect outcomes on stop', async () => {
    const blockedRead = createDeferred<TurnStreamReadResult>();
    const readEntered = createDeferred<void>();
    daemonStreamStart.mockResolvedValueOnce({ streamId: 'stream-stop' });
    daemonStreamRead.mockImplementationOnce(async () => { readEntered.resolve(); return await blockedRead.promise; });
    const outcomes = getRetainedLocalVoiceEffectOutcomes('s1');
    outcomes.set('effect-stop', {
      fingerprint: 'fingerprint-stop',
      outcome: Promise.resolve({ t: 'sendSessionMessage', args: {}, result: { ok: true } }),
    });

    const controller = createVoiceExecutionTransport();
    const activeTurn = trackPromise(controller.sendTurn('s1', 'hello'));
    await readEntered.promise;
    expect(daemonStreamRead).toHaveBeenCalledTimes(1);

    const stopping = trackPromise(controller.stop('s1'));
    await Promise.resolve();
    expect(stopping.isSettled()).toBe(false);
    expect(getRetainedLocalVoiceEffectOutcomes('s1').has('effect-stop')).toBe(true);

    const turnResult = await activeTurn.settled;
    expect(turnResult.status).toBe('rejected');
    await expect(stopping.settled).resolves.toMatchObject({ status: 'resolved' });
    expect(getRetainedLocalVoiceEffectOutcomes('s1').size).toBe(0);
    expect(daemonStreamCancel).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'stream-stop' }));
  });

  it('forwards a concurrent turn to canonical admission instead of queueing it in Voice', async () => {
    const blockedRead = createDeferred<TurnStreamReadResult>();
    const readEntered = createDeferred<void>();
    daemonStreamStart.mockResolvedValueOnce({ streamId: 'stream-active' });
    daemonStreamStart.mockRejectedValueOnce(
      Object.assign(new Error('Voice agent busy'), { rpcErrorCode: 'execution_run_busy' }),
    );
    daemonStreamRead.mockImplementationOnce(async () => { readEntered.resolve(); return await blockedRead.promise; });

    const controller = createVoiceExecutionTransport();
    const activeTurn = trackPromise(controller.sendTurn('s1', 'active turn'));
    await readEntered.promise;
    expect(daemonStreamRead).toHaveBeenCalledTimes(1);

    await expect(controller.sendTurn('s1', 'concurrent turn')).rejects.toMatchObject({
      rpcErrorCode: 'execution_run_busy',
    });

    expect(daemonStreamStart).toHaveBeenCalledTimes(2);
    expect(daemonStreamRead).toHaveBeenCalledTimes(1);
    expect(daemonStart).toHaveBeenCalledTimes(1);
    expect(daemonRunStop).not.toHaveBeenCalled();

    blockedRead.resolve({
      streamId: 'stream-active',
      events: [{ t: 'done', assistantText: 'active complete', actions: [] }],
      nextCursor: 1,
      done: true,
    });
    await expect(activeTurn.settled).resolves.toMatchObject({
      status: 'resolved',
      value: { assistantText: 'active complete' },
    });
  });

  it('joins concurrent stops without retiring the first stop before daemon recovery', async () => {
    const stopStarted = createDeferred<void>();
    const releaseStop = createDeferred<void>();
    daemonRunStop.mockImplementationOnce(async () => {
      stopStarted.resolve();
      await releaseStop.promise;
      return { ok: true };
    });

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');

    const firstStop = trackPromise(controller.stop('s1'));
    const secondStop = trackPromise(controller.stop('s1'));
    await stopStarted.promise;
    await flushHookEffects({ cycles: 2, turns: 2 });

    expect(daemonRunStop).toHaveBeenCalledTimes(1);
    expect(firstStop.isSettled()).toBe(false);
    expect(secondStop.isSettled()).toBe(false);

    releaseStop.resolve();
    await expect(firstStop.settled).resolves.toMatchObject({ status: 'resolved' });
    await expect(secondStop.settled).resolves.toMatchObject({ status: 'resolved' });
    expect(daemonRunStop).toHaveBeenCalledTimes(1);
  });

  it('surfaces a clear error when starting local voice on an inactive target session', async () => {
    setVoiceControllerState({
      sessions: {
        s1: { id: 's1', active: false, modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
    });

    const controller = createVoiceExecutionTransport();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).rejects.toMatchObject({
      message: 'Target session is inactive. Resume it before starting local voice.',
      code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE',
    });
    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when starting local voice on an offline target session', async () => {
    setVoiceControllerState({
      sessions: {
        s1: { id: 's1', active: true, presence: 'offline', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
    });

    const controller = createVoiceExecutionTransport();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).rejects.toMatchObject({
      message: 'Target session is offline. Reconnect it before starting local voice.',
      code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE',
    });
    expect(daemonStart).not.toHaveBeenCalled();
  });

  it('starts an independently admitted Voice run on a target without terminal control support', async () => {
    setVoiceControllerState({
      sessions: {
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'kimi' } },
      },
    });

    const controller = createVoiceExecutionTransport();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).resolves.toBeNull();
    expect(controller.isActive('s1')).toBe(true);
  });

  it('does not confuse OpenCode ACP terminal support with Voice Execution Run admission', async () => {
    setVoiceControllerState({
      settings: {
        opencodeBackendMode: 'server',
      },
      sessions: {
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'opencode', opencodeBackendMode: 'acp' },
        },
      },
    });

    const controller = createVoiceExecutionTransport();

    await expect(controller.ensureRunningAndMaybeWelcome('s1')).resolves.toBeNull();
    expect(controller.isActive('s1')).toBe(true);
  });

  it('always enables daemon transcript persistence for the hidden voice conversation session', async () => {
    setVoiceControllerState({
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
    });

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        transcript: { persistenceMode: 'persistent', epoch: 0 },
      }),
    );
  });

  it('does not inject a local greeting prompt into the first user turn when welcome mode is on_first_turn', async () => {
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          welcome: { enabled: true, mode: 'on_first_turn', templateId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',

                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            agentRuntimeFacetsV1: {
              v: 1,
              transcriptSource: {
                supported: true,
                followLeaseSupported: true,
              },
            },
          },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();
    await controller.sendTurn('s1', 'hello');

    expect(daemonStreamStart).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'hello',
      }),
    );
  });

  it('delivers interrupting text updates as immediate follow-up turns', async () => {
    const controller: any = createVoiceExecutionTransport();

    await controller.sendTextUpdate('s1', 'Permission required for writing /tmp/file.txt. Ask whether to allow it.');

    expect(daemonStreamStart).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Permission required for writing /tmp/file.txt. Ask whether to allow it.',
      }),
    );
  });

  it('projects a concurrent text update to canonical admission instead of queueing it in Voice', async () => {
    const blockedRead = createDeferred<TurnStreamReadResult>();
    const readEntered = createDeferred<void>();
    daemonStreamStart.mockResolvedValueOnce({ streamId: 'stream-1' });
    daemonStreamStart.mockRejectedValueOnce(
      Object.assign(new Error('Voice agent busy'), { rpcErrorCode: 'execution_run_busy' }),
    );
    daemonStreamRead.mockImplementationOnce(async () => { readEntered.resolve(); return await blockedRead.promise; });

    const controller: any = createVoiceExecutionTransport();
    const firstTurn = controller.sendTurn('s1', 'hello');
    await readEntered.promise;
    expect(daemonStreamRead).toHaveBeenCalledTimes(1);

    await expect(
      controller.sendTextUpdate('s1', 'Permission required. Ask the human whether to allow it.'),
    ).rejects.toMatchObject({ rpcErrorCode: 'execution_run_busy' });
    expect(daemonStreamStart).toHaveBeenCalledTimes(2);

    blockedRead.resolve({
      streamId: 'stream-1',
      events: [{ t: 'done', assistantText: 'ok', actions: [] }],
      nextCursor: 1,
      done: true,
    });
    await expect(firstTurn).resolves.toMatchObject({ assistantText: 'ok' });
  });

  it('can emit an immediate welcome via ensureRunningAndMaybeWelcome, and does not inject a greeting into the next user turn', async () => {
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          welcome: { enabled: true, mode: 'immediate', templateId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',

                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();
    const welcomed = await controller.ensureRunningAndMaybeWelcome('s1');
    expect(welcomed).toBe('Welcome!');
    expect(daemonWelcome).toHaveBeenCalledTimes(1);

    await controller.sendTurn('s1', 'hello');
    const payload = (daemonStreamStart.mock.calls[0]?.[0] as any)?.message ?? '';
    expect(daemonStreamStart).toHaveBeenCalledWith(expect.objectContaining({
      message: 'hello',
      displayMessage: 'hello',
    }));
    expect(String(payload)).not.toContain('greeting');
  });

  it('emits an immediate welcome for migrated Provider-backed Chat through the daemon', async () => {
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          welcome: { enabled: true, mode: 'immediate', templateId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                agentSource: 'agent',
                agentId: 'opencode',
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
                providerChat: {
                  status: 'configured',
                  chat: { agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: 'provider-chat', modelId: 'chat-model' },
                  commit: { agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: 'provider-chat', modelId: 'commit-model' },
                },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();
    const welcomed = await controller.ensureRunningAndMaybeWelcome('s1');
    expect(welcomed).toBe('Welcome!');
    expect(daemonWelcome).toHaveBeenCalledTimes(1);
  });

  it('does not use ready_handshake bootstrap when immediate welcome is enabled (welcome acts as the bootstrap prompt)', async () => {
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          welcome: { enabled: true, mode: 'immediate', templateId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              tts: { autoSpeakReplies: true },
              agent: {
                backend: 'daemon',
                prewarmOnConnect: true,

                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunningAndMaybeWelcome('s1');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ bootstrapMode: 'none' }));
    expect(daemonWelcome).toHaveBeenCalledTimes(1);
  });

  it('uses ready_handshake bootstrap when prewarm is enabled but auto-speak is disabled (even if welcome immediate is enabled)', async () => {
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          welcome: { enabled: true, mode: 'immediate', templateId: null },
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              tts: { autoSpeakReplies: false },
              agent: {
                backend: 'daemon',
                prewarmOnConnect: true,

                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
    }));

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ bootstrapMode: 'ready_handshake' }));
    expect(daemonStart.mock.calls.at(-1)?.[0]).not.toHaveProperty('bootstrapTimeoutMs');
  });

  it('prefetches relevant agent installables before starting a daemon voice agent session', async () => {
    setControllerState(() => ({
      settings: {
        codexBackendMode: 'acp',
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                agentSource: 'agent',
                agentId: 'codex',
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: createLocallyControllableSessionMetadata({ machineId: 'machine-1' }),
        },
      },
      machines: {
        'machine-1': { id: 'machine-1', active: true, activeAt: Date.now() },
      },
      sessionMessages: {},
    }));

    // Feed the canonical scoped Account projection, not a catalog or policy stub.
    storage.setState({ settings: attachAgentPluginSettings(storage.getState().settings,
      { account: { codexBackendMode: 'acp' } }),
      machines: { 'machine-1': createMachineFixture({ id: 'machine-1', activeAt: Date.now(),
        access: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }).access }) },
    });
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {}, familiesById: {
      managedDependencies: { family: 'managedDependencies', entriesById: { 'codex-acp': {
        id: 'codex-acp', pluginId: 'acme', key: 'codex-acp', capabilityId: 'dep.codex-acp',
        sourceKind: 'github_release_binary', display: { name: 'Codex ACP' },
        defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' }, experimental: true,
      } } },
    } });
    let installed = false;
    installerReply = async (method, payload) => {
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: { 'dep.codex-acp': {
        ok: true, checkedAt: Date.now(), data: { installed, installDir: '/managed', binPath: null,
          installedVersion: null, sourceKind: 'github_release_binary', lastInstallLogPath: null,
          lastBackgroundUpdateCheckAtMs: null },
      } } };
      expect(payload).toMatchObject({ id: 'dep.codex-acp', method: 'install' });
      installed = true;
      daemonEffects.push('install');
      return { ok: true, result: null };
    };
    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');

    expect(installed).toBe(true);
    expect(daemonEffects).toEqual(['install', 'admit']);
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } }));
  });

  it('passes the effective disabled voice action ids into daemon starts', async () => {
    setControllerState(() => ({
      settings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'review.start': { enabled: true, disabledSurfaces: ['voice'], disabledPlacements: [] },
          },
        },
        voice: {
          privacy: {
            shareDeviceInventory: false,
            currentUiContextMode: 'off',
          },
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                transcript: { persistenceMode: 'ephemeral', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');

    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        disabledActionIds: expect.arrayContaining([
          'review.start',
          'paths.list_recent',
          'machines.list',
          'servers.list',
          'ui.current_context.read',
          'ui.current_context.command.invoke',
        ]),
      }),
    );
  });

  it('times out using configured turnStreamTimeoutMs (not a hard-coded poll count)', async () => {
    daemonStreamRead.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');
    vi.useFakeTimers();
    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 1300 });

    const outcome = await sendTurnOutcome.settled;
    if (outcome.status !== 'rejected') {
      throw new Error(`Expected rejection outcome, received ${outcome.status}`);
    }
    expect(String(outcome.reason)).toContain('stream_timeout');
    expect(daemonStreamCancel).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to networkTimeoutMs when turnStreamTimeoutMs is null', async () => {
    let readCount = 0;
    daemonStreamRead.mockImplementation(async () => {
      readCount += 1;
      if (readCount >= 8) {
        return {
          streamId: 'stream-1',
          events: [{ t: 'done', assistantText: 'ok', actions: [] }],
          nextCursor: readCount,
          done: true,
        };
      }
      return {
        streamId: 'stream-1',
        events: [],
        nextCursor: readCount,
        done: false,
      };
    });
    setControllerState(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnReadPollIntervalMs: 250,
            turnStreamTimeoutMs: null,
          },
          networkTimeoutMs: 1000,
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
        },
      }),
    );

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');
    vi.useFakeTimers();
    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 1800 });

    await expect(sendTurnOutcome.settled).resolves.toMatchObject({
      status: 'resolved',
      value: { assistantText: 'ok', actions: [] },
    });
    expect(readCount).toBeGreaterThanOrEqual(8);
    expect(daemonStreamCancel).toHaveBeenCalledTimes(0);
  });

  it('supports long streamed turns (does not clamp turnStreamTimeoutMs to 60s)', async () => {
    daemonStreamRead.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    setControllerState(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnStreamTimeoutMs: 65_000,
          },
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
        },
      }),
    );

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');
    vi.useFakeTimers();

    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 61_000 });
    expect(sendTurnOutcome.isSettled()).toBe(false);

    await flushHookEffects({ cycles: 1, advanceTimersMs: 4_000 });
    const outcome = await sendTurnOutcome.settled;
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(String((outcome.status === 'rejected' ? outcome.reason : null) as any)).toContain('stream_timeout');
  });

  it('aborts a streamed turn when the provided abort signal is aborted', async () => {
    try {
      const readTurnStarted = createDeferred<void>();
      daemonStreamRead.mockImplementation(async () => {
        readTurnStarted.resolve();
        return {
          streamId: 'stream-1',
          events: [],
          nextCursor: 1,
          done: false,
        };
      });

      const controller = createVoiceExecutionTransport();
      await controller.ensureRunning('s1');
      vi.useFakeTimers();
      const abortController = new AbortController();

      const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello', { signal: abortController.signal } as any));

      await readTurnStarted.promise;

      abortController.abort();

      await flushHookEffects({ cycles: 1, advanceTimersMs: 10 });

      const outcome = await sendTurnOutcome.settled;
      if (outcome.status !== 'rejected') {
        throw new Error(`Expected rejected outcome, received ${outcome.status}`);
      }
      expect(String(outcome.reason)).toContain('turn_aborted');
      expect(daemonStreamCancel).toHaveBeenCalledTimes(1);
    } finally {
      // Ensure we don't leak the in-flight promise if abort isn't implemented yet.
      await flushHookEffects({ cycles: 1, advanceTimersMs: 10 });
      vi.useRealTimers();
    }
  });

  it('supports very long streamed turns (does not clamp turnStreamTimeoutMs to 10min)', async () => {
    daemonStreamRead.mockImplementation(async () => ({
      streamId: 'stream-1',
      events: [],
      nextCursor: 1,
      done: false,
    }));

    setControllerState(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnReadPollIntervalMs: 500,
            turnStreamTimeoutMs: 900_000,
          },
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
        },
      }),
    );

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning('s1');
    vi.useFakeTimers();

    const sendTurnOutcome = trackPromise(controller.sendTurn('s1', 'hello'));

    await flushHookEffects({ cycles: 1, advanceTimersMs: 899_000 });
    expect(sendTurnOutcome.isSettled()).toBe(false);

    await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
    const outcome = await sendTurnOutcome.settled;
    if (outcome.status !== 'rejected') {
      throw new Error(`Expected rejection outcome, received ${outcome.status}`);
    }
    expect(String(outcome.reason)).toContain('stream_timeout');
    expect(daemonStreamCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores non-finite or invalid streaming config values (does not short-circuit the stream loop)', async () => {
    const {
      readLocalConversationVoiceSettings,
      voiceSettingsDefaults,
    } = await import('@/sync/domains/settings/voiceSettings');
    const localConversationDefaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);

    setControllerState(() =>
      createVoiceControllerState({
        voice: {
          streaming: {
            turnReadPollIntervalMs: -10,
            turnReadMaxEvents: Number.NaN,
            turnStreamTimeoutMs: Number.NaN,
          },
        },
        sessions: {
          sys_voice: {
            id: 'sys_voice',
            modelMode: 'default',
            metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
          },
          s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
        },
      }),
    );

    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn('s1', 'hello')).resolves.toMatchObject({ assistantText: 'ok' });
    expect(daemonStreamRead).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEvents: localConversationDefaults.streaming.turnReadMaxEvents,
      }),
    );
      expect(daemonStreamCancel).toHaveBeenCalledTimes(0);
  });

  it('uses the hidden voice conversation session id when starting the daemon agent for the global agent session', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(daemonStreamStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(daemonStreamRead).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('queues the full target-session context into the first turn instead of the bootstrap prompt for hidden voice-home starts', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: connection.home.id, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
      updatedAt: 1,
    });

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        initialContext: buildVoiceInitialContext(VOICE_AGENT_GLOBAL_SESSION_ID),
      }),
    );
    expect(daemonStreamStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        message: expect.stringContaining(targetInitialContext()),
        displayMessage: 'hello',
      }),
    );
  });

  it('keeps one deferred target context across a pre-turn handle recovery', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: connection.home.id, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
      updatedAt: 1,
    });
    daemonCommit.mockRejectedValueOnce(
      Object.assign(new Error('execution_run_not_found'), { rpcErrorCode: 'execution_run_not_found' }),
    );

    const controller = createVoiceExecutionTransport();

    await controller.commit(VOICE_AGENT_GLOBAL_SESSION_ID);
    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'first turn');

    const firstPayload = String((daemonStreamStart.mock.calls[0]?.[0] as any)?.message ?? '');
    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(firstPayload.split(targetInitialContext()).slice(1)).toHaveLength(1);

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'next turn');
    const nextPayload = String((daemonStreamStart.mock.calls[1]?.[0] as any)?.message ?? '');
    expect(nextPayload).not.toContain(targetInitialContext());
  });

  it('does not requeue consumed target context when the first turn retries its handle', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: connection.home.id, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
      updatedAt: 1,
    });
    daemonStreamStart.mockRejectedValueOnce(
      Object.assign(new Error('execution_run_not_found'), { rpcErrorCode: 'execution_run_not_found' }),
    );

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'first turn');

    const retriedPayload = String((daemonStreamStart.mock.calls[1]?.[0] as any)?.message ?? '');
    expect(daemonStart).toHaveBeenCalledTimes(2);
    expect(retriedPayload.split(targetInitialContext()).slice(1)).toHaveLength(1);

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'next turn');
    const nextPayload = String((daemonStreamStart.mock.calls[2]?.[0] as any)?.message ?? '');
    expect(nextPayload).not.toContain(targetInitialContext());
  });

  it('keeps explicit attempt context without the retired eight-update Follow cap', async () => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice',
      conversationSessionAddress: { serverId: connection.home.id, sessionId: 'sys_voice' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
      updatedAt: 1,
    });

    const controller = createVoiceExecutionTransport();
    await controller.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
    for (let index = 0; index < 9; index += 1) {
      controller.appendAttemptContextUpdate(VOICE_AGENT_GLOBAL_SESSION_ID, `ORDINARY_CONTEXT_${index}`);
    }

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'first turn');

    const firstPayload = String((daemonStreamStart.mock.calls[0]?.[0] as any)?.message ?? '');
    expect(firstPayload.split(targetInitialContext()).slice(1)).toHaveLength(1);
    for (let index = 0; index < 9; index += 1) {
      expect(firstPayload).toContain(`ORDINARY_CONTEXT_${index}`);
    }

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'next turn');
    const nextPayload = String((daemonStreamStart.mock.calls[1]?.[0] as any)?.message ?? '');
    expect(nextPayload).not.toContain(targetInitialContext());
  });

  it('passes the clean user turn separately from wrapped context updates when streaming a daemon voice turn', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });

    const controller = createVoiceExecutionTransport();
    controller.appendAttemptContextUpdate(VOICE_AGENT_GLOBAL_SESSION_ID, 'Session asks what should be handled in this workspace.');

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Create the file.');

    expect(daemonStreamStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        message: expect.stringContaining('Context updates since your last voice turn'),
        displayMessage: 'Create the file.',
      }),
    );
  });

  it('recovers empty daemon streamed assistant text from the hidden session transcript when the transcript already contains the committed reply', async () => {
    const sessionState: any = {
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: { backend: 'daemon', transcript: { persistenceMode: 'persistent', epoch: 0 } },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {
        sys_voice: {
          isLoaded: true,
          messages: [],
        },
      },
    };
    setControllerState(() => sessionState);
    daemonStreamRead.mockImplementation(async () => {
      sessionState.sessionMessages.sys_voice = createSessionMessagesFixture({ isLoaded: true,
        messageIdsOldestFirst: ['m-user-1', 'm-agent-1'], messagesById: {
          'm-user-1': { kind: 'user-text', id: 'm-user-1', localId: 'voice-transcript-input', createdAt: 122, text: 'hello' },
          'm-agent-1': { kind: 'agent-text', id: 'm-agent-1', localId: null, createdAt: 123, text: 'LOCAL_HELLO' },
        },
      });
      storage.setState({ sessionMessages: sessionState.sessionMessages });
      return {
        streamId: 'stream-1',
        events: [{ t: 'done', assistantText: '', actions: [] }],
        nextCursor: 1,
        done: true,
      };
    });

    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello', {
      userTranscript: { mode: 'persist', localId: 'voice-transcript-input' },
    })).resolves.toMatchObject({
      assistantText: 'LOCAL_HELLO',
      actions: [],
    });
  });

  it('keeps the hidden voice conversation session as the global daemon anchor even when another target session is active', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      machines: {
        machine_stale: { id: 'machine_stale', active: false, metadata: { host: 'stale', happyHomeDir: '/Users/leeroy/.happier/stale' } },
        machine_active: { id: 'machine_active', active: true, metadata: { host: 'active', happyHomeDir: '/Users/leeroy/.happier/active' } },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            machineId: 'machine_active',
            path: '/Users/leeroy/.happier/active/voice-agent',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          },
        },
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: createLocallyControllableSessionMetadata({
            machineId: 'machine_active',
            path: '/Users/leeroy/Documents/Development/happier/dev',
          }),
        },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(daemonStreamStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
  });

  it('does not retry global daemon start on another session when the hidden voice conversation session rejects the payload', async () => {
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: { backend: 'daemon', transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      machines: {
        machine_active: { id: 'machine_active', active: true, metadata: { host: 'active' } },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          updatedAt: 20,
          modelMode: 'default',
          metadata: { flavor: 'claude', machineId: 'machine_active', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        },
        s_good: { id: 's_good', active: true, presence: 'online', updatedAt: 10, modelMode: 'default', metadata: { flavor: 'claude', machineId: 'machine_active' } },
      },
      sessionMessages: {},
    }));
    daemonStart.mockImplementation((async (params: any) => {
      if (params.sessionId === 'sys_voice') {
        throw Object.assign(new Error('Invalid params'), { rpcErrorCode: 'execution_run_invalid_action_input' });
      }
      return { ok: true, runId: 'm1', created: true };
    }) as any);

    const controller = createVoiceExecutionTransport();

    await expect(controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello')).rejects.toMatchObject({
      rpcErrorCode: 'execution_run_invalid_action_input',
    });

    expect(daemonStart).toHaveBeenCalledTimes(1);
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sys_voice' }));
    expect(daemonStreamStart).not.toHaveBeenCalled();
  });

  it('seeds initialContext with persisted agent transcript turns when persistence is enabled', async () => {
    await transcriptMemory.handleFetch('https://voice-streaming.example.test/v1/kv', { method: 'POST',
      body: JSON.stringify({ mutations: [{ key: VOICE_TRANSCRIPT_MEMORY_KEY, version: -1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, epoch: 3 } }),
      }] }),
    });
    // Carrier session transcript should be used to seed voice agent context across restarts.
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });
    const summaryRunner = LlmTaskRunnerConfigV1Schema.parse({ v: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'default', permissionMode: 'no_tools',
    });

    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                transcript: { persistenceMode: 'persistent', epoch: 3 },
                replay: { strategy: 'summary_plus_recent', recentMessagesCount: 16 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
        sessionReplaySummaryRunnerV1: summaryRunner,
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            voiceAgentRunV1: {
              v: 1,
              runId: 'run_prev',
              backendId: 'claude',
              resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_1' },
              updatedAtMs: 123,
              transcriptContractVersion: 2,
            },
          },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {
        sys_voice: {
          isLoaded: true,
          messages: [
            {
              kind: 'user-text',
              id: 'm1',
              localId: null,
              createdAt: 100,
              text: 'USER',
              meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
            },
            {
              kind: 'agent-text',
              id: 'm2',
              localId: null,
              createdAt: 200,
              text: 'ASSIST',
              meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'assistant', voiceAgentId: 'mid', ts: 200 } } },
            },
          ],
        },
      },
    }));

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sys_voice',
        runId: null,
        retentionPolicy: 'resumable',
        replay: expect.objectContaining({
          kind: 'voice_session.v1',
          previousSessionId: 'sys_voice',
          transcriptEpoch: 3,
          strategy: 'summary_plus_recent',
          recentMessagesCount: 16,
        }),
      }),
    );
    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({
        replay: expect.objectContaining({
          summaryRunner,
        }),
      }),
    );
    expect(daemonStart).toHaveBeenCalledWith(
      expect.not.objectContaining({
        initialContext: expect.stringContaining('USER'),
      }),
    );
  });

  it('admits provider-resume for a persistent global agent without giving ordinary streamed input recovery intent', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });

    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                resumabilityMode: 'provider_resume',
                providerResume: { fallbackToReplay: false },
                transcript: { persistenceMode: 'persistent', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: {
          id: 'sys_voice',
          active: true,
          modelMode: 'default',
          metadata: {
            flavor: 'claude',
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            agentRuntimeFacetsV1: {
              v: 1,
              transcriptSource: {
                supported: true,
                followLeaseSupported: true,
              },
            },
          },
        },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sys_voice',
      resume: true,
      retentionPolicy: 'resumable',
    }));
    expect(daemonStreamStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sys_voice',
      runId: 'm1',
      message: 'hello',
    }));
    expect(daemonStreamStart.mock.calls[0]?.[0]).not.toHaveProperty('resume');
  });

  it('fails closed and does not pass resume=true to stream_start when runtime publication does not expose transcriptSource', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });

    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                resumabilityMode: 'provider_resume',
                providerResume: { fallbackToReplay: false },
                transcript: { persistenceMode: 'persistent', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', active: true, modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sys_voice',
      resume: false,
    }));
    expect(daemonStart.mock.calls.at(-1)?.[0]).not.toHaveProperty('resumeHandle');
    expect(daemonStreamStart).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }));
  });

  it('fails closed to a fresh daemon start when provider-resume is configured but runtime publication does not expose transcriptSource for a reconciled run', async () => {
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: connection.home.id, sessionId: 's1' });
    setControllerState(() => ({
      settings: {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: true,
                turnReadPollIntervalMs: 50,
                turnReadMaxEvents: 7,
                turnStreamTimeoutMs: 1200,
              },
              agent: {
                backend: 'daemon',
                resumabilityMode: 'provider_resume',
                providerResume: { fallbackToReplay: false },
                transcript: { persistenceMode: 'persistent', epoch: 0 },
              },
              networkTimeoutMs: 15_000,
            } },
          },
        },
      },
      sessions: {
        sys_voice: { id: 'sys_voice', active: true, modelMode: 'default', metadata: { flavor: 'claude', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
        s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: createLocallyControllableSessionMetadata() },
      },
      sessionMessages: {},
    }));
    daemonRunList.mockResolvedValueOnce({
      runs: [
        ExecutionRunPublicStateSchema.parse({
          runId: 'run_reconciled',
          callId: 'call_reconciled', sidechainId: 'sidechain_reconciled',
          intent: 'voice_agent',
          status: 'running',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read-only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
          startedAtMs: 20,
        }),
      ],
    });
    daemonRunGet.mockResolvedValueOnce({
      run: ExecutionRunPublicStateSchema.parse({
        runId: 'run_reconciled',
        callId: 'call_reconciled', sidechainId: 'sidechain_reconciled',
        intent: 'voice_agent', status: 'running', startedAtMs: 20,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read-only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        transcript: { persistenceMode: 'persistent', epoch: 0 },
        resumeHandle: { kind: 'provider_session.v1', backendId: 'claude', providerSessionId: 'vs_reconciled' },
      }),
    });

    const controller = createVoiceExecutionTransport();

    await controller.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'hello');

    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sys_voice',
      runId: null,
      resume: false,
    }));
    expect(daemonStart.mock.calls.at(-1)?.[0]).not.toHaveProperty('resumeHandle');
  });
});
