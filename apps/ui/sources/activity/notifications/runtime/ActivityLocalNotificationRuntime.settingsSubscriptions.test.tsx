import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { getStorage } from '@/sync/domains/state/storage';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();

const sendExpoLocalNotification = vi.hoisted(() => vi.fn(async () => 'notif-1'));
const sendTauriLocalNotification = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    });
});

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));

vi.mock('@/desktop/window/isTauriMainWindowActivelyViewed', () => ({
    isTauriMainWindowActivelyViewed: () => false,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    isSessionSurfaceVisible: () => false,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('../channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification,
}));

vi.mock('../channels/sendTauriLocalNotification', () => ({
    sendTauriLocalNotification,
}));

describe('ActivityLocalNotificationRuntime settings subscriptions', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        sendExpoLocalNotification.mockClear();
        sendTauriLocalNotification.mockClear();
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
});
