/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

// Dimensions are the platform boundary; feature decisions, target resolution and admission stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) },
    });
});

const initialStorage = getStorage().getState();
function seedVoiceSettings(voice: unknown) {
    getStorage().setState((state) => ({
        isDataReady: true,
        settings: { ...state.settings, voice: voiceSettingsParse(voice) },
    }));
}
function createGlobalStartAdapter(id: string): VoiceAdapterController {
    return {
        id, engineKind: 'realtime',
        start: async () => {}, stop: async () => {}, toggle: async () => {},
        interrupt: async () => {}, bargeIn: async () => {}, setMuted: async () => {},
        sendContextUpdate: () => {},
        getSnapshot: () => ({ adapterId: id, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false, bargeInEnabled: false,
        }),
    };
}

describe('Voice default-target lifecycle', () => {
    beforeEach(() => {
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
    });
    afterEach(async () => {
        standardCleanup();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
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
        let snapshot: VoiceSessionSnapshot = { adapterId: 'local_conversation', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false };
        const listeners = new Set<() => void>();
        const starts: Array<import('@/sync/domains/session/sessionAddress').SessionAddress | null> = [];
        const stops: string[] = [];
        const publish = (next: VoiceSessionSnapshot) => {
            snapshot = next;
            for (const listener of listeners) listener();
        };
        // Provider/media boundary fixture: all command admission, focus, attempt and lifecycle logic stays real.
        const adapter: VoiceAdapterController = {
            ...createGlobalStartAdapter('local_conversation'),
            start: async (input) => {
                starts.push(input.requestedTargetSessionAddress);
                publish({ adapterId: 'local_conversation', sessionId: input.sessionId || VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected', mode: 'listening', canStop: true });
            },
            stop: async ({ sessionId }) => {
                stops.push(sessionId);
                publish({ adapterId: 'local_conversation', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            },
            getSnapshot: () => snapshot,
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        };
        seedVoiceSettings({ providerId: 'local_conversation', ui: { activityFeedEnabled: false, scopeDefault }, providers: { local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } } } });
        getStorage().setState((state) => ({ localSettings: { ...state.localSettings, voicePresenceContainer: 'top_bar' } }));
        registerVoiceAdapters([adapter]);
        const controller = createVoiceSessionLifecycleController({ captureAdmission: createVoiceCaptureAdmissionController() });
        controller.setConfiguredProviderId('local_conversation');
        setVoiceSessionLifecycleController(controller);
        const unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        setVoiceSessionSnapshot(controller.getSnapshot());
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
            setFocusedSessionId('session-a', 'server-a');
            screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><VoiceTopBarPresenceMount /><VoiceKeyboardRuntime /><Invoke /></KeyboardShortcutProvider>);
            expect(useVoiceTargetStore.getState().scope).toBe('global');
            await screen.pressByTestIdAsync('voice-top-bar-rest');
            const expected = scopeDefault === 'global' ? null : { serverId: 'server-a', sessionId: 'session-a' };
            expect(starts).toEqual([expected]);
            const admitted = getVoiceSessionSnapshot();
            expect(admitted.status).toBe('connected');
            await act(async () => { setFocusedSessionId('session-b', 'server-b'); });
            await act(async () => { expect(toggle()).toBe(true); });
            expect(stops).toEqual([admitted.sessionId]);
            expect(starts).toHaveLength(1);
            expect(getVoiceSessionSnapshot().status).toBe('disconnected');
            await act(async () => { setFocusedSessionId('session-a', 'server-a'); });
            await act(async () => { expect(toggle()).toBe(true); });
            expect(starts).toEqual([expected, expected]);
            await act(async () => { expect(toggle()).toBe(true); });
            await act(async () => { glanceToggle(); });
            expect(starts).toEqual([expected, expected, expected]);
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
