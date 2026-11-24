import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { createSessionFixture, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getStorage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createBuiltinVoiceAdapterAssembly } from '@/dev/testkit/harness/builtinVoiceAdapters';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { acknowledgeVoiceSessionRuntimeReady, setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import 'fake-indexeddb/auto';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

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
let account: Awaited<ReturnType<typeof serveAccountHomes>>;
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
        };
        const sessionHttp = createSessionMetadataHttpBoundary(() => sessions);
        const sessionRead = createSessionReadBatchFetchBoundary(async (url, init) => sessionHttp.handle(url, init));
        const serverIdentityId = `srv_voice_composer_${crypto.randomUUID()}`;
        account = await serveAccountHomes({
            homes: [{ key: 'composer', serverUrl: 'https://composer-targeting.test', accountId: 'composer-account',
                currentAccount: true, serverIdentityId }],
            route: async ({ path, url, method, headers, body }) => {
                const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
                if (path === '/v1/sessions' && method === 'POST') return sessionHttp.createSessionFromPost('composer-conversation', init);
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                    features: { voice: { enabled: true } }, capabilities: { serverIdentity: { serverIdentityId } },
                }));
                const preparation = answerVoiceRealtimePreparationHttpRequest(url, getStorage().getState().settings);
                if (preparation) return preparation;
                if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'composer-token', leaseId: 'composer-lease',
                    bindingNonce: 'composer-nonce', expiresAtMs: Date.now() + 60_000 });
                if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
                return (await sessionRead(url, init)) ?? createEmptyAccountBootstrapHttpResponse(path, init) ?? undefined;
            },
        });
        await account.restoreActiveConnection();
        const storage = getStorage();
        const serverId = account.homes.composer!.id;
        await waitForTestEvent(storage.subscribe, () => {
            expect(storage.getState().profileScope?.serverId).toBe(serverId);
            expect(storage.getState().isDataReady).toBe(true);
        });
        const voice = writeVoiceProviderSettingsConfig(initialStorageState.settings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
            voice: { ...voice, providerId: entry.providerId },
        }, storage.getState().settings));
        storage.getState().applySessions(Object.values(sessions).map(session => ({ ...session, serverId })));
        assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
        registerVoiceAdapters(assembly.adapters);
        captureAdmission = createVoiceCaptureAdmissionController();
        lifecycle = createVoiceSessionLifecycleController({ captureAdmission });
        setVoiceSessionLifecycleController(lifecycle);
        acknowledgeVoiceSessionRuntimeReady(true);
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
        acknowledgeVoiceSessionRuntimeReady(false);
        vi.restoreAllMocks();
        webLocks.restore();
        registerVoiceAdapters([]);
        voiceSessionBindingStore.setState(initialBindings, true);
        getStorage().setState(initialStorageState, true);
        resetVoiceSessionStoreForTests();
    });

    async function renderMount(sessionId: string | null, serverId: string | null = null) {
        const { VoiceComposerPlanetMount } = await import('./VoiceComposerPlanetMount');
        const credentials = await TokenStorage.getCredentialsForServerUrl(account.homes.composer!.serverUrl);
        const target = sessionId === null
            ? { kind: 'global' as const }
            : { kind: 'session' as const, sessionAddress: serverId === null ? null : { serverId, sessionId } };
        return await renderScreen(
            <InjectedAuthProvider credentials={credentials}>
                <VoiceEnergyProvider
                    state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                    previewTimeMs={0}
                >
                    <VoiceComposerPlanetMount target={target} />
                </VoiceEnergyProvider>
            </InjectedAuthProvider>,
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
        const screen = await renderMount('  session-7  ', ` ${account.homes.composer!.id} `);

        await screen.pressByTestIdAsync('session-composer-voice');

        await waitForVoiceStart();
        expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({ adapterId: entry.providerId, status: 'connected', canStop: true }));
        expect(lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: account.homes.composer!.id, sessionId: 'session-7' });
        expect(captureAdmission.acquire('dictation')).toEqual({ status: 'busy', activeOwner: 'conversation' });
        await screen.unmount();
    });

    it('fails closed for a blank existing-session target instead of falling back to Global Voice', async () => {
        const screen = await renderMount('   ', account.homes.composer!.id);
        await screen.pressByTestIdAsync('session-composer-voice');
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
        expect(sdk.startSession).not.toHaveBeenCalled();
        const dictation = captureAdmission.acquire('dictation');
        expect(dictation.status).toBe('acquired');
        if (dictation.status === 'acquired') dictation.lease.release();

        await screen.unmount();
    });
});
