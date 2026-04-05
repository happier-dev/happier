import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    type NotificationChannelV1,
    type NotificationsSettingsV1,
} from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web' | 'android',
}));
const tauriDesktopState = vi.hoisted(() => ({
    value: false,
}));


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsMock = vi.fn();
const applyLocalSettingsMock = vi.fn();
const modalPromptMock = vi.fn();
const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();
const routerPushMock = vi.fn();

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
    activitySurfacesEnabled: true,
    liveActivitiesEnabled: true,
    liveActivitiesStrategy: 'dynamic_primary',
    iosLiveActivitiesEnabled: true,
    widgetsEnabled: true,
    liveActivitiesMode: 'focused',
    liveActivitiesMaxConcurrent: 1,
    liveActivitiesShowPreviewText: true,
    liveActivitiesAllowActionButtons: true,
    liveActivitiesIncludeReady: true,
    liveActivitiesIncludeThinking: true,
    widgetsPresetMode: 'summary',
    widgetsShowPreviewText: true,
    widgetsShowMachinePath: true,
    homeScreenWidgetsMode: 'summary',
    homeScreenWidgetsShowPreviewText: true,
    homeScreenWidgetsShowMachinePath: true,
    activitySurfaceTapTarget: 'open_session',
    activitySurfacePrivacyMode: 'title_only',
    desktopOverlayEnabled: false,
    desktopOverlayVisibilityMode: 'attention_only',
    desktopOverlayShowWhenRunning: true,
    desktopOverlayShowWhenAttentionRequired: true,
    desktopOverlayShowWhenReady: true,
    desktopOverlayAlwaysOnTop: true,
    desktopOverlayAutoHideEnabled: true,
    desktopOverlayAutoHideDelayMs: 6_000,
    desktopOverlayExpandedBehavior: 'click',
    desktopOverlayInteractiveCollapsed: true,
    desktopOverlayEnableDragReposition: false,
    desktopOverlayLockPosition: true,
    desktopOverlayPlacementMode: 'anchored',
    desktopOverlayAnchor: 'top_center',
    desktopOverlayOffsetX: 0,
    desktopOverlayOffsetY: 0,
    desktopOverlayClickAction: 'expand_overlay',
    desktopOverlayDensity: 'compact',
    desktopOverlayShowSessionCount: true,
    desktopOverlayShowPreviewText: false,
    desktopOverlayCompactStyle: 'pill',
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
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
            },
        });
    },
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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
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
        platformState.os = 'ios';
        tauriDesktopState.value = false;
        applySettingsMock.mockReset();
        applyLocalSettingsMock.mockReset();
        modalPromptMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
        routerPushMock.mockReset();

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

    it('navigates to push notification troubleshooting', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);

        screen.pressRow('settings-notifications-push-troubleshoot');

        expect(routerPushMock).toHaveBeenCalledWith('/settings/notifications/push');
    });

    it('renders the activity-surface section alongside the badge and notification sections', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const groupTitles = [
            'settingsNotifications.activitySurfaces.title',
            'settingsNotifications.activitySurfaces.shared.title',
            'settingsNotifications.activitySurfaces.liveActivities.title',
            'settingsNotifications.activitySurfaces.widgets.title',
            'settingsNotifications.badges.title',
            'settingsNotifications.local.title',
            'settingsNotifications.push.title',
            'settingsNotifications.webhooks.title',
            'settingsNotifications.types.title',
            'settingsNotifications.foregroundBehavior.title',
        ].map((title) => screen.findGroup(title)?.props.title);

        expect(groupTitles).toEqual([
            'settingsNotifications.activitySurfaces.title',
            'settingsNotifications.activitySurfaces.shared.title',
            'settingsNotifications.activitySurfaces.liveActivities.title',
            'settingsNotifications.activitySurfaces.widgets.title',
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

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findByTestId('settings-notifications-screen')).toBeTruthy();
        expect(screen.findRow('settings-notifications-activity-surfaces-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-badges-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-local-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-push-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-add-webhook')).toBeTruthy();
    });

    it('writes the activity surfaces master toggle through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const activitySurfacesItem = requireRow(screen, 'settings-notifications-activity-surfaces-enabled');

        await act(async () => {
            activitySurfacesItem.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ activitySurfacesEnabled: false });
    });

    it('writes the live activities mode through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const liveActivitiesModeItem = requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.liveActivities.focusedTitle');

        await act(async () => {
            liveActivitiesModeItem.props.onPress();
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ liveActivitiesMode: 'focused' });
    });

    it('writes the live activities strategy through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const strategyItem = requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.liveActivities.dynamicPrimaryTitle');

        await act(async () => {
            strategyItem.props.onPress();
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ liveActivitiesStrategy: 'dynamic_primary' });
    });

    it('renders a labeled live activities presentation cluster', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRowByTitle('settingsNotifications.activitySurfaces.liveActivities.presentationTitle')).toBeTruthy();
    });

    it('disables live-activity concurrency controls unless the session-specific strategy is selected', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTitle').props.disabled).toBe(true);
        expect(requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTwoTitle').props.disabled).toBe(true);
    });

    it('enables live-activity concurrency controls for the session-specific strategy', async () => {
        const previousStrategy = localSettingsState.liveActivitiesStrategy;
        localSettingsState.liveActivitiesStrategy = 'session_specific';

        try {
            const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

            const screen = await renderSettingsView(<NotificationsSettingsView />);

            expect(requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTitle').props.disabled).toBe(false);
            expect(requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTwoTitle').props.disabled).toBe(false);
        } finally {
            localSettingsState.liveActivitiesStrategy = previousStrategy;
        }
    });

    it('writes the widget mode through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const widgetsModeItem = requireRowByTitle(screen, 'settingsNotifications.activitySurfaces.widgets.summaryTitle');

        await act(async () => {
            widgetsModeItem.props.onPress();
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ widgetsPresetMode: 'summary' });
    });

    it('does not show the removed frequent-updates toggle', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRowByTitle('settingsNotifications.activitySurfaces.liveActivities.preferMoreFrequentUpdatesTitle')).toBeFalsy();
    });

    it('hides the activity surfaces section on non-iOS non-desktop platforms', async () => {
        platformState.os = 'web';
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRow('settings-notifications-activity-surfaces-enabled')).toBeFalsy();
    });

    it('renders the shared activity-surface controls on Tauri desktop without the iOS-only groups', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.activitySurfaces.title')).toBeTruthy();
        expect(screen.findGroup('settingsNotifications.activitySurfaces.shared.title')).toBeTruthy();
        expect(screen.findRow('settings-notifications-activity-surfaces-enabled')).toBeTruthy();
        expect(screen.findGroup('settingsNotifications.activitySurfaces.liveActivities.title')).toBeFalsy();
        expect(screen.findGroup('settingsNotifications.activitySurfaces.widgets.title')).toBeFalsy();
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

    it('writes remote push settings through the synced account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const pushItem = requireRow(screen, 'settings-notifications-push-enabled');

        await act(async () => {
            pushItem.props.rightElement.props.onValueChange(false);
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

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.types.readyPreview.title');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
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
