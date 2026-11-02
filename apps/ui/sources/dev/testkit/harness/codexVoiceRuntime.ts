import { expect, vi } from 'vitest';
import { createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { BundledRealtimeProviderRuntimeHost } from '@/voice/registry/bundledConversationRuntimeContract';
import type { installVoiceWebRtcBrowserBoundary } from './voiceWebRtcHarness';

export type CodexVoiceRpcRequest = Readonly<{
    serverId: string;
    accountId: string | null;
    timeoutMs: number | null;
    method: string;
    payload: unknown;
}>;

type CreateAgentSessionRealtimeService = NonNullable<BundledRealtimeProviderRuntimeHost['createAgentSessionRealtimeService']>;

/** The incumbent generated Codex recipe; only Home HTTP and Socket SDK replies are authored here. */
export async function createCodexVoiceRuntimeEnvironment() {
    await import('@/sync/syncEngine');
    const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
    const { buildQualifiedPluginContributionKey, createPluginContributionIdentity, FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
    const { encodePlainMachineStoredContent } = await import('@happier-dev/protocol/machines/machineStoredContent');
    const { ACP_CATALOG_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
    const { createSessionMetadataHttpBoundary } = await import('./sessionMetadataHttpBoundary');
    const { answerVoiceRealtimePreparationHttpRequest } = await import('./voiceRealtimePreparationHttpBoundary');
    const { restoreServerAccountForTest } = await import('./serverAccountConnectionHarness');
    const { installRealActionExecutorModuleLoader } = await import('./actionHomesHttpHarness');
    const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults, settingsParse, applySettings } = await import('@/sync/domains/settings/settings');
    const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { sync } = await import('@/sync/sync');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { refreshAcpCatalog } = await import('@/sync/engine/settings/acpCatalogEngine');
    const { parseToken } = await import('@/utils/auth/parseToken');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } = await import('@/voice/registry/bundledConversationRuntimeHost');
    const { createBundledVoiceRecipientContract } = await import('@/voice/credentials/voiceRecipientContract');
    const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const { getExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
    const browserStorage = typeof globalThis.localStorage === 'undefined' ? installLocalStorageMock() : null;
    const foundEntry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(candidate => candidate.declaration.id === 'realtime-codex');
    if (!foundEntry) throw new Error('realtime_codex bundled entry missing');
    const entry = foundEntry;
    const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId: entry.pluginId, localId: entry.declaration.id }));
    const accountId = 'codex-composed-account';
    const server = getActiveServerSnapshot();
    const serverSessions: Record<string, Session> = {
        'codex-direct-session': createSessionFixture({
            id: 'codex-direct-session', serverId: server.serverId, active: true, encryptionMode: 'plain',
            metadata: { path: '/workspace/direct', host: 'test.local', homeDir: '/Users/tester', machineId: 'machine-direct', flavor: 'codex' },
        }),
    };
    const serverMachines: Record<string, Machine> = {
        'machine-direct': createMachineFixture({ id: 'machine-direct', activeAt: Date.now() }),
    };
    const sessionHttp = createSessionMetadataHttpBoundary(() => serverSessions);
    let settingsVersion = (storage.getState().settingsVersion ?? 0) + 1;
    let persistedSettings = settingsParse({
        ...settingsDefaults,
        ...normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse({ providerId,
            providers: { [providerId]: { schemaVersion: 2, config: { globalConnectedServices: null } } },
        }) }, settingsDefaults),
    });
    let nextTranscriptSeq = 0;
    let daemonProjection: PluginProjectionV2 | null = null;
    const rpcBoundary = { sessionRpc: vi.fn<(input: CodexVoiceRpcRequest & Readonly<{ sessionId: string }>) => Promise<unknown>>() };
    const machineRpcBoundary = { machineRpc: vi.fn<(input: CodexVoiceRpcRequest & Readonly<{ machineId: string }>) => Promise<unknown>>() };
    let homeResponse: (input: URL | RequestInfo, init?: RequestInit) => Response | null | Promise<Response | null> = () => null;
    const transcriptRequest = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (/^\/v[123]\/sessions\/[^/]+\/messages$/.test(path) && (init?.method ?? 'GET') === 'GET') return Response.json({ messages: [], hasMore: false });
        if (path !== '/v2/sessions/codex-direct-session/messages') return Response.json({ error: 'not_found' }, { status: 404 });
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body)) as Readonly<{ localId: string }>;
        nextTranscriptSeq += 1;
        return Response.json({ didWrite: true, message: { id: `codex-direct-message-${nextTranscriptSeq}`,
            seq: nextTranscriptSeq, localId: body.localId, createdAt: Date.now() } });
    });
    const readMachineRow = (machine: Machine) => ({
        ...createPlainMachineRowFixture({ id: machine.id, accountId }),
        seq: machine.seq, createdAt: machine.createdAt, updatedAt: machine.updatedAt,
        active: machine.active, activeAt: machine.activeAt, metadata: encodePlainMachineStoredContent(machine.metadata),
        metadataVersion: machine.metadataVersion, daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null,
        daemonStateVersion: machine.daemonStateVersion,
    });
    const request = createSessionReadBatchFetchBoundary(async (input: URL | RequestInfo, init?: RequestInit): Promise<Response | null> => {
        const response = await homeResponse(input, init);
        if (response) return response;
        const path = new URL(String(input)).pathname;
        if (path === '/health') return Response.json({});
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: accountId,
            connectedServicesV2: [{ serviceId: 'openai-codex', profiles: ['voice-profile', 'codex-global-profile'].map(profileId => ({ profileId, status: 'connected', kind: 'oauth' })) }],
            connectedServiceCredentialRevisionsV1: ['voice-profile', 'codex-global-profile'].map(profileId => ({ serviceId: 'openai-codex', profileId, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })),
        }));
        const sessionResponse = sessionHttp.handle(input, init);
        if (sessionResponse) return sessionResponse;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: persistedSettings }, version: settingsVersion });
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } });
        if (path === '/v1/machines') return Response.json(Object.values(serverMachines).map(readMachineRow));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => serverMachines[id] ? readMachineRow(serverMachines[id]!) : null);
        const machineMatch = /^\/v1\/machines\/([^/]+)$/.exec(path);
        if (machineMatch) {
            const machine = serverMachines[decodeURIComponent(machineMatch[1]!)];
            return machine ? Response.json({ machine: readMachineRow(machine) }) : Response.json({}, { status: 404 });
        }
        const accessMatch = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
        if (accessMatch) {
            const machineId = decodeURIComponent(accessMatch[1]!);
            const machine = serverMachines[machineId];
            if (!machine) return Response.json({}, { status: 404 });
            const row = readMachineRow(machine);
            return Response.json({ machineId, custodian: row.access!.custodian, access: row.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
        }
        const preparation = answerVoiceRealtimePreparationHttpRequest(input, persistedSettings);
        if (preparation) return preparation;
        return transcriptRequest(input, init);
    });
    const configureSocket: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']> = (socket, serverUrl) => {
        let timeoutMs: number | null = null;
        socket.connect = vi.fn<typeof socket.connect>(() => {
            if (!socket.connected) { socket.connected = true; for (const listener of socket.listeners('connect')) listener(); }
            return socket;
        });
        socket.timeout = vi.fn<typeof socket.timeout>(value => { timeoutMs = value ?? null; return socket; });
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Expected a framed Socket RPC');
            const token = typeof socket.auth === 'object' && 'token' in socket.auth ? socket.auth.token : undefined;
            if (serverUrl !== accountConnection.home.serverUrl || token !== accountConnection.credentials.token) throw new Error('Expected the captured Home Account credential');
            const separator = payload.method.indexOf(':');
            const targetId = payload.method.slice(0, separator);
            const method = payload.method.slice(separator + 1);
            const requestTimeoutMs = timeoutMs; timeoutMs = null;
            const authority = { serverId: accountConnection.home.id, accountId: parseToken(accountConnection.credentials.token), timeoutMs: requestTimeoutMs, method, payload: payload.params };
            const result = method.startsWith('session.agentRealtime.')
                ? await rpcBoundary.sessionRpc({ ...authority, sessionId: targetId })
                : await machineRpcBoundary.machineRpc({ ...authority, machineId: targetId });
            return { ok: true, result };
        });
    };
    const accountConnection = await restoreServerAccountForTest({
        serverUrl: server.serverUrl, accountId, credentialScope: 'restored-home',
        activation: apiSocket.getMachineRequestScope() ? 'switch' : undefined,
        configureSocket, request,
    });
    for (const session of Object.values(serverSessions)) session.serverId = accountConnection.home.id;
    const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    await sync.refreshProfile();
    await sync.refreshAccountSettingsFromServer(settingsVersion, storage.getState().settingsScope);
    await refreshAcpCatalog({ serverId: accountConnection.home.id, accountId });
    await sync.refreshMachines();
    await sync.refreshSessions({ awaitSessionListHydration: true });

    async function configureVoice(input: unknown): Promise<void> {
        const current = storage.getState().settings;
        persistedSettings = applySettings(current, normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse(input) }, current));
        settingsVersion += 1;
        await sync.refreshAccountSettingsFromServer(settingsVersion, storage.getState().settingsScope);
    }
    async function publishSessions(): Promise<void> {
        for (const id of Object.keys(serverSessions)) sessionHttp.replaceSession(id);
        await sync.refreshSessions({ awaitSessionListHydration: true });
    }
    async function publishMachines(): Promise<void> { await sync.refreshMachines(); }

    async function createRuntime(_browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>, observers: Readonly<{
        onCreateAgentSessionRealtimeService?(input: Parameters<CreateAgentSessionRealtimeService>[0]): void;
    }> = {}) {
        const hostLease = createBundledConversationRuntimeHostLease();
        let controller: ReturnType<BundledRealtimeProviderRuntimeHost['createConversationController']> | null = null;
        const presentAttemptDiagnostic = vi.fn(hostLease.host.presentAttemptDiagnostic);
        const host = Object.freeze({ ...hostLease.host, presentAttemptDiagnostic,
            createConversationController(input: Parameters<BundledRealtimeProviderRuntimeHost['createConversationController']>[0]) {
                controller = hostLease.host.createConversationController(input); return controller;
            },
            async createAgentSessionRealtimeService(input: Parameters<CreateAgentSessionRealtimeService>[0]) {
                observers.onCreateAgentSessionRealtimeService?.(input);
                const createService = hostLease.host.createAgentSessionRealtimeService;
                if (!createService) throw new Error('Codex requires the actual Agent realtime service');
                return await createService(input);
            },
        });
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: entry.pluginId, occurrenceId: `${entry.pluginId}-activation-occurrence`, declarations: [entry.declaration],
            hostPlatform: host.getPlatform(), runtimeHost: host,
            isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
            hostBindingsByLocalId: Object.freeze({ [entry.declaration.id]: Object.freeze({
                recipientContract: createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration }), descriptor: 'bundled' as const,
            }) }),
        });
        const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
        (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
        await scope.commit();
        const registration = getExternalVoiceProviderRegistration(providerId);
        if (!registration?.adapter) throw new Error('realtime_codex bundled activation failed');
        registerVoiceAdapters([registration.adapter]);
        const runtime = Object.freeze({ adapter: registration.adapter, async dispose() { await scope.unwind(); } });
        return { runtime, adapter: runtime.adapter, host, hostLease, presentAttemptDiagnostic,
            getController() { if (!controller) throw new Error('Codex controller has not been constructed'); return controller; },
        };
    }
    return {
        entry, providerId, accountConnection, activeServerId: accountConnection.home.id,
        serverSessions, serverMachines, sessionHttp, transcriptRequest, rpcBoundary, machineRpcBoundary,
        get daemonProjection(): PluginProjectionV2 | null { return daemonProjection; },
        set daemonProjection(value: PluginProjectionV2 | null) { daemonProjection = value; },
        get homeResponse() { return homeResponse; },
        set homeResponse(value) { homeResponse = value; },
        configureVoice, publishSessions, publishMachines, createRuntime,
        async dispose() { await accountConnection.dispose(); restoreExecutorModuleLoader(); browserStorage?.restore(); },
    };
}
