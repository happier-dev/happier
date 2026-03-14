import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    type NotificationChannelV1,
    type NotificationsSettingsV1,
} from '@happier-dev/protocol';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsMock = vi.fn();
const applyLocalSettingsMock = vi.fn();
const modalPromptMock = vi.fn();
const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();

const settingsState: {
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelV1[];
} = {
    notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
    },
    notificationChannelsV1: [
        {
            v: 1,
            id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            kind: 'expo_push',
            enabled: true,
            topics: {
                ready: true,
                permissionRequest: true,
                userActionRequest: true,
            },
            readyIncludeMessageText: true,
        },
    ],
};

const localSettingsState = {
    activityBadgesEnabled: true,
    activityBadgeShowUnread: true,
    activityBadgeShowPendingPermissionRequests: true,
    activityBadgeShowPendingUserActionRequests: true,
    activityBadgeShowQueuedUserInput: true,
    activityBadgeShowFriendRequestsInboxCount: true,
    activityBadgeShowDesktopNonNumericDot: true,
    localNotificationsEnabled: true,
    localNotificationsShowReady: true,
    localNotificationsShowReadyMessageText: true,
    localNotificationsShowPendingPermissionRequests: true,
    localNotificationsShowPendingUserActionRequests: true,
    localNotificationsForegroundBehavior: 'silent',
};

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: { blue: '#00f' },
                success: '#0f0',
                textSecondary: '#666',
                warning: '#f90',
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: modalPromptMock,
        confirm: modalConfirmMock,
        alert: modalAlertMock,
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettings: () => settingsState,
    useLocalSettings: () => localSettingsState,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

describe('NotificationsSettingsView', () => {
    beforeEach(() => {
        applySettingsMock.mockReset();
        applyLocalSettingsMock.mockReset();
        modalPromptMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();

        settingsState.notificationsSettingsV1 = {
            v: 1,
            pushEnabled: true,
            ready: true,
            readyIncludeMessageText: true,
            permissionRequest: true,
            userActionRequest: true,
            foregroundBehavior: 'full',
        };
        settingsState.notificationChannelsV1 = [
            {
                v: 1,
                id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                kind: 'expo_push',
                enabled: true,
                topics: {
                    ready: true,
                    permissionRequest: true,
                    userActionRequest: true,
                },
                readyIncludeMessageText: true,
            },
        ];
    });

    it('renders device-local badge/local sections alongside the remote push section', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const groupTitles = tree!.root.findAllByType('ItemGroup' as any).map((node) => node.props.title);
        expect(groupTitles).toEqual([
            'settingsNotifications.badges.title',
            'settingsNotifications.local.title',
            'settingsNotifications.push.title',
            'settingsNotifications.webhooks.title',
            'settingsNotifications.types.title',
            'settingsNotifications.foregroundBehavior.title',
        ]);
    });

    it('exposes stable test ids for the notifications screen and primary controls', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const rootList = tree!.root.findAllByType('ItemList' as any)[0];
        expect(rootList?.props.testID).toBe('settings-notifications-screen');

        const itemTestIds = tree!.root.findAllByType('Item' as any)
            .map((item) => item.props.testID)
            .filter(Boolean);

        expect(itemTestIds).toEqual(expect.arrayContaining([
            'settings-notifications-badges-enabled',
            'settings-notifications-local-enabled',
            'settings-notifications-push-enabled',
            'settings-notifications-add-webhook',
        ]));
    });

    it('writes device-local badge settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const badgeItem = items.find((item) => item.props.title === 'settingsNotifications.badges.enabledTitle');
        expect(badgeItem).toBeTruthy();

        await act(async () => {
            badgeItem!.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ activityBadgesEnabled: false });
    });

    it('writes device-local local-notification topic settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const readyItem = items.find((item) => item.props.title === 'settingsNotifications.local.readyTitle');
        expect(readyItem).toBeTruthy();

        await act(async () => {
            readyItem!.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ localNotificationsShowReady: false });
    });

    it('writes device-local ready preview settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const previewItem = items.find((item) => item.props.title === 'settingsNotifications.local.readyPreviewTitle');
        expect(previewItem).toBeTruthy();

        await act(async () => {
            previewItem!.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ localNotificationsShowReadyMessageText: false });
    });

    it('writes remote push settings through the synced account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const pushItem = items.find((item) => item.props.subtitle === 'settingsNotifications.push.enabledSubtitle');
        expect(pushItem).toBeTruthy();

        await act(async () => {
            pushItem!.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: {
                v: 1,
                pushEnabled: false,
                ready: true,
                readyIncludeMessageText: true,
                permissionRequest: true,
                userActionRequest: true,
                foregroundBehavior: 'full',
            },
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: false,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: true,
                },
            ],
        });
    });

    it('writes synced ready preview settings through the account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const previewItem = items.find((item) => item.props.title === 'settingsNotifications.types.readyPreview.title');
        expect(previewItem).toBeTruthy();

        await act(async () => {
            previewItem!.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: {
                v: 1,
                pushEnabled: true,
                ready: true,
                readyIncludeMessageText: false,
                permissionRequest: true,
                userActionRequest: true,
                foregroundBehavior: 'full',
            },
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: false,
                },
            ],
        });
    });

    it('adds a webhook notification channel from the settings screen', async () => {
        modalPromptMock.mockResolvedValue('https://hooks.example.test/notify');

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const addWebhookItem = items.find((item) => item.props.title === 'settingsNotifications.webhooks.addTitle');
        expect(addWebhookItem).toBeTruthy();

        await act(async () => {
            await addWebhookItem!.props.onPress();
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: settingsState.notificationsSettingsV1,
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: true,
                },
                {
                    v: 1,
                    id: 'webhook-hooks-example-test-notify',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: false,
                },
            ],
        });
    });

    it('removes a webhook notification channel from the settings screen', async () => {
        settingsState.notificationChannelsV1 = [
            ...settingsState.notificationChannelsV1,
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: {
                    ready: true,
                    permissionRequest: true,
                    userActionRequest: true,
                },
                readyIncludeMessageText: false,
            },
        ];
        modalConfirmMock.mockResolvedValue(true);

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const webhookItem = items.find((item) => item.props.title === 'https://hooks.example.test/notify');
        expect(webhookItem).toBeTruthy();

        const deleteAction = webhookItem!.props.rightElement.props.actions.find((action: { id: string }) => action.id === 'delete');
        expect(deleteAction).toBeTruthy();

        await act(async () => {
            await deleteAction.onPress();
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: settingsState.notificationsSettingsV1,
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: true,
                },
            ],
        });
    });

    it('sets a webhook signing secret from the settings screen', async () => {
        settingsState.notificationChannelsV1 = [
            ...settingsState.notificationChannelsV1,
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: {
                    ready: true,
                    permissionRequest: true,
                    userActionRequest: true,
                },
                readyIncludeMessageText: false,
            },
        ];
        modalPromptMock.mockResolvedValue('shared-webhook-secret');

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const signingSecretItem = items.find((item) => item.props.title === 'settingsNotifications.webhooks.signingSecretTitle');
        expect(signingSecretItem).toBeTruthy();

        await act(async () => {
            await signingSecretItem!.props.onPress();
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: settingsState.notificationsSettingsV1,
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: true,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: {
                        _isSecretValue: true,
                        value: 'shared-webhook-secret',
                    },
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: false,
                },
            ],
        });
    });

    it('clears a configured webhook signing secret from the settings screen', async () => {
        settingsState.notificationChannelsV1 = [
            ...settingsState.notificationChannelsV1,
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'abc123' },
                },
                topics: {
                    ready: true,
                    permissionRequest: true,
                    userActionRequest: true,
                },
                readyIncludeMessageText: false,
            },
        ];

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<NotificationsSettingsView />);
        });

        const items = tree!.root.findAllByType('Item' as any);
        const signingSecretItem = items.find((item) => item.props.title === 'settingsNotifications.webhooks.signingSecretTitle');
        expect(signingSecretItem).toBeTruthy();

        const clearAction = signingSecretItem!.props.rightElement.props.actions.find((action: { id: string }) => action.id === 'clear-signing-secret');
        expect(clearAction).toBeTruthy();

        await act(async () => {
            await clearAction.onPress();
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: settingsState.notificationsSettingsV1,
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: true,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: false,
                },
            ],
        });
    });
});
