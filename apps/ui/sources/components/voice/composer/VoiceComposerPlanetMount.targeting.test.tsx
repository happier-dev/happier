import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import type { VoiceAdapterController } from '@/voice/session/types';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/voice/agent/getVoiceAgentSessionTeleportAvailability', () => ({
    getVoiceAgentSessionTeleportAvailability: () => ({ ok: false }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => Object.freeze({ entries: Object.freeze([]) }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/' }).module;
});

const initialStorageState = getStorage().getState();

function createReadyAdapter(): VoiceAdapterController {
    return {
        id: 'local_conversation',
        engineKind: 'realtime',
        start: async () => undefined,
        stop: async () => undefined,
        toggle: async () => undefined,
        interrupt: async () => undefined,
        bargeIn: async () => undefined,
        setMuted: async () => undefined,
        sendContextUpdate: () => undefined,
        getSnapshot: () => ({
            adapterId: 'local_conversation',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart: true,
            controlSessionScope: 'global',
            requiresVoiceAgentFeature: false,
            bargeInEnabled: false,
            cancelResponse: 'unsupported',
        }),
    } as VoiceAdapterController;
}

describe('VoiceComposerPlanetMount targeting', () => {
    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        getStorage().setState((state: any) => ({
            ...state,
            isDataReady: true,
            settings: {
                ...state.settings,
                voice: {
                    providerId: 'local_conversation',
                    ui: {
                        activityFeedEnabled: false,
                        scopeDefault: 'global',
                        surfaceLocation: 'auto',
                    },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { conversationMode: 'agent' },
                        },
                    },
                },
            },
        }));
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([createReadyAdapter()]);
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        } as any);
    });

    afterEach(async () => {
        standardCleanup();
        vi.restoreAllMocks();
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        getStorage().setState(initialStorageState, true);
    });

    async function renderMount(sessionId: string | null) {
        const { VoiceComposerPlanetMount } = await import('./VoiceComposerPlanetMount');
        return await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                previewTimeMs={0}
            >
                <VoiceComposerPlanetMount sessionId={sessionId} />
            </VoiceEnergyProvider>,
        );
    }

    it('starts Global Voice only for the explicit New Session null target', async () => {
        const { voiceSessionManager } = await import('@/voice/session/voiceSession');
        const toggle = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined);
        const screen = await renderMount(null);

        await screen.pressByTestIdAsync('session-composer-voice');

        expect(toggle).toHaveBeenCalledWith('');
        await screen.unmount();
    });

    it('starts the exact normalized existing-session target', async () => {
        const { voiceSessionManager } = await import('@/voice/session/voiceSession');
        const toggle = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined);
        const screen = await renderMount('  session-7  ');

        await screen.pressByTestIdAsync('session-composer-voice');

        expect(toggle).toHaveBeenCalledWith('session-7');
        await screen.unmount();
    });

    it('fails closed for a blank existing-session target instead of falling back to Global Voice', async () => {
        const { voiceSessionManager } = await import('@/voice/session/voiceSession');
        const toggle = vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined);
        const screen = await renderMount('   ');

        expect(screen.findByTestId('session-composer-voice')).toBeNull();
        expect(toggle).not.toHaveBeenCalled();

        await screen.unmount();
    });
});
