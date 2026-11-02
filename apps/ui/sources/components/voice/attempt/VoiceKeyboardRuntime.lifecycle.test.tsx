/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createBuiltinVoiceAdapterAssembly } from '@/dev/testkit/harness/builtinVoiceAdapters';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const sdk = vi.hoisted(() => ({ startSession: vi.fn() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: sdk.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: sdk.startSession } }));
// Decline any unexpected dialog: ordinary drawn/keyboard controls must start directly.
vi.mock('@/modal', async () => (
    await import('@/dev/testkit/mocks/modal')
).createModalModuleMock({ confirmResult: false }).module);

// Dimensions are the platform boundary; feature decisions, target resolution and admission stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Dimensions: { get: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) },
    });
});

const initialStorage = getStorage().getState();
function seedVoiceSettings(voice: unknown) {
    getStorage().setState((state) => ({
        isDataReady: true,
        settings: { ...state.settings, ...normalizeVoiceSettingsLocalDelta({ voice: voiceSettingsParse(voice) }, state.settings) },
    }));
}
const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.declaration.id === 'realtime-elevenlabs')!;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let assembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>> | null = null;
let locks: ReturnType<typeof installWebLockManagerMock> | null = null;

describe('Voice default-target lifecycle', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        locks = installWebLockManagerMock();
        getStorage().setState(initialStorage, true);
        resetVoiceSessionStoreForTests();
        useVoiceTargetStore.getState().setScope('global');
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: {
            status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }),
        } });
        getStorage().setState((state) => ({
            settings: { ...state.settings, experiments: true, featureToggles: { ...state.settings.featureToggles, voice: true } },
        }));
        const sessions = createSessionMetadataHttpBoundary(() => getStorage().getState().sessions);
        account = await restoreServerAccountForTest({ serverUrl: 'https://keyboard-voice.example.test', credentialScope: 'restored-home', activation: 'switch', request: createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ features: { voice: { enabled: true } }, capabilities: {} });
            if (path.endsWith('/messages') && init?.method !== 'POST') return Response.json(SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false }));
            const preparation = answerVoiceRealtimePreparationHttpRequest(url, getStorage().getState().settings);
            if (preparation) return preparation;
            if (path === '/v1/sessions' && init?.method === 'POST') return sessions.createSessionFromPost('keyboard-history', init);
            const sessionResponse = sessions.handle(url, init);
            if (sessionResponse) return sessionResponse;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'keyboard-token', leaseId: 'keyboard-lease', bindingNonce: 'keyboard-nonce', expiresAtMs: Date.now() + 60_000 });
            if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
            return new Response('{}', { status: 404 });
        }) });
        expect(await TokenStorage.getCredentials()).toEqual(account.credentials);
        const metadata = { path: '/voice-history', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Voice History owner metadata was not admitted');
        sessions.createSessionFromPost('keyboard-history', { method: 'POST', body: JSON.stringify({ tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, metadataLayoutVersion: 1,
            sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })) },
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, dataEncryptionKey: null, encryptionMode: 'plain' }) });
        voiceConversationRuntimeMachine.reset();
    });
    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        await assembly?.dispose(); assembly = null;
        await account?.dispose();
        locks?.restore(); locks = null;
        getStorage().setState(initialStorage, true);
        resetVoiceSessionStoreForTests();
        resetServerFeaturesClientForTests();
    });
    it.each(['global', 'session'] as const)('uses the %s idle policy for shell, keyboard and glance and ends the admitted attempt after navigation', async (scopeDefault) => {
        const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
        const { VoiceKeyboardRuntime } = await import('./VoiceKeyboardRuntime');
        const { VoiceTopBarPresenceMount } = await import('../presence/VoiceTopBarPresence');
        const { useVoiceSurfaceModel } = await import('../surface/useVoiceSurfaceModel');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { setFocusedSessionId, resetSessionSurfaceVisibilityForTests } = await import('@/sync/domains/session/sessionSurfaceVisibility');
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
        const { createVoiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { getVoiceSessionSnapshot, setVoiceSessionSnapshot, dismissVoiceSessionEndedAttempt } = await import('@/voice/session/voiceSessionStore');
        const starts: Array<SessionAddress | null> = [];
        const stops: string[] = [];
        // SDK start/end are provider boundaries. Registration, adapter, binding,
        // media admission, controller and snapshot publication remain real.
        sdk.startSession.mockReset().mockImplementation(async () => {
            const controlSessionId = voiceConversationRuntimeMachine.getSnapshot().controlSessionId;
            if (!controlSessionId) throw new Error('SDK was called before a Voice attempt owned the runtime');
            const binding = voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId);
            if (!binding) throw new Error('SDK was called before a Voice conversation was bound');
            starts.push(binding.targetSessionAddress);
            return { getId: () => `keyboard-provider-${starts.length}`,
                endSession: async () => { stops.push(binding.controlSessionId); },
                setMicMuted() {}, setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {} };
        });
        seedVoiceSettings({ providerId: entry.providerId, welcome: { enabled: false }, ui: { activityFeedEnabled: false, scopeDefault }, providers: { [entry.providerId]: { schemaVersion: 2, config: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } } });
        getStorage().setState((state) => ({ localSettings: { ...state.localSettings, voicePresenceContainer: 'top_bar' } }));
        getStorage().setState({ sessions: { 'keyboard-history': createSessionFixture({ id: 'keyboard-history', serverId: account.home.id, encryptionMode: 'plain', active: false,
            metadata: { path: '/voice-history', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() } }),
            'session-a': createSessionFixture({ id: 'session-a', serverId: account.home.id, encryptionMode: 'plain', metadata: { path: '/project', host: 'test' } }) } });
        voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'keyboard-history', conversationSessionAddress: { serverId: account.home.id, sessionId: 'keyboard-history' },
            targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
        assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
        registerVoiceAdapters(assembly.adapters);
        const controller = createVoiceSessionLifecycleController({ captureAdmission: createVoiceCaptureAdmissionController() });
        controller.setConfiguredProviderId(entry.providerId);
        setVoiceSessionLifecycleController(controller);
        const publish = () => {
            const snapshot = controller.getSnapshot();
            const binding = snapshot.sessionId ? voiceSessionBindingStore.getState().getByControlSessionId(snapshot.sessionId) : null;
            const accountScope = getStorage().getState().profileScope;
            setVoiceSessionSnapshot(snapshot, binding, accountScope ? { accountScope,
                targetSessionAddress: controller.getAttemptTargetSessionAddress(), conversationScope: null } : null);
        };
        const unsubscribe = controller.subscribe(publish);
        publish();
        const waitForStatus = async (status: ReturnType<typeof controller.getSnapshot>['status']) => {
            await act(async () => {
                await waitForTestEvent(controller.subscribe, controller.getSnapshot, snapshot => snapshot.status === status);
            });
            expect(getVoiceSessionSnapshot().status,
                `Voice transition failure code: ${getVoiceSessionSnapshot().errorCode ?? 'none'}`).toBe(status);
        };
        dismissVoiceSessionEndedAttempt();
        let toggle: () => boolean = () => false;
        let glanceToggle = () => {};
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        function Invoke() {
            const execute = useKeyboardCommand();
            const model = useVoiceSurfaceModel({ variant: 'sidebar' });
            glanceToggle = () => model?.attemptControl.onToggle();
            toggle = () => execute('voice.toggle');
            return null;
        }
        try {
            setFocusedSessionId('session-a', account.home.id);
            screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><VoiceTopBarPresenceMount /><VoiceKeyboardRuntime /><Invoke /></KeyboardShortcutProvider>);
            expect(useVoiceTargetStore.getState().scope).toBe('global');
            expect(getStorage().getState().settings.voice.ui.scopeDefault).toBe(scopeDefault);
            await screen.pressByTestIdAsync('voice-top-bar-rest');
            const expected = scopeDefault === 'global' ? null : { serverId: account.home.id, sessionId: 'session-a' };
            await waitForStatus('connected');
            expect(starts).toEqual([expected]);
            const admitted = getVoiceSessionSnapshot();
            expect(admitted.status).toBe('connected');
            await act(async () => { setFocusedSessionId('session-b', 'server-b'); });
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('disconnected');
            expect(stops).toEqual([admitted.sessionId]);
            expect(starts).toHaveLength(1);
            expect(getVoiceSessionSnapshot().status).toBe('disconnected');
            await act(async () => { setFocusedSessionId('session-a', account.home.id); });
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('connected');
            expect(starts).toEqual([expected, expected]);
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('disconnected');
            await act(async () => { glanceToggle(); });
            await waitForStatus('connected');
            expect(starts).toEqual([expected, expected, expected]);
            // An explicitly targeted composer attempt keeps its target when the
            // app-level shortcut ends and restarts it, even with Global as the idle default.
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('disconnected');
            const explicitTarget = { serverId: account.home.id, sessionId: 'session-a' };
            await act(async () => { await controller.toggle(explicitTarget); });
            await waitForStatus('connected');
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('disconnected');
            await act(async () => { setFocusedSessionId('session-b', 'server-b'); expect(toggle()).toBe(true); });
            await waitForStatus('connected');
            expect(starts.slice(-2)).toEqual([explicitTarget, explicitTarget]);
            // A provider failure is still the admitted Session attempt. The
            // rebound keyboard command must not apply the idle Global default.
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('disconnected');
            sdk.startSession.mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), { code: 'provider_unavailable' }));
            await act(async () => { await expect(controller.toggle(explicitTarget)).rejects.toMatchObject({ code: 'provider_unavailable' }); });
            expect(getVoiceSessionSnapshot().errorRecoveryAction).toBe('retry');
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('connected');
            expect(starts.at(-1)).toEqual(explicitTarget);
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('disconnected');
            await act(async () => { dismissVoiceSessionEndedAttempt(); setFocusedSessionId('session-a', account.home.id); });
            await act(async () => { expect(toggle()).toBe(true); });
            await waitForStatus('connected');
            expect(starts.at(-1)).toEqual(expected);
            const { Modal } = await import('@/modal');
            expect(Modal.confirm).not.toHaveBeenCalled();
            // Remove the runtime while keeping the command provider and its caller alive.
            // Calling a hook closure after its entire provider unmounted is not a product flow.
            await screen.update(<KeyboardShortcutProvider handlers={{}}><Invoke /></KeyboardShortcutProvider>);
            expect(toggle()).toBe(false);
            await screen.unmount();
        } finally {
            await screen?.unmount();
            unsubscribe();
            await controller.dispose();
            setVoiceSessionLifecycleController(null);
            resetSessionSurfaceVisibilityForTests();
        }
    });
});
