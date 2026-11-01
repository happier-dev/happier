import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { Platform } from 'react-native';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS } from '@happier-dev/protocol';
import * as profiles from '@/sync/domains/server/serverProfiles';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    });
});

const native = vi.hoisted(() => ({ schedule: vi.fn<(request: import('expo-notifications').NotificationRequestInput) => Promise<string>>(async () => 'notif-1') }));
// The Expo scheduling API is the OS boundary; builder, adapter and store stay real.
vi.mock('expo-notifications', () => ({
    scheduleNotificationAsync: native.schedule,
    getPresentedNotificationsAsync: async () => [],
    addNotificationReceivedListener: () => ({ remove() {} }),
}));

describe('ActivityLocalNotificationRuntime local settings subscriptions', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        Platform.OS = 'ios';
        const profile = profiles.upsertServerProfile({ serverUrl: 'https://stack.example.test', name: 'Test' });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        getStorage().setState({ profileScope: { serverId: profile.id, accountId: 'account-1' } });
        getStorage().getState().applyLocalSettings({
            localNotificationsEnabled: true,
            localNotificationsShowReady: true,
            localNotificationsShowReadyMessageText: true,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: true,
            activityBadgeShowUnread: true,
        });
    });

    afterEach(async () => {
        getStorage().setState(initialStorageState, true);
        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
        vi.clearAllMocks();
    });

    it('updates request privacy without hiding the request notification', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const request = { sessionId: 'private-session', requestId: 'request-1', requestKind: 'permission' as const,
            toolName: 'Bash', toolArgs: { command: 'cat private.txt' } };
        await act(async () => { notifyActivityAgentRequest(request); });
        expect(native.schedule.mock.calls.at(-1)?.[0].content.body).toContain('cat private.txt');
        await act(async () => {
            getStorage().getState().applyLocalSettings({ localNotificationsShowRequestMessageText: false });
        });
        await act(async () => { notifyActivityAgentRequest({ ...request, requestId: 'request-2' }); });
        const privateNotification = native.schedule.mock.calls.at(-1)?.[0].content;
        expect(privateNotification?.body).not.toContain('private.txt');
        expect(privateNotification?.data?.requestId).toBe('request-2');
        await act(async () => { screen.tree.unmount(); });
    });

    it.each(['android', 'ios'] as const)('delivers request channels and captured Account identity to the OS on %s', async (platform) => {
        Platform.OS = platform;
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');
        const screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        for (const requestKind of ['permission', 'user_action'] as const) {
            await act(async () => { notifyActivityAgentRequest({
                sessionId: 'channel-session', requestId: requestKind, occurrenceId: `${requestKind}-occurrence`, requestKind,
                toolName: requestKind === 'permission' ? 'Bash' : 'AskUserQuestion', toolArgs: {},
            }); });
            const channelId = requestKind === 'permission'
                ? PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1
                : PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1;
            expect(native.schedule.mock.calls.at(-1)?.[0]).toMatchObject({
                content: { data: { accountId: 'account-1', kind: requestKind, occurrenceId: `${requestKind}-occurrence` } },
                trigger: platform === 'android' ? { channelId } : null,
            });
        }
        await screen.unmount();
    });

    it('does not rerender for local setting writes unrelated to local notifications', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        let updateCount = 0;

        const screen = await renderScreen(
            <React.Profiler
                id="activity-local-notification-runtime"
                onRender={(_id, phase) => {
                    if (phase === 'update') updateCount += 1;
                }}
            >
                <ActivityLocalNotificationRuntime />
            </React.Profiler>,
        );

        const updatesBeforeUnrelatedLocalSettingWrite = updateCount;

        await act(async () => {
            getStorage().getState().applyLocalSettings({ activityBadgeShowUnread: false });
        });

        expect(updateCount).toBe(updatesBeforeUnrelatedLocalSettingWrite);

        await act(async () => {
            screen.tree.unmount();
        });
    });
});
