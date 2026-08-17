import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/voice/agent/getVoiceAgentSessionTeleportAvailability', () => ({
    getVoiceAgentSessionTeleportAvailability: () => ({ ok: false }),
}));

// The real hook returns the module-level registry snapshot
// (`connectedServiceRegistry.ts:179-181`), so the mock must be a stable object
// too — a fresh literal per render would manufacture exactly the instability
// this test exists to detect.
const connectedServices = vi.hoisted(() => ({
    snapshot: Object.freeze({ entries: Object.freeze([]) }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => connectedServices.snapshot,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/target-session' }).module;
});

const initialStorageState = getStorage().getState();

const TARGET_SESSION_ID = 'target-session';

function seedVoiceSession(): void {
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
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                active: true,
                metadata: { summaryText: 'Dashboard auth' },
            },
        },
    }));
}

/**
 * M2 — the view-model seam is only substitutable if it is also stable.
 *
 * `VoiceSurfaceView` is `React.memo` over a single `model` prop, so a model that
 * is a fresh object on every render makes that memo decorative: Horizon, the
 * transcript stream and every light leaf below them re-render on any unrelated
 * parent render. The contract asserted here is the one the memo needs — an
 * unchanged Voice setting, snapshot and session produce the *same* model object.
 */
describe('useVoiceSurfaceModel identity', () => {
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

    it('returns the same model object across a re-render with unchanged inputs', async () => {
        seedVoiceSession();
        const { useVoiceSurfaceModel } = await import('./useVoiceSurfaceModel');

        const hook = await renderHook(() => useVoiceSurfaceModel({
            variant: 'session',
            sessionId: TARGET_SESSION_ID,
        } as any));

        const first = hook.getCurrent();
        expect(first).not.toBeNull();

        await hook.rerender();
        const second = hook.getCurrent();

        expect(Object.is(first, second)).toBe(true);

        await hook.unmount();
    });
});
