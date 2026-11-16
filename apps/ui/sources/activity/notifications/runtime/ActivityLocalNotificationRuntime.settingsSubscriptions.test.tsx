import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { getStorage } from '@/sync/domains/state/storage';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();

const sendExpoLocalNotification = vi.hoisted(() => vi.fn(async () => 'notif-1'));
const sendTauriLocalNotification = vi.hoisted(() => vi.fn(async () => true));
const syncSessionChangedBackgroundWakeTaskRegistration = vi.hoisted(
    () => vi.fn(async () => ({ status: 'registered' as const })),
);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/desktop/window/desktopMainWindowPresence', () => ({
    isDesktopMainWindowFocused: () => false,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    isSessionSurfaceVisible: () => false,
}));

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const { createDesktopHostModuleMock } = await import('@/dev/testkit/mocks/desktopHost');
    return createDesktopHostModuleMock({ importOriginal, overrides: {
    isDesktopHost: () => false,
    } });
});

vi.mock('../channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification,
}));

vi.mock('../channels/sendTauriLocalNotification', () => ({
    sendTauriLocalNotification,
}));

// Only the OS task-registry call is replaced; the wake consumer beneath it,
// including its module-load task definition, stays real.
vi.mock('../backgroundWake/defineSessionChangedBackgroundWakeTask', async (importOriginal) => ({
    ...await importOriginal<typeof import('../backgroundWake/defineSessionChangedBackgroundWakeTask')>(),
    syncSessionChangedBackgroundWakeTaskRegistration,
}));

describe('ActivityLocalNotificationRuntime settings subscriptions', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        sendExpoLocalNotification.mockClear();
        sendTauriLocalNotification.mockClear();
        syncSessionChangedBackgroundWakeTaskRegistration.mockClear();
    });

    afterEach(async () => {
        standardCleanup();
        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
        getStorage().setState(initialStorageState, true);
    });

    it('does not rerender for unrelated local settings changes', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        let updateCount = 0;

        await renderScreen(
            <React.Profiler
                id="activity-local-notification-runtime"
                onRender={(_, phase) => {
                    if (phase === 'update') updateCount += 1;
                }}
            >
                <ActivityLocalNotificationRuntime />
            </React.Profiler>,
        );

        await act(async () => {
            getStorage().getState().applyLocalSettings({ uiFontScale: 1.1 });
        });

        expect(updateCount).toBe(0);
    });

    it('does not rerender for unrelated account settings changes', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        let updateCount = 0;

        await renderScreen(
            <React.Profiler
                id="activity-local-notification-runtime"
                onRender={(_, phase) => {
                    if (phase === 'update') updateCount += 1;
                }}
            >
                <ActivityLocalNotificationRuntime />
            </React.Profiler>,
        );

        await act(async () => {
            getStorage().getState().applySettingsLocal({ analyticsOptOut: true });
        });

        expect(updateCount).toBe(0);
    });
    it('does not rerender while a Session streams a reply', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const session = createSessionFixture({ id: 'session-streaming', active: true });
        const transcriptAt = (text: string, messagesVersion: number) => createSessionMessagesFixture({
            messageIdsOldestFirst: ['reply'],
            messagesById: { reply: { kind: 'agent-text', id: 'reply', localId: null, createdAt: 1_000, text } },
            messagesVersion,
        });
        getStorage().setState({ sessions: { [session.id]: session }, sessionMessages: { [session.id]: transcriptAt('', 1) } });
        let updateCount = 0;

        await renderScreen(
            <React.Profiler
                id="activity-local-notification-runtime"
                onRender={(_, phase) => {
                    if (phase === 'update') updateCount += 1;
                }}
            >
                <ActivityLocalNotificationRuntime />
            </React.Profiler>,
        );

        // Three streamed deltas of one reply: the transcript moves, no notification fact does.
        for (const [index, text] of ['word0 ', 'word0 word1 ', 'word0 word1 word2 '].entries()) {
            await act(async () => {
                getStorage().setState({ sessionMessages: { [session.id]: transcriptAt(text, index + 2) } });
            });
        }

        expect(updateCount).toBe(0);
    });

    it('does not rerender while a remote turn moves Session rows but no audience', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const session = createSessionFixture({ id: 'session-remote-turn', active: true, seq: 1 });
        getStorage().getState().applySessions([session]);
        let updateCount = 0;

        await renderScreen(
            <React.Profiler
                id="activity-local-notification-runtime"
                onRender={(_, phase) => {
                    if (phase === 'update') updateCount += 1;
                }}
            >
                <ActivityLocalNotificationRuntime />
            </React.Profiler>,
        );

        // A turn sent from another device: the row starts thinking, commits messages and settles.
        const turn = [
            { seq: 2, thinking: true, thinkingAt: 2_000, latestTurnStatus: 'in_progress' as const },
            { seq: 3, thinking: true, thinkingAt: 2_000, latestTurnStatus: 'in_progress' as const, meaningfulActivityAt: 3_000 },
            { seq: 4, thinking: false, latestTurnStatus: 'completed' as const, meaningfulActivityAt: 4_000 },
        ];
        for (const patch of turn) {
            await act(async () => {
                getStorage().getState().applySessions([{ ...getStorage().getState().sessions[session.id]!, ...patch }]);
            });
        }

        expect(updateCount).toBe(0);
    });

    // The closed-app `session_changed` wake exists to hydrate the woken Home so
    // this runtime can present its Activity notification, and this runtime
    // mounts on every platform. Reconciling the registration from here — with
    // no platform argument, so the task owner alone decides where it can run —
    // is what gives the Android hop a consumer at all. A registration that
    // silently stops happening is invisible until a device is asleep.
    it('reconciles the closed-app wake task registration and leaves the platform decision to its owner', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');

        await renderScreen(<ActivityLocalNotificationRuntime />);

        expect(syncSessionChangedBackgroundWakeTaskRegistration).toHaveBeenCalledTimes(1);
        expect(syncSessionChangedBackgroundWakeTaskRegistration).toHaveBeenCalledWith();
    });
});
