import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createBuiltinVoiceAdapterAssembly } from '@/dev/testkit/harness/builtinVoiceAdapters';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import 'fake-indexeddb/auto';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const sdk = vi.hoisted(() => ({ startSession: vi.fn(), endSession: vi.fn(async () => undefined) }));
// The vendor SDK is the microphone/network boundary; adapter and host lifecycle stay real.
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/' }).module;
});

await loadSyncSingletonForTests();
const initialStorageState = getStorage().getState();
const initialBindings = voiceSessionBindingStore.getState();
const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
if (!entry) throw new Error('Composer targeting requires the ElevenLabs contribution');
let assembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>>;
let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
let captureAdmission: ReturnType<typeof createVoiceCaptureAdmissionController>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

// Observe the real async Start; the owning test budget bounds this wait.
function waitForVoiceStart(): Promise<void> {
    return new Promise((resolve, reject) => {
        const observe = () => {
            const snapshot = lifecycle.getSnapshot();
            if (snapshot.status === 'connected') {
                unsubscribe();
                resolve();
            } else if (snapshot.status === 'error') {
                unsubscribe();
                reject(new Error(snapshot.errorCode ?? 'voice_start_failed'));
            }
        };
        const unsubscribe = lifecycle.subscribe(observe);
        onTestFinished(unsubscribe);
        observe();
    });
}

describe('VoiceComposerPlanetMount targeting', () => {
    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        resetVoiceSessionStoreForTests();
        voiceConversationRuntimeMachine.reset();
        webLocks = installWebLockManagerMock();
        sdk.endSession.mockClear();
        sdk.startSession.mockReset().mockResolvedValue({ endSession: sdk.endSession,
            setMicMuted() {}, setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {},
            getId: () => 'composer-provider-conversation' });
        const sessions = {
            'session-7': createSessionFixture({ id: 'session-7' }),
            'composer-conversation': createSessionFixture({ id: 'composer-conversation', active: false,
                metadata: { path: '/voice-history', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() } }),
        };
        const sessionHttp = createSessionMetadataHttpBoundary(() => sessions);
        account = await restoreServerAccountForTest({ serverUrl: 'https://composer-targeting.test',
            accountId: 'composer-account', credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json({ features: { voice: { enabled: true } }, capabilities: {} });
                const preparation = answerVoiceRealtimePreparationHttpRequest(url, getStorage().getState().settings);
                if (preparation) return preparation;
                if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'composer-token', leaseId: 'composer-lease',
                    bindingNonce: 'composer-nonce', expiresAtMs: Date.now() + 60_000 });
                if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
                const sessionResponse = sessionHttp.handle(url, init);
                if (sessionResponse) return sessionResponse;
                return null;
            }) });
        // The Home fixture seeds SDK storage; the credential owner resolves it.
        expect(await TokenStorage.getCredentials()).toEqual(account.credentials);
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        const voice = writeVoiceProviderSettingsConfig(initialStorageState.settings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
        getStorage().setState((state) => ({ isDataReady: true,
            settings: { ...state.settings, voice: { ...voice, providerId: entry.providerId } },
            sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, { ...session, serverId: account.home.id }])) }));
        voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'composer-conversation', conversationSessionAddress: { serverId: account.home.id, sessionId: 'composer-conversation' },
            targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
        assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
        registerVoiceAdapters(assembly.adapters);
        captureAdmission = createVoiceCaptureAdmissionController();
        lifecycle = createVoiceSessionLifecycleController({ captureAdmission });
        setVoiceSessionLifecycleController(lifecycle);
        lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
        lifecycle.setConfiguredProviderId(entry.providerId);
        setVoiceSessionSnapshot(lifecycle.getSnapshot());
    });

    afterEach(async () => {
        standardCleanup();
        await lifecycle?.dispose();
        await assembly?.dispose();
        await account?.dispose();
        setVoiceSessionLifecycleController(null);
        vi.restoreAllMocks();
        webLocks.restore();
        registerVoiceAdapters([]);
        voiceSessionBindingStore.setState(initialBindings, true);
        getStorage().setState(initialStorageState, true);
        resetVoiceSessionStoreForTests();
    });

    async function renderMount(sessionId: string | null, serverId: string | null = null) {
        const { VoiceComposerPlanetMount } = await import('./VoiceComposerPlanetMount');
        return await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                previewTimeMs={0}
            >
                <VoiceComposerPlanetMount
                    target={sessionId === null
                        ? { kind: 'global' }
                        : {
                            kind: 'session',
                            sessionAddress: serverId === null
                                ? null
                                : { serverId, sessionId },
                        }}
                />
            </VoiceEnergyProvider>,
        );
    }

    it('starts Global Voice only for the explicit New Session null target', async () => {
        const screen = await renderMount(null);

        await screen.pressByTestIdAsync('session-composer-voice');

        await waitForVoiceStart();
        expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({ adapterId: entry.providerId, status: 'connected', canStop: true }));
        expect(lifecycle.getAttemptTargetSessionAddress()).toBeNull();
        expect(captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
        await screen.unmount();
    });

    it('starts the exact normalized existing-session target', async () => {
        const screen = await renderMount('  session-7  ', ` ${account.home.id} `);

        await screen.pressByTestIdAsync('session-composer-voice');

        await waitForVoiceStart();
        expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({ adapterId: entry.providerId, status: 'connected', canStop: true }));
        expect(lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: account.home.id, sessionId: 'session-7' });
        expect(captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
        await screen.unmount();
    });

    it('fails closed for a blank existing-session target instead of falling back to Global Voice', async () => {
        const screen = await renderMount('   ');

        expect(screen.findByTestId('session-composer-voice')).toBeNull();
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
        expect(sdk.startSession).not.toHaveBeenCalled();
        const dictation = captureAdmission.acquire('dictation');
        expect(dictation.status).toBe('acquired');
        if (dictation.status === 'acquired') dictation.lease.release();

        await screen.unmount();
    });
});
