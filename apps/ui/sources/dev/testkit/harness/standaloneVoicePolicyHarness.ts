import { vi } from 'vitest';
import { CurrentCursorResponseSchema, FeaturesResponseSchema, SessionCurrentProjectionRecordV1Schema,
    SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { installVitestRnShim } from '@/dev/vitestRnShim';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import type { SettingsWriteDelta } from '@/sync/domains/settings/settings';

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
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('../mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
    const { createExpoUpdatesMock } = await import('../mocks/expoUpdates');
    return createExpoUpdatesMock();
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
installDisconnectedServerSocketBoundary((socket) => {
    // Deliver the external handshake through the real Socket listeners, so
    // the connection supervisor (not the fixture) publishes availability.
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'disconnect').mockImplementation(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        if (event === 'update-metadata') {
            const update = payload as { expectedVersion: number; metadata: string };
            return { result: 'success', version: update.expectedVersion + 1, metadata: update.metadata };
        }
        if (event !== 'rpc-call') throw new Error(`Unexpected transport event: ${event}`);
        const request = payload as { method: string; params: unknown };
        return { ok: true, result: await dispatch(request.method.slice(request.method.indexOf(':') + 1), request.params) };
    });
});

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

/** UI-owned half of a cross-program test; only transport dispatch crosses into CLI. */
export async function createStandaloneVoicePolicyHarness(params: Readonly<{
    mode: 'off' | 'immediate' | 'on_first_turn';
    dispatch: (method: string, input: unknown) => Promise<unknown>;
}>) {
    dispatch = params.dispatch;
    await prepareStandaloneVoicePolicyHarness();
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const applyPreference = (delta: SettingsWriteDelta) =>
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta(delta, storage.getState().settings));
    const { initializeVoiceAgentHandle } = await import('@/voice/agent/initializeVoiceAgentHandle');
    const { DaemonVoiceAgentClient } = await import('@/voice/agent/daemonVoiceAgentClient');
    const { createVoiceWelcomePolicy } = await import('@/voice/runtime/execution/voiceWelcomePolicy');
    let session = createSessionFixture({ id: 'voice-parent', active: true,
        metadata: { path: '/voice', host: 'voice.test', flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } });
    let wireSession = SessionCurrentProjectionRecordV1Schema.parse({
        ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
        effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null, share: null,
        archivedAt: null, agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
    });
    const connection = await restoreServerAccountForTest({
        serverUrl: `https://voice-policy-${params.mode}.example.test`,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
            if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
            if (path === `/v2/sessions/${session.id}`) {
                if (init?.method === 'PATCH') {
                    const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                    if (patch.mode === 'shared_editor') throw new Error('Voice admission does not use shared-editor metadata');
                    const target = patch.mode === 'owner_migration' ? patch.target : patch;
                    wireSession = SessionCurrentProjectionRecordV1Schema.parse({
                        ...wireSession, metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
                        ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
                        metadataVersion: wireSession.metadataVersion + 1, agentStateVersion: (wireSession.agentStateVersion ?? 0) + 1,
                    });
                    return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({
                        success: true, metadataLayoutVersion: 1, sharedMetadata: { version: wireSession.metadataVersion },
                        agentState: { version: wireSession.agentStateVersion },
                    }));
                }
                return Response.json({ session: wireSession });
            }
            return new Response('{}', { status: 404 });
        },
    });
    session = { ...session, serverId: connection.home.id };
    applyPreference({ experiments: true, featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
        voice: { ...storage.getState().settings.voice, providerId: 'local_conversation', assistantLanguage: 'fr-FR', welcome: { ...storage.getState().settings.voice.welcome, enabled: params.mode !== 'off', mode: params.mode === 'on_first_turn' ? params.mode : 'immediate' },
            providers: { local_conversation: { schemaVersion: 1, config: { agent: { agentSource: 'agent', agentId: 'claude', prewarmOnConnect: false, transcript: { persistenceMode: 'ephemeral', epoch: 0 } }, tts: { autoSpeakReplies: true } } } } } });
    storage.setState({ sessions: { [session.id]: session }, sessionListRowsByServerId: { [connection.home.id]: { [session.id]: session } },
        ordinarySessionListMembershipByServerId: { [connection.home.id]: [session.id] },
        sessionListIndexByServerId: { [connection.home.id]: [{ type: 'session', sessionId: session.id, serverId: connection.home.id, serverName: 'Voice' }] } });
    const initialize = () => initializeVoiceAgentHandle({ sessionId: session.id,
        getDaemonVoiceAgentClient: (scope) => new DaemonVoiceAgentClient(scope), setDeferredTargetSessionContext: () => {} });
    const handle = await initialize().catch(async (error: unknown) => {
        await connection.dispose();
        throw error;
    });
    let currentHandle = handle;
    return {
        sessionId: session.id,
        handle,
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
        dispose: () => connection.dispose(),
    };
}
