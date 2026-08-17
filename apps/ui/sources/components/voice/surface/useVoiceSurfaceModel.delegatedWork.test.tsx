import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/voice/agent/getVoiceAgentSessionTeleportAvailability', () => ({
    getVoiceAgentSessionTeleportAvailability: () => ({ ok: false }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => ({ entries: [] }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/target-session' }).module;
});

const initialStorageState = getStorage().getState();

const TARGET_SESSION_ID = 'target-session';

function seedSession(thinking: boolean): void {
    getStorage().setState((state: any) => ({
        ...state,
        isDataReady: true,
        settings: {
            ...state.settings,
            voice: {
                providerId: 'local_conversation',
                ui: {
                    activityFeedEnabled: false,
                    scopeDefault: 'session',
                    surfaceLocation: 'session',
                },
            },
        },
        sessions: {
            ...state.sessions,
            [TARGET_SESSION_ID]: {
                id: TARGET_SESSION_ID,
                thinking,
                thinkingAt: thinking ? 10 : 0,
                presence: 'online',
                active: true,
                metadata: { summaryText: 'Dashboard auth' },
            },
        },
    }));
}

async function renderModel() {
    const { useVoiceSurfaceModel } = await import('./useVoiceSurfaceModel');
    return renderHook(() => useVoiceSurfaceModel({
        variant: 'session',
        sessionId: TARGET_SESSION_ID,
    } as any));
}

describe('useVoiceSurfaceModel delegated work', () => {
    beforeEach(async () => {
        getStorage().setState(initialStorageState, true);
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: TARGET_SESSION_ID,
            status: 'connected',
            mode: 'listening',
            canStop: true,
        } as any);
    });

    afterEach(() => {
        standardCleanup();
        getStorage().setState(initialStorageState, true);
    });

    it('projects agent-authored status text and session thinking as a separate delegated-work channel', async () => {
        seedSession(true);
        const { voiceOutputStatusStore } = await import('@/voice/runtime/outputStatus/voiceOutputStatusStore');
        voiceOutputStatusStore.show({
            sessionId: TARGET_SESSION_ID,
            turnId: 'turn-1',
            statusId: 'status-1',
            text: 'Codex is editing AgentInput.tsx',
        });

        const hook = await renderModel();
        const model = hook.getCurrent();

        expect(model).not.toBeNull();
        expect(model?.delegatedWork).toEqual({
            sessionId: TARGET_SESSION_ID,
            statusText: 'Codex is editing AgentInput.tsx',
            thinking: true,
        });

        await hook.unmount();
    });

    it('keeps the subtitle on the target/error channel instead of flattening agent status text into it', async () => {
        seedSession(false);
        const { voiceOutputStatusStore } = await import('@/voice/runtime/outputStatus/voiceOutputStatusStore');
        voiceOutputStatusStore.show({
            sessionId: TARGET_SESSION_ID,
            turnId: 'turn-2',
            statusId: 'status-2',
            text: 'Codex is editing AgentInput.tsx',
        });

        const hook = await renderModel();
        const model = hook.getCurrent();

        expect(model?.subtitle ?? '').not.toContain('Codex is editing AgentInput.tsx');
        expect(model?.delegatedWork?.statusText).toBe('Codex is editing AgentInput.tsx');

        await hook.unmount();
    });

    it('reports no delegated work when neither the agent nor the session is doing any', async () => {
        seedSession(false);
        const { voiceOutputStatusStore } = await import('@/voice/runtime/outputStatus/voiceOutputStatusStore');
        voiceOutputStatusStore.clear({ sessionId: TARGET_SESSION_ID, turnId: 'turn-2' });

        const hook = await renderModel();

        expect(hook.getCurrent()?.delegatedWork).toBeNull();

        await hook.unmount();
    });

    it('stops carrying the redundant isSpeaking, openLabel and controlsActive fields across the seam', async () => {
        seedSession(false);

        const hook = await renderModel();
        const model = hook.getCurrent();

        expect(model).not.toBeNull();
        expect(model).not.toHaveProperty('isSpeaking');
        expect(model).not.toHaveProperty('openLabel');
        expect(model).not.toHaveProperty('controlsActive');

        await hook.unmount();
    });
});
