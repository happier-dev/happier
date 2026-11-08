import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { ExecutionRunTurnStreamStartV2RequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { ExecutionRunEnsureOrStartResponseSchema } from '@happier-dev/protocol/execution/runs/index';

import { createSessionFixture, flushHookEffects, renderHook, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { createLocalDirectVoiceAdapter } from '@/voice/adapters/localDirect/localDirectAdapter';
import { bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner, voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { writeVoiceConversationBindingMetadata } from '@/voice/binding/voiceConversationBindingMetadata';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';

const localSearchParamsState = vi.hoisted(() => ({ current: {} as Record<string, string | string[] | undefined> }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: () => localSearchParamsState.current }).module;
});
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

type StreamRequest = ReturnType<typeof ExecutionRunTurnStreamStartV2RequestSchema.parse>;
const turns: Array<{ sessionId: string; request: StreamRequest; foreground: typeof localSearchParamsState.current }> = [];
let acceptTurn: Promise<void> | undefined;
let releaseTurnAck: (() => void) | undefined;
// Only the daemon transport is synthetic. Adapter, engine, execution transport,
// transcript acceptance and Sync pending custody run through their real owners.
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Expected canonical Voice Socket RPC request');
    }
    const separator = payload.method.indexOf(':');
    const sessionId = payload.method.slice(0, separator);
    const method = payload.method.slice(separator + 1);
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { ok: true, result: { runs: [] } };
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
      return { ok: true, result: ExecutionRunEnsureOrStartResponseSchema.parse({ ok: true, runId: 'foreground-voice-run', created: true }) };
    }
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
      turns.push({ sessionId, request: ExecutionRunTurnStreamStartV2RequestSchema.parse(payload.params), foreground: localSearchParamsState.current });
      await acceptTurn;
      return { ok: true, result: { streamId: 'foreground-turn-' + turns.length } };
    }
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
      return { ok: true, result: { streamId: 'foreground-turn-' + turns.length, events: [{ t: 'done', assistantText: '', actions: [] }], nextCursor: 1, done: true } };
    }
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return { ok: true, result: { ok: true } };
    return { ok: true, result: { ok: false, error: 'not found', errorCode: 'execution_run_not_found' } };
  });
});

let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
let serverId: string;
let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
let unsubscribeLifecycle: (() => void) | undefined;
const initialBindings = voiceSessionBindingStore.getState();
const initialStorageState = getStorage().getState();
const initialDev = (globalThis as { __DEV__?: boolean }).__DEV__;

function pendingWrites() { return home.requests.filter(request => request.method === 'POST' && /\/pending$/.test(request.path)); }
function handledWrites() { return home.requests.filter(request => request.method === 'POST' && /\/delivery\/handled$/.test(request.path)); }

async function activateAttempt(conversationSessionId: string, updatedAt = 1) {
  getStorage().setState(state => ({ sessions: { ...state.sessions,
    [conversationSessionId]: createSessionFixture({ id: conversationSessionId, serverId, active: true,
      metadata: { path: '/voice', host: 'foreground-qa', flavor: 'claude' } }),
  } }));
  bindVoiceRuntimeAttemptBinding({ binding: {
    adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    conversationSessionId, conversationSessionAddress: { serverId, sessionId: conversationSessionId },
    lifetime: 'runtime_attempt', targetSessionAddress: null, transcriptMode: 'native_session', updatedAt,
  }, owner: createVoiceRuntimeAttemptBindingOwner() });
  await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
  expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
}

async function publishAttempt(status: 'connected' | 'disconnected', mode: 'idle' | 'listening' | 'speaking' = 'idle') {
  await act(async () => {
    const owner = { controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID };
    if (status === 'disconnected') voiceConversationRuntimeMachine.transitionToDisconnected(owner);
    else if (mode === 'listening') voiceConversationRuntimeMachine.transitionToListening(owner);
    else if (mode === 'speaking') voiceConversationRuntimeMachine.transitionToSpeaking(owner);
    else voiceConversationRuntimeMachine.transitionToConnected(owner);
  });
  await flushHookEffects({ cycles: 4, turns: 4 });
}

describe('foreground Voice text-turn QA bridge', () => {
  beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    voiceConversationRuntimeMachine.reset();
    voiceSessionBindingStore.setState(initialBindings, true);
    turns.length = 0;
    acceptTurn = undefined;
    releaseTurnAck = undefined;
    localSearchParamsState.current = {};
    const { router } = await import('expo-router');
    vi.mocked(router.push).mockClear();
    vi.mocked(router.replace).mockClear();
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.pendingInput = { protocolVersion: 1 };
    for (const id of ['voice', 'voice.agent', 'execution.runs'] as const) tryWriteServerEnabledBitInPlace(features, id, true);
    const sessionHttp = createSessionMetadataHttpBoundary(() => getStorage().getState().sessions);
    home = await serveAccountHomes({ homes: [{ key: 'voice', serverUrl: 'https://foreground-voice.test', accountId: 'account-a',
      settings: { experiments: true, featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true }, voice: {
        providerId: 'local_conversation', welcome: { enabled: false },
        providers: { local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent',
          agent: { agentSource: 'session', prewarmOnConnect: false }, tts: { autoSpeakReplies: false }, streaming: { enabled: false } } } },
      } },
    }], route: createSessionReadBatchHttpBoundary(request => {
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
      if (/^\/v2\/sessions\/[^/]+\/pending$/.test(request.path)) {
        if (request.method !== 'POST') return Response.json({ pending: [], discarded: [], pendingVersion: 0 });
        const body = request.body;
        if (!body || typeof body !== 'object' || !('localId' in body) || !('requestedAction' in body) || !('deliveryMode' in body)) throw new Error('Expected canonical pending input request');
        return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId,
          deliveryStatus: { status: body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued' } } });
      }
      if (request.method === 'POST' && /\/pending\/[^/]+\/delivery\/handled$/.test(request.path)) return Response.json({});
      if (/^\/v1\/sessions\/[^/]+\/messages$/.test(request.path)) return Response.json({ messages: [], hasMore: false });
      const init = {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      };
      return sessionHttp.handle(request.url, init)
        ?? createEmptyAccountBootstrapHttpResponse(request.path, init) ?? undefined;
    }).handle });
    serverId = home.homes.voice!.id;
    await loadSyncSingletonForTests();
    const { switchConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    // Each case replaces the Account in the same live Sync singleton; cold
    // restoration is the app-entry path, not this warm fixture transition.
    await switchConnectionToActiveServer();
    disconnect = disconnectActiveServerConnection;
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    // Warm connection switches may publish before their Settings read settles.
    // Exercise the configured agent mode after its real HTTP baseline arrives.
    await waitForTestEvent(getStorage().subscribe, getStorage().getState, state =>
      state.settingsScope?.serverId === serverId
      && state.settingsScope.accountId === 'account-a' && state.settingsVersion === 1);
    home.requests.length = 0;
    registerVoiceAdapters([createLocalDirectVoiceAdapter(), createLocalConversationVoiceAdapter()]);
    lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId('local_conversation');
    unsubscribeLifecycle = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
  });

  afterEach(async () => {
    releaseTurnAck?.();
    releaseTurnAck = undefined;
    standardCleanup();
    unsubscribeLifecycle?.();
    unsubscribeLifecycle = undefined;
    await lifecycle?.dispose();
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    await disconnect?.();
    disconnect = undefined;
    await home.dispose();
    vi.restoreAllMocks();
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    voiceConversationRuntimeMachine.reset();
    getStorage().setState(initialStorageState, true);
    voiceSessionBindingStore.setState(initialBindings, true);
    localSearchParamsState.current = {};
    if (initialDev === undefined) delete (globalThis as { __DEV__?: boolean }).__DEV__;
    else (globalThis as { __DEV__?: boolean }).__DEV__ = initialDev;
  });

  it('rejects a persisted foreground binding when no local-agent attempt is active', async () => {
    const persistedBinding = { adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'persisted-voice-carrier', conversationSessionAddress: { serverId, sessionId: 'persisted-voice-carrier' },
      transcriptMode: 'native_session' as const, targetSessionAddress: null, updatedAt: 1 };
    const session = createSessionFixture({ id: persistedBinding.conversationSessionId, serverId });
    if (!session.metadata) throw new Error('Persisted Session fixture metadata unavailable');
    const metadata = session.metadata;
    getStorage().setState(state => ({ sessions: { ...state.sessions, [session.id]: { ...session,
      metadata: writeVoiceConversationBindingMetadata({ ...metadata,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) }, persistedBinding) },
    } }));
    const { dispatchForegroundVoiceTextTurnQa } = await import('./foregroundVoiceTextTurnQaBridge');
    await expect(dispatchForegroundVoiceTextTurnQa('Read the current issue')).rejects.toThrow('foreground_voice_text_turn_qa_binding_unavailable');
    expect(turns).toEqual([]);
    expect(pendingWrites()).toEqual([]);
    expect(handledWrites()).toEqual([]);
  });

  it('keeps the current Triage foreground intact while using the active local conversation text-turn port', async () => {
    const foregroundTriage = Object.freeze({ path: '/plugins/happier.triage/triage', issueTitle: 'Issue A' });
    localSearchParamsState.current = foregroundTriage;
    await activateAttempt('voice-carrier-for-triage');
    const { dispatchForegroundVoiceTextTurnQa } = await import('./foregroundVoiceTextTurnQaBridge');
    // Missing the actual conversation adapter must fail before pending custody
    // is acquired; a different registered adapter cannot receive this turn.
    registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
    await expect(dispatchForegroundVoiceTextTurnQa('Read the current issue')).rejects.toThrow('foreground_voice_text_turn_qa_adapter_unavailable');
    expect(pendingWrites()).toEqual([]);
    expect(turns).toEqual([]);
    registerVoiceAdapters([createLocalDirectVoiceAdapter(), createLocalConversationVoiceAdapter()]);
    const binding = await dispatchForegroundVoiceTextTurnQa('Read the current issue');
    expect(binding).toMatchObject({ conversationSessionId: 'voice-carrier-for-triage', conversationSessionAddress: { serverId, sessionId: 'voice-carrier-for-triage' } });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ sessionId: 'voice-carrier-for-triage', request: { message: expect.stringContaining('Read the current issue') } });
    expect(turns[0]!.foreground).toBe(foregroundTriage);
    expect(localSearchParamsState.current).toBe(foregroundTriage);
    const { router } = await import('expo-router');
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(pendingWrites()).toHaveLength(1);
    expect(pendingWrites()[0]).toMatchObject({ home: 'voice', accountId: 'account-a', path: '/v2/sessions/voice-carrier-for-triage/pending',
      body: { deliveryMode: 'external_handoff', requestedAction: { v: 1, kind: 'send_now' } } });
    const body = pendingWrites()[0]!.body;
    if (!body || typeof body !== 'object' || !('localId' in body)) throw new Error('Pending localId unavailable');
    expect(turns[0]!.request.userTranscript).toMatchObject({ localId: body.localId });
    expect(handledWrites().map(request => request.path)).toEqual(['/v2/sessions/voice-carrier-for-triage/pending/' + body.localId + '/delivery/handled']);
  });

  it('retries the same query after the active attempt starts, then dedupes by the resolved attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localSearchParamsState.current = { happier_voice_e2e_text_turn: 'Read the current issue' };
    const { useForegroundVoiceTextTurnQaBridge } = await import('./useForegroundVoiceTextTurnQaBridge');
    const hook = await renderHook(() => { useForegroundVoiceTextTurnQaBridge(); return null; });
    await flushHookEffects({ cycles: 4, turns: 4 });
    expect(turns).toEqual([]);
    await activateAttempt('voice-carrier-attempt-a');
    await publishAttempt('connected');
    expect(turns.map(turn => turn.sessionId)).toEqual(['voice-carrier-attempt-a']);
    await publishAttempt('connected');
    expect(turns).toHaveLength(1);
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
    await publishAttempt('disconnected');
    await activateAttempt('voice-carrier-attempt-b', 2);
    await publishAttempt('connected');
    expect(turns.map(turn => turn.sessionId)).toEqual(['voice-carrier-attempt-a', 'voice-carrier-attempt-b']);
    expect(pendingWrites()).toHaveLength(2);
    expect(handledWrites()).toHaveLength(2);
    await hook.unmount();
  });

  it('does not enqueue the same active-attempt query again while its first dispatch is unsettled', async () => {
    let releaseFirstDispatch!: () => void;
    acceptTurn = new Promise<void>(resolve => { releaseFirstDispatch = resolve; releaseTurnAck = resolve; });
    await activateAttempt('voice-carrier-pending-attempt');
    localSearchParamsState.current = { happier_voice_e2e_text_turn: 'Read the current issue' };
    await publishAttempt('connected');
    const { useForegroundVoiceTextTurnQaBridge } = await import('./useForegroundVoiceTextTurnQaBridge');
    const hook = await renderHook(() => { useForegroundVoiceTextTurnQaBridge(); return null; });
    await flushHookEffects({ cycles: 4, turns: 4 });
    expect(turns).toHaveLength(1);
    expect(pendingWrites()).toHaveLength(1);
    expect(handledWrites()).toEqual([]);
    await publishAttempt('connected', 'listening');
    expect(turns).toHaveLength(1);
    expect(pendingWrites()).toHaveLength(1);
    releaseFirstDispatch();
    await flushHookEffects({ cycles: 4, turns: 4 });
    await publishAttempt('connected', 'speaking');
    expect(turns).toHaveLength(1);
    expect(pendingWrites()).toHaveLength(1);
    expect(handledWrites()).toHaveLength(1);
    await hook.unmount();
  });

  it.each(['generation', 'target'] as const)('delivers the query again when the same carrier changes its %s', async change => {
    await activateAttempt('voice-carrier-reused');
    localSearchParamsState.current = { happier_voice_e2e_text_turn: 'Read the current issue' };
    await publishAttempt('connected');
    const { useForegroundVoiceTextTurnQaBridge } = await import('./useForegroundVoiceTextTurnQaBridge');
    const hook = await renderHook(() => { useForegroundVoiceTextTurnQaBridge(); return null; });
    await flushHookEffects({ cycles: 4, turns: 4 });
    expect(turns).toHaveLength(1);

    if (change === 'generation') {
      // A newly admitted attempt can reuse all public binding fields.
      await activateAttempt('voice-carrier-reused');
    } else {
      const store = voiceSessionBindingStore.getState();
      const binding = store.runtimeBindingsByConversationSessionId['voice-carrier-reused'];
      if (!binding) throw new Error('Expected the admitted runtime binding');
      store.bind({ ...binding, targetSessionAddress: { serverId, sessionId: 'new-target' } });
    }
    await publishAttempt('connected', 'listening');
    expect(turns).toHaveLength(2);
    await publishAttempt('connected', 'speaking');
    expect(turns).toHaveLength(2);
    expect(pendingWrites()).toHaveLength(2);
    expect(handledWrites()).toHaveLength(2);
    await hook.unmount();
  });
});
