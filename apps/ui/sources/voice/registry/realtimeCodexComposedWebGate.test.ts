import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import type {
  BundledRealtimeProviderRuntimeHost,
} from '@/voice/registry/bundledConversationRuntimeContract';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  PluginProjectionV2Schema,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import type { BundledVoiceRuntimeContribution } from '@/voice/session/types';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { parseToken } from '@/utils/auth/parseToken';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionOwnerCompatibilityViewV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { writeVoiceConversationBindingMetadata } from '@/voice/binding/voiceConversationBindingMetadata';
import { writeVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import type { AgentSessionRealtimeWatchResultV1 } from '@happier-dev/protocol/voice/realtime/agentSession';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const rpcBoundary = vi.hoisted(() => ({
  sessionRpc: vi.fn(),
}));
const machineRpcBoundary = vi.hoisted(() => ({
  machineRpc: vi.fn(),
}));
let daemonProjection: ReturnType<typeof PluginProjectionV2Schema.parse> | null = null;
const transportHomes = new Map<string, { serverId: string; token: string }>();
const rpcEvents = new EventTarget();
function subscribeRpc(notify: () => void) {
  rpcEvents.addEventListener('rpc', notify);
  return () => rpcEvents.removeEventListener('rpc', notify);
}
// Keep Home/Account admission, Session and Machine crypto, request scope and RPC
// framing real. Only the Socket.IO network's authenticated daemon reply changes.
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
  let timeoutMs: number | null = null;
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  // This cold external transport exists for its entire Socket lifetime. Keep
  // its native network methods installed after per-test spy restoration.
  socket.timeout = vi.fn<typeof socket.timeout>(value => { timeoutMs = value ?? null; return socket; });
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Expected a framed Socket RPC');
    }
    const home = transportHomes.get(String(serverUrl));
    const token = typeof socket.auth === 'object' && 'token' in socket.auth ? socket.auth.token : undefined;
    if (!home || token !== home.token) throw new Error('Expected the captured Home Account credential');
    const separator = payload.method.indexOf(':');
    const targetId = payload.method.slice(0, separator);
    const method = payload.method.slice(separator + 1);
    const requestTimeoutMs = timeoutMs;
    timeoutMs = null;
    const authority = { serverId: home.serverId, accountId: parseToken(home.token), timeoutMs: requestTimeoutMs };
    const responding = method.startsWith('session.agentRealtime.')
      ? rpcBoundary.sessionRpc({ ...authority, sessionId: targetId, method, payload: payload.params })
      : machineRpcBoundary.machineRpc({ ...authority, machineId: targetId, method, payload: payload.params });
    rpcEvents.dispatchEvent(new Event('rpc'));
    let result: unknown;
    try { result = await responding; } finally { rpcEvents.dispatchEvent(new Event('rpc')); }
    return { ok: true, result };
  });
});

import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import {
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
import {
  registerVoiceAdapters,
  resetVoiceAdapterRegistryForTests,
} from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import {
  createBundledConversationRuntimeHostLease,
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from './generatedBundledVoiceRuntimeEntries';

type CreateAgentSessionRealtimeService = NonNullable<
  BundledRealtimeProviderRuntimeHost['createAgentSessionRealtimeService']
>;

const CODEX_CONNECTED_SERVICE_KEY = buildQualifiedPluginContributionKey(
  createPluginContributionIdentity({
    pluginId: 'happier.agent.codex',
    localId: 'openai-codex',
  }),
);

function readEntryProviderId(entry: Readonly<{
  pluginId: string;
  declaration: Readonly<{ id: string }>;
}>): string {
  return buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: entry.pluginId,
    localId: entry.declaration.id,
  }));
}

function codexEntry() {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES
    .find((candidate) => candidate.declaration.id === 'realtime-codex');
  if (!entry) throw new Error('realtime_codex bundled entry missing');
  return entry;
}

async function activateCodexEntry(input: Readonly<{
  host: BundledRealtimeProviderRuntimeHost;
  authorityHost: BundledRealtimeProviderRuntimeHost;
}>): Promise<BundledVoiceRuntimeContribution> {
  const entry = codexEntry();
  const providerId = readEntryProviderId(entry);
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: entry.pluginId,
    occurrenceId: `${entry.pluginId}-activation-occurrence`,
    declarations: [entry.declaration],
    hostPlatform: input.host.getPlatform(),
    runtimeHost: input.host,
    isRuntimeHostCurrent: () =>
      getCurrentBundledConversationRuntimeHost() === input.authorityHost,
    hostBindingsByLocalId: Object.freeze({
      [entry.declaration.id]: Object.freeze({
        recipientContract: createBundledVoiceRecipientContract({
          pluginId: entry.pluginId,
          declaration: entry.declaration,
        }),
        descriptor: 'bundled' as const,
      }),
    }),
  });
  const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
  (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
  await scope.commit();
  const registration = getExternalVoiceProviderRegistration(providerId);
  if (!registration?.adapter) {
    throw new Error('realtime_codex bundled activation failed');
  }
  return Object.freeze({
    adapter: registration.adapter,
    async dispose() {
      await scope.unwind();
    },
  });
}

function installDirectSessionState() {
  const voice = voiceSettingsParse({
    providerId: 'happier.agent.codex/realtime-codex',
    providers: {
      'happier.agent.codex/realtime-codex': {
        schemaVersion: 2,
        config: { globalConnectedServices: null },
      },
    },
  });
  const settings = settingsParse({
    ...settingsDefaults,
    ...normalizeVoiceSettingsLocalDelta({ voice }, settingsDefaults),
  });
  storage.setState((current) => ({
    ...current,
    sessions: {
      ...current.sessions,
      'codex-direct-session': createSessionFixture({
        id: 'codex-direct-session',
        serverId: getActiveServerSnapshot().serverId,
        active: true,
        encryptionMode: 'plain',
        metadata: {
          path: '/workspace/direct',
          host: 'test.local',
          homeDir: '/Users/tester',
          machineId: 'machine-direct',
          flavor: 'codex',
        },
      }),
    },
  }) as never);
  return settings;
}

describe('realtime_codex normal web composed gate', () => {
  let activeServerId: string;
  let nextTranscriptSeq: number;
  let persistenceCleanup: (() => void) | null;
  let restoreExecutorModuleLoader: (() => void) | null;
  let transcriptRequest: ReturnType<typeof vi.fn>;
  let globalCreationAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null;
  let sessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;
  // These records belong to the simulated Home database, not the client store.
  // The real spawned-session owner must fetch and publish them through Sync.
  let daemonSessions: Record<string, ReturnType<typeof createSessionFixture>>;
  let daemonMachines: Record<string, ReturnType<typeof createMachineFixture>>;
  let globalCreationSettings = storage.getState().settings;

  const machineRow = (id: string) => ({
    ...createPlainMachineRowFixture({ id, accountId: 'codex-composed-account' }),
    ...(daemonMachines[id] ? { metadata: encodePlainMachineStoredContent(daemonMachines[id]!.metadata) } : {}),
  });

  const restoreGlobalCreationAccount = async (settings = storage.getState().settings) => {
    globalCreationSettings = settings;
    // This is a new server document fixture, not an older echo of the scoped
    // document already persisted by the actual settings owner.
    const settingsRevision = (storage.getState().settingsVersion ?? 0) + 1;
    await globalCreationAccount?.dispose();
    globalCreationAccount = await restoreServerAccountForTest({
      serverUrl: getActiveServerSnapshot().serverUrl,
      accountId: 'codex-composed-account',
      credentialScope: 'restored-home',
      request: createSessionReadBatchFetchBoundary(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/health') return Response.json({});
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({
          id: 'codex-composed-account',
          connectedServicesV2: [{
            serviceId: 'openai-codex',
            profiles: ['voice-profile', 'codex-global-profile'].map(profileId => ({
              profileId, status: 'connected', kind: 'oauth',
            })),
          }],
          connectedServiceCredentialRevisionsV1: ['voice-profile', 'codex-global-profile'].map(profileId => ({
            serviceId: 'openai-codex', profileId,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          })),
        }));
        const sessionResponse = sessionHttp.handle(input, init);
        if (sessionResponse) return sessionResponse;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: globalCreationSettings }, version: settingsRevision });
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } });
        if (path === '/v1/machines') return Response.json(Object.keys(daemonMachines).map(machineRow));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
          machineRow);
        const machine = /^\/v1\/machines\/([^/]+)$/.exec(path);
        if (machine) return Response.json({ machine: machineRow(decodeURIComponent(machine[1]!)) });
        const access = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
        if (access) {
          const machineId = decodeURIComponent(access[1]!);
          const row = createPlainMachineRowFixture({ id: machineId, accountId: 'codex-composed-account' });
          return Response.json({ machineId, custodian: row.access!.custodian, access: row.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
        }
        return await transcriptRequest(input, init);
      }),
    });
    activeServerId = globalCreationAccount.home.id;
    transportHomes.set(globalCreationAccount.home.serverUrl, { serverId: activeServerId, token: globalCreationAccount.credentials.token });
    await sync.refreshProfile();
    expect(storage.getState().profileScope).toMatchObject({
      serverId: activeServerId, accountId: 'codex-composed-account',
    });
    await refreshAcpCatalog({ serverId: activeServerId, accountId: 'codex-composed-account' });
  };

  const transcriptPostCount = (): number => transcriptRequest.mock.calls.filter(
    ([input]) => String(input).endsWith(
      '/v2/sessions/codex-direct-session/messages',
    ),
  ).length;

  const installTranscriptPersistenceBoundary = async (): Promise<void> => {
    const activeRequestSpy = vi.spyOn(apiSocket, 'request');
    persistenceCleanup = () => {
      activeRequestSpy.mockRestore();
      persistenceCleanup = null;
    };
  };

  beforeEach(async () => {
    await selectActiveTestHomeForTests();
    const activeServer = getActiveServerSnapshot();
    if (!activeServer.serverId) throw new Error('Codex composed test requires an active server');
    activeServerId = activeServer.serverId;
    await disconnectActiveServerConnection();
    storage.getState().clearProfileScope();
    const directSettings = installDirectSessionState();
    nextTranscriptSeq = 0;
    persistenceCleanup = null;
    globalCreationAccount = null;
    daemonSessions = {};
    daemonMachines = {};
    sessionHttp = createSessionMetadataHttpBoundary(() => ({
      ...storage.getState().sessions, ...daemonSessions,
    }));
    restoreExecutorModuleLoader = null;
    transcriptRequest = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (/^\/v[123]\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname) && (init?.method ?? 'GET') === 'GET') return Response.json({ messages: [], hasMore: false });
      const sessionResponse = sessionHttp.handle(input, init);
      if (sessionResponse) return sessionResponse;
      const preparation = answerVoiceRealtimePreparationHttpRequest(input, storage.getState().settings);
      if (preparation) return preparation;
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (new URL(url).pathname !== '/v2/sessions/codex-direct-session/messages') return Response.json({ error: 'not_found' }, { status: 404 });
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Readonly<{ localId: string }>;
      nextTranscriptSeq += 1;
      return new Response(JSON.stringify({
        didWrite: true,
        message: {
          id: `codex-direct-message-${nextTranscriptSeq}`,
          seq: nextTranscriptSeq,
          localId: body.localId,
          createdAt: Date.now(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    rpcBoundary.sessionRpc.mockReset();
    machineRpcBoundary.machineRpc.mockReset();
    daemonProjection = null;
    clearDaemonMergedProjectionCacheForTests();
    vi.spyOn(sync, 'patchSessionMetadataWithRetry');
    resetVoiceAdapterRegistryForTests();
    resetVoiceSessionStoreForTests();
    voiceConversationRuntimeMachine.reset();
    voiceSessionBindingStore.setState({
      ...voiceSessionBindingStore.getInitialState(),
      bind: voiceSessionBindingStore.getState().bind,
      unbind: voiceSessionBindingStore.getState().unbind,
      replacePersistedBindings: voiceSessionBindingStore.getState().replacePersistedBindings,
      getByConversationSessionId: voiceSessionBindingStore.getState().getByConversationSessionId,
      getByControlSessionId: voiceSessionBindingStore.getState().getByControlSessionId,
      list: voiceSessionBindingStore.getState().list,
    }, true);
    await restoreGlobalCreationAccount(directSettings);
    const restored = storage.getState();
    if (!restored.settingsScope) throw new Error('Direct Codex fixture requires the restored Account settings scope');
    restored.applySettingsForScope(restored.settingsScope, directSettings, (restored.settingsVersion ?? 0) + 1);
    installDirectSessionState();
    // Browser environment leaves select the real host's browser audio branch;
    // its generation guard and lease lifetime are not replaced by the fixture.
    vi.stubGlobal('window', Object.freeze({}));
    vi.stubGlobal('document', Object.freeze({}));
  });

  afterEach(async () => {
    await globalCreationAccount?.dispose();
    restoreExecutorModuleLoader?.();
    persistenceCleanup?.();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearDaemonMergedProjectionCacheForTests();
    resetVoiceAdapterRegistryForTests();
    voiceConversationRuntimeMachine.reset();
  });

  it('persists a continued hidden native carrier logical target before realtime starts', async () => {
    const previousSessions = storage.getState().sessions;
    const carrierAddress = { serverId: activeServerId, sessionId: 'codex-hidden-continuation' };
    const session = createSessionFixture({ ...previousSessions['codex-direct-session']!, id: carrierAddress.sessionId });
    const ownerMetadata = writeVoiceConversationBindingMetadata(writeVoiceConversationScopeMetadata({
      ...session.metadata!,
      ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
    }, { kind: 'voice_home' }), {
      adapterId: 'happier.agent.codex/realtime-codex', controlSessionId: '__voice_agent__',
      conversationSessionId: carrierAddress.sessionId, conversationSessionAddress: carrierAddress,
      transcriptMode: 'native_session', targetSessionAddress: carrierAddress, updatedAt: 1,
    });
    storage.setState(current => ({ sessions: { ...current.sessions, [session.id]: { ...session, metadata: ownerMetadata } } }));
    sessionHttp.replaceSession(session.id);
    const readPersistedBinding = async () => {
      const response = sessionHttp.handle(new URL(`/v2/sessions/${session.id}`, getActiveServerSnapshot().serverUrl));
      if (!response) throw new Error('Missing persisted hidden carrier');
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('session' in payload)) throw new Error('Missing Session response');
      const record = SessionCurrentProjectionRecordV1Schema.parse(payload.session);
      if (record.ownerMetadata?.t !== 'plain') throw new Error('Expected persisted Plain owner metadata');
      return createStoredReadSchema(SessionOwnerCompatibilityViewV1Schema.shape.voiceConversationBindingV1)
        .parse(record.ownerMetadata.v.system?.voiceConversationBindingV1);
    };
    const started = createDeferred<void>();
    const watched = createDeferred<AgentSessionRealtimeWatchResultV1>();
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{ sessionId: string; method: string }>) => {
      expect(input.sessionId).toBe(session.id);
      if (input.method.endsWith('.inspect')) return { ok: true, status: 'available', transport: 'webrtc' };
      if (input.method.endsWith('.start')) {
        try {
          expect(await readPersistedBinding()).toMatchObject({ targetSessionId: null, targetServerId: null });
        } catch (error) {
          started.reject(error);
          throw error;
        }
        started.resolve();
        return { ok: true, status: 'started', transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=continued-answer\r\n' } };
      }
      if (input.method.endsWith('.watch')) return await watched.promise;
      if (input.method.endsWith('.stop')) {
        watched.resolve({ ok: true, status: 'terminal', event: { kind: 'terminal', reason: 'stopped' } });
        return { ok: true, status: 'stopped' };
      }
      throw new Error(`Unexpected native carrier RPC ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const lease = createBundledConversationRuntimeHostLease();
    const runtime = await activateCodexEntry({
      host: Object.freeze({ ...lease.host, getPlatform: () => 'web' as const, createMicSession: browser.createMicSession }),
      authorityHost: lease.host,
    });
    registerVoiceAdapters([runtime.adapter]);
    try {
      const starting = runtime.adapter.start({ sessionId: session.id, requestedTargetSessionAddress: carrierAddress });
      await Promise.race([started.promise, starting.then(() => {
        throw new Error('Native carrier Start settled before the realtime start boundary');
      })]);
      browser.peer.channel.open();
      await starting;
      expect(runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected', sessionId: session.id });
      expect(voiceSessionBindingStore.getState().getByControlSessionId(session.id))
        .toMatchObject({ conversationSessionAddress: carrierAddress, targetSessionAddress: null });
      expect(rpcBoundary.sessionRpc.mock.calls.some(([input]) => String(input.method).endsWith('.inspect'))).toBe(true);
      await runtime.adapter.stop({ sessionId: session.id });
    } finally {
      watched.resolve({ ok: true, status: 'terminal', event: { kind: 'terminal', reason: 'stopped' } });
      await runtime.dispose();
      lease.revoke();
      browser.restore();
      storage.setState({ sessions: previousSessions });
    }
  });

  it('composes public activation, exact direct binding, bound V3 authority, host WebRTC, finals, reverse terminal cleanup, and honest unphased live presentation', async () => {
    const consoleError = vi.spyOn(console, 'error');
    const watchResolvers: Array<(value: unknown) => void> = [];
    let resolveFirstStop!: (value: unknown) => void;
    let stopCount = 0;
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      sessionId: string;
      method: string;
      payload: unknown;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=test-answer\r\n' },
          preparedInstructionsFor: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        };
      }
      if (input.method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          watchResolvers.push(resolve);
        });
      }
      if (input.method.endsWith('.stop')) {
        stopCount += 1;
        if (stopCount === 1) {
          return await new Promise((resolve) => {
            resolveFirstStop = resolve;
          });
        }
        return { ok: true, status: 'stopped' };
      }
      throw new Error(`unexpected session RPC: ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const diagnosticPresented = createDeferred<void>();
    const presentAttemptDiagnostic = vi.fn((...args: Parameters<typeof hostLease.host.presentAttemptDiagnostic>) => {
      const result = hostLease.host.presentAttemptDiagnostic(...args);
      diagnosticPresented.resolve();
      return result;
    });
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
      presentAttemptDiagnostic,
      async createAgentSessionRealtimeService(input: Parameters<
        CreateAgentSessionRealtimeService
      >[0]) {
        expect(sync.patchSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
        expect(voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        )).toMatchObject({
          conversationSessionId: 'codex-direct-session',
        });
        expect(input.onStarted).toEqual(expect.any(Function));
        const createService = hostLease.host.createAgentSessionRealtimeService;
        return createService ? await createService(input) : null;
      },
    });
    const runtime = await activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });
    registerVoiceAdapters([runtime.adapter]);

    const binding = await runtime.adapter.resolveConversationBinding?.({
      controlSessionId: 'codex-direct-session',
      requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      settings: storage.getState().settings,
    });
    expect(binding).toEqual({
      conversationSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
    });

    const starting = runtime.adapter.start({
      sessionId: 'codex-direct-session',
      requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
    });
    await waitForTestEvent(runtime.adapter.subscribe!, () => expect(runtime.adapter.getSnapshot().status).toBe('connecting'));
    expect(runtime.adapter.getSnapshot().preparedInstructionsFor).toBeUndefined();
    await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
    browser.peer.channel.open();
    await starting;

    expect(runtime.adapter.getSnapshot()).toMatchObject({
      adapterId: 'happier.agent.codex/realtime-codex',
      sessionId: 'codex-direct-session',
      status: 'connected',
      mode: 'idle',
      preparedInstructionsFor: { serverId: activeServerId, sessionId: 'codex-direct-session' },
    });
    const readPhaseLabel = () => resolveVoiceSurfaceStatusPresentation(
      resolveVoiceSurfaceState(runtime.adapter.getSnapshot()),
    ).labelKey;
    // Codex declares outputLevelMeter: 'unavailable' and has no native audio
    // phase edge. The announcer shares this canonical connected/live fallback;
    // neither an open microphone nor transcript text proves Listening/Speaking.
    expect(readPhaseLabel()).toBe('voiceAssistant.label');
    expect(browser.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0\r\na=test-answer\r\n',
    });
    expect(browser.peer.addTrack).toHaveBeenCalledWith(
      browser.micTrack,
      browser.micStream,
    );
    const startRpc = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{ sessionId: string; method: string; payload: unknown }>)
      .find((input) => input.method.endsWith('.start'));
    const applicationAttemptId = (
      startRpc?.payload as Readonly<{ applicationAttemptId?: unknown }> | undefined
    )?.applicationAttemptId;
    expect(applicationAttemptId).toMatch(
      /^voice:1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(startRpc).toMatchObject({
      sessionId: 'codex-direct-session',
      payload: {
        v: 1,
        provider: {
          pluginId: 'happier.agent.codex',
          localId: 'realtime-codex',
        },
        applicationAttemptId,
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=test-offer\r\n',
        },
      },
    });
    const watchRpc = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{
        method: string;
        timeoutMs?: number | null;
      }>)
      .find((input) => input.method.endsWith('.watch'));
    expect(watchRpc).toMatchObject({
      timeoutMs: null,
    });

    const final = {
      type: 'turn.done',
      turn: {
        id: 'turn-direct-final',
        role: 'assistant',
        transcript: 'Finished once.',
      },
    };
    browser.peer.channel.message(JSON.stringify({
      type: 'output_transcript.added',
      item: { text: 'Reply in progress.' },
    }));
    browser.peer.channel.message(JSON.stringify({
      type: 'turn.done',
      turn: {
        id: 'turn-\uD800',
        role: 'assistant',
        transcript: 'must remain inert',
      },
    }));
    await diagnosticPresented.promise;
    expect(presentAttemptDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          code: 'codex_v3_malformed_turn_done',
        }),
      }),
    );
    expect(runtime.adapter.getSnapshot().status).toBe('connected');
    expect(runtime.adapter.getSnapshot().mode).toBe('idle');
    expect(readPhaseLabel()).toBe('voiceAssistant.label');
    expect(readCanonicalVoiceTranscriptSnapshot('codex-direct-session')).toEqual([]);

    await installTranscriptPersistenceBoundary();
    browser.peer.channel.message(JSON.stringify(final));
    browser.peer.channel.message(JSON.stringify(final));
    await waitForTestEvent(storage.subscribe, () => expect(
      readCanonicalVoiceTranscriptSnapshot('codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        itemId: 'codex-v3:1:turn-direct-final',
        role: 'assistant',
        text: 'Finished once.',
        revision: 1,
        final: true,
      }),
    ]));
    await waitForTestEvent(storage.subscribe, () => expect(
      readStoredSessionMessages(storage.getState(), 'codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        kind: 'agent-text',
        text: 'Finished once.',
        meta: expect.objectContaining({
          happier: expect.objectContaining({
            conversationTurnOriginV1: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
              source: {
                pluginId: 'happier.agent.codex',
                contributionId: 'realtime-codex',
              },
            },
          }),
        }),
      }),
    ]));
    expect(transcriptPostCount()).toBe(1);
    expect(runtime.adapter.getSnapshot().mode).toBe('idle');
    expect(readPhaseLabel()).toBe('voiceAssistant.label');
    persistenceCleanup?.();
    const secondBrowser = installVoiceWebRtcBrowserBoundary();
    browser.peer.channel.close();
    await waitForTestEvent(subscribeRpc, () => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1));
    await Promise.resolve(browser.peerCreated().then(peer => peer.closed)).then(() => expect(browser.peer.close).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(secondBrowser.peers).toHaveLength(0);
    resolveFirstStop({ ok: true, status: 'stopped' });
    await Promise.resolve(secondBrowser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(secondBrowser.peer.createDataChannel).toHaveBeenCalledTimes(1));
    secondBrowser.peer.channel.open();
    await waitForTestEvent(runtime.adapter.subscribe!, () => expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'connected',
    }));
    expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'connected',
    });
    expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1);
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.start'),
    )).toHaveLength(2);
    expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(1);
    const firstStopRpc = rpcBoundary.sessionRpc.mock.calls
      .map(([input]) => input as Readonly<{ sessionId: string; method: string; payload: unknown }>)
      .find((input) => input.method.endsWith('.stop'));
    expect(firstStopRpc).toMatchObject({
      sessionId: 'codex-direct-session',
      payload: { applicationAttemptId },
    });

    await installTranscriptPersistenceBoundary();
    secondBrowser.peer.channel.message(JSON.stringify({
      type: 'turn.done',
      turn: {
        id: 'turn-second-attempt',
        role: 'assistant',
        transcript: 'Second attempt survives.',
      },
    }));
    await waitForTestEvent(storage.subscribe, () => expect(
      readCanonicalVoiceTranscriptSnapshot('codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        epoch: 1,
        itemId: 'codex-v3:1:turn-direct-final',
        role: 'assistant',
        text: 'Finished once.',
        revision: 1,
        final: true,
      }),
      expect.objectContaining({
        // A reconnect retains the controller's current logical conversation
        // attempt; it must not create a second persistence epoch.
        epoch: 1,
        itemId: 'codex-v3:1:turn-second-attempt',
        role: 'assistant',
        text: 'Second attempt survives.',
        revision: 1,
        final: true,
      }),
    ]));
    await waitForTestEvent(storage.subscribe, () => expect(
      readStoredSessionMessages(storage.getState(), 'codex-direct-session'),
    ).toEqual([
      expect.objectContaining({
        kind: 'agent-text',
        text: 'Finished once.',
      }),
      expect.objectContaining({
        kind: 'agent-text',
        text: 'Second attempt survives.',
        meta: expect.objectContaining({
          happier: expect.objectContaining({
            conversationTurnOriginV1: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
              source: {
                pluginId: 'happier.agent.codex',
                contributionId: 'realtime-codex',
              },
            },
          }),
        }),
      }),
    ]));
    expect(transcriptPostCount()).toBe(2);
    expect(consoleError).not.toHaveBeenCalledWith(
      '[fireAndForget] VoiceTranscriptProjector.persistFinal',
      expect.anything(),
    );
    persistenceCleanup?.();

    expect(watchResolvers).toHaveLength(2);
    watchResolvers[1]!({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await Promise.resolve(secondBrowser.peerCreated().then(peer => peer.closed)).then(() => expect(secondBrowser.peer.close).toHaveBeenCalledTimes(1));
    await waitForTestEvent(subscribeRpc, () => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(2));
    await waitForTestEvent(runtime.adapter.subscribe!, () => expect(runtime.adapter.getSnapshot().status).not.toBe('connected'));

    const thirdBrowser = installVoiceWebRtcBrowserBoundary();
    const playbackEntered = createDeferred<void>();
    const remoteAudio = {
      autoplay: false,
      srcObject: null as MediaStream | null,
      volume: 1,
      play: vi.fn(async () => {
        playbackEntered.resolve();
        throw new DOMException(
          'browser autoplay policy detail must not escape',
          'NotAllowedError',
        );
      }),
      pause: vi.fn<() => void>(),
      remove: vi.fn<() => void>(),
    };
    vi.stubGlobal('document', {
      createElement: vi.fn((tagName: string) => {
        if (tagName !== 'audio') throw new Error(`unexpected element: ${tagName}`);
        return remoteAudio;
      }),
    });
    const thirdStarting = runtime.adapter.start({
      sessionId: 'codex-direct-session',
      requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
    });
    const thirdRejected = expect(thirdStarting).rejects.toMatchObject({
      code: 'voice_webrtc_remote_audio_playback_failed',
      message: 'voice_webrtc_remote_audio_playback_failed',
    });
    await Promise.resolve(thirdBrowser.peerCreated().then(peer => peer.remoteDescriptionSet)).then(() => expect(thirdBrowser.peer.setRemoteDescription).toHaveBeenCalledTimes(1));
    const remoteTrackEvent = new Event('track');
    Object.defineProperties(remoteTrackEvent, {
      track: { value: { id: 'remote-playback-failure' } as MediaStreamTrack },
      streams: { value: [{ id: 'remote-playback-stream' } as MediaStream] },
    });
    thirdBrowser.peer.dispatchEvent(remoteTrackEvent);
    await playbackEntered.promise;
    expect(remoteAudio.play).toHaveBeenCalledTimes(1);
    thirdBrowser.peer.channel.open();

    await thirdRejected;
    expect(runtime.adapter.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'voice_webrtc_remote_audio_playback_failed',
      errorMessage: 'voice_webrtc_remote_audio_playback_failed',
    });
    await waitForTestEvent(subscribeRpc, () => expect(rpcBoundary.sessionRpc.mock.calls.filter(
      ([input]) => String((input as { method?: unknown }).method).endsWith('.stop'),
    )).toHaveLength(3));

    await runtime.dispose();
    hostLease.revoke();
    thirdBrowser.restore();
    secondBrowser.restore();
    browser.restore();
  });

  it('sanitizes native rejection through the host classifier and closes only the bound Voice attachment', async () => {
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      sessionId: string;
      method: string;
      payload: unknown;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=test-answer\r\n' },
        };
      }
      if (input.method.endsWith('.watch')) return await new Promise(() => {});
      if (input.method.endsWith('.stop')) return { ok: true, status: 'stopped' };
      throw new Error(`unexpected session RPC: ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const presentAttemptDiagnostic = vi.fn(hostLease.host.presentAttemptDiagnostic);
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
      presentAttemptDiagnostic,
    });
    const runtime = await activateCodexEntry({ host: webHost, authorityHost: hostLease.host });
    registerVoiceAdapters([runtime.adapter]);

    try {
      const starting = runtime.adapter.start({
        sessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;
      expect(runtime.adapter.getSnapshot().status).toBe('connected');
      expect(browser.peer.channel.sent.map((frame) => JSON.parse(frame).type))
        .not.toContain('session.update');

      browser.peer.channel.message(JSON.stringify({
        type: 'error',
        error: { message: 'Bearer private-token; private session context', code: 'private-code' },
      }));
      await waitForTestEvent(runtime.adapter.subscribe!, () => expect(runtime.adapter.getSnapshot()).toMatchObject({
        status: 'disconnected',
        errorCode: 'provider_error',
        errorMessage: 'upstream_rejected',
        errorRecoveryAction: 'retry',
        errorPresentation: 'notice',
      }));
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      const stopRpcs = rpcBoundary.sessionRpc.mock.calls
        .map(([input]) => input as Readonly<{ sessionId: string; method: string; payload: unknown }>)
        .filter((input) => input.method.endsWith('.stop'));
      expect(stopRpcs).toEqual([
        expect.objectContaining({ sessionId: 'codex-direct-session', method: 'session.agentRealtime.stop' }),
      ]);
      expect(storage.getState().sessions['codex-direct-session']?.active).toBe(true);
      expect(readCanonicalVoiceTranscriptSnapshot('codex-direct-session')).toEqual([]);
      expect(presentAttemptDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        diagnostic: { code: 'codex_v3_upstream_error', severity: 'warning' },
      }));
      expect(JSON.stringify(runtime.adapter.getSnapshot())).not.toContain('private');
      expect(JSON.stringify(presentAttemptDiagnostic.mock.calls)).not.toContain('private');
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('fails closed against an old daemon with no Agent-realtime method and opens no media or fallback', async () => {
    rpcBoundary.sessionRpc.mockRejectedValue(
      Object.assign(new Error('RPC method not available'), {
        errorCode: 'RPC_METHOD_NOT_AVAILABLE',
      }),
    );
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
    });
    const runtime = await activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        settings: storage.getState().settings,
      })).resolves.toBeNull();

      const methods = rpcBoundary.sessionRpc.mock.calls.map(
        ([input]) => String((input as Readonly<{ method?: unknown }>).method),
      );
      expect(methods).toEqual(['session.agentRealtime.inspect']);
      expect(methods).not.toContain('session.agentRealtime.start');
      expect(methods.some((method) => method.includes('voice_media'))).toBe(false);
      expect(browser.peers).toHaveLength(0);
      expect(storage.getState().settings.voice.providerId).toBe('happier.agent.codex/realtime-codex');
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('names an inactive target session as an unavailable session rather than a connection failure', async () => {
    // A resumable-but-inactive target is a real, common, user-reachable Start
    // refusal decided entirely on device. Reported as `voice_connection_failed`
    // it is byte-identical to a transport fault and offers the wrong remedy.
    storage.setState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        'codex-direct-session': {
          ...current.sessions['codex-direct-session'],
          active: false,
        },
      },
    }) as never);
    rpcBoundary.sessionRpc.mockImplementation(async () => {
      throw new Error('inspect must not be reached for an inactive target session');
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
    });
    const runtime = await activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });
    registerVoiceAdapters([runtime.adapter]);

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        settings: storage.getState().settings,
      })).rejects.toMatchObject({ code: 'session_unavailable' });

      await expect(runtime.adapter.start({
        sessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      })).rejects.toMatchObject({ code: 'session_unavailable' });

      expect(runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'session_unavailable',
        errorPresentation: 'error',
      });
      expect(rpcBoundary.sessionRpc).not.toHaveBeenCalled();
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(browser.peers).toHaveLength(0);
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('projects a retryable global binding preflight failure before microphone or WebRTC acquisition', async () => {
    await restoreGlobalCreationAccount();
    restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        [CODEX_CONNECTED_SERVICE_KEY]: {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'voice-profile',
        },
      },
    };
    const globalMachine = createMachineFixture({
      id: 'machine-global-preflight',
      activeAt: Date.now(),
      metadata: {
        ...createMachineFixture().metadata!,
        homeDir: '/Users/global-preflight',
        happyHomeDir: '/Users/global-preflight/.happier',
      },
    });
    const voice = voiceSettingsParse({
      providerId: 'happier.agent.codex/realtime-codex',
      executionMachine: {
        mode: 'fixed',
        machineId: globalMachine.id,
      },
      providers: {
        'happier.agent.codex/realtime-codex': {
          schemaVersion: 2,
          config: { globalConnectedServices: connectedServices },
        },
        local_conversation: {
          schemaVersion: 1,
          config: {
            agent: {
              permissionIntent: 'safe-yolo',
              voiceHomeSubdirName: 'codex-global-preflight',
            },
          },
        },
      },
    });
    daemonMachines = { [globalMachine.id]: globalMachine };
    storage.setState((current) => ({
      ...current,
      settings: settingsParse({ ...settingsDefaults, ...normalizeVoiceSettingsLocalDelta({ voice }, settingsDefaults) }),
    }) as never);
    observeMachinePresenceForTest({ serverId: activeServerId, accountId: 'codex-composed-account' }, [globalMachine.id]);
    globalCreationSettings = storage.getState().settings;
    await sync.refreshMachines();
    expect(storage.getState().machines[globalMachine.id]?.metadata).toMatchObject(globalMachine.metadata!);
    daemonProjection = PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          codex: {
            id: 'codex',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            isBuiltIn: true,
            capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, startupInstructions: { versions: [1] } } },
          },
        },
        familiesById: {},
      });
    machineRpcBoundary.machineRpc.mockImplementation(async (input) => {
      if (input.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection: daemonProjection };
      if (input.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return createExistingSessionDirectoryPreflightResult(input.payload);
      return {
        type: 'error' as const,
        code: 'spawn_failed' as const,
        retryable: true,
        providerError: {
          v: 1 as const,
          code: 'provider_secret_unavailable' as const,
          retryable: true,
          action: 'retry' as const,
        },
      };
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const createService = hostLease.host.createAgentSessionRealtimeService;
    if (!createService) throw new Error('Codex requires the actual Agent realtime service');
    const createAgentSessionRealtimeService = vi.fn(createService);
    const host = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
      createAgentSessionRealtimeService,
    });
    const runtime = await activateCodexEntry({ host, authorityHost: hostLease.host });
    registerVoiceAdapters([runtime.adapter]);

    try {
      await expect(runtime.adapter.start({
        sessionId: host.globalVoiceSessionId,
        requestedTargetSessionAddress: null,
      })).rejects.toMatchObject({
        code: 'service_temporarily_unavailable',
        message: 'service_temporarily_unavailable',
      });
      // A preflight refusal the user must retry is surfaced, not swallowed:
      // projected as a recoverable notice it read as `disconnected`, which the
      // surface renders as plain idle, so Start showed nothing at all.
      expect(runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error',
        errorCode: 'service_temporarily_unavailable',
        errorMessage: 'service_temporarily_unavailable',
        errorRecoveryAction: 'retry',
        errorPresentation: 'error',
      });
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(browser.peers).toHaveLength(0);
      expect(machineRpcBoundary.machineRpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SESSION_SPAWN_NEW)).toHaveLength(1);
      expect(createAgentSessionRealtimeService).not.toHaveBeenCalled();
      expect(rpcBoundary.sessionRpc).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it('preserves a safe start diagnostic through the canonical machine and excludes raw provider text', async () => {
    const rawProviderText = 'upstream rejected /Users/private/repository token=secret';
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      method: string;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        return {
          ok: false,
          status: 'failed',
          code: 'update_required',
          message: rawProviderText,
        };
      }
      throw new Error(`unexpected session RPC: ${input.method}`);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const webHost = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
    });
    const runtime = await activateCodexEntry({
      host: webHost,
      authorityHost: hostLease.host,
    });
    registerVoiceAdapters([runtime.adapter]);

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        settings: storage.getState().settings,
      })).resolves.toMatchObject({
        conversationSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      });

      await expect(runtime.adapter.start({
        sessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      })).rejects.toMatchObject({
        code: 'update_required',
        message: 'update_required',
      });

      const snapshot = runtime.adapter.getSnapshot();
      expect(snapshot).toMatchObject({
        status: 'error',
        errorCode: 'update_required',
        errorMessage: 'update_required',
        errorRecoveryAction: 'update_agent_runtime',
      });
      expect(JSON.stringify(snapshot)).not.toContain(rawProviderText);
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });

  it.each([
    'codex_realtime_retry_unavailable',
    'codex_realtime_runtime_restart_required',
  ] as const)(
    'keeps the %s start diagnostic as a generic user-retryable provider failure',
    async (diagnosticCode) => {
      rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
        method: string;
      }>) => {
        if (input.method.endsWith('.inspect')) {
          return { ok: true, status: 'available', transport: 'webrtc' };
        }
        if (input.method.endsWith('.start')) {
          return {
            ok: false,
            status: 'unavailable',
            code: diagnosticCode,
            message: 'provider text must not become a machine policy',
          };
        }
        throw new Error(`unexpected session RPC: ${input.method}`);
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const hostLease = createBundledConversationRuntimeHostLease();
      const host = Object.freeze({
        ...hostLease.host,
        getPlatform: () => 'web' as const,
        createMicSession: browser.createMicSession,
      });
      const runtime = await activateCodexEntry({ host, authorityHost: hostLease.host });
      registerVoiceAdapters([runtime.adapter]);

      try {
        await expect(runtime.adapter.start({
          sessionId: 'codex-direct-session',
          requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        })).rejects.toMatchObject({
          code: diagnosticCode,
          message: diagnosticCode,
        });
        expect(runtime.adapter.getSnapshot()).toMatchObject({
          status: 'disconnected',
          errorCode: 'provider_error',
          errorMessage: diagnosticCode,
          errorRecoveryAction: 'retry',
          errorPresentation: 'notice',
        });
        expect(rpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => String((input as Readonly<{ method?: unknown }>).method).endsWith('.start'),
        )).toHaveLength(1);
      } finally {
        await runtime.dispose();
        hostLease.revoke();
        browser.restore();
      }
    },
  );

  it.each([
    'codex_realtime_retry_unavailable',
    'codex_realtime_runtime_restart_required',
  ] as const)(
    'matches that generic user-retryable policy when %s arrives after start',
    async (diagnosticCode) => {
      let resolveWatch!: (value: unknown) => void;
      rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
        method: string;
      }>) => {
        if (input.method.endsWith('.inspect')) {
          return { ok: true, status: 'available', transport: 'webrtc' };
        }
        if (input.method.endsWith('.start')) {
          return {
            ok: true,
            status: 'started',
            transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=terminal-answer\r\n' },
          };
        }
        if (input.method.endsWith('.watch')) {
          return await new Promise((resolve) => {
            resolveWatch = resolve;
          });
        }
        if (input.method.endsWith('.stop')) return { ok: true, status: 'stopped' };
        throw new Error(`unexpected session RPC: ${input.method}`);
      });
      const browser = installVoiceWebRtcBrowserBoundary();
      const hostLease = createBundledConversationRuntimeHostLease();
      const host = Object.freeze({
        ...hostLease.host,
        getPlatform: () => 'web' as const,
        createMicSession: browser.createMicSession,
      });
      const runtime = await activateCodexEntry({ host, authorityHost: hostLease.host });
      registerVoiceAdapters([runtime.adapter]);

      try {
        const starting = runtime.adapter.start({
          sessionId: 'codex-direct-session',
          requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        });
        await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
        browser.peer.channel.open();
        await starting;

        resolveWatch({
          ok: true,
          status: 'terminal',
          event: {
            kind: 'terminal',
            reason: 'error',
            diagnostic: { code: diagnosticCode, severity: 'error' },
          },
        });
        await waitForTestEvent(runtime.adapter.subscribe!, () => expect(runtime.adapter.getSnapshot()).toMatchObject({
          status: 'disconnected',
          errorCode: 'provider_error',
          errorMessage: diagnosticCode,
          errorRecoveryAction: 'retry',
          errorPresentation: 'notice',
        }));
        expect(rpcBoundary.sessionRpc.mock.calls.filter(
          ([input]) => String((input as Readonly<{ method?: unknown }>).method).endsWith('.start'),
        )).toHaveLength(1);
      } finally {
        await runtime.dispose();
        hostLease.revoke();
        browser.restore();
      }
    },
  );

  it('composes Global through the real hidden-session owner before exact hidden-session inspection', async () => {
    await restoreGlobalCreationAccount();
    installDirectSessionState();
    restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        [CODEX_CONNECTED_SERVICE_KEY]: {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'codex-global-profile',
        },
      },
    };
    const globalMachine = createMachineFixture({
      id: 'machine-global',
      activeAt: Date.now(),
      metadata: {
        ...createMachineFixture().metadata!,
        homeDir: '/Users/global',
        happyHomeDir: '/Users/global/.happier',
      },
    });
    const voice = voiceSettingsParse({
      providerId: 'happier.agent.codex/realtime-codex',
      executionMachine: {
        mode: 'fixed',
        machineId: globalMachine.id,
      },
      providers: {
        'happier.agent.codex/realtime-codex': {
          schemaVersion: 2,
          config: { globalConnectedServices: connectedServices },
        },
        local_conversation: {
          schemaVersion: 1,
          config: {
            agent: {
              permissionIntent: 'safe-yolo',
              voiceHomeSubdirName: 'codex-global-voice',
            },
          },
        },
      },
    });
    daemonMachines = { [globalMachine.id]: globalMachine };
    storage.setState((current) => ({
      ...current,
      settings: settingsParse({
        ...settingsDefaults,
        ...normalizeVoiceSettingsLocalDelta({ voice }, settingsDefaults),
      }),
      sessions: {
        ...current.sessions,
        // Production's cold-resume proof is deliberately false. This exact
        // candidate must not be inspected or reused while resolving Global.
        'hidden-never-reused': createSessionFixture({
          id: 'hidden-never-reused',
          active: true,
          encryptionMode: 'plain',
          metadata: {
            machineId: globalMachine.id,
            path: '/Users/global/.happier/codex-global-voice',
            host: 'global.test.local',
            flavor: 'codex',
            connectedServices,
            systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
            voiceAgentStartupInstructionsV1: { v: 1, id: 'voice-global', revision: 1 },
          },
          permissionMode: 'safe-yolo',
        }),
      },
    }) as never);
    observeMachinePresenceForTest({ serverId: activeServerId, accountId: 'codex-composed-account' }, [globalMachine.id]);
    globalCreationSettings = storage.getState().settings;
    await sync.refreshMachines();
    expect(storage.getState().machines[globalMachine.id]?.metadata).toMatchObject(globalMachine.metadata!);

    daemonProjection = PluginProjectionV2Schema.parse({
          v: 2,
          generation: 1,
          agentsById: {
            codex: {
              id: 'codex',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              isBuiltIn: true,
              capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, startupInstructions: { versions: [1] } } },
            },
            'acme.codex': {
              id: 'acme.codex',
              identity: { pluginId: 'acme.agent.codex', localId: 'codex' },
              isBuiltIn: false,
            },
          },
          familiesById: {},
        });

    const events: string[] = [];
    const spawnedSessionIds = ['hidden-global-failed', 'hidden-global-ready'];
    machineRpcBoundary.machineRpc.mockImplementation(async (input) => {
      if (input.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection: daemonProjection };
      if (input.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return createExistingSessionDirectoryPreflightResult(input.payload);
      const sessionId = spawnedSessionIds[events.filter(event => event.startsWith('spawn:')).length];
      if (!sessionId) throw new Error('unexpected trusted Global spawn');
      events.push(`spawn:${sessionId}`);
      daemonSessions[sessionId] = createSessionFixture({
        id: sessionId,
        serverId: activeServerId,
        active: true,
        encryptionMode: 'plain',
        metadata: {
          machineId: input.machineId,
          path: input.payload.directory.path,
          host: 'global.test.local',
          flavor: 'codex',
          connectedServices,
        },
        permissionMode: input.payload.permissionMode,
      });
      sessionHttp.replaceSession(sessionId);
      expect(storage.getState().sessions[sessionId]).toBeUndefined();
      return {
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId,
        executionTarget: { serverId: activeServerId, machineId: globalMachine.id },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
      };
    });
    sessionHttp.rejectNextPatch('hidden-global-failed');

    let resolveWatch!: (value: unknown) => void;
    const assertFinalizedHiddenSession = (sessionId: string): void => {
      expect(sessionId).toBe('hidden-global-ready');
      expect(storage.getState().sessions[sessionId]?.active).toBe(true);
      expect(readSessionOwnerMetadataView(storage.getState().sessions[sessionId]!)).toMatchObject({
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
          voiceAgentStartupInstructionsV1: expect.objectContaining({ v: 1 }),
      });
    };
    rpcBoundary.sessionRpc.mockImplementation(async (input: Readonly<{
      sessionId: string;
      method: string;
    }>) => {
      if (input.method.endsWith('.inspect')) {
        events.push(`inspect:${input.sessionId}`);
        if (input.sessionId === 'hidden-global-ready') assertFinalizedHiddenSession(input.sessionId);
        return { ok: true, status: 'available', transport: 'webrtc' };
      }
      if (input.method.endsWith('.start')) {
        events.push(`start:${input.sessionId}`);
        assertFinalizedHiddenSession(input.sessionId);
        return {
          ok: true,
          status: 'started',
          transport: { kind: 'webrtc', answerSdp: 'v=0\r\na=global-answer\r\n' },
        };
      }
      if (input.method.endsWith('.watch')) {
        return await new Promise((resolve) => {
          resolveWatch = resolve;
        });
      }
      if (input.method.endsWith('.stop')) return { ok: true, status: 'stopped' };
      throw new Error(`unexpected session RPC: ${input.method}`);
    });

    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const host = Object.freeze({
      ...hostLease.host,
      getPlatform: () => 'web' as const,
      createMicSession: browser.createMicSession,
      async createAgentSessionRealtimeService(input: Parameters<CreateAgentSessionRealtimeService>[0]) {
        const storedBinding = voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        );
        events.push(`service:${storedBinding?.conversationSessionId ?? 'none'}`);
        expect(storedBinding).toMatchObject({ conversationSessionId: 'hidden-global-ready' });
        const createService = hostLease.host.createAgentSessionRealtimeService;
        return createService ? await createService(input) : null;
      },
    });
    const runtime = await activateCodexEntry({ host, authorityHost: hostLease.host });

    try {
      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: host.globalVoiceSessionId,
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'visible-global-target' },
        settings: storage.getState().settings,
      })).rejects.toMatchObject({ code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED' });
      expect(readSessionOwnerMetadataView(storage.getState().sessions['hidden-global-failed']!)).toMatchObject({
        systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
      });
      registerVoiceAdapters([runtime.adapter]);
      expect(storage.getState().settings.voice.executionMachine).toEqual({ mode: 'fixed', machineId: globalMachine.id });
      const starting = runtime.adapter.start({
        sessionId: host.globalVoiceSessionId,
        requestedTargetSessionAddress: null,
      });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]).then(() => {
        expect(events).toContain('service:hidden-global-ready');
        expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      });
      browser.peer.channel.open();
      await starting;
      expect(voiceSessionBindingStore.getState().getByControlSessionId(
        host.globalVoiceSessionId,
      )).toMatchObject({
        conversationSessionId: 'hidden-global-ready',
        transcriptMode: 'native_session',
        targetSessionAddress: null,
      });
      expect(machineRpcBoundary.machineRpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SESSION_SPAWN_NEW)).toHaveLength(2);
      expect(machineRpcBoundary.machineRpc).toHaveBeenCalledWith(expect.objectContaining({
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        machineId: globalMachine.id, serverId: activeServerId,
      }));
      expect(events.indexOf('spawn:hidden-global-ready')).toBeLessThan(
        events.indexOf('inspect:hidden-global-ready'),
      );
      expect(events).not.toContain('inspect:hidden-never-reused');
      expect(events.indexOf('spawn:hidden-global-ready')).toBeLessThan(
        events.indexOf('start:hidden-global-ready'),
      );

      await runtime.adapter.stop({ sessionId: host.globalVoiceSessionId });
      resolveWatch({
        ok: true,
        status: 'terminal',
        event: { kind: 'terminal', reason: 'stopped' },
      });

      await expect(runtime.adapter.resolveConversationBinding?.({
        controlSessionId: 'codex-direct-session',
        requestedTargetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        settings: storage.getState().settings,
      })).resolves.toEqual({
        conversationSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
        transcriptMode: 'native_session',
        targetSessionAddress: { serverId: activeServerId, sessionId: 'codex-direct-session' },
      });
      expect(machineRpcBoundary.machineRpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SESSION_SPAWN_NEW)).toHaveLength(2);
    } finally {
      await runtime.dispose();
      hostLease.revoke();
      browser.restore();
    }
  });
});
