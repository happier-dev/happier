import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    type NotificationChannelV1,
    type NotificationChannelTopicsV1,
    type NotificationsSettingsV1,
} from '@happier-dev/protocol';
import { installBrowserNotificationApiStub } from '@/dev/testkit/mocks/browserNotification';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsMock = vi.fn();
const applyLocalSettingsMock = vi.fn();
const modalPromptMock = vi.fn();
const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();
const routerPushMock = vi.fn();
const isTauriDesktopState = vi.hoisted(() => ({ value: false }));
const tauriIsPermissionGrantedMock = vi.hoisted(() => vi.fn(async () => true));
const tauriRequestPermissionMock = vi.hoisted(() => vi.fn(async () => 'granted'));
const useFeatureEnabledSpy = vi.hoisted(() => vi.fn((_featureId: string) => true));

function createNotificationTopics(overrides: Partial<NotificationChannelTopicsV1> = {}): NotificationChannelTopicsV1 {
    return {
        ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
        ...overrides,
    };
}

function createNotificationsSettings(overrides: Partial<NotificationsSettingsV1> = {}): NotificationsSettingsV1 {
    return {
        ...DEFAULT_NOTIFICATIONS_SETTINGS_V1,
        ...overrides,
    };
}

const settingsState: {
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelV1[];
} = {
    notificationsSettingsV1: createNotificationsSettings(),
    notificationChannelsV1: [
        {
            v: 1,
            id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            kind: 'expo_push',
            enabled: true,
            topics: createNotificationTopics(),
            readyIncludeMessageText: true,
            requestIncludeMessageText: true,
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

type NotificationsSettingsScreen = Awaited<ReturnType<typeof renderSettingsView>>;

function requireRow(screen: NotificationsSettingsScreen, testID: string) {
    const row = screen.findRow(testID);
    expect(row).toBeTruthy();
    return row!;
}

function requireRowByTitle(screen: NotificationsSettingsScreen, title: string) {
    const row = screen.findRowByTitle(title);
    expect(row).toBeTruthy();
    return row!;
}

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalPromptMock,
                confirm: modalConfirmMock,
                alert: modalAlertMock,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => settingsState,
            useLocalSettings: () => localSettingsState,
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: '#00f' },
                    success: '#0f0',
                    textSecondary: '#666',
                    warning: '#f90',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/settings/notifications',
            segments: ['(app)', 'settings', 'notifications'],
            router: {
                push: routerPushMock,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopState.value,
}));

vi.mock('@/activity/notifications/channels/tauriNotificationPlugin', () => ({
    isPermissionGranted: tauriIsPermissionGrantedMock,
    requestPermission: tauriRequestPermissionMock,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassthroughComponentMock('ItemList'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: createPassthroughComponentMock('ItemRowActions'),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassthroughComponentMock('Switch'),
}));

describe('NotificationsSettingsView', () => {
    beforeEach(() => {
        applySettingsMock.mockReset();
        applyLocalSettingsMock.mockReset();
        modalPromptMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
        routerPushMock.mockReset();
        tauriIsPermissionGrantedMock.mockReset();
        tauriRequestPermissionMock.mockReset();
        tauriIsPermissionGrantedMock.mockResolvedValue(true);
        tauriRequestPermissionMock.mockResolvedValue('granted');
        useFeatureEnabledSpy.mockReset();
        useFeatureEnabledSpy.mockReturnValue(true);
        isTauriDesktopState.value = false;

        settingsState.notificationsSettingsV1 = createNotificationsSettings();
        settingsState.notificationChannelsV1 = [
            {
                v: 1,
                id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                kind: 'expo_push',
                enabled: true,
                topics: createNotificationTopics(),
                readyIncludeMessageText: true,
                requestIncludeMessageText: true,
            },
        ];
    });

    it('navigates to push notification troubleshooting', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);

        screen.pressRow('settings-notifications-push-troubleshoot');

        expect(routerPushMock).toHaveBeenCalledWith('/settings/notifications/push');
    });

    it('renders device-local badge/local sections alongside the remote push section', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const groupTitles = [
            'settingsNotifications.badges.title',
            'settingsNotifications.local.title',
            'settingsNotifications.push.title',
            'settingsNotifications.webhooks.title',
            'settingsNotifications.connectedServices.title',
            'settingsNotifications.types.title',
            'settingsNotifications.foregroundBehavior.title',
        ].map((title) => screen.findGroup(title)?.props.title);

        expect(groupTitles).toEqual([
            'settingsNotifications.badges.title',
            'settingsNotifications.local.title',
            'settingsNotifications.push.title',
            'settingsNotifications.webhooks.title',
            'settingsNotifications.connectedServices.title',
            'settingsNotifications.types.title',
            'settingsNotifications.foregroundBehavior.title',
        ]);
    });

    it('exposes stable test ids for the notifications screen and primary controls', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findByTestId('settings-notifications-screen')).toBeTruthy();
        expect(screen.findRow('settings-notifications-badges-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-local-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-push-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-add-webhook')).toBeTruthy();
    });

    it('keeps focused-computer muting opt-in and persists the account setting', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const row = requireRow(screen, 'settings-notifications-mute-phone-focused-computer');
        const control = row.props.rightElement;
        expect(control.props.value).toBe(false);
        await act(async () => control.props.onValueChange(true));
        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            notificationsSettingsV1: expect.objectContaining({ mutePhoneWhenComputerFocused: true }),
        }));
    });

    it('renders connected-service quota and account-switch notification controls when quota fallback features are enabled', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.connectedServices.title')).toBeTruthy();
        expect(screen.findRow('settings-notifications-connected-service-account-switch')).toBeTruthy();
        expect(screen.findRow('settings-notifications-connected-service-quota-blocked')).toBeTruthy();
        expect(screen.findRow('settings-notifications-connected-service-quota-recovered')).toBeTruthy();
    });

    it('shows quota notification controls when quotas are enabled without account fallback', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId === 'connectedServices.quotas');
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRow('settings-notifications-connected-service-account-switch')).toBeNull();
        expect(screen.findRow('settings-notifications-connected-service-quota-blocked')).toBeTruthy();
        expect(screen.findRow('settings-notifications-connected-service-quota-recovered')).toBeTruthy();
    });

    it('shows account-switch notification controls when fallback is enabled without quotas', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId === 'connectedServices.accountFallback');
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRow('settings-notifications-connected-service-account-switch')).toBeTruthy();
        expect(screen.findRow('settings-notifications-connected-service-quota-blocked')).toBeNull();
        expect(screen.findRow('settings-notifications-connected-service-quota-recovered')).toBeNull();
    });

    it('hides connected-service notification controls when quota and fallback features are disabled', async () => {
        useFeatureEnabledSpy.mockReturnValue(false);
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.connectedServices.title')).toBeNull();
        expect(screen.findRow('settings-notifications-connected-service-account-switch')).toBeNull();
        expect(screen.findRow('settings-notifications-connected-service-quota-blocked')).toBeNull();
        expect(screen.findRow('settings-notifications-connected-service-quota-recovered')).toBeNull();
    });

    it('hides desktop notification diagnostics outside the Tauri app', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.desktop.title')).toBeNull();
        expect(screen.findRow('settings-notifications-desktop-permission')).toBeNull();
    });

    it('shows desktop notification diagnostics inside the Tauri app', async () => {
        isTauriDesktopState.value = true;
        tauriIsPermissionGrantedMock.mockResolvedValue(false);
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {});

        expect(screen.findGroup('settingsNotifications.desktop.title')).toBeTruthy();
        expect(screen.findRow('settings-notifications-desktop-permission')).toBeTruthy();
    });

    it('requests Tauri notification permission from the desktop diagnostics row', async () => {
        isTauriDesktopState.value = true;
        tauriIsPermissionGrantedMock.mockResolvedValue(false);
        tauriRequestPermissionMock.mockResolvedValue('granted');
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {});

        await act(async () => {
            screen.pressRow('settings-notifications-desktop-permission');
        });

        expect(tauriRequestPermissionMock).toHaveBeenCalledTimes(1);
    });

    it('asks the browser for notification permission when local notifications are turned on', async () => {
        const browser = installBrowserNotificationApiStub('default');
        try {
            const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
            const screen = await renderSettingsView(<NotificationsSettingsView />);
            const enabledItem = requireRow(screen, 'settings-notifications-local-enabled');

            await act(async () => {
                enabledItem.props.rightElement.props.onValueChange(false);
            });
            expect(browser.requestPermission).not.toHaveBeenCalled();

            await act(async () => {
                enabledItem.props.rightElement.props.onValueChange(true);
            });
            expect(applyLocalSettingsMock).toHaveBeenLastCalledWith({ localNotificationsEnabled: true });
            expect(browser.requestPermission).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('leaves desktop app notification permission to the desktop diagnostics row', async () => {
        isTauriDesktopState.value = true;
        const browser = installBrowserNotificationApiStub('default');
        try {
            const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
            const screen = await renderSettingsView(<NotificationsSettingsView />);
            await act(async () => {});

            await act(async () => {
                requireRow(screen, 'settings-notifications-local-enabled').props.rightElement.props.onValueChange(true);
            });
            expect(browser.requestPermission).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('writes device-local badge settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const badgeItem = requireRow(screen, 'settings-notifications-badges-enabled');

        await act(async () => {
            badgeItem.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ activityBadgesEnabled: false });
    });

    it('writes device-local local-notification topic settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const readyItem = requireRowByTitle(screen, 'settingsNotifications.local.readyTitle');

        await act(async () => {
            readyItem.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ localNotificationsShowReady: false });
    });

    it('writes device-local ready preview settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.local.readyPreviewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ localNotificationsShowReadyMessageText: false });
    });

    it('writes device-local request preview settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.local.requestPreviewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ localNotificationsShowRequestMessageText: false });
    });

    it('writes remote push settings through the synced account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const pushItem = requireRow(screen, 'settings-notifications-push-enabled');

        await act(async () => {
            pushItem.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: createNotificationsSettings({
                pushEnabled: false,
            }),
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: false,
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: true,
                },
            ],
        });
    });

    it('disables quota recovered push notifications when quota blocked notifications are disabled', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const quotaBlockedItem = requireRow(screen, 'settings-notifications-connected-service-quota-blocked');

        await act(async () => {
            quotaBlockedItem.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: createNotificationsSettings({
                connectedServiceQuotaBlocked: false,
                connectedServiceQuotaRecovered: false,
            }),
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: createNotificationTopics({
                        connectedServiceQuotaBlocked: false,
                        connectedServiceQuotaRecovered: false,
                    }),
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: true,
                },
            ],
        });
    });

    it('disables synced request previews without changing notification topics', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.types.requestPreview.title');
        expect(previewItem.props.rightElement.props.value).toBe(true);
        await act(async () => { previewItem.props.rightElement.props.onValueChange(false); });
        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            notificationsSettingsV1: createNotificationsSettings({ requestIncludeMessageText: false }),
            notificationChannelsV1: [expect.objectContaining({
                kind: 'expo_push', requestIncludeMessageText: false, topics: createNotificationTopics(),
            })],
        }));
    });

    it('writes synced ready preview settings through the account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.types.readyPreview.title');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: createNotificationsSettings({
                readyIncludeMessageText: false,
                requestIncludeMessageText: true,
            }),
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: true,
                },
            ],
        });
    });

    it('adds a webhook notification channel from the settings screen', async () => {
        modalPromptMock.mockResolvedValue('https://hooks.example.test/notify');

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        await act(async () => {
            screen.pressRow('settings-notifications-add-webhook');
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: settingsState.notificationsSettingsV1,
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: true,
                },
                {
                    v: 1,
                    id: 'webhook-hooks-example-test-notify',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: true,
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
                topics: createNotificationTopics(),
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
        ];
        modalConfirmMock.mockResolvedValue(true);

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const webhookItem = requireRow(screen, 'settings-notifications-webhook-webhook-primary');

        const deleteAction = webhookItem.props.rightElement.props.actions.find((action: { id: string }) => action.id === 'delete');
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
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: true,
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
                topics: createNotificationTopics(),
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
        ];
        modalPromptMock.mockResolvedValue('shared-webhook-secret');

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        await act(async () => {
            screen.pressRowByTitle('settingsNotifications.webhooks.signingSecretTitle');
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            notificationsSettingsV1: settingsState.notificationsSettingsV1,
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: true,
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
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
            ],
        });
    });

    it('writes connected-service webhook topics through the selected webhook channel settings', async () => {
        settingsState.notificationChannelsV1 = [
            ...settingsState.notificationChannelsV1,
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: createNotificationTopics(),
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
            {
                v: 1,
                id: 'webhook-secondary',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/secondary',
                signingSecret: null,
                topics: createNotificationTopics(),
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
        ];

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const topicItem = requireRow(
            screen,
            'settings-notifications-webhook-topic:webhook-secondary:connectedServiceQuotaBlocked',
        );

        await act(async () => {
            topicItem.props.rightElement.props.onValueChange(false);
        });

        const written = applySettingsMock.mock.calls.at(-1)?.[0] as { notificationChannelsV1?: NotificationChannelV1[] };
        const webhook = written.notificationChannelsV1?.find((channel) => channel.id === 'webhook-primary');
        const secondaryWebhook = written.notificationChannelsV1?.find((channel) => channel.id === 'webhook-secondary');
        expect(webhook?.topics.connectedServiceQuotaBlocked).toBe(true);
        expect(secondaryWebhook?.topics.connectedServiceQuotaBlocked).toBe(false);
        expect(secondaryWebhook?.topics.connectedServiceAccountSwitch).toBe(true);
        expect(secondaryWebhook?.topics.connectedServiceQuotaRecovered).toBe(false);
    });

    it('gates connected-service webhook topics by their owning feature', async () => {
        useFeatureEnabledSpy.mockImplementation((featureId: string) => featureId === 'connectedServices.quotas');
        settingsState.notificationChannelsV1 = [
            ...settingsState.notificationChannelsV1,
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: createNotificationTopics(),
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
        ];

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRow('settings-notifications-webhook-topic:webhook-primary:connectedServiceAccountSwitch')).toBeNull();
        expect(screen.findRow('settings-notifications-webhook-topic:webhook-primary:connectedServiceQuotaBlocked')).toBeTruthy();
        expect(screen.findRow('settings-notifications-webhook-topic:webhook-primary:connectedServiceQuotaRecovered')).toBeTruthy();
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
                topics: createNotificationTopics(),
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
        ];

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const signingSecretItem = requireRowByTitle(screen, 'settingsNotifications.webhooks.signingSecretTitle');

        const clearAction = signingSecretItem.props.rightElement.props.actions.find((action: { id: string }) => action.id === 'clear-signing-secret');
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
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: true,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: createNotificationTopics(),
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
            ],
        });
    });
});
