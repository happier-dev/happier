import type { VoiceAdapterController } from '@/voice/session/types';
import type { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import type { serveAccountHomes } from './actionHomesHttpHarness';

type ElevenLabsVoiceRuntimeScope = Readonly<{
    adapter: VoiceAdapterController;
    lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
    home: Awaited<ReturnType<typeof serveAccountHomes>>;
    providerId: string;
}>;

/**
 * The existing generated ElevenLabs recipe. Callers install the genuine native,
 * Socket and vendor SDK boundaries before entering this scope; this module has
 * no mock-registration or native-platform side effects.
 */
export async function withGeneratedElevenLabsVoiceRuntime(
    exercise: (scope: ElevenLabsVoiceRuntimeScope) => Promise<void>,
): Promise<void> {
    const { storage } = await import('@/sync/domains/state/storage');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { PendingLocalIdSchema } = await import('@happier-dev/protocol/sessions/pending/pendingLocalId');
    const { PendingRequestedActionV1Schema } = await import('@happier-dev/protocol/sessions/pending/pendingRequestedActionV1');
    const { SessionStoredMessageContentSchema } = await import('@happier-dev/protocol/sessions/messages/sessionStoredMessageContent');
    const { serveAccountHomes } = await import('./actionHomesHttpHarness');
    const { createSessionMetadataHttpBoundary } = await import('./sessionMetadataHttpBoundary');
    const { createSessionReadBatchHttpBoundary } = await import('./sessionReadBatchHttpBoundary');
    const { answerVoiceRealtimePreparationHttpRequest } = await import('./voiceRealtimePreparationHttpBoundary');
    const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
    const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
    const { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } = await import('../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index');
    const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } = await import('@/voice/persistence/voiceTranscriptHistorySession');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    const previousStorage = storage.getState();
    const previousBindings = voiceSessionBindingStore.getState();
    const previousAdapters = getVoiceAdapterRegistry().list();
    const previousLifecycle = getVoiceSessionLifecycleController();
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
    if (!entry) throw new Error('Missing generated ElevenLabs contribution');
    const metadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.pendingInput = { protocolVersion: 1 };
    const home = await serveAccountHomes({
        homes: [{ key: 'qa', serverUrl: 'https://voice-qa-realtime.example.test', accountId: 'qa-account',
            currentAccount: true,
            settings: { voice: { ...previousStorage.settings.voice, providerId: entry.providerId,
                providers: { [entry.providerId]: { schemaVersion: 1, config: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } } } } }],
        route: createSessionReadBatchHttpBoundary(request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
            const preparation = answerVoiceRealtimePreparationHttpRequest(request.url, storage.getState().settings);
            if (preparation) return preparation;
            if (request.path === '/v1/voice/token') return Response.json({ allowed: true, token: 'hosted-token', leaseId: 'qa-lease', bindingNonce: 'qa-nonce', expiresAtMs: Date.now() + 60_000 });
            if (request.path === '/v1/voice/session/complete' || request.path === '/v1/voice/session/release') return Response.json({ ok: true });
            if (request.path === '/v1/sessions' && request.method === 'POST') {
                return metadata.createSessionFromPost('qa-history', { method: request.method, body: JSON.stringify(request.body) });
            }
            if (request.method === 'POST' && /\/pending$/.test(request.path)) {
                const body = request.body;
                if (!body || typeof body !== 'object' || !('localId' in body) || !('requestedAction' in body)
                    || !('content' in body) || !('deliveryMode' in body) || body.deliveryMode !== 'external_handoff') {
                    throw new Error('Expected canonical external-handoff pending input');
                }
                // The ordinary Session POST body is route-owned, not a published
                // aggregate schema. Validate its published fields at this HTTP leaf.
                const localId = PendingLocalIdSchema.parse(body.localId);
                const requestedAction = PendingRequestedActionV1Schema.parse(body.requestedAction);
                SessionStoredMessageContentSchema.parse(body.content);
                return Response.json({ requestedAction, pending: { localId, deliveryStatus: { status: 'external_handoff' } } });
            }
            if (request.method === 'POST' && /\/delivery\/handled$/.test(request.path)) return Response.json({});
            if (/\/messages$/.test(request.path)) return Response.json({ messages: [], hasMore: false });
            return metadata.handle(request.url, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined;
        }).handle,
    });
    let disconnect: (() => Promise<void>) | undefined;
    const assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
    registerVoiceAdapters(assembly.adapters);
    const lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId(entry.providerId);
    setVoiceSessionLifecycleController(lifecycle);
    try {
        disconnect = await home.restoreActiveConnection();
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.qa!.serverUrl);
        if (!credentials || JSON.stringify(await TokenStorage.getCredentials()) !== JSON.stringify(credentials)) {
            throw new Error('Missing current admitted ElevenLabs Account');
        }
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        storage.setState({ sessions: {} });
        await sync.ensureHostedSystemSession({
            tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
            metadata: buildVoiceTranscriptHistorySessionMetadata(),
        });
        // This is an admitted fixture binding, not proof of actual binding publication.
        // Consumer tests observe SDK/context/custody; publication has its own real keeper.
        voiceSessionBindingStore.getState().bind({
            adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'qa-history', conversationSessionAddress: { serverId: home.homes.qa!.id, sessionId: 'qa-history' },
            targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1,
        });
        const adapter = getVoiceAdapterRegistry().get(entry.providerId);
        if (!adapter) throw new Error('Missing actual generated ElevenLabs adapter');
        await exercise({ adapter, lifecycle, home, providerId: entry.providerId });
    } finally {
        await lifecycle.dispose();
        setVoiceSessionLifecycleController(previousLifecycle);
        await assembly.dispose();
        await disconnect?.();
        await home.dispose();
        registerVoiceAdapters(previousAdapters);
        voiceSessionBindingStore.setState(previousBindings, true);
        storage.setState(previousStorage, true);
    }
}
