import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import React from 'react';
import 'fake-indexeddb/auto';
import { DEFAULT_SESSION_CAPABILITIES } from '@happier-dev/protocol';
import { MetadataSchema } from '@happier-dev/session-core/state';
import renderer, { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPreferredLanguageFromSettings, t } from '@/text';

import { storage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { settingsParse } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
  writeVoiceProviderSettingsConfig,
} from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { resetVoiceQaStoreForTests, useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import {
  flushHookEffects,
  pressTestInstanceAsync,
  renderScreen as renderTestScreen,
  standardCleanup,
  createSessionFixture,
  createSessionListRenderableSessionFixture,
  createSessionMessagesFixture,
  createMachineFixture,
  createDeferred,
  waitForTestEvent,
} from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
  getVoiceQaOutputTapSnapshot,
  resetVoiceQaOutputTapForTests,
} from '@/voice/qa/voiceQaOutputTap';
import { daemonSpeechStreamDiagnostics } from '@/voice/runtime/daemonInference/daemonSpeechStreamDiagnostics';
import {
  clearMachineRpcPeerMediationReceiptsForTest,
  recordMachineRpcPeerMediationReceipt,
} from '@/sync/domains/machines/peer/mediation/rpc/receiptLog';

// Only vendor/native/network boundaries are replaced; the generated contribution,
// adapter assembly, lifecycle, QA controllers and persistence owners stay real.
const sdk = vi.hoisted(() => ({ startSession: vi.fn(), endSession: vi.fn(), sendUserMessage: vi.fn(), sendContextualUpdate: vi.fn() }));
// Browser-reported device locale is external; translation lookup and locale state stay real.
vi.hoisted(() => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, language: 'en-US', languages: ['en-US'] });
});
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));
const expoRouterMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
type DaemonRpcRequest = Readonly<{ machineId: string; method: string; payload: Record<string, unknown> }>;
const daemonRpcRequests: DaemonRpcRequest[] = [];
let transcriptionError: string | null = null;
let heldTranscription: Promise<unknown> | null = null;
let transcriptionStarted = createDeferred<void>();
let assembly: Awaited<ReturnType<typeof import('@/dev/testkit/harness/builtinVoiceAdapters').createBuiltinVoiceAdapterAssembly>> | null = null;
let lifecycle: ReturnType<typeof import('@/voice/session/voiceSessionLifecycleController').createVoiceSessionLifecycleController> | null = null;
let unsubscribeLifecycle: (() => void) | null = null;
const pendingWrites: Array<Readonly<{ sessionId: string; body: Record<string, unknown> }>> = [];
const pendingRows = new Map<string, Readonly<{ sessionId: string; row: Record<string, unknown> }>>();
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const homeSessions: Record<string, ReturnType<typeof createSessionFixture>> = {};
const recordingBytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]);
const uploadedRecording = new File([recordingBytes], 'recording.wav', { type: 'audio/wav' });
const transcribeRequests = () => daemonRpcRequests.filter(request => request.method === 'daemon.voiceInference.stt.transcribe');

installDisconnectedServerSocketBoundary(socket => {
  socket.connect = vi.fn<typeof socket.connect>(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, rawPayload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    const request = rawPayload as Readonly<{ method: string; params: Record<string, unknown> }>;
    const separator = request.method.indexOf(':');
    const machineId = request.method.slice(0, separator);
    const method = request.method.slice(separator + 1);
    daemonRpcRequests.push({ machineId, method, payload: request.params });
    let result: unknown;
    if (method === 'daemon.voiceInference.stt.upload.init') {
      result = { success: true, uploadId: 'qa-upload', chunkSizeBytes: 1024,
        recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64 };
    } else if (method === 'daemon.voiceInference.stt.upload.chunk') {
      result = { success: true };
    } else if (method === 'daemon.voiceInference.stt.upload.finalize') {
      result = { success: true, uploadId: 'qa-upload', path: '/tmp/qa-recording.wav',
        sizeBytes: recordingBytes.byteLength, sha256: 'qa-recording' };
    } else if (method === 'daemon.voiceInference.stt.transcribe') {
      transcriptionStarted.resolve();
      result = heldTranscription ? await heldTranscription
        : transcriptionError ? { ok: false, errorCode: 'internal_error', error: transcriptionError }
        : { ok: true, requestId: request.params.requestId, text: 'hello explicit daemon stt',
          language: 'en', modelPackId: 'daemon-pack' };
    } else if (method === 'daemon.voiceInference.stt.cancel' || method === 'daemon.voiceInference.stt.upload.abort') {
      result = method.endsWith('.abort') ? { success: true } : { ok: true };
    } else {
      return { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' };
    }
    return { ok: true, result };
  });
});

async function prepareDaemonAudioQa(allowedPorts: number[] = []) {
  await loadSyncSingletonForTests();
  const sessionHttp = createSessionMetadataHttpBoundary(() => homeSessions);
  const answerRequest = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const requestedUrl = new URL(String(url));
    const path = requestedUrl.pathname;
    if (requestedUrl.protocol === 'blob:') return new Response(uploadedRecording);
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path === '/v1/features') {
      const features = createRootLayoutFeaturesResponse({
        features: { voice: { enabled: true } },
        capabilities: { session: { ...DEFAULT_SESSION_CAPABILITIES, pendingInput: { protocolVersion: 4 } } },
      });
      features.features.machines.liveStream.serverRouted.enabled = true;
      features.capabilities.machines.liveStream.serverRouted = { caps: {}, disabledReason: null };
      features.capabilities.machines.tunnel.directPeer.allowedPorts = allowedPorts;
      return Response.json(features);
    }
    const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
    if (preparation) return preparation;
    const sessionResponse = sessionHttp.handle(url, init);
    if (sessionResponse) return sessionResponse;
    if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'hosted-token',
      leaseId: 'qa-lease', bindingNonce: 'qa-nonce', expiresAtMs: Date.now() + 60_000 });
    if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
    const pendingPath = /^\/v2\/sessions\/([^/]+)\/pending$/u.exec(path);
    if (pendingPath && init?.method === 'POST') {
      const body: Record<string, unknown> = JSON.parse(String(init.body));
      const sessionId = decodeURIComponent(pendingPath[1]);
      pendingWrites.push({ sessionId, body });
      const row = { localId: body.localId, content: body.content, messageRole: body.messageRole,
        status: 'queued', deliveryStatus: { status: 'external_handoff' },
        position: 0, createdAt: Date.now(), updatedAt: Date.now(), discardedAt: null, discardedReason: null };
      pendingRows.set(String(body.localId), { sessionId, row });
      return Response.json({ didWrite: true, requestedAction: body.requestedAction,
        pending: row, pendingCount: 1, pendingVersion: 1 });
    }
    const handledPath = /^\/v2\/sessions\/([^/]+)\/pending\/([^/]+)\/delivery\/handled$/u.exec(path);
    if (handledPath && init?.method === 'POST') {
      pendingRows.delete(decodeURIComponent(handledPath[2]));
      return Response.json({});
    }
    if (pendingPath) {
      const pending = [...pendingRows.values()]
        .filter(value => value.sessionId === decodeURIComponent(pendingPath[1])).map(value => value.row);
      return Response.json({ pending, discarded: [], pendingCount: pending.length, pendingVersion: 1 });
    }
    if (/^\/v2\/sessions\/[^/]+\/messages$/u.test(path)) return Response.json({ messages: [], hasMore: false });
    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
    if (path === '/v2/account/settings') return Response.json({ version: 1,
      content: { t: 'plain', v: storage.getState().settings } });
    if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
      id => createPlainMachineRowFixture({ id, accountId: 'voice-qa-account' }));
    if (path.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
      id: decodeURIComponent(path.slice('/v1/machines/'.length)), accountId: 'voice-qa-account',
    }) });
    return new Response('{}', { status: 404 });
  };
  const sessionReadResponse = createSessionReadBatchFetchBoundary(answerRequest);
  account = await restoreServerAccountForTest({
    serverUrl: 'https://voice-qa.example.test', accountId: 'voice-qa-account', credentialScope: 'restored-home',
    request: sessionReadResponse,
  });
  const { sync } = await import('@/sync/sync');
  await sync.resumeSync('manual');
  setRuntimeFetch(async (url, init) => await sessionReadResponse(url, init) ?? new Response('{}', { status: 404 }));
}


async function prepareRealtimeQa(targetSessionId: string) {
  await prepareDaemonAudioQa();
  expoRouterMock.state.router.setParams({ voiceQaServerId: account!.home.id });
  const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
  if (!entry || !entry.declaration.settings) throw new Error('Missing declared ElevenLabs Voice contribution');
  expect(await TokenStorage.getCredentials()).toEqual(account!.credentials);
  sdk.endSession.mockReset().mockResolvedValue(undefined);
  sdk.startSession.mockReset().mockResolvedValue({
    endSession: sdk.endSession, setMicMuted() {}, setVolume() {},
    sendUserMessage: sdk.sendUserMessage, sendContextualUpdate: sdk.sendContextualUpdate,
    getId: () => 'voice-qa-provider-conversation',
  });
  const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, entry.providerId,
    Object.fromEntries(entry.declaration.settings.fields.map(field => [field.id, field.default])));
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta(
    { voice: { ...voice, providerId: entry.providerId } }, storage.getState().settings,
  ));
  homeSessions[targetSessionId] = createSessionFixture({ id: targetSessionId,
    serverId: account!.home.id, encryptionMode: 'plain', active: false,
    metadata: { path: '/target', host: 'test' } });
  storage.getState().applySessions(Object.values(homeSessions));
  const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
  const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
  const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
  voiceConversationRuntimeMachine.reset();
  assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
  registerVoiceAdapters(assembly.adapters);
  voiceSessionBindingStore.getState().bind({
    adapterId: entry.providerId, controlSessionId: targetSessionId, conversationSessionId: targetSessionId,
    conversationSessionAddress: { serverId: account!.home.id, sessionId: targetSessionId },
    targetSessionAddress: { serverId: account!.home.id, sessionId: targetSessionId },
    lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: Date.now(),
  });
  const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
  const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
  lifecycle = createVoiceSessionLifecycleController();
  setVoiceSessionLifecycleController(lifecycle);
  lifecycle.setConfiguredProviderId(entry.providerId);
  unsubscribeLifecycle = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle!.getSnapshot()));
}

class BrowserFixtureAudio {
  static instances: BrowserFixtureAudio[] = [];
  static playbackStarted = createDeferred<void>();
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly play = vi.fn(async () => { BrowserFixtureAudio.playbackStarted.resolve(); });
  readonly pause = vi.fn(() => undefined);
  constructor(readonly url: string) {
    BrowserFixtureAudio.instances.push(this);
  }
}
const fixtureFetches: string[] = [];
const emptySessionMetadata = MetadataSchema.parse({});

function prepareOutputPlaybackQa() {
  BrowserFixtureAudio.instances.length = 0;
  BrowserFixtureAudio.playbackStarted = createDeferred<void>();
  fixtureFetches.length = 0;
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', undefined);
  vi.stubGlobal('Audio', BrowserFixtureAudio);
  setRuntimeFetch(async url => {
    fixtureFetches.push(String(url));
    return new Response(recordingBytes, { headers: { 'content-type': 'audio/wav' } });
  });
}

async function renderScreen(element: React.ReactElement) {
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  return await renderTestScreen(
    <InjectedAuthProvider credentials={account?.credentials ?? { token: 'voice-qa-token', secret: 'voice-qa-secret' }}>
      {element}
    </InjectedAuthProvider>,
  );
}

// Observe actual Start settlement; the containing test owns the time budget.
async function waitForQaStart() {
  const state = await waitForTestEvent(useVoiceQaStore.subscribe, useVoiceQaStore.getState,
    state => state.status === 'running' || state.status === 'error');
  if (state.status === 'error') throw new Error('voice_qa_start_failed');
}

// Hoist framework boundaries before storage's import graph reaches real media owners.
vi.mock('react-native', async () => (
  await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (
  await import('@/dev/testkit/mocks/unistyles')
).createUnistylesMock());
vi.mock('expo-router', () => expoRouterMock.module);

describe('VoiceQaScreen', () => {
  const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

  beforeEach(() => {
    setPreferredLanguageFromSettings('en');
    process.env.EXPO_PUBLIC_DEBUG = '1';
    resetVoiceQaOutputTapForTests();
    clearMachineRpcPeerMediationReceiptsForTest();
    vi.clearAllMocks();
    expoRouterMock.state.router.setParams({
      voiceQaSessionId: undefined,
      voiceQaServerId: undefined,
      voiceQaMode: undefined,
      voiceQaTransportRoute: undefined,
      voiceQaOutputCapture: undefined,
      voiceQaOutputFixtureUrl: undefined,
      voiceQaOutputCancelMs: undefined,
      voiceQaRecordedAudioDaemonSttPackId: undefined,
      voiceQaRecordedAudioDaemonMachineId: undefined,
      voiceQaRecordedAudioDaemonBasePath: undefined,
    });
    daemonRpcRequests.length = 0;
    pendingWrites.length = 0;
    pendingRows.clear();
    for (const sessionId of Object.keys(homeSessions)) delete homeSessions[sessionId];
    transcriptionError = null;
    heldTranscription = null;
    transcriptionStarted = createDeferred<void>();
    resetVoiceQaStoreForTests();
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getState(),
      runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {},
      bindingsByConversationSessionId: {},
    });
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    const voice = voiceSettingsParse({
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { conversationMode: 'agent' },
        },
      },
    });
    storage.setState({
      settings: settingsParse({
        ...(storage.getState()).settings,
        voiceSettingsV1: voice,
        voice,
      }),
        sessionMessages: {},
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:voice-qa-recording');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(async () => {
    if (assembly) {
      const { voiceQaController } = await import('@/voice/qa/voiceQaController');
      await voiceQaController.stop();
      await lifecycle?.dispose();
      unsubscribeLifecycle?.();
      unsubscribeLifecycle = null;
      lifecycle = null;
      await assembly.dispose();
      assembly = null;
      const { resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
      const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
      resetVoiceAdapterRegistryForTests();
      setVoiceSessionLifecycleController(null);
    }
    const { voiceQaOutputFixturePlayback } = await import('@/voice/qa/voiceQaOutputFixturePlayback');
    voiceQaOutputFixturePlayback.stop();
    await account?.dispose();
    account = null;
    vi.useRealTimers();
    process.env.EXPO_PUBLIC_DEBUG = originalDebug;
    resetVoiceQaOutputTapForTests();
    clearMachineRpcPeerMediationReceiptsForTest();
    standardCleanup();
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  afterAll(() => {
    setPreferredLanguageFromSettings(null);
    vi.unstubAllGlobals();
  });

  it('renders without re-render loops when there is no active QA session yet', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const texts = tree.findAll((node) => String(node.type) === 'Text').map((node) => String(node.props.children));
    expect(texts).toContain(t('devVoiceQa.title'));
    expect(useVoiceQaStore.getState().status).toBe('idle');
    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    expect(items.find((node) => node.props.title === t('devVoiceQa.targetSession'))?.props.detail)
      .toBe(t('voiceSurface.noTarget'));
    expect(items.find((node) => node.props.title === t('devVoiceQa.runtimeSession'))?.props.detail)
      .toBe(t('common.none'));
    const mediaSnapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.media.snapshot').props.children,
    ));
    expect(mediaSnapshot).toMatchObject({
      status: 'disconnected',
      configuredProviderId: 'local_conversation',
      machineControlPortAuthorized: false,
      directLoopbackEndpointReady: false,
      accountProfileReady: false,
      activeServerSocketReady: false,
      serverRoute: {
        activeServerId: expect.any(String),
        activeServerUrl: expect.any(String),
        rpcDirectPeerEnabled: null,
      },
      machineRpcReceipts: [],
    });
  });

  it('uses the applied Home daemon port instead of stale machine-list diagnostics', async () => {
    await prepareDaemonAudioQa([39001]);
    const serverId = account!.home.id;
    const machine = createMachineFixture({ id: 'qa-voice-machine', activeAt: Date.now(), daemonState: { httpPort: 39001 } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
      voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId: machine.id } },
    }, storage.getState().settings));
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [{ ...machine, daemonState: null }] } });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const screen = await renderScreen(<VoiceQaScreen />);
    const snapshot = () => JSON.parse(String(screen.findByTestId('voiceQa.media.snapshot')!.props.children));
    expect(snapshot()).toMatchObject({ executionMachineId: machine.id, machineControlPortAuthorized: true });
    await act(async () => {
      storage.setState({ machines: { [machine.id]: { ...machine, daemonState: null } }, machineListByServerId: { [serverId]: [machine] } });
    });
    expect(snapshot().machineControlPortAuthorized).toBe(false);
  });

  it('projects bounded voice machine-RPC routing receipts into dev QA evidence', async () => {
    recordMachineRpcPeerMediationReceipt({
      receipt: 'machine_rpc_fell_back_to_server',
      method: 'daemon.voice.speech.transcribe.upload.init',
      reasonCode: 'loopback_unavailable',
      requestId: 'rpc-qa-1',
    });
    recordMachineRpcPeerMediationReceipt({
      receipt: 'machine_rpc_fell_back_to_server',
      method: 'daemon.unrelated.operation',
      reasonCode: 'not-relevant',
    });

    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const { tree } = await renderScreen(<VoiceQaScreen />);
    const snapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.media.snapshot').props.children,
    ));

    expect(snapshot.machineRpcReceipts).toEqual([{
      receipt: 'machine_rpc_fell_back_to_server',
      method: 'daemon.voice.speech.transcribe.upload.init',
      reasonCode: 'loopback_unavailable',
      requestId: 'rpc-qa-1',
    }]);
  });

  it('surfaces live daemon streaming transport diagnostics for QA evidence', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = daemonSpeechStreamDiagnostics.snapshot().jsonRpcCompatibilitySelections;
    const { tree } = await renderScreen(<VoiceQaScreen />);

    await act(async () => {
      daemonSpeechStreamDiagnostics.record({
        sessionId: `qa-compat-${before}`,
        machineId: 'machine-qa',
        transport: 'json_rpc_compat',
      });
    });

    const snapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.daemonSpeechTransport.snapshot').props.children,
    ));
    expect(snapshot.jsonRpcCompatibilitySelections).toBe(before + 1);
    expect(snapshot.lastTransport).toBe('json_rpc_compat');
    warn.mockRestore();
  });

  it('reacts to voice session binding updates and shows the open-conversation button', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    expect(tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation')).toHaveLength(0);

    await act(async () => {
      voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        conversationSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_1' },
        lifetime: 'runtime_attempt',
        targetSessionAddress: null,
        transcriptMode: 'synthetic',
        updatedAt: Date.now(),
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    const openConversationNodes = tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation');
    expect(openConversationNodes.length).toBeGreaterThan(0);
    const mediaSnapshot = JSON.parse(String(
      tree.find((node) => String(node.props?.testID) === 'voiceQa.media.snapshot').props.children,
    ));
    expect(mediaSnapshot.runtimeSessionId).toBe('voice_session_1');
  });

  it('refreshes persisted voice binding metadata into the QA surface after render', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    expect(tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation')).toHaveLength(0);

    await act(async () => {
      storage.setState({
        ...(storage.getState()),
        sessions: {
          ...((storage.getState()).sessions ?? {}),
          target_s1: createSessionFixture({
            id: 'target_s1',
            updatedAt: 5,
            metadata: {
              ...emptySessionMetadata,
              name: 'target_s1',
            },
          }),
          voice_session_1: createSessionFixture({
            id: 'voice_session_1',
            serverId: getActiveServerSnapshot().serverId,
            updatedAt: 10,
            metadata: {
              ...emptySessionMetadata,
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              voiceConversationBindingV1: {
                v: 1,
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                transcriptMode: 'native_session',
                targetSessionId: 'target_s1',
                targetServerId: getActiveServerSnapshot().serverId,
                updatedAt: 100,
              },
            },
          }),
        },
      });
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    const openConversationNodes = tree.findAll((node) => String(node.props?.testID) === 'voiceQa.openConversation');
    expect(openConversationNodes.length).toBeGreaterThan(0);

    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    const runtimeItem = items.find((node) => node.props.title === t('devVoiceQa.runtimeSession'));
    expect(runtimeItem?.props.detail).toBe(t('devVoiceQa.runtimeSession'));
  });

  it('shows the bound target session and hidden conversation session for local voice QA', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        conversationSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_1' },
        targetSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'target_s1' },
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
    });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    const targetItem = items.find((node) => node.props.title === t('devVoiceQa.targetSession'));
    const runtimeItem = items.find((node) => node.props.title === t('devVoiceQa.runtimeSession'));

    expect(targetItem?.props.detail).toBe(t('devVoiceQa.targetSession'));
    expect(runtimeItem?.props.detail).toBe(t('devVoiceQa.runtimeSession'));
  });

  it('falls back to generic human labels when session metadata only contains raw ids', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    storage.setState({
        ...(storage.getState()),
        sessions: {
            ...((storage.getState()).sessions ?? {}),
            target_s1: createSessionFixture({
                id: 'target_s1',
                serverId: getActiveServerSnapshot().serverId,
                metadata: {
                  ...emptySessionMetadata,
                    name: 'target_s1',
                },
            }),
            voice_session_1: createSessionFixture({
                id: 'voice_session_1',
                serverId: getActiveServerSnapshot().serverId,
                metadata: {
                  ...emptySessionMetadata,
                    name: 'voice_session_1',
                },
            }),
        },
    });
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_1',
        conversationSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_1' },
        targetSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'target_s1' },
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
    });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    const targetItem = items.find((node) => node.props.title === t('devVoiceQa.targetSession'));
    const runtimeItem = items.find((node) => node.props.title === t('devVoiceQa.runtimeSession'));

    expect(targetItem?.props.detail).toBe(t('devVoiceQa.targetSession'));
    expect(runtimeItem?.props.detail).toBe(t('devVoiceQa.runtimeSession'));
  });

  it('prefers the active QA target and runtime session details over drifting global bindings', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.setState((state) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        status: 'running',
        targetSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'target_s1' },
        runtimeSessionId: 'voice_session_1',
    }));
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_2' });
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice_session_2',
        conversationSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_2' },
        targetSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_2' },
        transcriptMode: 'native_session',
        updatedAt: Date.now(),
    });
    setVoiceSessionSnapshot({
        adapterId: 'local_conversation',
        sessionId: 'voice_session_2',
        status: 'connected',
        mode: 'thinking',
        canStop: true,
    });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    const targetItem = items.find((node) => node.props.title === t('devVoiceQa.targetSession'));
    const runtimeItem = items.find((node) => node.props.title === t('devVoiceQa.runtimeSession'));

    expect(targetItem?.props.detail).toBe(t('devVoiceQa.targetSession'));
    expect(runtimeItem?.props.detail).toBe(t('devVoiceQa.runtimeSession'));
  });

  it('uses the translated voice-agent label for the global sentinel', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.setState((state) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        targetSessionAddress: null,
        status: 'running',
    }));
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    const targetItem = items.find((node) => node.props.title === t('devVoiceQa.targetSession'));

    expect(targetItem?.props.detail).toBe(t('voiceActivity.format.voiceAgent'));
  });

  it('replaces the global voice sentinel with the active target session label', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    storage.setState((state) => ({
        settings: {
            ...state.settings,
            voice: {
                ...state.settings?.voice,
                privacy: {
                    ...state.settings?.voice?.privacy,
                    shareSessionSummary: true,
                },
            },
        },
        sessions: {
            ...(state.sessions ?? {}),
            s_current: createSessionFixture({
                id: 's_current',
                serverId: getActiveServerSnapshot().serverId,
                metadata: {
                  ...emptySessionMetadata,
                    summaryText: 'Session QA Voice Matrix',
                },
            }),
            hidden_voice_conversation: createSessionFixture({
                id: 'hidden_voice_conversation',
                serverId: getActiveServerSnapshot().serverId,
                metadata: {
                  ...emptySessionMetadata,
                    name: 'voice-agent',
                },
            }),
        },
    }));
    useVoiceQaStore.setState((state) => ({
        ...state,
        provider: 'local_voice_agent',
        sessionId: '__voice_agent__',
        targetSessionAddress: null,
        runtimeSessionId: 'hidden_voice_conversation',
        status: 'running',
    }));
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: getActiveServerSnapshot().serverId, sessionId: 's_current' });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const items = tree.findAll((node) => 'title' in node.props && 'detail' in node.props);
    const targetItem = items.find((node) => node.props.title === t('devVoiceQa.targetSession'));
    const runtimeItem = items.find((node) => node.props.title === t('devVoiceQa.runtimeSession'));

    expect(targetItem?.props.detail).toBe('Session QA Voice Matrix');
    expect(runtimeItem?.props.detail).toBe('voice-agent');
  });

  it('keeps stable target and runtime labels privacy-safe across preferred-metadata lifecycles', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const targetSessionId = 'stable_target';
    const runtimeSessionId = 'stable_runtime';
    const serverId = 'voice-qa-label-server';
    const runtimeServerId = getActiveServerSnapshot().serverId;

    storage.setState((state): Partial<StorageState> => ({
      settings: {
        ...state.settings,
        voice: {
          ...state.settings?.voice,
          privacy: {
            ...state.settings?.voice?.privacy,
            shareSessionSummary: false,
            shareFilePaths: false,
          },
        },
      },
      sessions: {
        ...(state.sessions ?? {}),
        [targetSessionId]: createSessionFixture({
          id: targetSessionId,
          serverId,
          presence: 1,
          metadata: {
            ...emptySessionMetadata,
            summaryText: 'Raw private target summary',
            path: '/Users/alice/raw-private-target',
          },
        }),
        [runtimeSessionId]: createSessionFixture({
          id: runtimeSessionId,
          serverId: runtimeServerId,
          presence: 1,
          metadata: {
            ...emptySessionMetadata,
            name: runtimeSessionId,
          },
        }),
      },
      sessionListRowsByServerId: { [serverId]: {
        ...(state.sessionListRowsByServerId?.[serverId] ?? {}),
        [targetSessionId]: createSessionListRenderableSessionFixture({
          id: targetSessionId,
          metadata: {
            ...emptySessionMetadata,
            summaryText: 'Preferred private target summary',
            path: '/Users/alice/preferred-private-target',
          },
        }),
      }, [runtimeServerId]: {
        [runtimeSessionId]: createSessionListRenderableSessionFixture({
          id: runtimeSessionId,
          metadata: {
            ...emptySessionMetadata,
            name: 'Preferred runtime label',
            path: '',
          },
        }),
      },
      },
      sessionListIndexByServerId: {
        ...(state.sessionListIndexByServerId ?? {}),
        [serverId]: [
          { type: 'session' as const, sessionId: targetSessionId, serverId, serverName: 'Voice QA labels' },
        ],
        [runtimeServerId]: [
          { type: 'session' as const, sessionId: runtimeSessionId, serverId: runtimeServerId, serverName: 'Voice runtime' },
        ],
      },
      concurrentSessionListCacheByServerId: {},
    }));
    useVoiceQaStore.setState((state) => ({
      ...state,
      provider: 'local_voice_agent',
      sessionId: '__voice_agent__',
      targetSessionAddress: { serverId, sessionId: targetSessionId },
      runtimeSessionId,
      status: 'running',
    }));

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const readLabel = (title: string) => tree
      .findAll((node) => 'title' in node.props && 'detail' in node.props)
      .find((node) => node.props.title === title)
      ?.props.detail;

    expect(readLabel(t('devVoiceQa.targetSession'))).toBe(t('devVoiceQa.targetSession'));
    expect(readLabel(t('devVoiceQa.runtimeSession'))).toBe(t('devVoiceQa.runtimeSession'));

    await act(async () => {
      storage.setState((state): Partial<StorageState> => ({
        sessionListRowsByServerId: { [serverId]: {
          ...state.sessionListRowsByServerId?.[serverId],
          [targetSessionId]: {
            ...createSessionListRenderableSessionFixture(state.sessionListRowsByServerId?.[serverId]?.[targetSessionId]),
            metadata: {
              ...emptySessionMetadata,
              name: 'Updated offline target label',
              summaryText: 'Updated preferred target summary',
              path: '/Users/alice/updated-private-target',
            },
          },
        }, [runtimeServerId]: {
          [runtimeSessionId]: {
            ...createSessionListRenderableSessionFixture(state.sessionListRowsByServerId?.[runtimeServerId]?.[runtimeSessionId]),
            metadata: {
              ...emptySessionMetadata,
              name: 'Updated runtime label',
              summaryText: 'Updated preferred runtime summary',
            },
          },
        } },
      }));
    });
    expect(readLabel(t('devVoiceQa.targetSession'))).toBe(t('devVoiceQa.targetSession'));
    expect(readLabel(t('devVoiceQa.runtimeSession'))).toBe(t('devVoiceQa.runtimeSession'));

    await act(async () => {
      storage.setState((state) => ({
        settings: {
          ...state.settings,
          voice: {
            ...state.settings.voice,
            privacy: {
              ...state.settings.voice?.privacy,
              shareSessionSummary: true,
              shareFilePaths: false,
            },
          },
        },
      }));
    });
    expect(readLabel(t('devVoiceQa.targetSession'))).toBe('Updated preferred target summary');
    expect(readLabel(t('devVoiceQa.runtimeSession'))).toBe('Updated preferred runtime summary');

    await act(async () => {
      storage.setState((state) => {
        const serverRows = { ...state.sessionListRowsByServerId?.[serverId] };
        delete serverRows[targetSessionId];
        delete serverRows[runtimeSessionId];
        return {
          sessions: {
            ...state.sessions,
            [targetSessionId]: {
              ...state.sessions[targetSessionId],
              presence: 1,
              metadata: { ...emptySessionMetadata, name: 'Raw offline target label' },
            },
            [runtimeSessionId]: {
              ...state.sessions[runtimeSessionId],
              presence: 1,
              metadata: { ...emptySessionMetadata, name: 'Raw offline runtime label' },
            },
          },
          sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [serverId]: serverRows, [runtimeServerId]: {} },
        };
      });
    });
    expect(readLabel(t('devVoiceQa.targetSession'))).toBe('Raw offline target label');
    expect(readLabel(t('devVoiceQa.runtimeSession'))).toBe('Raw offline runtime label');

    await act(async () => {
      storage.setState((state) => ({
        settings: {
          ...state.settings,
          voice: {
            ...state.settings.voice,
            privacy: {
              ...state.settings.voice?.privacy,
              shareSessionSummary: false,
              shareFilePaths: false,
            },
          },
        },
      }));
    });
    expect(readLabel(t('devVoiceQa.targetSession'))).toBe(t('devVoiceQa.targetSession'));
    expect(readLabel(t('devVoiceQa.runtimeSession'))).toBe(t('devVoiceQa.runtimeSession'));

    await act(async () => {
      storage.setState((state) => {
        const sessions = { ...state.sessions };
        delete sessions[targetSessionId];
        delete sessions[runtimeSessionId];
        return { sessions };
      });
    });
    expect(readLabel(t('devVoiceQa.targetSession'))).toBe(t('devVoiceQa.targetSession'));
    expect(readLabel(t('devVoiceQa.runtimeSession'))).toBe(t('devVoiceQa.runtimeSession'));
  });

  it('uses the latest session id when start is pressed before the button rerenders', async () => {
    await prepareRealtimeQa('session_latest');
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_latest');
      await pressTestInstanceAsync(startButton);
    });

    await waitForQaStart();
    const state = useVoiceQaStore.getState();
    expect({ status: state.status,
      errors: state.entries.filter(entry => entry.kind === 'error').map(entry => entry.text),
      adapter: assembly!.adapters[0].getSnapshot(), sdkStarts: sdk.startSession.mock.calls.length,
    }).toMatchObject({ status: 'running', errors: [], adapter: { status: 'connected' }, sdkStarts: 1 });
    expect(useVoiceQaStore.getState()).toMatchObject({ status: 'running',
      targetSessionAddress: { serverId: account!.home.id, sessionId: 'session_latest' } });
    expect(sdk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      overrides: expect.objectContaining({ conversation: { textOnly: true } }),
    }));
  });

  it('uses the explicit dev-route media mode while preserving the normal start control', async () => {
    await prepareRealtimeQa('session_media');
    expoRouterMock.state.router.setParams({ voiceQaMode: 'media' });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_media');
      await pressTestInstanceAsync(startButton);
    });

    await waitForQaStart();
    expect(useVoiceQaStore.getState().status).toBe('running');
    expect(useVoiceQaStore.getState()).toMatchObject({ status: 'running',
      targetSessionAddress: { serverId: account!.home.id, sessionId: 'session_media' } });
    expect(lifecycle!.getSnapshot().status).toBe('connected');
    expect(sdk.startSession).toHaveBeenCalledWith(expect.objectContaining({
      overrides: expect.objectContaining({ conversation: { textOnly: false } }),
    }));
  });

  it('refuses Start when the actual provider registration is withdrawn', async () => {
    await prepareRealtimeQa('session_withdrawn');
    await assembly!.dispose();
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([]);
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    await act(async () => {
      tree.changeTextByTestId('voiceQa.sessionIdInput', 'session_withdrawn');
      await tree.pressByTestIdAsync('voiceQa.start');
    });
    await waitForTestEvent(useVoiceQaStore.subscribe, useVoiceQaStore.getState, state => state.status === 'error');
    expect(useVoiceQaStore.getState().status).toBe('error');
    expect(useVoiceQaStore.getState().entries.filter(entry => entry.kind === 'error').map(entry => entry.text))
      .toContain('realtime_voice_session_not_registered');
    expect(sdk.startSession).not.toHaveBeenCalled();
  });

  it('passes the explicit dev-route server-relay requirement to the media attempt', async () => {
    await prepareRealtimeQa('session_relay');
    expoRouterMock.state.router.setParams({
      voiceQaMode: 'media',
      voiceQaTransportRoute: 'server_relay',
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');

    await act(async () => {
      sessionInput.props.onChangeText('session_relay');
      await pressTestInstanceAsync(startButton);
    });

    await waitForQaStart();
    expect(useVoiceQaStore.getState().status).toBe('running');
    expect(useVoiceQaStore.getState()).toMatchObject({ status: 'running',
      targetSessionAddress: { serverId: account!.home.id, sessionId: 'session_relay' } });
    const { readDaemonSpeechStreamQaRouteRequirement } = await import('@/voice/runtime/daemonInference/daemonSpeechStreamQaRouteRequirement');
    expect(readDaemonSpeechStreamQaRouteRequirement('session_relay')).toBe('server_relay');
    expect(readDaemonSpeechStreamQaRouteRequirement('another-session')).toBeNull();
    await pressTestInstanceAsync(tree.find(node => node.props.testID === 'voiceQa.stop'));
    expect(readDaemonSpeechStreamQaRouteRequirement('session_relay')).toBeNull();
  });

  it('enables bounded output evidence and plays a route fixture from a user gesture through the QA playback owner', async () => {
    prepareOutputPlaybackQa();
    expoRouterMock.state.router.setParams({
      voiceQaOutputCapture: '1',
      voiceQaOutputFixtureUrl: 'https://fixtures.invalid/output.wav',
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const rendered = await renderScreen(<VoiceQaScreen />);

    await flushHookEffects({ cycles: 2, turns: 2 });
    expect(fixtureFetches).toEqual([]);
    const playFixtureButton = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.playFixture',
    );
    await pressTestInstanceAsync(playFixtureButton);
    await BrowserFixtureAudio.playbackStarted.promise;
    expect({
      errors: useVoiceQaStore.getState().entries.filter(entry => entry.kind === 'error').map(entry => entry.text),
      fetches: fixtureFetches,
      audioInstances: BrowserFixtureAudio.instances.length,
    }).toMatchObject({ errors: [], fetches: ['https://fixtures.invalid/output.wav'], audioInstances: 1 });
    expect(fixtureFetches).toEqual(['https://fixtures.invalid/output.wav']);

    await act(async () => {
      BrowserFixtureAudio.instances[0].onended?.();
      await Promise.resolve();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('completed');
    const artifact = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.artifact',
    );
    const artifactBytes = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.artifactBytes',
    );
    expect(String(artifact.props.children)).toContain('"lifecycle":"completed"');
    expect(artifactBytes.props.children).toBe('UklGRgECAwRXQVZF');
  });

  it('can cancel fixture playback on a bounded dev-route timer', async () => {
    prepareOutputPlaybackQa();
    vi.useFakeTimers();
    expoRouterMock.state.router.setParams({
      voiceQaOutputCapture: '1',
      voiceQaOutputFixtureUrl: 'https://fixtures.invalid/output.wav',
      voiceQaOutputCancelMs: '25',
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const rendered = await renderScreen(<VoiceQaScreen />);
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).not.toBe('cancelled');
    const playFixtureButton = rendered.tree.find(
      (node) => String(node.props?.testID) === 'voiceQa.output.playFixture',
    );
    await pressTestInstanceAsync(playFixtureButton);
    await BrowserFixtureAudio.playbackStarted.promise;
    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('playing');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24);
    });
    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('playing');
    await flushHookEffects({ cycles: 1, turns: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getVoiceQaOutputTapSnapshot().artifact?.lifecycle).toBe('cancelled');
    expect(BrowserFixtureAudio.instances[0]?.pause).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('uses the latest prompt when send is pressed before the button rerenders', async () => {
    await prepareRealtimeQa('session_send');
    const userMessageSent = createDeferred<void>();
    sdk.sendUserMessage.mockImplementation((message) => {
      if (message === 'prompt_latest') userMessageSent.resolve();
    });
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const promptInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.promptInput');
    const sendButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.send');

    await act(async () => {
      sessionInput.props.onChangeText('session_send');
      promptInput.props.onChangeText('prompt_latest');
      await pressTestInstanceAsync(sendButton);
    });

    await waitForQaStart();
    await userMessageSent.promise;
    expect(pendingWrites).toHaveLength(1);
    expect(sdk.sendUserMessage).toHaveBeenCalledWith('prompt_latest');
    expect(useVoiceQaStore.getState().targetSessionAddress?.sessionId).toBe('session_send');
    expect(pendingWrites).toEqual([expect.objectContaining({ sessionId: 'session_send',
      body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
        role: 'user', content: expect.objectContaining({ text: 'prompt_latest' }),
      }) } }),
    })]);
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'user' && entry.text === 'prompt_latest')).toBe(true);
  });

  it('stops the admitted provider session when input changes before the button rerenders', async () => {
    await prepareRealtimeQa('session_stop_admitted');
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const { voiceQaController } = await import('@/voice/qa/voiceQaController');
    await act(async () => {
      await voiceQaController.start({ sessionAddress: { serverId: account!.home.id, sessionId: 'session_stop_admitted' } });
    });
    expect(useVoiceQaStore.getState().status).toBe('running');
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const stopButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.stop');

    await act(async () => {
      sessionInput.props.onChangeText('session_stop_latest');
      await pressTestInstanceAsync(stopButton);
    });

    await waitForTestEvent(useVoiceQaStore.subscribe, useVoiceQaStore.getState, state => state.status === 'idle');
    expect(useVoiceQaStore.getState().status).toBe('idle');
    expect(sdk.endSession).toHaveBeenCalledTimes(1);
  });

  it('calls clear without routing through the busy action wrapper', async () => {
    useVoiceQaStore.getState().appendUser('retained diagnostic prompt');
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const clearButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.clear');

    await act(async () => {
      await pressTestInstanceAsync(clearButton);
    });

    expect(useVoiceQaStore.getState().entries).toEqual([]);
    expect(useVoiceQaStore.getState().status).toBe('idle');
  });

  it('opens the hidden conversation route for the bound runtime session', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    let tree!: renderer.ReactTestRenderer;
    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    storage.setState((state) => ({
      sessions: {
        ...state.sessions,
        voice_session_qa_open: createSessionFixture({
          id: 'voice_session_qa_open',
          serverId: getActiveServerSnapshot().serverId,
          metadata: emptySessionMetadata,
        }),
      },
    }));
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice_session_qa_open',
      conversationSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_session_qa_open' },
      targetSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'target_s1' },
      transcriptMode: 'native_session',
      updatedAt: Date.now(),
    });
    tree = (await renderScreen(<VoiceQaScreen />)).tree;

    const openConversationButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.openConversation');

    await act(async () => {
      await pressTestInstanceAsync(openConversationButton);
    });

    expect(expoRouterMock.spies.push).toHaveBeenCalledWith(
      `/session/voice_session_qa_open?serverId=${encodeURIComponent(getActiveServerSnapshot().serverId)}`,
    );
  });

  it('renders transcript and projected conversation entries from the QA stores', async () => {
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    useVoiceQaStore.getState().begin('local_voice_agent', '__voice_agent__');
    useVoiceQaStore.getState().appendUser('user prompt');
    useVoiceQaStore.getState().appendAssistant('assistant reply');
    storage.setState({
      ...(storage.getState()),
      sessionMessages: {
        voice_hidden_runtime: createSessionMessagesFixture({
          messageIdsOldestFirst: ['proj_1', 'proj_2'],
          messagesById: {
            proj_1: {
              kind: 'agent-text',
              id: 'proj_1',
              createdAt: 1,
              localId: 'proj_1',
              text: 'Assistant is speaking',
            },
            proj_2: {
              kind: 'agent-text',
              id: 'proj_2',
              createdAt: 2,
              localId: 'proj_2',
              text: '[Voice] Tool result: sendSessionMessage succeeded',
            },
          },
        }),
      },
    });
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice_hidden_runtime',
      conversationSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice_hidden_runtime' },
      targetSessionAddress: { serverId: getActiveServerSnapshot().serverId, sessionId: 'target_s1' },
      transcriptMode: 'native_session',
      updatedAt: Date.now(),
    });
    useVoiceQaStore.setState((state) => ({
      ...state,
      runtimeSessionId: 'voice_hidden_runtime',
    }));

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const allText = tree.findAll((node) => String(node.type) === 'Text').map((node) => String(node.props.children));

    expect(allText).toContain('user');
    expect(allText).toContain('user prompt');
    expect(allText).toContain('assistant');
    expect(allText).toContain('assistant reply');
    expect(allText.some((text) => text.includes('Assistant is speaking'))).toBe(true);
    expect(allText.some((text) => text.includes('[Voice] Tool result: sendSessionMessage succeeded'))).toBe(true);
    expect(allText).not.toContain(t('devVoiceQa.transcriptEmpty'));
    expect(allText).not.toContain(t('devVoiceQa.activityEmpty'));
  });

  it('transcribes a complete explicit recorded-audio target without consulting configured runtime settings', async () => {
    await prepareDaemonAudioQa();
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const configuredVoiceBeforeTranscription = storage.getState().settings.voice;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-daemon-stt');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-daemon-stt');
      daemonBasePathInput.props.onChangeText('/tmp/voice-agent');
      fileInput.props.onChange({
        target: {
          files: [uploadedRecording],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(await waitForTestEvent(tree.subscribe,
      () => String(tree.find(node => node.props.testID === 'voiceQa.recordedAudio.status').props.children),
      status => status.includes('success'))).toContain('success');

    expect({
      status: String(tree.find(node => node.props.testID === 'voiceQa.recordedAudio.status').props.children),
      result: tree.find(node => node.props.testID === 'voiceQa.recordedAudio.result').props.children,
      requests: transcribeRequests(),
    }).toMatchObject({ status: expect.stringContaining('success'), result: expect.stringContaining('hello explicit daemon stt'), requests: [expect.any(Object)] });
    expect(transcribeRequests()[0]?.payload).toMatchObject({
      packId: 'sherpa-onnx-stt-en-v1',
    });

    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
    expect(storage.getState().settings.voice).toEqual(configuredVoiceBeforeTranscription);
    expect((storage.getState()).sessions?.['session-daemon-stt']).toBeUndefined();
    expect(Object.hasOwn(storage.getState(), 'sessionListRenderables')).toBe(false);
    expect((storage.getState()).machines?.['machine-daemon-stt']).toBeUndefined();
  });

  it('uses recorded-audio daemon route params for the explicit daemon fallback path', async () => {
    await prepareDaemonAudioQa();
    expoRouterMock.state.router.setParams({
      voiceQaSessionId: 'session-from-route',
      voiceQaRecordedAudioDaemonSttPackId: 'sherpa-onnx-stt-en-v1',
      voiceQaRecordedAudioDaemonMachineId: 'machine-from-route',
      voiceQaRecordedAudioDaemonBasePath: '/tmp/voice-from-route',
    });

    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    expect(sessionInput.props.value).toBe('session-from-route');
    expect(daemonPackIdInput.props.value).toBe('sherpa-onnx-stt-en-v1');
    expect(daemonMachineIdInput.props.value).toBe('machine-from-route');
    expect(daemonBasePathInput.props.value).toBe('/tmp/voice-from-route');

    await act(async () => {
      fileInput.props.onChange({
        target: {
          files: [uploadedRecording],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(await waitForTestEvent(tree.subscribe,
      () => String(tree.find(node => node.props.testID === 'voiceQa.recordedAudio.status').props.children),
      status => status.includes('success'))).toContain('success');

    expect(daemonRpcRequests.filter(request => request.method.endsWith('.transcribe'))).toHaveLength(1);
    expect(transcribeRequests()[0]?.payload).toMatchObject({
      packId: 'sherpa-onnx-stt-en-v1',
      language: 'en',
    });
    expect(transcribeRequests()[0]?.machineId).toBe('machine-from-route');
    expect((storage.getState()).sessions?.['session-from-route']).toBeUndefined();
    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');
    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
  });

  it('uses the latest explicit daemon machine target after the screen rerenders', async () => {
    await prepareDaemonAudioQa();
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-latest-target');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-before-rerender');
      daemonBasePathInput.props.onChangeText('/repo/before-rerender');
      fileInput.props.onChange({
        target: {
          files: [uploadedRecording],
          value: 'recording.wav',
        },
      });
    });
    await act(async () => {
      daemonMachineIdInput.props.onChangeText('machine-after-rerender');
      daemonBasePathInput.props.onChangeText('/repo/after-rerender');
    });
    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(await waitForTestEvent(tree.subscribe,
      () => String(tree.find(node => node.props.testID === 'voiceQa.recordedAudio.status').props.children),
      status => status.includes('success'))).toContain('success');

    expect(transcribeRequests()[0]?.machineId).toBe('machine-after-rerender');
    expect((storage.getState()).sessions?.['session-latest-target']).toBeUndefined();
  });

  it('restores temporarily primed recorded-audio settings when the QA screen unmounts mid-action', async () => {
    await prepareDaemonAudioQa();
    let resolveTranscription!: (value: unknown) => void;
    heldTranscription = new Promise(resolve => { resolveTranscription = resolve; });
    storage.getState().applyMachines([createMachineFixture({
      id: 'qa-configured-machine', activeAt: Date.now(),
    })]);
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({
      ...storage.getState().settings.voice,
      executionMachine: { mode: 'fixed', machineId: 'qa-configured-machine', autoMachineId: null },
    }) }, storage.getState().settings));
    const baseline = {
      experiments: storage.getState().settings.experiments,
      featureToggles: storage.getState().settings.featureToggles,
      voiceSettingsV1: storage.getState().settings.voiceSettingsV1,
      voice: storage.getState().settings.voice,
    };
    const { VoiceQaScreen } = await import('./VoiceQaScreen');
    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      fileInput.props.onChange({
        target: {
          files: [uploadedRecording],
          value: 'recording.wav',
        },
      });
    });
    await act(async () => {
      transcribeButton.props.onPress();
      await transcriptionStarted.promise;
      expect(transcribeRequests()).toHaveLength(1);
    });
    const primedSettings = storage.getState().settings;
    expect(readLocalConversationVoiceSettings(primedSettings.voice).stt.localNeural).toMatchObject({
      assetId: 'sherpa-onnx-stt-en-v1',
      execution: 'daemon',
    });
    expect(readLocalConversationVoiceSettings(primedSettings.voiceSettingsV1).stt.localNeural).toMatchObject({
      assetId: 'sherpa-onnx-stt-en-v1',
      execution: 'daemon',
    });

    await act(async () => {
      tree.unmount();
    });
    expect(storage.getState().settings).toMatchObject(baseline);

    resolveTranscription({ ok: true, requestId: transcribeRequests()[0]?.payload.requestId,
      text: '', language: 'en', modelPackId: 'daemon-pack' });
    await Promise.resolve();
  });

  it('uses the explicit daemon QA path directly when every target field is complete', async () => {
    await prepareDaemonAudioQa();
    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-daemon-fallback');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-daemon-stt');
      daemonBasePathInput.props.onChangeText('/tmp/voice-agent');
      fileInput.props.onChange({
        target: {
          files: [uploadedRecording],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(await waitForTestEvent(tree.subscribe,
      () => String(tree.find(node => node.props.testID === 'voiceQa.recordedAudio.status').props.children),
      status => status.includes('success'))).toContain('success');

    expect(transcribeRequests()[0]?.payload).toMatchObject({
      packId: 'sherpa-onnx-stt-en-v1',
      language: 'en',
    });
    expect(daemonRpcRequests.filter(request => request.method.endsWith('.transcribe'))).toHaveLength(1);

    expect(transcribeRequests()[0]?.machineId).toBe('machine-daemon-stt');
    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('success');
    expect(String(resultText.props.children)).toContain('hello explicit daemon stt');
  });

  it('surfaces explicit daemon QA fallback failures instead of collapsing them to empty', async () => {
    await prepareDaemonAudioQa();
    transcriptionError = 'daemon_rpc_failed';

    const { VoiceQaScreen } = await import('./VoiceQaScreen');

    const tree = (await renderScreen(<VoiceQaScreen />)).tree;
    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');
    const daemonPackIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonPackIdInput');
    const daemonMachineIdInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonMachineIdInput');
    const daemonBasePathInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.daemonBasePathInput');
    const fileInput = tree.find((node) => String(node.props?.['data-testid']) === 'voiceQa.recordedAudio.fileInput');
    const transcribeButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.transcribe');

    await act(async () => {
      sessionInput.props.onChangeText('session-daemon-error');
      daemonPackIdInput.props.onChangeText('sherpa-onnx-stt-en-v1');
      daemonMachineIdInput.props.onChangeText('machine-daemon-stt');
      daemonBasePathInput.props.onChangeText('/tmp/voice-agent');
      fileInput.props.onChange({
        target: {
          files: [uploadedRecording],
          value: 'recording.wav',
        },
      });
    });

    await act(async () => {
      await pressTestInstanceAsync(transcribeButton);
    });

    expect(await waitForTestEvent(tree.subscribe,
      () => String(tree.find(node => node.props.testID === 'voiceQa.recordedAudio.status').props.children),
      status => status.includes('error'))).toContain('error');

    const statusText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.status');
    const resultText = tree.find((node) => String(node.props?.testID) === 'voiceQa.recordedAudio.result');

    expect(String(statusText.props.children)).toContain('error');
    expect(String(resultText.props.children)).toContain('daemon_rpc_failed');
    expect(daemonRpcRequests.filter(request => request.method.endsWith('.transcribe'))).toHaveLength(1);
  });
});
