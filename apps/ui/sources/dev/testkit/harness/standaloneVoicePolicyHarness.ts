import { vi } from 'vitest';
import 'fake-indexeddb/auto';
import { CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { installVitestRnShim } from '@/dev/vitestRnShim';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { createAccountKvHttpFixture } from '../fixtures/accountKvHttpFixture';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import { createCompactSessionListFetchBoundary } from './sessionReadBatchHttpBoundary';
import { createConnectedPurposeCatalogHttpBoundary } from './connectedAccountCatalogBoundary';
import type { SettingsWriteDelta } from '@/sync/domains/settings/settings';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createExternalActionAccountHttpBoundary } from './externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from './homeGovernanceHarness';
import { ExecutionRunEnsureRequestSchema, ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExternalActionRequesterInvocationBaseV1Schema } from '@happier-dev/protocol/sessions/creation/externalActionRequesterInvocationBaseV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

// Native/OS adapters only: Account, Sync, settings, catalog and launch remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebRuntime } = await import('../runtime/reactNativeRuntime');
    return createReactNativeWebRuntime(undefined, () => vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub'));
});
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
    const { createExpoUpdatesMock } = await import('../mocks/expoUpdates');
    return createExpoUpdatesMock();
});
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('../mocks/expoFileSystem');
    return createExpoFileSystemFileMock().module;
});
vi.mock('react-native-typography', async () => {
    const { createReactNativeTypographyMock } = await import('../mocks/reactNativeTypography');
    return createReactNativeTypographyMock();
});
vi.mock('@shopify/react-native-skia', async () => {
    const { createReactNativeSkiaMock } = await import('../mocks/reactNativeSkia');
    return createReactNativeSkiaMock();
});
// Expo's native image view manager does not exist in the Node process.
vi.mock('expo-image', () => ({ Image: 'Image' }));

let dispatch: (method: string, input: unknown) => Promise<unknown>;
const sockets = new Map<string, import('socket.io-client').Socket[]>();
const configureStandaloneSocket: Parameters<typeof installDisconnectedServerSocketBoundary>[0] = (socket, serverUrl) => {
    if (serverUrl) sockets.set(serverUrl, [...(sockets.get(serverUrl) ?? []), socket]);
    // Deliver the external handshake through the real Socket listeners, so
    // the connection supervisor (not the fixture) publishes availability.
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    // The external transport survives per-test spy restoration with pooled sockets.
    socket.emit = vi.fn<typeof socket.emit>(() => socket);
    socket.disconnect = vi.fn<typeof socket.disconnect>(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
        if (event === 'update-metadata') {
            const update = payload as { expectedVersion: number; metadata: string };
            return { result: 'success', version: update.expectedVersion + 1, metadata: update.metadata };
        }
        if (event !== 'rpc-call') throw new Error(`Unexpected transport event: ${event}`);
        const request = payload as { method: string; params: unknown };
        return { ok: true, result: await dispatch(request.method.slice(request.method.indexOf(':') + 1), request.params) };
    });
};
installDisconnectedServerSocketBoundary(configureStandaloneSocket);

/** Load the real UI graph during collection, before per-behavior deadlines. */
export async function prepareStandaloneVoicePolicyHarness() {
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('self', globalThis);
    installVitestRnShim();
    await loadSyncSingletonForTests();
    await Promise.all([
        import('@/voice/agent/initializeVoiceAgentHandle'),
        import('@/voice/agent/daemonVoiceAgentClient'),
        import('@/voice/runtime/execution/voiceWelcomePolicy'),
    ]);
}

export { createRetainedVoiceAgentRpcBoundary } from './voiceAgentRpcBoundary';

/** UI-owned half of a cross-program test; only transport dispatch crosses into CLI. */
export async function createStandaloneVoicePolicyHarness(params: Readonly<{
    mode: 'off' | 'immediate' | 'on_first_turn';
    dispatch: (method: string, input: unknown) => Promise<unknown>;
    existingSession?: Parameters<typeof createSessionFixture>[0];
    /** Additional server-created Sessions for exact target/privacy composition. */
    sessions?: ReadonlyArray<ReturnType<typeof createSessionFixture>>;
    initializeSessionId?: string;
    /** Additional genuine Home HTTP leaves; core Account and Session routes stay owned above. */
    handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
}>) {
    dispatch = params.dispatch;
    // Another composed fixture may configure this same canonical SDK factory
    // between collection and activation. This Home owns its network replies.
    installDisconnectedServerSocketBoundary(configureStandaloneSocket);
    // Cross-program callers do not run UI's global browser SDK setup.
    const browserStorage = typeof globalThis.localStorage === 'undefined' ? installLocalStorageMock() : null;
    const browserLocks = typeof globalThis.navigator?.locks === 'undefined' ? installWebLockManagerMock() : null;
    let teardownConnection: (() => Promise<void>) | undefined;
    try {
        await prepareStandaloneVoicePolicyHarness();
        const { storage } = await import('@/sync/domains/state/storage');
        const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
        const applyPreference = (delta: SettingsWriteDelta) =>
            storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta(delta, storage.getState().settings));
        const { initializeVoiceAgentHandle } = await import('@/voice/agent/initializeVoiceAgentHandle');
        const { DaemonVoiceAgentClient } = await import('@/voice/agent/daemonVoiceAgentClient');
        const { createVoiceWelcomePolicy } = await import('@/voice/runtime/execution/voiceWelcomePolicy');
        let session = createSessionFixture({ id: 'voice-parent', active: true, activeAt: Date.now(),
            metadata: { path: '/voice', host: 'voice.test', flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } },
            ...params.existingSession });
        const machineId = session.metadata?.machineId ?? 'voice-machine';
        session = { ...session, metadata: { path: '/voice', host: 'voice.test', ...session.metadata, machineId } };
        let actionBoundaries: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>[] = [];
        const { createSessionMetadataHttpBoundary } = await import('./sessionMetadataHttpBoundary');
        const extraSessions = params.sessions ?? [];
        const sessionHttp = createSessionMetadataHttpBoundary(() => Object.fromEntries([session, ...extraSessions].map(value => [value.id, value])));
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const baselineSettings = settingsParse({});
        const purposes = createConnectedPurposeCatalogHttpBoundary();
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const transcriptMemory = createAccountKvHttpFixture();
        const messageRequests: string[] = [];
        const connection = await restoreServerAccountForTest({
            serverUrl: `https://voice-policy-${params.mode}.example.test`,
            serverIdentityId: `srv_voice-policy-${params.mode}-home`,
            credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
            activation: 'switch', credentialScope: 'restored-home',
            request: createCompactSessionListFetchBoundary(async (url, init) => {
                for (const boundary of actionBoundaries) {
                    const response = await boundary.handle(new URL(String(url)), init);
                    if (response) return response;
                }
              if (new URL(String(url)).pathname === '/v2/sessions/read-batch' && init?.method === 'POST') return undefined;
                const memoryResponse = await transcriptMemory.handleFetch(url, init);
                if (memoryResponse) return memoryResponse;
                const path = new URL(String(url)).pathname;
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/features' || path === '/v1/features/authenticated') {
                    return Response.json(FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }));
                }
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a' });
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: baselineSettings } });
                if (path.endsWith('/messages')) {
                    messageRequests.push(path);
                    return Response.json({ messages: [], hasMore: false });
                }
                const sessionResponse = sessionHttp.handle(url, init);
                if (sessionResponse) return sessionResponse;
                const additionalResponse = await params.handleRequest?.(`${path}${new URL(String(url)).search}`, init);
                if (additionalResponse) return additionalResponse;
                const purposeResponse = await purposes.handle(url, init);
                if (purposeResponse) return purposeResponse;
                return new Response('{}', { status: 404 });
            }, { preferExactSnapshot: true }),
        });
        teardownConnection = connection.dispose;
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        await new Promise<void>(resolve => {
            let unsubscribe = () => {};
            const observeBootstrap = () => {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, connection.home.id)
                    || !storage.getState().isDataReady) return;
                unsubscribe();
                resolve();
            };
            unsubscribe = storage.subscribe(observeBootstrap);
            observeBootstrap();
        });
        session = { ...session, serverId: connection.home.id };
        const sessionScopeId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(connection.home.id);
        let admittedInvocation: ReturnType<typeof ExternalActionRequesterInvocationBaseV1Schema.parse> | undefined;
        try {
            if (!account.serverIdentityId) throw new Error('Expected the restored Voice Action Home');
            const serverIdentityId = account.serverIdentityId;
            actionBoundaries = await Promise.all((['execution.run.start', 'execution.run.ensure'] as const).map(actionId =>
                createExternalActionAccountHttpBoundary({ serverUrl: account.endpointUrl, serverIdentityId,
                    accountId: account.accountId, machineId, actionId, tokenEpoch: 0,
                    failure: value => value && typeof value === 'object' && 'ok' in value && value.ok === false
                        && 'errorCode' in value && typeof value.errorCode === 'string'
                        ? { errorCode: value.errorCode, error: 'error' in value && typeof value.error === 'string' ? value.error : value.errorCode,
                            ...('details' in value ? { details: value.details } : {}) } : null,
                    execute: async (input, context) => {
                        // This external daemon fixture exposes its existing Ensure-or-Start bridge
                        // beneath the genuine signed Action transport, just as the runtime does.
                        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a Run Action input');
                        const { sessionId: _sessionId, ...runInput } = input as Record<string, unknown>;
                        const request = actionId === 'execution.run.start'
                            ? { start: ExecutionRunStartRequestSchema.parse(runInput) }
                            : ExecutionRunEnsureRequestSchema.parse(runInput);
                        const result = await params.dispatch(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, request);
                        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) return result;
                        if (actionId === 'execution.run.ensure') return { ok: true, actionInvocation: admittedInvocation };
                        admittedInvocation = ExternalActionRequesterInvocationBaseV1Schema.parse(context.invocation && {
                            caller: context.invocation.caller, surface: context.invocation.surface, authority: context.invocation.authority,
                        });
                        return { runId: 'runId' in result ? result.runId : undefined, callId: 'voice-call', sidechainId: 'voice-sidechain',
                            ...('preparedInstructionsFor' in result ? { preparedInstructionsFor: result.preparedInstructionsFor } : {}),
                            actionInvocation: admittedInvocation };
                    },
                })));
        } finally { account.dispose(); }
        applyPreference({ experiments: true, featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
            voice: { ...storage.getState().settings.voice, providerId: 'local_conversation', assistantLanguage: 'fr-FR', welcome: { ...storage.getState().settings.voice.welcome, enabled: params.mode !== 'off', mode: params.mode === 'on_first_turn' ? params.mode : 'immediate' },
                providers: { local_conversation: { schemaVersion: 1, config: { agent: { agentSource: 'agent', agentId: 'claude', prewarmOnConnect: false, transcript: { persistenceMode: 'ephemeral', epoch: 0 } }, tts: { autoSpeakReplies: true } } } } } });
        storage.setState({ sessions: { [session.id]: session, ...Object.fromEntries(extraSessions.map(value => [value.id, { ...value, serverId: connection.home.id }])) }, sessionListRowsByServerId: { [sessionScopeId]: { [session.id]: session } },
            ordinarySessionListMembershipByServerId: { [sessionScopeId]: [session.id] },
            sessionListIndexByServerId: { [sessionScopeId]: [{ type: 'session', sessionId: session.id, serverId: connection.home.id, serverName: 'Voice' }] } });
        const { sync } = await import('@/sync/sync');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        const { EphemeralUpdateSchema } = await import('@happier-dev/protocol/updates');
        for (const visible of [session, ...extraSessions]) {
            if (!visible.active) continue;
            const activity = EphemeralUpdateSchema.parse({ type: 'activity', id: visible.id, active: true, activeAt: Date.now(), thinking: false });
            for (const socket of sockets.get(connection.home.serverUrl) ?? []) {
                // Socket.IO dispatches received packets to catch-all listeners
                // before event-specific listeners. The real API transport owns
                // its Sync message dispatch through onAny, not on('ephemeral').
                for (const listener of socket.listenersAny()) listener('ephemeral', activity);
                for (const listener of socket.listeners('ephemeral')) listener(activity);
            }
        }
        if (session.active) await vi.waitFor(() => {
            const state = storage.getState();
            const direct = state.sessions[session.id];
            const row = state.sessionListRowsByServerId[sessionScopeId]?.[session.id];
            if (direct?.presence !== 'online' || row?.presence !== 'online') {
                throw new Error(`Test daemon activity has not reached both Session carriers: ${JSON.stringify({
                    direct: direct ? { serverId: direct.serverId, active: direct.active, activeAt: direct.activeAt, presence: direct.presence } : null,
                    row: row ? { active: row.active, activeAt: row.activeAt, presence: row.presence } : null,
                    sockets: (sockets.get(connection.home.serverUrl) ?? []).map(socket => ({
                        connected: socket.connected, receiveListeners: socket.listenersAny().length,
                    })),
                })}`);
            }
        });
        const initialize = () => initializeVoiceAgentHandle({ sessionId: params.initializeSessionId ?? session.id,
            getDaemonVoiceAgentClient: (scope) => new DaemonVoiceAgentClient(scope), setDeferredTargetSessionContext: () => {} });
        const handle = await initialize();
        let currentHandle = handle;
        return {
            sessionId: session.id,
            handle,
            sessionHttp,
            transcriptMemory,
            /** Physical Home message reads, excluding metadata/catalog requests. */
            messageRequests,
            /** Observe genuine outbound SDK namespaces, including lazily created sockets. */
            get rpcSockets() { return [...(sockets.get(connection.home.serverUrl) ?? [])]; },
            /**
             * The real local engine answers Agent activity from this execution owner.
             * This activates the retained Agent conversation without acquiring a microphone.
             */
            async activateLocalAgent(targetSessionAddress: SessionAddress | null = null) {
                const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
                const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
                const { voiceSessionBindingStore, createVoiceRuntimeAttemptBindingOwner, bindVoiceRuntimeAttemptBinding, unbindVoiceRuntimeAttemptBindingIfOwned } = await import('@/voice/binding/voiceConversationBindingStore');
                const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
                const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
                const { localVoiceRuntimeController } = await import('@/voice/local/localVoiceRuntimeController');
                const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
                const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
                applyPreference({ voice: writeVoiceProviderSettingsConfig(storage.getState().settings.voice, 'local_conversation', {
                    ...local, conversationMode: 'agent', agent: { ...local.agent, prewarmOnConnect: false },
                }) });
                const existingAdapters = getVoiceAdapterRegistry().list();
                const adapter = createLocalConversationVoiceAdapter();
                registerVoiceAdapters([...existingAdapters.filter(existing => existing.id !== adapter.id), adapter]);
                const bindingOwner = createVoiceRuntimeAttemptBindingOwner();
                bindVoiceRuntimeAttemptBinding({ owner: bindingOwner, binding: {
                    adapterId: adapter.id, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                    conversationSessionId: session.id,
                    conversationSessionAddress: { serverId: connection.home.id, sessionId: session.id },
                    targetSessionAddress, transcriptMode: 'native_session', lifetime: 'runtime_attempt', updatedAt: Date.now(),
                } });
                const binding = voiceSessionBindingStore.getState().getByConversationSessionId(session.id);
                if (!binding) throw new Error('Local Voice binding was not admitted');
                try {
                    await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
                } catch (error) {
                    unbindVoiceRuntimeAttemptBindingIfOwned({ conversationSessionId: session.id, owner: bindingOwner });
                    registerVoiceAdapters(existingAdapters);
                    throw error;
                }
                return {
                    adapter, binding, controller: localVoiceRuntimeController,
                    async dispose() {
                        try {
                            await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
                        } finally {
                            unbindVoiceRuntimeAttemptBindingIfOwned({ conversationSessionId: session.id, owner: bindingOwner });
                            registerVoiceAdapters(existingAdapters);
                        }
                    },
                };
            },
            async welcome() {
                const welcome = createVoiceWelcomePolicy({ getVoiceAgentHandle: async () => currentHandle, resetCachedHandle: () => {} });
                await welcome.ensureRunningAndMaybeWelcome(session.id);
            },
            async hydrateAfterSettingsChange() {
                const admitted = storage.getState().settings.voice;
                applyPreference({ voice: { ...admitted, assistantLanguage: 'de-DE', welcome: { ...admitted.welcome, enabled: false } } });
                currentHandle = await initialize();
                return currentHandle;
            },
            async dispose() {
                try { await connection.dispose(); }
                finally { browserLocks?.restore(); browserStorage?.restore(); }
            },
        };
    } catch (error) {
        try { await teardownConnection?.(); }
        finally { browserLocks?.restore(); browserStorage?.restore(); }
        throw error;
    }
}
