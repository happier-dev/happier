import React from 'react';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
// Genuine browser persistence SDK; Sync/outbox admission and codecs stay real.
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol';
import { createDeferred, renderScreen as renderRuntimeScreen, waitForTestEvent } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { z } from 'zod/mini';
import { SavedSecretResourceMaterialsResponseV1Schema, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture } from '@/dev/testkit';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import type { PartialOptions as ElevenLabsStartOptions } from '@elevenlabs/client';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { VoiceLocalDirectSchema } from '@happier-dev/protocol/voice/settings/localDirect';
import { VoiceLocalConversationSchema } from '@happier-dev/protocol/voice/settings/localConversation';
import { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } from '@/dev/testkit/harness/voiceWebRtcHarness';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

const nativeSpeech = createVoiceSpeechOutputBoundary({ getAccount: () => {
  if (!accountConnection) throw new Error('Mounted native Voice Account unavailable');
  return accountConnection;
} });
const platformOsMock = nativeSpeech.platform;
let nativeAudio = nativeSpeech.reset().audioSession;
const recognizer = vi.hoisted(() => ({
  listeners: new Map<string, Set<() => void>>(),
  callListeners: new Set<() => void>(),
  start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
}));
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
  isRecognitionAvailable: () => true,
  requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  addListener: (name: string, listener: () => void) => {
    const listeners = recognizer.listeners.get(name) ?? new Set<() => void>();
    recognizer.listeners.set(name, listeners);
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
  start: (...args: unknown[]) => {
    const result = recognizer.start(...args);
    for (const listener of recognizer.callListeners) listener();
    return result;
  },
  stop: () => {
    const result = recognizer.stop();
    for (const listener of recognizer.callListeners) listener();
    return result;
  },
  abort: () => recognizer.abort(),
} }));
const sdk = vi.hoisted(() => ({ startSession: vi.fn(), endSession: vi.fn(), callListeners: new Set<() => void>() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: (...args: unknown[]) => {
  const result = sdk.startSession(...args);
  for (const listener of sdk.callListeners) listener();
  return result;
} } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: (...args: unknown[]) => {
  const result = sdk.startSession(...args);
  for (const listener of sdk.callListeners) listener();
  return result;
} } }));
vi.mock('expo-audio', () => ({ AudioModule: {
  setAudioModeAsync: vi.fn(async () => undefined),
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
} }));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/settings/voice', segments: ['(app)', 'settings', 'voice'] }).module);
// The incumbent Vitest platform resolver selects complete actual .web modules
// for the explicit browser invocation. Do not use an async mock import here:
// LiveMic's UI dependency graph re-enters that same mock factory during load.
const currentUiContextToolSetMode = vi.hoisted(() => ({
  value: 'on_demand' as 'off' | 'on_demand' | 'automatic',
}));
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';
const EXTERNAL_PROVIDER_ID = 'acme.voice.demo/realtime-demo';
const EXTERNAL_REGISTRATION_TOKEN = Object.freeze({});
const ELEVENLABS_PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const CODEX_CONNECTED_SERVICE_KEY = readBuiltInLegacyConnectedAccountServiceKeyIngress('openai-codex')!;

const sessionAddress = (sessionId: string) => ({ serverId: 'server-1', sessionId });

function waitForSdkCall(method: 'startSession' | 'endSession', count: number) {
  return waitForTestEvent(notify => {
    sdk.callListeners.add(notify);
    return () => { sdk.callListeners.delete(notify); };
  }, () => sdk[method].mock.calls.length, calls => calls >= count);
}

function waitForRecognizerCall(method: 'start' | 'stop', count: number) {
  return waitForTestEvent(notify => {
    recognizer.callListeners.add(notify);
    return () => { recognizer.callListeners.delete(notify); };
  }, () => recognizer[method].mock.calls.length, calls => calls >= count);
}

async function waitForMountedController(expected: ReturnType<typeof import('./voiceSessionLifecycleControllerStore')['getVoiceSessionLifecycleController']>) {
  const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
  const { subscribeToVoiceSessionSnapshot } = await import('./voiceSessionStore');
  const { getVoiceAdapterRegistry } = await import('./voiceAdapterRegistry');
  await waitForTestEvent(notify => {
    const stopSnapshot = subscribeToVoiceSessionSnapshot(notify);
    // Cleanup always withdraws the registry after clearing the controller,
    // including when the already-idle snapshot is deliberately unchanged.
    const stopRegistry = getVoiceAdapterRegistry().subscribe!(notify);
    return () => { stopSnapshot(); stopRegistry(); };
  }, getVoiceSessionLifecycleController, controller => controller === expected);
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDisconnectedServerSocketBoundary();


let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const retiredAccountConnections: Array<Awaited<ReturnType<typeof restoreServerAccountForTest>>> = [];
const generatedRuntimeScreens: Array<Awaited<ReturnType<typeof renderRuntimeScreen>>> = [];
const openAiRuntimeEnvironments: Array<Awaited<ReturnType<typeof import('@/dev/testkit/harness/openAiVoiceRuntime')['createOpenAiVoiceRuntimeEnvironment']>>> = [];
const browserBoundaries: Array<ReturnType<typeof installVoiceWebRtcBrowserBoundary>> = [];
const actionLoaderDisposals: Array<() => void> = [];
let resourceMaterials: readonly SavedSecretResourceMaterialV1[] = [];
const serverUrlsById = new Map<string, string>();
const retiredAccountHttpRequests: Array<Readonly<{ path: string; authenticatedAsRetiredAccount: boolean }>> = [];
const replacementSettingsRequests: Array<Readonly<{ method: string; expectedVersion: unknown; contentType: unknown; responseValid: boolean }>> = [];

type AccountScope = Readonly<{ serverId: string; accountId: string }>;
type RetiringSessionHttp = Readonly<{ address: Readonly<{ serverId: string; sessionId: string }>; boundary: ReturnType<typeof createSessionMetadataHttpBoundary> }>;
function applyAccountScope(scope: AccountScope, retiringSession?: RetiringSessionHttp): Promise<AccountScope>;
function applyAccountScope(scope: null, retiringSession?: RetiringSessionHttp): Promise<null>;
function applyAccountScope(scope: AccountScope | null, retiringSession?: RetiringSessionHttp): Promise<AccountScope | null>;
async function applyAccountScope(scope: AccountScope | null, retiringSession?: RetiringSessionHttp) {
  const previousConnection = accountConnection;
  accountConnection = null;
  if (!scope) {
    await previousConnection?.dispose();
    return null;
  }
  // Warm replacement goes through the real serialized Account switch. Keep
  // old device writes/HTTP cleanup alive until the mounted media owner retires.
  if (previousConnection) retiredAccountConnections.push(previousConnection);
  const serverUrl = serverUrlsById.get(scope.serverId) ?? `https://${scope.serverId}.voice-runtime.example.test`;
  const settingsHttp = createAccountSettingsHttpBoundary({ serverUrl, initialAccounts: [{ accountId: scope.accountId,
    snapshot: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }),
  }] });
  accountConnection = await restoreServerAccountForTest({ serverUrl, accountId: scope.accountId,
    ...(previousConnection ? { activation: 'switch' as const } : {}),
    ...(previousConnection ? { additionalRequestOrigins: [previousConnection.home.serverUrl] } : {}),
    request: createSessionReadBatchFetchBoundary(async (url, init) => {
      const requested = new URL(String(url));
      const path = requested.pathname;
      if (previousConnection && requested.origin === new URL(previousConnection.home.serverUrl).origin
        && requested.origin !== new URL(serverUrl).origin) {
        retiredAccountHttpRequests.push({ path, authenticatedAsRetiredAccount:
          new Headers(init?.headers).get('Authorization') === `Bearer ${previousConnection.credentials.token}` });
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${previousConnection.credentials.token}`);
        if (retiringSession && path === `/v2/sessions/${encodeURIComponent(retiringSession.address.sessionId)}`
          && (init?.method ?? 'GET') === 'GET') {
          // The bound daemon Stop's real scoped crypto admission rereads this
          // exact old-Account Session before issuing RPC. Preserve only that
          // original authenticated record, not an arbitrary retired Home read.
          expect(retiringSession.address.serverId).toBe(previousConnection.home.id);
          const response = retiringSession.boundary.handle(url, init);
          if (!response) throw new Error('Retiring bound Session HTTP record unavailable');
          expect(response.status).toBe(200);
          return response;
        }
        // Only the exact admitted old Account's hosted lease may finish here;
        // this is not an old-Home settings/session/credential read allowance.
        expect(['/v1/voice/session/complete', '/v1/voice/session/release']).toContain(path);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${previousConnection.credentials.token}`);
        return Response.json({ ok: true });
      }
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v2/account/settings') {
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const record = body && typeof body === 'object' ? body : null;
        const response = settingsHttp.handle(url, init);
        if (!response) throw new Error('Account Settings HTTP boundary unavailable');
        const { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateResponseSchema } = await import('@happier-dev/protocol/account/settings/accountSettingsApiV2');
        replacementSettingsRequests.push({ method: init?.method ?? 'GET',
          expectedVersion: record && 'expectedVersion' in record ? record.expectedVersion : undefined,
          contentType: record && 'content' in record && record.content && typeof record.content === 'object' && 't' in record.content ? record.content.t : undefined,
          responseValid: (init?.method === 'POST' ? AccountSettingsV2UpdateResponseSchema : AccountSettingsV2GetResponseSchema).safeParse(await response.clone().json()).success,
        });
        return response;
      }
      if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: scope.accountId });
      if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: resourceMaterials });
      return Response.json({}, { status: 404 });
    }),
  });
  serverUrlsById.set(accountConnection.home.id, serverUrl);
  const appliedScope = { serverId: accountConnection.home.id, accountId: scope.accountId };
  await refreshSavedSecretCatalog(appliedScope);
  return appliedScope;
}

async function setCurrentUiContextToolSetMode(mode: typeof currentUiContextToolSetMode.value) {
  currentUiContextToolSetMode.value = mode;
  const { storage } = await import('@/sync/domains/state/storage');
  const settings = storage.getState().settings;
  const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...settings.voice,
    privacy: { ...settings.voice.privacy, currentUiContextMode: mode },
  } }, settings));
}


function LayoutCommitBoundary({
  children,
  onLayout,
}: Readonly<{
  children: React.ReactNode;
  onLayout: () => void;
}>): React.ReactElement {
  React.useLayoutEffect(() => {
    onLayout();
  }, [onLayout]);
  return <>{children}</>;
}

// Load the shared graph once, outside per-case hooks; cold module transformation
// is not part of the mounted runtime's lifecycle operation budget.
await loadSyncSingletonForTests();

async function prepareGeneratedVoiceRuntime(input: Readonly<{ currentUi?: boolean; startGate?: Promise<void>; selectedProviderId?: string; local?: boolean; localPlatform?: 'ios' | 'web'; codex?: boolean;
  transcriptResponse?: (body: Readonly<{ localId: string }>) => Promise<Response | null>;
}> = {}) {
  platformOsMock.value = input.local ? input.localPlatform ?? 'ios' : 'web';
  if (input.local && platformOsMock.value !== 'web') {
    // The actual web live producer's no-browser capability branch delegates
    // to NativeMic; recognizer/coordinator assertions prove that real path.
    expect(globalThis.navigator?.mediaDevices?.getUserMedia).toBeUndefined();
  }
  const { storage } = await import('@/sync/domains/state/storage');
  const { AccountProfileSchema, PluginProjectionV2Schema } = await import('@happier-dev/protocol');
  const { RPC_METHODS, SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
  const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
  const agentProtocol = await import('@happier-dev/protocol/voice/realtime/agentSession');
  const { SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
  const { SessionSpawnNewResultV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1');
  const machineId = 'mounted-codex-machine';
  let profile = AccountProfileSchema.parse({ id: 'account-a', ...(input.codex ? {
    connectedServicesV2: [{ serviceId: 'openai-codex', profiles: ['work', 'primary', 'backup'].map(profileId => ({ profileId, status: 'connected', kind: 'oauth' })),
      groups: [{ groupId: 'voice-pool', activeProfileId: 'primary', generation: 1, memberProfileIds: ['primary', 'backup'] }],
    }],
    connectedServiceCredentialRevisionsV1: ['work', 'primary', 'backup'].map(profileId => ({ serviceId: 'openai-codex', profileId, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
  } : {}) });
  const agentRequests: Array<Readonly<{ method: string; targetId: string; params: unknown; timeoutMs: number | null }>> = [];
  const agentRequestListeners = new Set<() => void>();
  const watches = new Map<string, ReturnType<typeof createDeferred<ReturnType<typeof agentProtocol.AgentSessionRealtimeWatchResultV1Schema.parse>>>>();
  const daemonSessions: Record<string, ReturnType<typeof createSessionFixture>> = {};
  const { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } = await import('@/voice/persistence/voiceTranscriptHistorySession');
  const history = createSessionFixture({ id: 'mounted-runtime-history', seq: 0, encryptionMode: 'plain', active: false,
    metadata: { path: '/voice', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() },
  });
  const nativeSession = createSessionFixture({ id: 'mounted-native-session', encryptionMode: 'plain', active: true, activeAt: Date.now(),
    ...(input.codex ? { metadata: { machineId, path: '/voice', host: 'test', flavor: 'codex' } } : {}),
  });
  const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [history.id]: history, [nativeSession.id]: nativeSession, ...daemonSessions }));
  const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } = await import('@happier-dev/protocol');
  const historyOwner = createSessionOwnerMetadataV1({ metadata: history.metadata });
  if (!historyOwner.ok) throw new Error('Voice history fixture metadata owner unavailable');
  // Persist an actual current owner tuple at the Home HTTP boundary before
  // Sync reads it. A legacy layout-0 seed cannot answer current create/load.
  sessionHttp.createSessionFromPost(history.id, { method: 'POST', body: JSON.stringify({
    tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, metadataLayoutVersion: 1,
    sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: history.metadata, agentState: null })) },
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(historyOwner.ownerMetadata),
    agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
  }) });
  const httpRequests: Array<Readonly<{ path: string; method: string; settingsPost?: Readonly<{ expectedVersion: unknown; contentType: unknown; responseValid: boolean; status: number }> }>> = [];
  const transcriptSequences = new Map<string, number>();
  const serverUrl = 'https://voice-mounted-runtime.example.test';
  const settingsHttp = createAccountSettingsHttpBoundary({ serverUrl, initialAccounts: [{ accountId: 'account-a',
    snapshot: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }),
  }] });
  const configureSocket: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']> = (socket, capturedServerUrl) => {
    if (!capturedServerUrl) throw new Error('Captured daemon Home unavailable');
    expect(new URL(capturedServerUrl).origin).toBe(new URL(serverUrl).origin);
    let timeoutMs: number | null = null;
    socket.connect = vi.fn<typeof socket.connect>(() => {
      if (socket.connected) return socket;
      socket.connected = true;
      for (const listener of socket.listeners('connect')) listener();
      return socket;
    });
    socket.timeout = vi.fn<typeof socket.timeout>(value => { timeoutMs = value ?? null; return socket; });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
      // Socket.IO's payload is untyped; the framed DTO is narrowed here and each
      // provider/spawn payload is parsed by its actual strict Protocol schema.
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Expected framed daemon RPC');
      const separator = raw.method.indexOf(':');
      if (separator <= 0) throw new Error('Expected qualified daemon target');
      const targetId = raw.method.slice(0, separator);
      const method = raw.method.slice(separator + 1);
      const requestTimeoutMs = timeoutMs;
      timeoutMs = null;
      const { parseToken } = await import('@/utils/auth/parseToken');
      const token = typeof socket.auth === 'object' && 'token' in socket.auth ? socket.auth.token : null;
      expect(typeof token).toBe('string');
      if (typeof token !== 'string') throw new Error('Captured daemon Account credential unavailable');
      expect(parseToken(token)).toBe('account-a');
      if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT) {
        agentProtocol.AgentSessionRealtimeInspectRequestV1Schema.parse(raw.params);
        return { ok: true, result: agentProtocol.AgentSessionRealtimeInspectResultV1Schema.parse({ ok: true, status: 'available', transport: 'webrtc' }) };
      }
      if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START) {
        const request = agentProtocol.AgentSessionRealtimeStartRequestV1Schema.parse(raw.params);
        agentRequests.push({ method, targetId, params: request, timeoutMs: requestTimeoutMs });
        for (const listener of agentRequestListeners) listener();
        return { ok: true, result: agentProtocol.AgentSessionRealtimeStartResultV1Schema.parse({ ok: true, status: 'started', transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=mounted-codex-answer\r\n' } }) };
      }
      if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH) {
        const request = agentProtocol.AgentSessionRealtimeWatchRequestV1Schema.parse(raw.params);
        expect(requestTimeoutMs).toBeNull();
        agentRequests.push({ method, targetId, params: request, timeoutMs: requestTimeoutMs });
        for (const listener of agentRequestListeners) listener();
        const watch = createDeferred<ReturnType<typeof agentProtocol.AgentSessionRealtimeWatchResultV1Schema.parse>>();
        watches.set(request.applicationAttemptId, watch);
        return { ok: true, result: await watch.promise };
      }
      if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP) {
        const request = agentProtocol.AgentSessionRealtimeStopRequestV1Schema.parse(raw.params);
        agentRequests.push({ method, targetId, params: request, timeoutMs: requestTimeoutMs });
        for (const listener of agentRequestListeners) listener();
        watches.get(request.applicationAttemptId)?.resolve(agentProtocol.AgentSessionRealtimeWatchResultV1Schema.parse({ ok: true, status: 'terminal', event: { kind: 'terminal', reason: 'stopped' } }));
        return { ok: true, result: agentProtocol.AgentSessionRealtimeStopResultV1Schema.parse({ ok: true, status: 'stopped' }) };
      }
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { ok: true, result: { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { codex: {
        id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, isBuiltIn: true,
        capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, startupInstructions: { versions: [1] } } },
      } }, familiesById: {} }) } };
      if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
        return { ok: true, result: createExistingSessionDirectoryPreflightResult(raw.params) };
      }
      if (method === RPC_METHODS.SESSION_SPAWN_NEW) {
        const request = SessionSpawnNewInputV2Schema.parse(raw.params);
        if (!('path' in request.directory)) throw new Error('Expected actual Global absolute directory');
        const sessionId = `mounted-codex-global-${Object.keys(daemonSessions).length + 1}`;
        daemonSessions[sessionId] = createSessionFixture({ id: sessionId, serverId: request.executionTarget.serverId, active: true, encryptionMode: 'plain',
          metadata: { machineId: targetId, path: request.directory.path, host: 'test', flavor: 'codex', connectedServices: request.connectedServices },
          permissionMode: request.permissionMode,
        });
        sessionHttp.replaceSession(sessionId);
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        return { ok: true, result: SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId,
          executionTarget: request.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
        }) };
      }
      throw new Error(`Unexpected daemon RPC: ${method}`);
    });
  };
  accountConnection = await restoreServerAccountForTest({
    serverUrl, accountId: 'account-a', credentialScope: 'restored-home',
    activation: 'switch',
    ...(input.codex ? { configureSocket } : {}),
    request: createSessionReadBatchFetchBoundary(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const preparation = settingsHttp.handle(url, init) ?? answerVoiceRealtimePreparationHttpRequest(url, {});
      let settingsPost: typeof httpRequests[number]['settingsPost'];
      if (path === '/v2/account/settings' && init?.method === 'POST' && preparation) {
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        const record = body && typeof body === 'object' ? body : null;
        const { AccountSettingsV2UpdateResponseSchema } = await import('@happier-dev/protocol/account/settings/accountSettingsApiV2');
        settingsPost = { expectedVersion: record && 'expectedVersion' in record ? record.expectedVersion : undefined,
          contentType: record && 'content' in record && record.content && typeof record.content === 'object' && 't' in record.content ? record.content.t : undefined,
          responseValid: AccountSettingsV2UpdateResponseSchema.safeParse(await preparation.clone().json()).success,
          status: preparation.status,
        };
      }
      httpRequests.push({ path, method: init?.method ?? 'GET', ...(settingsPost ? { settingsPost } : {}) });
      if (preparation) return preparation;
      if (path === '/v1/account/profile') return Response.json(profile);
      if (input.codex && path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' })]);
      if (input.codex && path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => id === machineId ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
      if (input.codex && path === `/v1/machines/${machineId}`) return Response.json({ machine: createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }) });
      if (input.codex && path === `/v1/machines/${machineId}/access`) {
        const row = createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' });
        return Response.json({ machineId, custodian: row.access!.custodian, access: row.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
      }
      if (path === '/health') return Response.json({ status: 'ok' });
      if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'mounted-token', leaseId: 'mounted-lease', bindingNonce: 'mounted-nonce', expiresAtMs: Date.now() + 60_000 });
      if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
      const transcriptWrite = /^\/v2\/sessions\/([^/]+)\/messages$/.exec(path);
      if (transcriptWrite && init?.method === 'POST') {
        const { z } = await import('zod/mini');
        const { RawRecordSchema } = await import('@happier-dev/session-core/raw');
        const body = z.object({ localId: z.string(), messageRole: z.literal('agent'),
          content: z.object({ t: z.literal('plain'), v: RawRecordSchema }),
        }).parse(JSON.parse(String(init.body)));
        const override = await input.transcriptResponse?.(body);
        if (override) return override;
        const sessionId = decodeURIComponent(transcriptWrite[1]!);
        const seq = Math.max(transcriptSequences.get(sessionId) ?? 0, storage.getState().sessions[sessionId]?.seq ?? 0) + 1;
        transcriptSequences.set(sessionId, seq);
        return Response.json({ didWrite: true, message: { id: `ack:${body.localId}`,
          localId: body.localId, seq, createdAt: Date.now() } });
      }
      if (path === '/v2/sessions/lookup-by-tags') {
        const request = SessionLookupByTagsRequestV2Schema.parse(JSON.parse(String(init?.body)));
        expect(request.tags).toEqual([VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG]);
        const response = sessionHttp.handle(`https://voice-mounted-runtime.example.test/v2/sessions/${history.id}`);
        if (!response) throw new Error('Persisted Voice history detail unavailable');
        return Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions: [(await response.json()).session] }));
      }
      if (path === '/v1/sessions' && init?.method === 'POST') return sessionHttp.createSessionFromPost(history.id, init);
      const sessionResponse = sessionHttp.handle(url, init);
      if (sessionResponse) return sessionResponse;
      return Response.json({}, { status: 404 });
    }),
  });
  const account = accountConnection;
  if (input.codex) {
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    actionLoaderDisposals.push(await installRealActionExecutorModuleLoader());
  }
  const { sync } = await import('@/sync/sync');
  await sync.resumeSync('manual');
  await waitForTestEvent(storage.subscribe, storage.getState, state => state.isDataReady
    && state.profileScope?.serverId === account.home.id && state.profileScope.accountId === 'account-a');
  expect(storage.getState().profileScope).toEqual({ serverId: account.home.id, accountId: 'account-a' });
  expect(storage.getState().isDataReady).toBe(true);
  const localProviderId = input.selectedProviderId === 'local_conversation' ? 'local_conversation' : 'local_direct';
  const voice = input.local
    ? writeVoiceProviderSettingsConfig(voiceSettingsParse({ providerId: localProviderId }), localProviderId,
      localProviderId === 'local_conversation'
        ? VoiceLocalConversationSchema.parse({ tts: { autoSpeakReplies: false } })
        : VoiceLocalDirectSchema.parse({ tts: { autoSpeakReplies: false } }))
    : input.codex
      ? writeVoiceProviderSettingsConfig(voiceSettingsParse({ providerId: CODEX_PROVIDER_ID, executionMachine: { mode: 'fixed', machineId } }), CODEX_PROVIDER_ID,
        { globalConnectedServices: { v: 1, bindingsByServiceId: { [CODEX_CONNECTED_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' } } } })
      : writeVoiceProviderSettingsConfig(voiceSettingsParse({ providerId: ELEVENLABS_PROVIDER_ID }), ELEVENLABS_PROVIDER_ID, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
  const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
  storage.getState().applySettingsLocal({
    ...normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: input.selectedProviderId ?? (input.local ? 'local_direct' : ELEVENLABS_PROVIDER_ID) } }, storage.getState().settings),
    ...(input.currentUi ? { featureToggles: { ...storage.getState().settings.featureToggles, voice: true } } : {}),
  });
  sdk.endSession.mockReset().mockResolvedValue(undefined);
  const conversation = {
    getId: () => 'mounted-provider-conversation', endSession: (...args: unknown[]) => {
      const result = sdk.endSession(...args);
      for (const listener of sdk.callListeners) listener();
      return result;
    },
    setMicMuted() {}, setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {},
  };
  sdk.startSession.mockReset().mockImplementation(async () => {
    await input.startGate;
    return conversation;
  });
  const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
  let runtime: React.ReactElement = React.createElement(VoiceSessionRuntime);
  if (input.currentUi) {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { CurrentUiContextProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    runtime = <InjectedAuthProvider credentials={account.credentials}>
      <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
        <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
          {runtime}
        </PluginSurfaceFocusEligibilityProvider>
      </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
    </InjectedAuthProvider>;
  }
  const screen = await renderRuntimeScreen(runtime);
  generatedRuntimeScreens.push(screen);
  const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
  const lifecycle = getVoiceSessionLifecycleController();
  if (!lifecycle) throw new Error('Mounted Voice lifecycle unavailable');
  expect(lifecycle.getConfiguredProviderId()).toBe(input.codex ? CODEX_PROVIDER_ID : input.local ? localProviderId : ELEVENLABS_PROVIDER_ID);
  return { screen, lifecycle, runtime, httpRequests, agentRequests, sessionHttp,
    waitForAgentRequests(predicate: (requests: typeof agentRequests) => boolean) {
      return waitForTestEvent(notify => {
        agentRequestListeners.add(notify);
        return () => { agentRequestListeners.delete(notify); };
      }, () => agentRequests, predicate);
    },
    get profile() { return profile; },
    async publishProfile(next: z.input<typeof AccountProfileSchema>) {
      profile = AccountProfileSchema.parse(next);
      await sync.refreshProfile();
      await screen.update(runtime);
    },
  };
}

async function mountGeneratedElevenLabsRuntime(input: Readonly<{ currentUi?: boolean; selectedProviderId?: string }> = {}) {
  const mounted = await prepareGeneratedVoiceRuntime(input);
  const { lifecycle } = mounted;
  await act(async () => { await lifecycle.toggle(null); });
  expect(lifecycle.getSnapshot(), JSON.stringify({ snapshot: lifecycle.getSnapshot(), sdkStarts: sdk.startSession.mock.calls.length, requests: mounted.httpRequests })).toMatchObject({ adapterId: ELEVENLABS_PROVIDER_ID, status: 'connected' });
  await waitForSdkCall('startSession', 1);
  expect(sdk.startSession).toHaveBeenCalledOnce();
  const options: ElevenLabsStartOptions = sdk.startSession.mock.calls[0][0];
  return { ...mounted, options };
}

async function mountGeneratedLocalRuntime(selectedProviderId: 'local_direct' | 'local_conversation' = 'local_direct', localPlatform: 'ios' | 'web' = 'ios') {
  const mounted = await prepareGeneratedVoiceRuntime({ local: true, selectedProviderId, localPlatform });
  if (!accountConnection) throw new Error('Native Voice Account unavailable');
  const target = { serverId: accountConnection.home.id, sessionId: 'mounted-native-session' };
  await act(async () => { await mounted.lifecycle.toggle(target); });
  await waitForRecognizerCall('start', 1);
  expect(recognizer.start, JSON.stringify(mounted.lifecycle.getSnapshot())).toHaveBeenCalledOnce();
  expect(mounted.lifecycle.getSnapshot()).toMatchObject({ adapterId: selectedProviderId,
    sessionId: target.sessionId, status: 'connected', canStop: true,
  });
  if (localPlatform !== 'web') expect(nativeSpeech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBeGreaterThan(0);
  return { ...mounted, target };
}

// Physical DOM media elements are owned by the browser SDK. The connection,
// remote-output lifecycle and capture owners beneath them remain real.
function createMountedBrowserDocument() {
  return Object.assign(new EventTarget(), {
    visibilityState: 'visible' as const,
    createElement(tag: string) {
      expect(tag).toBe('audio');
      return Object.assign(new EventTarget(), {
        autoplay: false, srcObject: null as MediaStream | null, volume: 1,
        play: vi.fn(async () => {}), pause: vi.fn(), remove: vi.fn(),
      });
    },
  });
}

async function mountGeneratedCodexRuntime(input: Readonly<{ global?: boolean; group?: boolean }> = {}) {
  const browser = installVoiceWebRtcBrowserBoundary();
  browserBoundaries.push(browser);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', createMountedBrowserDocument());
  const mounted = await prepareGeneratedVoiceRuntime({ codex: true, selectedProviderId: CODEX_PROVIDER_ID });
  const { storage } = await import('@/sync/domains/state/storage');
  const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
  if (input.group) {
    const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, CODEX_PROVIDER_ID, {
      globalConnectedServices: { v: 1, bindingsByServiceId: { [CODEX_CONNECTED_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'voice-pool' } } },
    });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice }, storage.getState().settings));
    await mounted.screen.update(mounted.runtime);
  }
  if (!accountConnection) throw new Error('Codex mounted Account unavailable');
  const target = { serverId: accountConnection.home.id, sessionId: 'mounted-native-session' };
  if (!input.global) {
    const { sync } = await import('@/sync/sync');
    await sync.ensureSessionVisibleForMessageRoute(target.sessionId, { serverId: target.serverId });
    expect(storage.getState().sessions[target.sessionId]).toMatchObject({ serverId: target.serverId, active: true });
  }
  let start: Promise<void> | undefined;
  try {
    await act(async () => { start = mounted.lifecycle.toggle(input.global ? null : target); void start.catch(() => {}); });
    if (!start) throw new Error('Mounted Voice start was not admitted');
    const peer = await Promise.race([browser.peerCreated(), start.then(() => browser.peer)]);
    expect(browser.peers, JSON.stringify(mounted.lifecycle.getSnapshot())).toHaveLength(1);
    await Promise.race([peer.remoteDescriptionSet, start]);
    expect(peer.setRemoteDescription, JSON.stringify(mounted.lifecycle.getSnapshot())).toHaveBeenCalledOnce();
    browser.peer.channel.open();
    await act(async () => { await start; });
    expect(mounted.lifecycle.getSnapshot()).toMatchObject({ adapterId: CODEX_PROVIDER_ID, status: 'connected', canStop: true });
    expect(browser.peer.addTrack).toHaveBeenCalledWith(browser.micTrack, browser.micStream);
    return { ...mounted, browser, target };
  } catch (error) {
    await mounted.lifecycle.dispose();
    await start?.catch(() => {});
    throw error;
  }
}

async function prepareMountedOpenAiRuntime(input: Readonly<{ credentialSource?: 'savedSecret' | 'connectedAccount' }> = {}) {
  platformOsMock.value = 'web';
  const { createOpenAiVoiceRuntimeEnvironment } = await import('@/dev/testkit/harness/openAiVoiceRuntime');
  const environment = await createOpenAiVoiceRuntimeEnvironment(input);
  openAiRuntimeEnvironments.push(environment);
  const { sync } = await import('@/sync/sync');
  const { storage } = await import('@/sync/domains/state/storage');
  await sync.resumeSync('manual');
  await waitForTestEvent(storage.subscribe, storage.getState, state => state.isDataReady
    && state.profileScope?.serverId === environment.accountConnection.home.id && state.profileScope.accountId === 'openai-composed-account');
  expect(storage.getState().profileScope).toEqual({ serverId: environment.accountConnection.home.id, accountId: 'openai-composed-account' });
  expect(storage.getState().isDataReady).toBe(true);
  const audioContext = new TestVoiceAudioContext();
  // The browser SDK fixture exposes only the Web Audio leaves capture consumes.
  const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => audioContext as unknown as AudioContext });
  browserBoundaries.push(browser);
  const AudioContextBoundary = class { constructor() { return audioContext; } };
  vi.stubGlobal('AudioContext', AudioContextBoundary);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { AudioContext: AudioContextBoundary }));
  vi.stubGlobal('document', createMountedBrowserDocument());
  const source = await import('@/voice/runtime/mic/createRealtimeMicSession');
  const browserSource = await import('@/voice/runtime/mic/createRealtimeMicSession.web');
  const liveSource = await import('@/voice/runtime/mic/createLiveMicSession');
  const browserLiveSource = await import('@/voice/runtime/mic/createLiveMicSession.web');
  // Deciding environment identity, not a fake host.createMicSession override.
  expect(source.createRealtimeMicSession).toBe(browserSource.createRealtimeMicSession);
  expect(liveSource.createLiveMicSession).toBe(browserLiveSource.createLiveMicSession);
  const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
  const runtime = React.createElement(VoiceSessionRuntime);
  const screen = await renderRuntimeScreen(runtime);
  generatedRuntimeScreens.push(screen);
  const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
  const lifecycle = getVoiceSessionLifecycleController();
  if (!lifecycle) throw new Error('Mounted OpenAI lifecycle unavailable');
  expect(lifecycle.getConfiguredProviderId()).toBe(OPENAI_PROVIDER_ID);
  return { environment, browser, screen, lifecycle, runtime };
}

describe('VoiceSessionRuntime', () => {
  beforeEach(async () => {
    resetConnectedAccountCatalogSnapshotsForTests();
    installDisconnectedServerSocketBoundary();
    resourceMaterials = [];
    nativeAudio = nativeSpeech.reset().audioSession;
    recognizer.listeners.clear();
    recognizer.callListeners.clear();
    sdk.callListeners.clear();
    recognizer.start.mockReset().mockImplementation(() => {
      for (const listener of recognizer.listeners.get('audiostart') ?? []) listener();
    });
    recognizer.stop.mockReset().mockImplementation(() => {
      for (const listener of recognizer.listeners.get('end') ?? []) listener();
    });
    recognizer.abort.mockReset().mockImplementation(() => {
      for (const listener of recognizer.listeners.get('end') ?? []) listener();
    });
    platformOsMock.value = 'ios';
    currentUiContextToolSetMode.value = 'on_demand';
    serverUrlsById.clear();
    retiredAccountHttpRequests.length = 0;
    replacementSettingsRequests.length = 0;

    const { storage } = await import('@/sync/domains/state/storage');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storage.getState());

    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
  });

  afterEach(async () => {
    // Media shutdown can still complete a hosted HTTP lease. Keep the external
    // Account transport installed until the real mounted owner has retired.
    const mountedScreens = generatedRuntimeScreens.splice(0);
    for (const screen of mountedScreens.reverse()) {
      await screen.unmount();
    }
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    // The public null publication follows both controller and assembly disposal.
    if (mountedScreens.length) await waitForMountedController(null);
    if (mountedScreens.length) expect(getVoiceSessionLifecycleController()).toBeNull();
    for (const environment of openAiRuntimeEnvironments.splice(0).reverse()) await environment.dispose();
    for (const browser of browserBoundaries.splice(0).reverse()) browser.restore();
    for (const dispose of actionLoaderDisposals.splice(0).reverse()) dispose();
    const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    // The connection harness fences disconnect on its captured Account lifetime.
    // Retiring it first skips disconnect and leaks the Account into the next test.
    await accountConnection?.dispose();
    accountConnection = null;
    for (const connection of retiredAccountConnections.splice(0).reverse()) await connection.dispose();
    retireActiveServerAccountScopeLifetime();
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
    currentUiContextToolSetMode.value = 'on_demand';
    // Every spy ever created stays in `@vitest/spy`'s module-level registry, and each one
    // holds its recorded `mock.contexts`/`calls`/`results`. Those records reach the adapter
    // objects a test body built (`{ ...controller, resolveSurfaceCapabilities: () => ... }`),
    // whose arrow functions carry that body's closure context and therefore its whole
    // module namespace. Clearing the records at the end of the test releases them;
    // it runs after every assertion, so no guard depends on it.
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await nativeSpeech.disposeAudioSession();
    nativeSpeech.disposeNativeSdkBridge();
  });

  it.each(['live', 'ended'] as const)('keeps direct-session pending requests reachable through the %s glance without a hidden binding', async (phase) => {
    const mounted = await mountGeneratedLocalRuntime('local_conversation');
    const { storage } = await import('@/sync/domains/state/storage');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { getVoiceSessionEndedAttempt } = await import('./voiceSessionStore');
    const { VoiceGlance } = await import('@/components/voice/presence/VoiceGlance');
    const { useVoiceSurfaceModel } = await import('@/components/voice/surface/useVoiceSurfaceModel');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { Text } = await import('@/components/ui/text/Text');
    const { createSessionMessagesFixture } = await import('@/dev/testkit');
    const now = Date.now();
    const request = { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'git status' }, createdAt: now };
    const session = createSessionFixture({ id: mounted.target.sessionId, serverId: mounted.target.serverId,
      active: true, presence: 'online', activeAt: now, createdAt: now, updatedAt: now,
      pendingPermissionRequestCount: 1, pendingRequestObservedAt: now,
      agentState: { requests: { 'direct-request': request } },
    });
    await act(async () => {
      storage.getState().applySessions([session]);
      storage.setState({ sessionMessages: { ...storage.getState().sessionMessages,
        [session.id]: createSessionMessagesFixture({ isLoaded: true }) } });
    });
    expect(voiceSessionBindingStore.getState().getByControlSessionId(session.id)).toBeNull();

    let currentControl: VoiceAttemptControlProjection | null = null;
    function Glance() {
      const model = useVoiceSurfaceModel({ variant: 'sidebar', sessionAddress: mounted.target });
      currentControl = model?.attemptControl ?? null;
      return model ? <VoiceGlance model={model} presentation="companion" /> : null;
    }
    function HostedGlance() {
      const [destination, setDestination] = React.useState('/settings/voice');
      const navigation = React.useMemo(() => ({ push: (href: unknown) => setDestination(String(href)),
        replace: (href: unknown) => setDestination(String(href)), back: () => setDestination('/settings/voice') }), []);
      return <DestinationInstanceHost tabId="direct-voice" ref={{ kind: 'voice', params: {} }}
        pathname={destination} focused visible navigation={navigation}>
        {destination === '/settings/voice' ? <Glance /> : <Text testID="direct-review-destination">{destination}</Text>}
      </DestinationInstanceHost>;
    }
    const glance = await renderRuntimeScreen(<HostedGlance />);
    generatedRuntimeScreens.push(glance);
    if (phase === 'live') {
      expect(currentControl).toMatchObject({ statusCell: 'needs_you', pendingRequestSessionAddress: mounted.target });
      expect(glance.findByTestId('permission-prompt-card')).not.toBeNull();
      expect(glance.getTextContent()).toContain(request.arguments.command);
    } else {
      await glance.pressByTestIdAsync('voice-glance-transport-end');
      await waitForTestEvent(mounted.lifecycle.subscribe, () => mounted.lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
      expect(mounted.lifecycle.getSnapshot().status).toBe('disconnected');
      expect(getVoiceSessionEndedAttempt()).toMatchObject({ targetSessionAddress: mounted.target,
        accountScope: { serverId: mounted.target.serverId, accountId: 'account-a' }, conversationSessionAddress: null });
      await waitForTestEvent(glance.subscribe, () => expect(glance.findByTestId('voice-glance-ended-pending.review')).not.toBeNull());
      await glance.pressByTestIdAsync('voice-glance-ended-pending.review');
      expect(glance.findByTestId('direct-review-destination')?.props.children)
        .toBe(`/session/${session.id}?serverId=${encodeURIComponent(mounted.target.serverId)}`);
    }
    // Rendering and End leave human approval custody untouched.
    expect(storage.getState().sessions[session.id]?.agentState?.requests?.['direct-request']).toEqual(request);
  });

  it('refreshes the active conversation scope when carrier metadata changes without changing its binding', async () => {
    const mounted = await mountGeneratedElevenLabsRuntime();
    const { storage } = await import('@/sync/domains/state/storage');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { getVoiceSessionPresentedBinding, getVoiceSessionEndedAttempt } = await import('./voiceSessionStore');
    const { readVoiceConversationScopeMetadata, writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
    const binding = getVoiceSessionPresentedBinding();
    if (!binding) throw new Error('Expected the admitted local binding');
    const carrier = storage.getState().sessions[binding.conversationSessionId];
    const carrierMetadata = carrier?.metadata;
    if (!carrier || !carrierMetadata) throw new Error('Expected the admitted conversation carrier metadata');
    const admittedBindings = voiceSessionBindingStore.getState();
    await act(async () => {
      storage.getState().applySessions([{
        ...carrier,
        metadata: writeVoiceConversationScopeMetadata(carrierMetadata, {
          kind: 'session_root', sessionRootId: 'updated-conversation-root',
        }),
      }]);
    });
    expect(readVoiceConversationScopeMetadata(storage.getState().sessions[carrier.id]?.metadata)).toEqual({
      kind: 'session_root', sessionRootId: 'updated-conversation-root',
    });
    expect(voiceSessionBindingStore.getState()).toBe(admittedBindings);
    await act(async () => { await mounted.lifecycle.stop(binding.controlSessionId); });
    expect(getVoiceSessionEndedAttempt()?.conversationScope).toEqual({
      kind: 'session_root', sessionRootId: 'updated-conversation-root',
    });
  });

  it('does not adopt a synced binding for an unbound live direct-session attempt', async () => {
    const mounted = await mountGeneratedLocalRuntime('local_conversation');
    const { storage } = await import('@/sync/domains/state/storage');
    const { getVoiceSessionPresentedBinding } = await import('./voiceSessionStore');
    const { writeVoiceConversationBindingMetadata } = await import('@/voice/binding/voiceConversationBindingMetadata');
    const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/control/contract');
    const { syncPersistedVoiceConversationBindings, voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
    const foreignBinding = { adapterId: 'local_conversation', controlSessionId: mounted.target.sessionId,
      conversationSessionId: 'remote-carrier', conversationSessionAddress: { ...mounted.target, sessionId: 'remote-carrier' },
      targetSessionAddress: mounted.target, transcriptMode: 'native_session' as const, updatedAt: Date.now() };
    await act(async () => {
      storage.getState().applySessions([createSessionFixture({ id: foreignBinding.conversationSessionId,
        serverId: mounted.target.serverId, metadata: writeVoiceConversationBindingMetadata({
          ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        }, foreignBinding) })]);
      // Apply the decoded Sync projection through its real binding owner. The
      // warm Vitest graph may load the bridge before its subscription is registered.
      syncPersistedVoiceConversationBindings();
    });
    expect(voiceSessionBindingStore.getState().persistedBindingsByConversationSessionId[foreignBinding.conversationSessionId])
      .toMatchObject(foreignBinding);
    expect(getVoiceSessionPresentedBinding()).toBeNull();
    expect(voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: mounted.target.sessionId })).toBeNull();
    expect(voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: foreignBinding.conversationSessionId })).toBeNull();
    expect(voiceConversationBindingResolver.resolveLatest({ controlSessionIds: [mounted.target.sessionId] })).toBeNull();
    expect(mounted.lifecycle.getSnapshot()).toMatchObject({ sessionId: mounted.target.sessionId, status: 'connected' });
  });

  it('keeps local microphone custody when a second client syncs a binding and acknowledged continuation', async () => {
    const mounted = await mountGeneratedElevenLabsRuntime();
    const { storage } = await import('@/sync/domains/state/storage');
    const { getVoiceSessionPresentedBinding, getVoiceSessionEndedAttempt, getVoiceSessionAttemptId, getVoiceSessionArrivedAttemptId } = await import('./voiceSessionStore');
    const { writeVoiceConversationBindingMetadata } = await import('@/voice/binding/voiceConversationBindingMetadata');
    const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/control/contract');
    const { createVoiceContinuationProjection } = await import('@/voice/transcript/voiceContinuationProjection');
    const { createVoiceTranscriptProjector } = await import('@/voice/transcript/VoiceTranscriptProjector');
    const { persistSessionTranscriptMessage } = await import('@happier-dev/session-core/messages');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { readVoiceContinuationProvenance } = await import('@/voice/transcript/voiceTranscriptNoteMeta');
    const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
    const { voiceHooks } = await import('@/voice/context/voiceHooks');
    const { getDeviceAnalyticsId } = await import('@/track/settingsAnalytics/deviceAnalyticsIdentity');
    const { syncPersistedVoiceConversationBindings, voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const binding = getVoiceSessionPresentedBinding();
    if (!binding) throw new Error('Expected the admitted local binding');
    const attemptId = getVoiceSessionAttemptId();
    const conversation = binding.conversationSessionAddress;
    // Observe this client's actual first ACK before assigning the independent
    // client's next sequence. Otherwise the fixture creates two seq-1 notes.
    await waitForTestEvent(storage.subscribe, () => readStoredSessionMessages(storage.getState(), conversation.sessionId),
      messages => messages.some(message => readVoiceContinuationProvenance(message.meta)?.deviceId === getDeviceAnalyticsId()));
    expect(readStoredSessionMessages(storage.getState(), conversation.sessionId)
      .some(message => readVoiceContinuationProvenance(message.meta)?.deviceId === getDeviceAnalyticsId())).toBe(true);
    const boundary = storage.getState().sessions[conversation.sessionId]?.seq ?? 0;
    const remoteDevice = `${getDeviceAnalyticsId()}-other-device`;
    const remote = createVoiceContinuationProjection();
    const remoteSnapshot = mounted.lifecycle.getSnapshot();
    const note = remote.update({ snapshot: remoteSnapshot, binding, deviceId: remoteDevice, sessionSeq: boundary });
    if (!note) throw new Error('Expected a connected second-client continuation');
    const foreignBinding = { ...binding, conversationSessionId: 'other-client-carrier',
      conversationSessionAddress: { ...conversation, sessionId: 'other-client-carrier' },
      targetSessionAddress: conversation, updatedAt: binding.updatedAt + 1 };
    await act(async () => {
      storage.getState().applySessions([createSessionFixture({ id: foreignBinding.conversationSessionId,
        serverId: conversation.serverId, metadata: writeVoiceConversationBindingMetadata({
          ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        }, foreignBinding) })]);
      syncPersistedVoiceConversationBindings();
    });
    expect(voiceSessionBindingStore.getState().persistedBindingsByConversationSessionId[foreignBinding.conversationSessionId])
      .toMatchObject({ conversationSessionAddress: foreignBinding.conversationSessionAddress });
    expect(getVoiceSessionPresentedBinding()).toMatchObject(binding);
    expect(getVoiceSessionAttemptId()).toBe(attemptId);
    expect(mounted.lifecycle.getSnapshot().status).toBe('connected');

    // Only Home's acknowledgement is substituted. The note writer, strict codec,
    // normalized message and mounted Sync→continuation→local End path stay real.
    let persistence: ReturnType<typeof persistSessionTranscriptMessage> | undefined;
    const projector = createVoiceTranscriptProjector({ getState: storage.getState,
      persistFinal: input => {
        persistence = persistSessionTranscriptMessage({ sessionEncryptionMode: 'plain', request: async () =>
          Response.json({ didWrite: true, message: { id: 'remote-continuation', localId: input.localId,
            seq: boundary + 1, createdAt: Date.now() } }) }, input);
        return persistence;
      } });
    await projector.projectNoteText({ conversationSessionId: conversation.sessionId, text: 'Voice continued.', ...note });
    const persisted = await persistence;
    if (!persisted) throw new Error('Expected an acknowledged continuation');
    const received = reducer(createReducer(), [persisted.message]).messages;
    expect(received).toHaveLength(1);
    // Sensitivity: without the actual registered controller the same Sync note
    // cannot reach local End. Restoring the registration must make it retire.
    setVoiceSessionLifecycleController(null);
    await act(async () => { voiceHooks.onMessages(conversation, received); });
    expect(mounted.lifecycle.getSnapshot().status).toBe('connected');
    setVoiceSessionLifecycleController(mounted.lifecycle);
    await act(async () => { voiceHooks.onMessages(conversation, received); });
    await waitForTestEvent(mounted.lifecycle.subscribe, () => mounted.lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
    expect(mounted.lifecycle.getSnapshot().status).toBe('disconnected');
    expect(getVoiceSessionEndedAttempt()).toMatchObject({ attemptId, conversationSessionAddress: conversation,
      reason: { kind: 'continued_elsewhere', continuation: note.continuation } });
    expect(remote.observe(conversation, received)).toBeNull();
    expect(sdk.endSession).toHaveBeenCalledOnce();

    // The arriving client hydrates the same acknowledged conversation. This uses
    // the ordinary reducer and observed sequence before a fresh real Start.
    await act(async () => {
      storage.getState().applyMessages(conversation.sessionId, [persisted.message]);
      const session = storage.getState().sessions[conversation.sessionId];
      if (!session) throw new Error('Expected the retained synced conversation');
      storage.getState().applySessions([{ ...session, seq: boundary + 1 }]);
      await mounted.lifecycle.toggle(null);
    });
    expect(mounted.lifecycle.getSnapshot().status).toBe('connected');
    expect(getVoiceSessionPresentedBinding()?.conversationSessionAddress).toEqual(conversation);
    const arrivingAttemptId = getVoiceSessionAttemptId();
    expect(arrivingAttemptId).not.toBeNull();
    expect(getVoiceSessionArrivedAttemptId()).toBe(arrivingAttemptId);
    await act(async () => { voiceHooks.onMessages(conversation, received); });
    expect(mounted.lifecycle.getSnapshot().status).toBe('connected');
  });

  it('persists the connected device continuation before any Agent turn on an empty carrier', async () => {
    const connection = createDeferred<void>();
    const mounted = await prepareGeneratedVoiceRuntime({ startGate: connection.promise });
    const { storage } = await import('@/sync/domains/state/storage');
    const { getVoiceSessionPresentedBinding } = await import('./voiceSessionStore');
    const { readVoiceContinuationProvenance } = await import('@/voice/transcript/voiceTranscriptNoteMeta');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { getDeviceAnalyticsId } = await import('@/track/settingsAnalytics/deviceAnalyticsIdentity');
    let start: Promise<void> | undefined;
    await act(async () => { start = mounted.lifecycle.toggle(null); });
    try {
      await waitForSdkCall('startSession', 1);
      expect(sdk.startSession).toHaveBeenCalledOnce();
      expect(mounted.lifecycle.getSnapshot().status).toBe('connecting');
      expect(mounted.httpRequests.filter(request => request.method === 'POST' && request.path.endsWith('/messages'))).toEqual([]);
    } finally {
      connection.resolve();
      await act(async () => { await start; });
    }
    const binding = getVoiceSessionPresentedBinding();
    if (!binding) throw new Error('Expected an admitted connected carrier');
    expect(mounted.agentRequests).toEqual([]);
    const notes = await waitForTestEvent(storage.subscribe, () => readStoredSessionMessages(storage.getState(), binding.conversationSessionId)
      .filter(message => readVoiceContinuationProvenance(message.meta) !== null), messages => messages.length > 0);
    expect(notes, JSON.stringify(mounted.httpRequests)).toHaveLength(1);
    expect(notes[0]?.seq).toBe(1);
    expect(readVoiceContinuationProvenance(notes[0]?.meta)).toMatchObject({
      deviceId: getDeviceAnalyticsId(), conversation: binding.conversationSessionAddress,
    });
  });

  it('retries a failed connected continuation with the same identity after Home recovery, then acknowledges once', async () => {
    const firstResponse = createDeferred<Response>();
    const firstWrite = createDeferred<void>();
    const writes: string[] = [];
    const mounted = await prepareGeneratedVoiceRuntime({ transcriptResponse: async ({ localId }) => {
      writes.push(localId);
      firstWrite.resolve();
      return writes.length === 1 ? firstResponse.promise : null;
    } });
    const { storage } = await import('@/sync/domains/state/storage');
    const { getVoiceSessionPresentedBinding } = await import('./voiceSessionStore');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { readVoiceContinuationProvenance } = await import('@/voice/transcript/voiceTranscriptNoteMeta');
    await act(async () => { await mounted.lifecycle.toggle(null); });
    await firstWrite.promise;
    expect(writes).toHaveLength(1);
    const binding = getVoiceSessionPresentedBinding();
    if (!binding) throw new Error('Expected a connected carrier');
    const notes = () => readStoredSessionMessages(storage.getState(), binding.conversationSessionId)
      .filter(message => readVoiceContinuationProvenance(message.meta));
    expect(notes()).toEqual([]);
    // Pending publication cannot fan out on repeated carrier updates.
    const updateCarrier = () => {
      const session = storage.getState().sessions[binding.conversationSessionId]!;
      storage.getState().applySessions([{ ...session, seq: session.seq + 1 }]);
    };
    await act(async () => { updateCarrier(); });
    expect(writes).toHaveLength(1);
    await act(async () => { firstResponse.resolve(Response.json({}, { status: 503 })); });
    // Recovered Home/current carrier facts are the existing retry trigger.
    await act(async () => { updateCarrier(); });
    await waitForTestEvent(storage.subscribe, notes, messages => messages.length > 0);
    expect(notes()).toHaveLength(1);
    expect(writes).toEqual([writes[0], writes[0]]);
    await act(async () => { updateCarrier(); });
    expect(writes).toHaveLength(2);
    expect(mounted.lifecycle.getSnapshot().status).toBe('connected');
    expect(mounted.agentRequests).toEqual([]);
  });

  it('does not renormalize materialized Voice settings for connectivity or Profile presentation updates', async () => {
    platformOsMock.value = 'web';
    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...storage.getState().settings.voice, providerId: 'off' } }, storage.getState().settings));
    let commits = 0;
    const screen = await renderRuntimeScreen(React.createElement(React.Profiler, {
      id: 'voice-runtime', onRender: () => { commits += 1; },
    }, React.createElement(VoiceSessionRuntime)));
    generatedRuntimeScreens.push(screen);

    const voice = storage.getState().settings.voice;
    const providers = voice.providers;
    const providersDescriptor = Object.getOwnPropertyDescriptor(voice, 'providers');
    if (!providersDescriptor) throw new Error('Parsed Voice fixture is missing its providers field');
    let providerReads = 0;
    // Observe work on real stored input; the privacy reader and normalization remain real.
    try {
      Object.defineProperty(voice, 'providers', {
        configurable: true,
        get() {
          providerReads += 1;
          return providers;
        },
      });
      await act(async () => {
        storage.getState().setEndpointConnectivity({
          status: 'online', reason: null, attempt: 1, nextRetryAt: null,
          lastConnectedAt: 1, lastDisconnectedAt: null, lastErrorMessage: null,
        });
      });

      expect(storage.getState().settings.voice).toBe(voice);
      expect(storage.getState().endpointStatus).toBe('online');
      expect(providerReads).toBe(0);
    } finally {
      Object.defineProperty(voice, 'providers', providersDescriptor);
    }

    const canonicalVoice = storage.getState().settings.voiceSettingsV1;
    const dictationDescriptor = Object.getOwnPropertyDescriptor(canonicalVoice, 'dictation');
    if (!dictationDescriptor) throw new Error('Materialized Voice fixture is missing dictation');
    const dictation = canonicalVoice.dictation;
    let dictationReads = 0;
    const commitsBeforeProfile = commits;
    try {
      // Count normalization work on the real projection, without mocking its parser.
      // A Session runtime does not need to rebuild unrelated dictation defaults.
      Object.defineProperty(canonicalVoice, 'dictation', {
        configurable: true,
        get() { dictationReads += 1; return dictation; },
      });
      for (let tick = 0; tick < 5; tick++) {
        await act(async () => {
          storage.getState().applyProfile({ ...storage.getState().profile, firstName: `Updated-${tick}` });
        });
      }

      expect(commits - commitsBeforeProfile).toBe(0);
      expect(storage.getState().settings.voiceSettingsV1).toBe(canonicalVoice);
      expect(dictationReads).toBe(0);
    } finally {
      Object.defineProperty(canonicalVoice, 'dictation', dictationDescriptor);
    }
  });

  it('publishes the active adapter snapshot into the voice session store', async () => {
    const { lifecycle } = await mountGeneratedElevenLabsRuntime();
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
    expect(getVoiceSessionSnapshot()).toMatchObject({
      adapterId: ELEVENLABS_PROVIDER_ID, sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected', mode: 'idle', canStop: true,
    });
  });

  it('configures exact-session Codex Voice without requiring its global account binding', async () => {
    platformOsMock.value = 'web';
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, CODEX_PROVIDER_ID, { globalConnectedServices: null });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: CODEX_PROVIDER_ID } }, storage.getState().settings));
    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const screen = await renderRuntimeScreen(React.createElement(VoiceSessionRuntime));
    generatedRuntimeScreens.push(screen);

    expect(getVoiceSessionLifecycleController()?.getConfiguredProviderId()).toBe(CODEX_PROVIDER_ID);
  });

  it('sends only current-UI tool availability changes to the lifecycle owner', async () => {
    const { screen, lifecycle, runtime } = await mountGeneratedElevenLabsRuntime({ currentUi: true });
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(sdk.startSession).toHaveBeenCalledOnce();

    await act(async () => {
      await setCurrentUiContextToolSetMode('automatic');
      await screen.update(runtime);
    });
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(sdk.startSession).toHaveBeenCalledOnce();
    expect(sdk.endSession).not.toHaveBeenCalled();

    await act(async () => {
      await setCurrentUiContextToolSetMode('off');
      await screen.update(runtime);
    });
    await waitForSdkCall('startSession', 2);
    expect(sdk.startSession).toHaveBeenCalledTimes(2);
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'connected');
    expect(sdk.endSession).toHaveBeenCalledOnce();
    expect(lifecycle.getSnapshot().status).toBe('connected');

    await act(async () => {
      await setCurrentUiContextToolSetMode('on_demand');
      await screen.update(runtime);
    });
    await waitForSdkCall('startSession', 3);
    expect(sdk.startSession).toHaveBeenCalledTimes(3);
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'connected');
    expect(sdk.endSession).toHaveBeenCalledTimes(2);
    expect(lifecycle.getSnapshot().status).toBe('connected');
  });

  it('updates the store when an adapter subscription fires', async () => {
    const { options, lifecycle } = await mountGeneratedElevenLabsRuntime();
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    expect(getVoiceSessionSnapshot().mode).toBe('idle');
    if (!options.onModeChange) throw new Error('Real generated provider did not subscribe to SDK mode events');
    await act(async () => {
      options.onModeChange?.({ mode: 'speaking' });
    });
    await waitForTestEvent(lifecycle.subscribe, () => lifecycle.getSnapshot(), snapshot => snapshot.mode === 'speaking');
    expect(getVoiceSessionSnapshot().mode).toBe('speaking');
    expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
  });

  it('rearms a failed provider-auth preparation after credential authority changes and waits for explicit start', async () => {
    const { environment, browser, screen, lifecycle, runtime } = await prepareMountedOpenAiRuntime({ credentialSource: 'connectedAccount' });
    const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
    const { sync } = await import('@/sync/sync');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    await environment.selectConnectedAccount('work');
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    environment.accountProfile = AccountProfileSchema.parse({
      ...environment.accountProfile,
      connectedServicesV2: [{ serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'needs_reauth', kind: 'token' }], groups: [],
      }],
      connectedAccountsV4: [{
        ref: { service, accountId: 'work' }, status: 'needs_reauth', authenticationModeId: 'api-key',
        configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned',
        credentialRevision: 'csr_initial0000000000000000', scopes: [],
      }],
      connectedServiceCredentialRevisionsV1: [],
    });
    await act(async () => { await sync.refreshProfile(); await screen.update(runtime); });
    let mintRequests = 0;
    environment.mintTransport = async () => {
      mintRequests += 1;
      return Object.freeze({
        status: 401, finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
        headers: Object.freeze({}), body: new TextEncoder().encode('{}'),
      });
    };
    await act(async () => { await lifecycle.toggle(null); });
    expect(getVoiceSessionSnapshot()).toMatchObject({
      status: 'error', errorCode: 'provider_auth_invalid', errorRecoveryAction: 'review_credentials',
    });
    const providerFailure = getVoiceSessionSnapshot();
    await act(async () => { lifecycle.rearmAfterCredentialAuthorityChange({
      agentDefaultAuthorityChanged: true, providerCredentialAuthorityChanged: false,
    }); });
    expect(getVoiceSessionSnapshot()).toEqual(providerFailure);
    expect(browser.peers).toEqual([]);
    expect(browser.micTracks).toEqual([]);
    const requestsBeforeRepair = mintRequests;
    environment.accountProfile = AccountProfileSchema.parse({
      ...environment.accountProfile,
      connectedServicesV2: [{ serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'token' }], groups: [],
      }],
      connectedAccountsV4: [{
        ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'api-key',
        configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned',
        credentialRevision: 'csr_replacement00000000000', scopes: [],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_replacement00000000000',
      }],
    });
    await act(async () => { await sync.refreshProfile(); await screen.update(runtime); });
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
    });
    expect(mintRequests).toBe(requestsBeforeRepair);
    expect(browser.peers).toEqual([]);
    expect(browser.micTracks).toEqual([]);
    environment.mintTransport = async () => {
      mintRequests += 1;
      return Object.freeze({
        status: 200, finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
        headers: Object.freeze({}),
        body: new TextEncoder().encode(JSON.stringify(environment.createClientAuthProviderResponse(
          'ek_source_composed', Math.floor(Date.now() / 1_000) + 60,
        ))),
      });
    };
    let retry: Promise<void> | undefined;
    try {
      await act(async () => { retry = lifecycle.toggle(null); void retry.catch(() => {}); });
      if (!retry) throw new Error('Mounted Voice retry was not admitted');
      const peer = await Promise.race([browser.peerCreated(), retry.then(() => browser.peer)]);
      expect(browser.peers).toHaveLength(1);
      await Promise.race([peer.remoteDescriptionSet, retry]);
      expect(peer.setRemoteDescription, JSON.stringify(lifecycle.getSnapshot())).toHaveBeenCalledOnce();
      browser.peer.channel.open();
      await act(async () => { await retry; });
      expect(mintRequests).toBe(requestsBeforeRepair + 1);
      expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
      expect(getVoiceSessionSnapshot(), JSON.stringify(lifecycle.getSnapshot())).toMatchObject({
        adapterId: OPENAI_PROVIDER_ID, status: 'connected', canStop: true,
      });
      expect(browser.peer.addTrack).toHaveBeenCalledWith(browser.micTrack, browser.micStream);
    } finally {
      await lifecycle.dispose();
      await retry;
    }
  });

  it('retires each Account scope transition once at the Account lifetime boundary', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...storage.getState().settings.voice, providerId: 'off' } }, storage.getState().settings));
    expect(captureActiveServerAccountScopeLifetime()).toBeNull();
    const runtime = React.createElement(VoiceSessionRuntime);
    const screen = await renderRuntimeScreen(runtime);
    generatedRuntimeScreens.push(screen);
    const lifecycle = getVoiceSessionLifecycleController();
    if (!lifecycle) throw new Error('Actual idle Runtime lifecycle unavailable');
    await act(async () => {
      await applyAccountScope({ serverId: 'voice-server', accountId: 'voice-account-a' });
      await screen.update(runtime);
    });
    const accountA = captureActiveServerAccountScopeLifetime();
    if (!accountA) throw new Error('Actual Account A lifetime unavailable');
    let retiredA = 0;
    const subscriptionA = accountA.onRetire(() => { retiredA += 1; });
    let subscriptionB: ReturnType<typeof accountA.onRetire> | undefined;
    try {
      await act(async () => {
        await applyAccountScope({ serverId: 'voice-server', accountId: 'voice-account-b' });
        await screen.update(runtime);
      });
      const accountB = captureActiveServerAccountScopeLifetime();
      if (!accountB) throw new Error('Actual Account B lifetime unavailable');
      expect(accountA.isCurrent()).toBe(false);
      expect(retiredA).toBe(1);
      expect(accountB.isCurrent()).toBe(true);
      expect(accountB.scope.accountId).toBe('voice-account-b');
      let retiredB = 0;
      subscriptionB = accountB.onRetire(() => { retiredB += 1; });
      await act(async () => { await applyAccountScope(null); await screen.update(runtime); });
      expect(captureActiveServerAccountScopeLifetime()).toBeNull();
      expect(accountB.isCurrent()).toBe(false);
      expect(retiredA).toBe(1);
      expect(retiredB).toBe(1);
      await screen.update(runtime);
      expect(retiredA).toBe(1);
      expect(retiredB).toBe(1);
      expect(getVoiceSessionLifecycleController()).toBe(lifecycle);
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    } finally {
      subscriptionA.dispose();
      subscriptionB?.dispose();
    }
  });

  it('classifies ordinary OpenAI credential changes as next-start-only while every Account scope change fences the live attempt', async () => {
    const mounted = await prepareMountedOpenAiRuntime();
    const { environment, browser, lifecycle } = mounted;
    const { storage } = await import('@/sync/domains/state/storage');
    const { applyAccountSettingsSavedSecretMutation } = await import('@happier-dev/protocol/account/settings/savedSecretMutationOwner');
    const { OpenAiRealtimeSettingsV1Schema } = await import('../../../../../packages/plugins/openai/src/protocol/voice/settings');
    const start = lifecycle.toggle(null);
    void start.catch(() => undefined);
    const peer = await Promise.race([browser.peerCreated(), start.then(() => browser.peer)]);
    expect(browser.peers, JSON.stringify(lifecycle.getSnapshot())).toHaveLength(1);
    await Promise.race([peer.remoteDescriptionSet, start]);
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    browser.peer.channel.open();
    await act(async () => { await start; });
    expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, status: 'connected' });

    const selectedSecret = storage.getState().settings.secrets.find(secret => secret.id === 'realtime-openai-composed-secret');
    if (!selectedSecret) throw new Error('Canonical selected SavedSecret unavailable');
    const rotated = applyAccountSettingsSavedSecretMutation(storage.getState().settings, {
      kind: 'rotateGlobal', secretId: selectedSecret.id, expectedUpdatedAt: selectedSecret.updatedAt,
      encryptedValue: { _isSecretValue: true, value: 'selected-secret-next-start' }, updatedAt: selectedSecret.updatedAt + 1,
    });
    await environment.publishAccountSettings(settingsParse(rotated.settings));
    const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, OPENAI_PROVIDER_ID, {
      ...OpenAiRealtimeSettingsV1Schema.parse(storage.getState().settings.voice.providers[OPENAI_PROVIDER_ID]?.config), voice: 'cedar',
    });
    await environment.configureVoice(voice);
    // Equal canonical HTTP hydration must not accidentally retire a live
    // ordinary attempt either; the selected secret/config apply next Start.
    await environment.publishAccountSettings(settingsParse(storage.getState().settings));
    await mounted.screen.update(mounted.runtime);
    expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, status: 'connected' });
    expect(browser.peer.close).not.toHaveBeenCalled();
    expect(browser.micTrack.stop).not.toHaveBeenCalled();

    // Account logout is a real scope transition, unlike ordinary credential
    // currentness. The separate Account transition keeper covers A/B, Home
    // replacement and null admission without a call-only lifecycle classifier.
    await environment.accountConnection.dispose();
    await waitForTestEvent(lifecycle.subscribe, () => lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
    expect(browser.peer.close).toHaveBeenCalledOnce();
    expect(browser.micTrack.stop).toHaveBeenCalledOnce();
    await mounted.screen.unmount();
    generatedRuntimeScreens.splice(generatedRuntimeScreens.indexOf(mounted.screen), 1);
    await environment.dispose();
    openAiRuntimeEnvironments.splice(openAiRuntimeEnvironments.indexOf(environment), 1);
    browser.restore();
    browserBoundaries.splice(browserBoundaries.indexOf(browser), 1);

    const agent = await mountGeneratedCodexRuntime({ global: true });
    const agentStarts = () => agent.agentRequests.filter(request => request.method.endsWith('.start'));
    const agentStops = () => agent.agentRequests.filter(request => request.method.endsWith('.stop'));
    expect(agentStarts()).toHaveLength(1);
    const agentVoice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, CODEX_PROVIDER_ID, {
      globalConnectedServices: { v: 1, bindingsByServiceId: {
        [CODEX_CONNECTED_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'backup' },
      } },
    });
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: agentVoice }, storage.getState().settings));
    await agent.screen.update(agent.runtime);
    await agent.waitForAgentRequests(requests => requests.filter(request => request.method.endsWith('.stop')).length >= 1);
    expect(agentStops()).toHaveLength(1);
    expect(agent.browser.peer.close).toHaveBeenCalledOnce();
    expect(agent.browser.micTrack.stop).toHaveBeenCalledOnce();
    expect(agentStarts()).toHaveLength(1);
    await agent.screen.update(agent.runtime);
    expect(agentStops()).toHaveLength(1);
  });

  it('does not terminate a pending ordinary OpenAI Start for unrelated secret, profile, or revision refreshes', async () => {
    const mounted = await prepareMountedOpenAiRuntime();
    const { environment, browser, lifecycle } = mounted;
    const { storage } = await import('@/sync/domains/state/storage');
    const { applyAccountSettingsSavedSecretMutation } = await import('@happier-dev/protocol/account/settings/savedSecretMutationOwner');
    const { SavedSecretSchema } = await import('@happier-dev/protocol/profiles/backendProfileSchema');
    const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
    const { createAccountVoiceCredentialAuthorityLease } = await import('@/voice/credentials/accountVoiceOperationService');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !environment.entry.declaration.credentials) throw new Error('Actual selected credential authority unavailable');
    const selectedAuthority = createAccountVoiceCredentialAuthorityLease({
      contribution: { pluginId: environment.entry.pluginId, localId: environment.entry.declaration.id },
      providerId: environment.entry.providerId,
      credentialSlotId: environment.entry.declaration.credentials.slot.id,
      purpose: { consumer: { pluginId: environment.entry.pluginId, localId: environment.entry.declaration.id }, purpose: environment.entry.declaration.credentials.slot.purpose },
      isCurrent: lifetime.isCurrent,
    });
    expect(selectedAuthority.isCurrent()).toBe(true);
    const mintGate = createDeferred<void>();
    const mintStarted = createDeferred<void>();
    const providerResponse = environment.providerFetch.getMockImplementation();
    if (!providerResponse) throw new Error('OpenAI HTTP boundary unavailable');
    environment.providerFetch.mockImplementationOnce(async (...args) => {
      // Hold the real provider HTTP response, not the adapter or lifecycle.
      mintStarted.resolve();
      await mintGate.promise;
      return providerResponse(...args);
    });
    const start = lifecycle.toggle(null);
    // The held SDK operation may reject if an assertion fails and cleanup wins.
    void start.catch(() => undefined);
    try {
      await Promise.race([mintStarted.promise, start]);
      expect(environment.providerFetch, JSON.stringify(lifecycle.getSnapshot())).toHaveBeenCalledOnce();
      expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, status: 'connecting' });
      const added = applyAccountSettingsSavedSecretMutation(storage.getState().settings, {
        kind: 'add',
        secret: SavedSecretSchema.parse({ id: 'unrelated-secret', name: 'Unrelated', kind: 'token',
          encryptedValue: { _isSecretValue: true, value: 'unrelated-secret' },
        }),
      });
      await environment.publishAccountSettings(settingsParse(added.settings));
      expect(lifetime.isCurrent(), 'actual Account lifetime after unrelated SavedSecret publication').toBe(true);
      expect(selectedAuthority.isCurrent(), 'selected authority after unrelated SavedSecret publication').toBe(true);
      environment.accountProfile = AccountProfileSchema.parse({
        ...environment.accountProfile,
        connectedServicesV2: [{ serviceId: 'anthropic',
          profiles: [{ profileId: 'unrelated-profile', status: 'connected', kind: 'token' }], groups: [],
        }],
        connectedServiceCredentialRevisionsV1: [{ serviceId: 'anthropic', profileId: 'unrelated-profile',
          credentialRevision: 'csr_revision200000000000000',
        }],
      });
      const { sync } = await import('@/sync/sync');
      await sync.refreshProfile();
      expect(selectedAuthority.isCurrent(), 'selected authority after unrelated Profile HTTP refresh').toBe(true);
      await mounted.screen.update(mounted.runtime);
      expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID, status: 'connecting' });
      expect(browser.peers).toEqual([]);
      expect(browser.micTracks).toEqual([]);

      mintGate.resolve();
      const peer = await Promise.race([browser.peerCreated(), start.then(() => browser.peer)]);
      expect(browser.peers, JSON.stringify(lifecycle.getSnapshot())).toHaveLength(1);
      await Promise.race([peer.remoteDescriptionSet, start]);
      expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
      browser.peer.channel.open();
      await act(async () => { await start; });
      expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: OPENAI_PROVIDER_ID,
        status: 'connected', canStop: true,
      });
      expect(browser.peer.addTrack).toHaveBeenCalledWith(browser.micTrack, browser.micStream);
      expect(browser.peer.close).not.toHaveBeenCalled();
      expect(browser.micTrack.stop).not.toHaveBeenCalled();
      expect(environment.providerFetch).toHaveBeenCalledTimes(2);
    } finally {
      mintGate.resolve();
      // If a pre-connect assertion fails, cancel through the real owner rather
      // than opening an SDK channel before its listener has been installed.
      await lifecycle.dispose();
      await start.catch(() => undefined);
    }
  });

  it('fences an established global Agent attachment exactly once when its selected group changes active profile', async () => {
    const mounted = await mountGeneratedCodexRuntime({ global: true, group: true });
    const stops = () => mounted.agentRequests.filter(request => request.method.endsWith('.stop'));
    const starts = () => mounted.agentRequests.filter(request => request.method.endsWith('.start'));
    const admittedSessionId = starts()[0]?.targetId;
    expect(admittedSessionId).toMatch(/^mounted-codex-global-/);
    expect(stops()).toEqual([]);
    await act(async () => {
      await mounted.publishProfile({
        ...mounted.profile,
        connectedServicesV2: mounted.profile.connectedServicesV2.map(service => ({
          ...service, groups: service.groups?.map(group => ({ ...group, activeProfileId: 'backup', generation: 2 })),
        })),
      });
    });
    await mounted.waitForAgentRequests(requests => requests.filter(request => request.method.endsWith('.stop')).length >= 1);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]?.targetId).toBe(admittedSessionId);
    await waitForTestEvent(mounted.lifecycle.subscribe, () => mounted.lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected' && snapshot.canStop === false);
    expect(mounted.lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(starts()).toHaveLength(1);
    await act(async () => {
      await mounted.publishProfile({
        ...mounted.profile,
        connectedServicesV2: [...mounted.profile.connectedServicesV2, {
          serviceId: 'openai', profiles: [{ profileId: 'unrelated', status: 'connected', kind: 'token' }], groups: [],
        }],
      });
    });
    expect(stops()).toHaveLength(1);
    expect(starts()).toHaveLength(1);
  });

  it.each([
    ['is deleted', []],
    ['is revoked', [{ profileId: 'work', status: 'needs_reauth', kind: 'oauth' }]],
  ] as const)(
    'fences an established global Agent attachment exactly once when its selected profile %s',
    async (_caseName, nextProfiles) => {
      const mounted = await mountGeneratedCodexRuntime({ global: true });
      const starts = () => mounted.agentRequests.filter(request => request.method.endsWith('.start'));
      const stops = () => mounted.agentRequests.filter(request => request.method.endsWith('.stop'));
      const admittedSessionId = starts()[0]?.targetId;
      expect(stops()).toEqual([]);
      await act(async () => {
        await mounted.publishProfile({
          ...mounted.profile,
          connectedServicesV2: mounted.profile.connectedServicesV2.map(service => ({ ...service,
            profiles: [...service.profiles.filter(profile => profile.profileId !== 'work'), ...nextProfiles],
          })),
        });
      });
      await mounted.waitForAgentRequests(requests => requests.filter(request => request.method.endsWith('.stop')).length >= 1);
      expect(stops()).toHaveLength(1);
      expect(stops()[0]?.targetId).toBe(admittedSessionId);
      await waitForTestEvent(mounted.lifecycle.subscribe, () => mounted.lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected' && snapshot.canStop === false);
      expect(mounted.lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
      expect(starts()).toHaveLength(1);
      await act(async () => { await mounted.publishProfile(mounted.profile); });
      expect(stops()).toHaveLength(1);
      expect(starts()).toHaveLength(1);
    },
  );

  it('does not fence an established global Agent attachment for an unrelated Connected Services update', async () => {
    const mounted = await mountGeneratedCodexRuntime({ global: true });
    const active = mounted.lifecycle.getSnapshot();
    await act(async () => {
      await mounted.publishProfile({
        ...mounted.profile,
        connectedServicesV2: [...mounted.profile.connectedServicesV2, {
          serviceId: 'openai', profiles: [{ profileId: 'unrelated', status: 'connected', kind: 'token' }], groups: [],
        }],
        connectedServiceCredentialRevisionsV1: [...mounted.profile.connectedServiceCredentialRevisionsV1, {
          serviceId: 'openai', profileId: 'unrelated', credentialRevision: 'csr_revision200000000000000',
        }],
      });
    });
    expect(mounted.lifecycle.getSnapshot()).toEqual(active);
    expect(mounted.agentRequests.filter(request => request.method.endsWith('.stop'))).toEqual([]);
    expect(mounted.agentRequests.filter(request => request.method.endsWith('.start'))).toHaveLength(1);
    expect(mounted.browser.peer.close).not.toHaveBeenCalled();
    expect(mounted.browser.micTrack.stop).not.toHaveBeenCalled();
  });

  it('fences an established direct Agent attachment only when its server-account scope changes', async () => {
    const mounted = await mountGeneratedCodexRuntime();
    const { screen, lifecycle, runtime, target, agentRequests } = mounted;
    const stops = () => agentRequests.filter(request => request.method.endsWith('.stop'));
    const starts = () => agentRequests.filter(request => request.method.endsWith('.start'));
    await screen.update(runtime);
    expect(stops()).toEqual([]);
    await act(async () => {
      await mounted.publishProfile({
        ...mounted.profile,
        connectedServicesV2: mounted.profile.connectedServicesV2.map(service => ({
          ...service, groups: service.groups?.map(group => ({ ...group, activeProfileId: 'backup', generation: 2 })),
        })),
      });
    });
    expect(stops()).toEqual([]);
    expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: CODEX_PROVIDER_ID, sessionId: target.sessionId, status: 'connected' });
    await act(async () => {
      await applyAccountScope({ serverId: 'server-b', accountId: 'account-b' }, { address: target, boundary: mounted.sessionHttp });
      await screen.update(runtime);
    });
    await waitForTestEvent(lifecycle.subscribe, () => lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
    expect(mounted.browser.peer.close).toHaveBeenCalledOnce();
    expect(mounted.browser.micTrack.stop).toHaveBeenCalledOnce();
    await mounted.waitForAgentRequests(requests => requests.filter(request => request.method.endsWith('.stop')).length >= 1);
    expect(stops(), JSON.stringify(retiredAccountHttpRequests)).toHaveLength(1);
    expect(stops()[0]?.targetId).toBe(target.sessionId);
    await waitForTestEvent(lifecycle.subscribe, () => lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected' && snapshot.canStop === false);
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(starts()).toHaveLength(1);
    await screen.update(runtime);
    expect(stops()).toHaveLength(1);
    expect(starts()).toHaveLength(1);
  });

  it('fences an established ordinary provider attempt when the server-account scope changes', async () => {
    const { screen, lifecycle, runtime } = await mountGeneratedElevenLabsRuntime();

    await act(async () => {
      await screen.update(runtime);
      await Promise.resolve();
    });
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(sdk.endSession).not.toHaveBeenCalled();

    const replacement = applyAccountScope({ serverId: 'server-b', accountId: 'account-b' });
    // Account admission is the real asynchronous operation, not React's
    // renderer flush. Join it before updating the mounted React boundary.
    await replacement;
    await act(async () => {
      await screen.update(runtime);
      await Promise.resolve();
    });

    await waitForSdkCall('endSession', 1);
    expect(sdk.endSession).toHaveBeenCalledOnce();
    await waitForTestEvent(lifecycle.subscribe, () => lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
    expect(lifecycle.getSnapshot().status).toBe('disconnected');
    expect(sdk.startSession).toHaveBeenCalledOnce();
  });

  it('synchronously retires an ordinary realtime attempt before a retained current-UI handler can reach either Account port', async () => {
    const { options, screen, runtime } = await mountGeneratedElevenLabsRuntime({ currentUi: true });
    const { getActionSpec } = await import('@happier-dev/protocol');
    const { VOICE_ACTION_EXECUTE_TOOL_NAME, VoiceActionExecuteInputSchema } = await import('@/voice/tools/voiceActionExecution');
    const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !accountConnection) throw new Error('Actual mounted Account lifetime unavailable');
    const accountA = { serverId: accountConnection.home.id, accountId: 'account-a' };
    const tools = ['ui.current_context.read', 'ui.current_context.command.invoke'] as const;
    const retained = tools.map(actionId => {
      const spec = getActionSpec(actionId);
      // Ordinary provider discovery ships reads directly and effects through
      // the canonical action_execute transport, not an invented SDK command.
      const name = actionId === 'ui.current_context.read' ? spec.bindings?.voiceClientToolName : VOICE_ACTION_EXECUTE_TOOL_NAME;
      const handler = name ? options.clientTools?.[name] : null;
      if (!name || !handler || !options.onIncomingEvent) throw new Error(`Generated current-UI SDK tool unavailable: ${actionId}/${name}; ${Object.keys(options.clientTools ?? {}).join(',')}`);
      const input = spec.inputSchema.parse(actionId === 'ui.current_context.read' ? {} : { commandId: 'retired-account-command' });
      const parameters = actionId === 'ui.current_context.read' ? input : VoiceActionExecuteInputSchema.parse({ actionId, input });
      // This is the vendor wire custody producer, not a copied AppShell port.
      options.onIncomingEvent({ type: 'client_tool_call', client_tool_call: {
        tool_call_id: actionId, tool_name: name, parameters,
      } });
      return () => handler(parameters);
    });
    const close = createDeferred<void>();
    sdk.endSession.mockImplementation(() => close.promise);
    try {
      // No re-render/microtask: the real Account retirement synchronously
      // invalidates every retained read/effect SDK callback before media closes.
      retireActiveServerAccountScopeLifetime();
      const deliveries = retained.map(deliver => deliver());
      expect(lifetime.isCurrent()).toBe(false);
      expect(sdk.endSession).toHaveBeenCalledOnce();
      for (const delivery of deliveries) await expect(delivery).rejects.toThrow('tool_cancelled');
      let switched = false;
      const replacement = applyAccountScope({ ...accountA, accountId: 'account-b' }).then(() => { switched = true; });
      await Promise.resolve();
      expect(switched).toBe(false);
      for (const deliver of retained) await expect(deliver()).rejects.toThrow('tool_cancelled');
      close.resolve(undefined);
      await replacement;
      await screen.update(runtime);
      for (const deliver of retained) await expect(deliver()).rejects.toThrow('tool_cancelled');
      expect(sdk.startSession).toHaveBeenCalledOnce();
    } finally {
      close.resolve(undefined);
    }
  });

  it('fails closed for a no-Account realtime Start before Account B layout admission without publishing an old SDK handler', async () => {
    platformOsMock.value = 'web';
    const browser = installVoiceWebRtcBrowserBoundary();
    browserBoundaries.push(browser);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', createMountedBrowserDocument());
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { OPENAI_REALTIME_DEFAULT_SETTINGS } = await import('../../../../../packages/plugins/openai/src/protocol/voice/settings');
    expect(getActiveServerAccountScope()).toBeNull();
    const voice = writeVoiceProviderSettingsConfig(voiceSettingsParse({ providerId: OPENAI_PROVIDER_ID }), OPENAI_PROVIDER_ID, OPENAI_REALTIME_DEFAULT_SETTINGS);
    storage.getState().applySettingsLocal({
      ...normalizeVoiceSettingsLocalDelta({ voice }, storage.getState().settings),
      featureToggles: { ...storage.getState().settings.featureToggles, voice: true },
    });
    sdk.startSession.mockReset();
    sdk.endSession.mockReset();
    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { CurrentUiContextProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    const layoutScopes: Array<ReturnType<typeof getActiveServerAccountScope>> = [];
    const renderRuntime = (credentials: React.ComponentProps<typeof InjectedAuthProvider>['credentials']) =>
      <InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider>
          <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
            <LayoutCommitBoundary onLayout={() => {
              layoutScopes.push(getActiveServerAccountScope());
              expect(sdk.startSession).not.toHaveBeenCalled();
              expect(browser.peers).toEqual([]);
              expect(browser.micTracks).toEqual([]);
              // No SDK conversation/callback was admitted under null Account,
              // so neither a read nor an effect can cross this B layout commit.
              expect(getVoiceSessionLifecycleController()?.getSnapshot().canStop).toBe(false);
            }}><VoiceSessionRuntime /></LayoutCommitBoundary>
          </PluginSurfaceFocusEligibilityProvider>
        </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
      </InjectedAuthProvider>;
    const screen = await renderRuntimeScreen(renderRuntime(null));
    generatedRuntimeScreens.push(screen);
    const lifecycle = getVoiceSessionLifecycleController();
    if (!lifecycle) throw new Error('Actual no-Account lifecycle unavailable');
    await act(async () => { await lifecycle.toggle(null); });
    expect(getActiveServerAccountScope()).toBeNull();
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'error', canStop: false });
    expect(sdk.startSession).not.toHaveBeenCalled();
    expect(sdk.endSession).not.toHaveBeenCalled();
    expect(browser.peers).toEqual([]);
    expect(browser.micTracks).toEqual([]);

    // The former fake active no-Account OpenAI tuple bypassed the real
    // Sync.ensureHostedSystemSession Account guard (and credential admission).
    // Reachable retained callback retirement is kept separately at actual A/B.
    await act(async () => {
      await applyAccountScope({ serverId: 'no-account-layout-home', accountId: 'account-b' });
      if (!accountConnection) throw new Error('Actual Account B unavailable');
      await screen.update(renderRuntime(accountConnection.credentials));
    });
    expect(layoutScopes[0]).toBeNull();
    expect(layoutScopes.at(-1)).toEqual({ serverId: accountConnection!.home.id, accountId: 'account-b' });
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(sdk.startSession).not.toHaveBeenCalled();
    expect(sdk.endSession).not.toHaveBeenCalled();
    expect(browser.peers).toEqual([]);
    expect(browser.micTracks).toEqual([]);
  });

  it('fences a pending ordinary provider Start when the server-account scope changes mid-preparation', async () => {
    const startDeferred = createDeferred<void>();
    // SDK carrier creation is genuinely non-abortable. Account retirement must
    // revoke the real attempt before its late carrier can publish connected.
    const { screen, lifecycle, runtime } = await prepareGeneratedVoiceRuntime({ startGate: startDeferred.promise });
    const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Pending SDK attempt Account lifetime unavailable');
    const statuses: string[] = [];
    const unsubscribe = lifecycle.subscribe(() => statuses.push(lifecycle.getSnapshot().status));
    let start: Promise<void> | undefined;
    let switching: Promise<AccountScope> | undefined;
    await act(async () => {
      start = lifecycle.toggle(null);
      void start.catch(() => undefined);
    });
    try {
      await waitForSdkCall('startSession', 1);
      expect(sdk.startSession).toHaveBeenCalledOnce();
      expect(lifecycle.getSnapshot().status).toBe('connecting');
      switching = applyAccountScope({ serverId: 'server-b', accountId: 'account-b' });
      void switching.catch(() => undefined);
      // Real Account admission may join old media cleanup. Observe retirement
      // before releasing its non-abortable SDK carrier; do not await B first.
      await waitForTestEvent(notify => {
        const retirement = accountLifetime.onRetire(notify);
        return () => retirement.dispose();
      }, accountLifetime.isCurrent, current => !current);
      expect(accountLifetime.isCurrent()).toBe(false);
      expect(statuses).not.toContain('connected');
      startDeferred.resolve();
      await act(async () => {
        await Promise.all([start, switching]);
        await screen.update(runtime);
      });
      await waitForSdkCall('endSession', 1);
      expect(sdk.endSession).toHaveBeenCalledOnce();
      expect(statuses).not.toContain('connected');
      expect(lifecycle.getSnapshot().status).toBe('disconnected');
      // The late SDK carrier is closed and the actual admission owner makes
      // the microphone available to Account B again.
      const readmitted = voiceCaptureAdmissionController.acquire('conversation');
      expect(readmitted.status).toBe('acquired');
      if (readmitted.status === 'acquired') readmitted.lease.release();
    } finally {
      startDeferred.resolve();
      await Promise.all([start, switching]);
      unsubscribe();
    }
  });

  it('prefers the selected provider adapter snapshot when multiple adapters are active', async () => {
    const { lifecycle, target } = await mountGeneratedLocalRuntime('local_conversation');
    const { getVoiceAdapterRegistry } = await import('./voiceAdapterRegistry');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    // Both public Local adapters project the same actual Local machine. Their
    // provider identity differs; no invented second capture/session is needed.
    const direct = getVoiceAdapterRegistry().get('local_direct')?.getSnapshot();
    const conversation = getVoiceAdapterRegistry().get('local_conversation')?.getSnapshot();
    expect(direct).toMatchObject({ adapterId: 'local_direct', sessionId: target.sessionId, status: 'connected' });
    expect(conversation).toMatchObject({ adapterId: 'local_conversation', sessionId: target.sessionId, status: 'connected' });
    expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
    expect(getVoiceSessionSnapshot()).toMatchObject({ adapterId: 'local_conversation', sessionId: target.sessionId, status: 'connected' });
  });

  it('keeps the active store owner stable when the selected provider changes mid-call', async () => {
    const { screen, lifecycle, runtime, target } = await mountGeneratedLocalRuntime();
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const stopped = createDeferred<void>();
    nativeAudio.nativeModule.restoreAudioSession.mockImplementationOnce(() => stopped.promise);
    try {
      await act(async () => {
        const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, 'local_conversation',
          VoiceLocalConversationSchema.parse({ tts: { autoSpeakReplies: false } }));
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: 'local_conversation' } }, storage.getState().settings));
        await screen.update(runtime);
      });
      await waitForRecognizerCall('stop', 1);
      expect(recognizer.stop).toHaveBeenCalledOnce();
      expect(lifecycle.getConfiguredProviderId()).toBe('local_conversation');
      expect(getVoiceSessionSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: target.sessionId });
      expect(recognizer.start).toHaveBeenCalledOnce();
      const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
      const admission = voiceCaptureAdmissionController.acquire('dictation');
      if (admission.status === 'acquired') admission.lease.release();
      expect(admission).toMatchObject({ status: 'busy', activeOwner: 'conversation' });
    } finally {
      stopped.resolve();
      await stopped.promise;
      await waitForRecognizerCall('start', 2);
      expect(recognizer.start).toHaveBeenCalledTimes(2);
    }
  });

  it('stops the current owner and starts the newly selected provider after disconnect', async () => {
    const { screen, lifecycle, runtime, target } = await mountGeneratedLocalRuntime();
    const stopped = createDeferred<void>();
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    nativeAudio.nativeModule.restoreAudioSession.mockImplementationOnce(() => stopped.promise);
    try {
      await act(async () => {
        const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, 'local_conversation',
          VoiceLocalConversationSchema.parse({ tts: { autoSpeakReplies: false } }));
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: 'local_conversation' } }, storage.getState().settings));
        await screen.update(runtime);
      });
      await waitForRecognizerCall('stop', 1);
      expect(recognizer.stop).toHaveBeenCalledOnce();
      // The genuine recognizer already emitted its terminal end event, but
      // media restore still owns capture. A successor cannot start yet.
      expect(recognizer.abort).not.toHaveBeenCalled();
      expect(recognizer.start).toHaveBeenCalledOnce();
      expect(getVoiceSessionSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: target.sessionId });
      await act(async () => { stopped.resolve(); await stopped.promise; });
      await waitForRecognizerCall('start', 2);
      expect(recognizer.start).toHaveBeenCalledTimes(2);
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'connected');
      expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
      expect(getVoiceSessionSnapshot()).toMatchObject({ adapterId: 'local_conversation',
        sessionId: target.sessionId, status: 'connected', canStop: true,
      });
      expect(nativeSpeech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBeGreaterThan(0);
    } finally {
      stopped.resolve();
      await stopped.promise;
    }
  });

  it('stops the current owner and settles to off after a real disconnect snapshot', async () => {
    const stopped = createDeferred<void>();
    const { screen, lifecycle, runtime } = await mountGeneratedElevenLabsRuntime();
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const active = lifecycle.getSnapshot();
    sdk.endSession.mockImplementation(() => stopped.promise);
    try {
      await act(async () => {
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
          ...storage.getState().settings.voice, providerId: 'off',
        } }, storage.getState().settings));
        await screen.update(runtime);
      });
      await waitForSdkCall('endSession', 1);
      expect(sdk.endSession).toHaveBeenCalledOnce();
      expect(sdk.startSession).toHaveBeenCalledOnce();
      // Teardown keeps Stop and does not announce a new connection (`ending` projects as connected).
      expect(getVoiceSessionSnapshot()).toEqual(active);
      await act(async () => {
        stopped.resolve();
        await stopped.promise;
      });
      await waitForTestEvent(lifecycle.subscribe, () => lifecycle.getSnapshot(), snapshot => snapshot.status === 'disconnected');
      expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
      expect(getVoiceSessionSnapshot()).toEqual({
        adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
      });
      expect(lifecycle.getConfiguredProviderId()).toBeNull();
      await act(async () => { await lifecycle.toggle(null); });
      expect(sdk.startSession).toHaveBeenCalledOnce();
    } finally {
      stopped.resolve();
      await stopped.promise;
    }
  });

  it('starts and publishes the canonical selected provider when its id is padded', async () => {
    const { lifecycle } = await mountGeneratedElevenLabsRuntime({ selectedProviderId: ` ${ELEVENLABS_PROVIDER_ID} ` });
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    expect(lifecycle.getConfiguredProviderId()).toBe(ELEVENLABS_PROVIDER_ID);
    expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
    expect(getVoiceSessionSnapshot()).toMatchObject({ adapterId: ELEVENLABS_PROVIDER_ID,
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected', canStop: true,
    });
  });

  it('keeps the stored local provider as the continuous-mode owner on web', async () => {
    const browser = installVoiceWebRtcBrowserBoundary();
    browserBoundaries.push(browser);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', createMountedBrowserDocument());
    const { lifecycle, target } = await mountGeneratedLocalRuntime('local_conversation', 'web');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { getVoiceAdapterRegistry } = await import('./voiceAdapterRegistry');
    expect(platformOsMock.value).toBe('web');
    expect(getVoiceAdapterRegistry().get('local_direct')?.getSnapshot()).toMatchObject({
      adapterId: 'local_direct', sessionId: target.sessionId, status: 'connected',
    });
    expect(getVoiceAdapterRegistry().get(ELEVENLABS_PROVIDER_ID)?.getSnapshot().status).toBe('disconnected');
    expect(getVoiceSessionSnapshot()).toEqual(lifecycle.getSnapshot());
    expect(getVoiceSessionSnapshot()).toMatchObject({
      adapterId: 'local_conversation', sessionId: target.sessionId, status: 'connected', canStop: true,
    });
    expect(sdk.startSession).not.toHaveBeenCalled();
  });

  it('fails closed when the configured provider id is unsupported', async () => {
    platformOsMock.value = 'web';
    sdk.startSession.mockReset();
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...storage.getState().settings.voice, providerId: 'unsupported_provider' } }, storage.getState().settings));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    const screen = await renderRuntimeScreen(React.createElement(VoiceSessionRuntime));
    generatedRuntimeScreens.push(screen);
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const lifecycle = getVoiceSessionLifecycleController();
    if (!lifecycle) throw new Error('Mounted lifecycle unavailable');
    expect(lifecycle.getConfiguredProviderId()).toBeNull();
    await act(async () => { await lifecycle.toggle(null); });
    expect(sdk.startSession).not.toHaveBeenCalled();

    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('keeps realtime capture admission and the active snapshot until unmount stop completes', async () => {
    const { screen, lifecycle } = await mountGeneratedElevenLabsRuntime();
    const stopDeferred = createDeferred<void>();
    sdk.endSession.mockImplementation(() => stopDeferred.promise);
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
    const activeSnapshot = getVoiceSessionSnapshot();
    await screen.unmount();
    await waitForSdkCall('endSession', 1);
    expect(sdk.endSession).toHaveBeenCalledOnce();
    const competingAdmission = voiceCaptureAdmissionController.acquire('dictation');
    if (competingAdmission.status === 'acquired') {
      competingAdmission.lease.release();
    }
    expect(competingAdmission).toMatchObject({
      status: 'busy',
      activeOwner: 'conversation',
    });
    expect(getVoiceSessionSnapshot()).toEqual(activeSnapshot);
    expect(getVoiceSessionLifecycleController()).toBe(lifecycle);

    await act(async () => {
      stopDeferred.resolve();
      await sdk.endSession.mock.results[0]?.value;
      await Promise.resolve();
    });

    await waitForMountedController(null);
    expect(getVoiceSessionLifecycleController()).toBeNull();
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
    const admissionAfterStop = voiceCaptureAdmissionController.acquire('dictation');
    expect(admissionAfterStop.status).toBe('acquired');
    if (admissionAfterStop.status === 'acquired') {
      admissionAfterStop.lease.release();
    }
  });

  it('stops and awaits an active Local Voice adapter before publishing idle on unmount', async () => {
    const stopDeferred = createDeferred<void>();
    const { screen, lifecycle } = await mountGeneratedLocalRuntime();
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const active = getVoiceSessionSnapshot();
    nativeAudio.nativeModule.restoreAudioSession.mockImplementation(() => stopDeferred.promise);
    try {
      await screen.unmount();
      await waitForRecognizerCall('stop', 1);
      expect(recognizer.stop).toHaveBeenCalledOnce();
      expect(recognizer.abort).not.toHaveBeenCalled();
      expect(getVoiceSessionSnapshot()).toEqual(active);
      expect(getVoiceSessionLifecycleController()).toBe(lifecycle);
      await act(async () => {
        stopDeferred.resolve();
        await stopDeferred.promise;
      });
      await waitForMountedController(null);
      expect(getVoiceSessionLifecycleController()).toBeNull();
      expect(nativeSpeech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
      expect(getVoiceSessionSnapshot()).toEqual({
        adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
      });
    } finally {
      stopDeferred.resolve();
      await stopDeferred.promise;
    }
  });

  it('does not let an earlier StrictMode-equivalent cleanup overwrite a remounted owner', async () => {
    const oldStopDeferred = createDeferred<void>();
    const { screen: oldScreen, lifecycle: oldController, runtime, options: oldOptions } = await mountGeneratedElevenLabsRuntime();
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    sdk.endSession.mockImplementationOnce(() => oldStopDeferred.promise);
    try {
      await oldScreen.unmount();
      await waitForSdkCall('endSession', 1);
      expect(sdk.endSession).toHaveBeenCalledOnce();
      const freshScreen = await renderRuntimeScreen(runtime);
      generatedRuntimeScreens.push(freshScreen);
      const freshController = getVoiceSessionLifecycleController();
      if (!freshController) throw new Error('Remounted Voice lifecycle unavailable');
      expect(freshController).not.toBe(oldController);
      expect(freshController.getConfiguredProviderId()).toBe(ELEVENLABS_PROVIDER_ID);
      const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
      const blocked = voiceCaptureAdmissionController.acquire('dictation');
      if (blocked.status === 'acquired') blocked.lease.release();
      expect(blocked).toMatchObject({ status: 'busy', activeOwner: 'conversation' });
      expect(sdk.startSession).toHaveBeenCalledOnce();
      await act(async () => {
        oldOptions.onModeChange?.({ mode: 'speaking' });
        oldStopDeferred.resolve();
        await oldStopDeferred.promise;
      });
      await oldController.dispose();
      await waitForMountedController(freshController);
      expect(getVoiceSessionLifecycleController()).toBe(freshController);
      expect(getVoiceSessionSnapshot()).not.toMatchObject({ status: 'connected', mode: 'speaking' });
      const admission = voiceCaptureAdmissionController.acquire('dictation');
      if (admission.status === 'acquired') admission.lease.release();
      expect(admission.status).toBe('acquired');
      expect(freshController.getSnapshot().status).toBe('disconnected');
      await act(async () => { await freshController.toggle(null); });
      await waitForSdkCall('startSession', 2);
      expect(sdk.startSession, JSON.stringify(freshController.getSnapshot())).toHaveBeenCalledTimes(2);
      expect(getVoiceSessionSnapshot()).toMatchObject({
        adapterId: ELEVENLABS_PROVIDER_ID, sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected',
      });
      await act(async () => { oldOptions.onModeChange?.({ mode: 'speaking' }); });
      expect(getVoiceSessionSnapshot().mode).toBe('idle');
      expect(getVoiceSessionLifecycleController()).toBe(freshController);
    } finally {
      oldStopDeferred.resolve();
      await oldStopDeferred.promise;
    }
  });

  it('does not let deferred Local cleanup stop or overwrite a replacement Local session', async () => {
    const oldStopDeferred = createDeferred<void>();
    let freshStart: Promise<void> | undefined;
    const { screen: oldScreen, lifecycle: oldController, runtime } = await mountGeneratedLocalRuntime();
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { storage } = await import('@/sync/domains/state/storage');
    if (!accountConnection) throw new Error('Replacement Local Account unavailable');
    const target = { serverId: accountConnection.home.id, sessionId: 'fresh-local-session' };
    storage.getState().applySessions([
      createSessionFixture({ id: target.sessionId, serverId: target.serverId, encryptionMode: 'plain', active: true }),
    ]);
    nativeAudio.nativeModule.restoreAudioSession.mockImplementationOnce(() => oldStopDeferred.promise);
    try {
      await oldScreen.unmount();
      await waitForRecognizerCall('stop', 1);
      expect(recognizer.stop).toHaveBeenCalledOnce();
      const freshScreen = await renderRuntimeScreen(runtime);
      generatedRuntimeScreens.push(freshScreen);
      const freshController = getVoiceSessionLifecycleController();
      if (!freshController) throw new Error('Replacement Local lifecycle unavailable');
      expect(freshController).not.toBe(oldController);
      await act(async () => {
        freshStart = freshController.toggle(target);
        // Keep a failure attributable to the later awaited admission rather
        // than an unhandled-rejection timer while the native SDK is held.
        void freshStart.catch(() => {});
      });
      expect(recognizer.start).toHaveBeenCalledOnce();
      expect(freshController.getAttemptTargetSessionAddress()).toEqual(target);
      expect(getVoiceSessionSnapshot().status).not.toBe('connected');
      await act(async () => {
        oldStopDeferred.resolve();
        await oldStopDeferred.promise;
      });
      await act(async () => { await freshStart; });
      await waitForRecognizerCall('start', 2);
      expect(recognizer.start).toHaveBeenCalledTimes(2);
      expect(getVoiceSessionLifecycleController()).toBe(freshController);
      expect(getVoiceSessionSnapshot()).toMatchObject({ adapterId: 'local_direct',
        sessionId: target.sessionId, status: 'connected', canStop: true,
      });
      expect(recognizer.stop).toHaveBeenCalledOnce();
      expect(recognizer.abort).not.toHaveBeenCalled();
      expect(nativeSpeech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBeGreaterThan(0);
      await freshScreen.unmount();
      await waitForRecognizerCall('stop', 2);
      expect(recognizer.stop).toHaveBeenCalledTimes(2);
      await waitForMountedController(null);
      expect(getVoiceSessionLifecycleController()).toBeNull();
      expect(nativeSpeech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    } finally {
      oldStopDeferred.resolve();
      await oldStopDeferred.promise;
      await freshStart;
    }
  });
  /**
   * C1 parity — an external provider must reach the runtime exactly like a built-in one.
   *
   * The selection is resolved through the provider registry, and a plugin only registers into
   * that registry when its runtime activates — after this component's first render on a cold
   * boot. Without observing the registry's own revision the first `null` answer stands forever:
   * the surface can present the persisted provider while Start silently does nothing, because
   * the lifecycle owner was never told which provider was configured.
   */
  it('configures a persisted external provider once its plugin registers', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
      ...storage.getState().settings.voice,
      providerId: EXTERNAL_PROVIDER_ID,
      providers: { [EXTERNAL_PROVIDER_ID]: { schemaVersion: 1, config: {} } },
    } }, storage.getState().settings));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const {
      commitExternalVoiceProviderRegistration,
      removeExternalVoiceProviderRegistration,
    } = await import('@/voice/registry/externalVoiceProviderRegistrations');
    const { VoiceProviderContributionSchema } = await import('@happier-dev/protocol/plugins/contributions/voice');
    const { projectVoiceProviderDeclarationRegistryBase } = await import('@/voice/registry/providerRegistry');
    const { createExternalVoiceProviderSettingsDescriptor } = await import('@/voice/settings/externalProviderSettings');
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'realtime-demo', title: 'External Voice', kind: 'conversation',
      roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'voice-runtime', exportName: 'activate' },
    });
    if (declaration.kind !== 'conversation') throw new Error('Expected conversation contribution');

    const screen = await renderRuntimeScreen(React.createElement(VoiceSessionRuntime));
    generatedRuntimeScreens.push(screen);
    const { getVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const lifecycleController = getVoiceSessionLifecycleController();
    if (!lifecycleController) throw new Error('Mounted lifecycle unavailable');
    expect(lifecycleController.getConfiguredProviderId()).toBeNull();

    await act(async () => {
      commitExternalVoiceProviderRegistration({
        token: EXTERNAL_REGISTRATION_TOKEN,
        pluginId: 'acme.voice.demo',
        localId: 'realtime-demo',
        providerId: EXTERNAL_PROVIDER_ID,
        descriptor: {
          kind: 'voice.conversation-provider.v1',
          pluginId: 'acme.voice.demo',
          providerId: EXTERNAL_PROVIDER_ID,
          settingsSectionId: 'voice.acme-demo',
          ...projectVoiceProviderDeclarationRegistryBase({
            declaration, providerSettings: createExternalVoiceProviderSettingsDescriptor(declaration.settings),
          }),
          declaration,
          source: { kind: 'external', pluginId: 'acme.voice.demo', localId: 'realtime-demo' },
        },
        adapter: null,
      });
    });

    expect(lifecycleController.getConfiguredProviderId()).toBe(EXTERNAL_PROVIDER_ID);

    // Withdrawal is the same authority in the other direction: an uninstalled plugin must not
    // leave the lifecycle owner holding a provider it can no longer resolve.
    await act(async () => {
      removeExternalVoiceProviderRegistration(EXTERNAL_REGISTRATION_TOKEN);
    });
    expect(lifecycleController.getConfiguredProviderId()).toBeNull();
  });
  it('does not activate a source provider while declaration admission is establishing', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const originalSettings = storage.getState().settings;
    storage.setState(state => ({ settings: { ...state.settings, voiceSettingsV1: {
      ...state.settings.voiceSettingsV1, providerId: ELEVENLABS_PROVIDER_ID,
    } } }));
    const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    function EstablishingDeclarations() {
      const value = useAppShellPluginUiProjection();
      return <AppShellPluginUiProjectionValueProvider value={value} declarationReady={false}><VoiceSessionRuntime /></AppShellPluginUiProjectionValueProvider>;
    }
    const screen = await renderRuntimeScreen(<EstablishingDeclarations />);
    generatedRuntimeScreens.push(screen);
    // Settle the real plugin-module boundary before checking host publication;
    // the compiled graph test separately counts module evaluation.
    await act(async () => { await import('@happier-dev/plugins-elevenlabs/happier-plugin-ui/voice-runtime'); });
    const { getExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
    try {
      expect(getExternalVoiceProviderRegistration(ELEVENLABS_PROVIDER_ID)).toBeNull();
      expect(sdk.startSession).not.toHaveBeenCalled();
    } finally {
      storage.setState({ settings: originalSettings });
    }
  });

});
