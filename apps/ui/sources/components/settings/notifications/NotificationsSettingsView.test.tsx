import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    type NotificationChannelV1,
    type NotificationsSettingsV1,
    type AttentionDeliveryPolicyV1,
} from '@happier-dev/protocol';
import { DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
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
const sendExpoLocalNotificationMock = vi.fn();
const tauriIsPermissionGrantedMock = vi.hoisted(() => vi.fn(async () => true));
const tauriRequestPermissionMock = vi.hoisted(() => vi.fn(async () => 'granted'));
const enabledLegacyNotificationTopics = {
    ready: true,
    permissionRequest: true,
    userActionRequest: true,
    connectedServiceAccountSwitch: true,
    connectedServiceQuotaBlocked: true,
    connectedServiceQuotaRecovered: true,
};
const liveActivityRemoteDiagnosticsState = vi.hoisted(() => ({
    value: {
        modes: {
            hosted_happier_relay: {
                available: false,
                reasons: ['hosted_relay_provider_blocked'],
            },
            direct_apns: {
                available: false,
                reasons: ['direct_apns_not_configured'],
                configurationDiagnostics: ['apns_private_key_missing'],
            },
            background_wake_best_effort: {
                available: false,
                reasons: ['background_wake_disabled'],
            },
        },
        capabilities: {
            perActivityUpdate: {
                id: 'per_activity_update',
                status: 'supported_when_configured',
                events: ['update', 'end'],
                targetKinds: ['activitykit_update_token'],
                availableModes: [],
                reasons: [],
            },
            pushToStart: {
                id: 'push_to_start',
                status: 'future_unsupported',
                events: ['start'],
                targetKinds: ['activitykit_push_to_start_token'],
                availableModes: [],
                reasons: ['not_in_phase_9_5'],
            },
            broadcastChannel: {
                id: 'broadcast_channel',
                status: 'future_unsupported',
                events: [],
                targetKinds: [],
                availableModes: [],
                reasons: ['private_per_session_surface_not_broadcast'],
            },
        },
    },
}));

const settingsState: {
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelV1[];
    attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1;
} = {
    notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        connectedServiceAccountSwitch: true,
        connectedServiceQuotaBlocked: true,
        connectedServiceQuotaRecovered: true,
        foregroundBehavior: 'full',
    },
    notificationChannelsV1: [
        {
            v: 1,
            id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            kind: 'expo_push',
            enabled: true,
            topics: enabledLegacyNotificationTopics,
            readyIncludeMessageText: true,
        },
    ],
    attentionDeliveryPolicyV1: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
};

const localSettingsState = {
    attentionDeviceOverridesV1: DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
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
        return createUnistylesMock();
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

vi.mock('@/activity/notifications/channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification: sendExpoLocalNotificationMock,
}));

vi.mock('@/activity/notifications/channels/tauriNotificationPlugin', () => ({
    isPermissionGranted: tauriIsPermissionGrantedMock,
    requestPermission: tauriRequestPermissionMock,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/hooks/server/useFeatureDetails', () => ({
    useFeatureDetails: () => liveActivityRemoteDiagnosticsState.value,
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
        sendExpoLocalNotificationMock.mockReset();
        sendExpoLocalNotificationMock.mockResolvedValue('preview-notification-id');
        tauriIsPermissionGrantedMock.mockReset();
        tauriRequestPermissionMock.mockReset();
        tauriIsPermissionGrantedMock.mockResolvedValue(true);
        tauriRequestPermissionMock.mockResolvedValue('granted');

        settingsState.notificationsSettingsV1 = {
            v: 1,
            pushEnabled: true,
            ready: true,
            readyIncludeMessageText: true,
            permissionRequest: true,
            userActionRequest: true,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: true,
            connectedServiceQuotaRecovered: true,
            foregroundBehavior: 'full',
        };
        settingsState.notificationChannelsV1 = [
            {
                v: 1,
                id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                kind: 'expo_push',
                enabled: true,
                topics: enabledLegacyNotificationTopics,
                readyIncludeMessageText: true,
            },
        ];
        settingsState.attentionDeliveryPolicyV1 = DEFAULT_ATTENTION_DELIVERY_POLICY_V1;
        localSettingsState.attentionDeviceOverridesV1 = DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1;
        liveActivityRemoteDiagnosticsState.value = {
            modes: {
                hosted_happier_relay: {
                    available: false,
                    reasons: ['hosted_relay_provider_blocked'],
                },
                direct_apns: {
                    available: false,
                    reasons: ['direct_apns_not_configured'],
                    configurationDiagnostics: ['apns_private_key_missing'],
                },
                background_wake_best_effort: {
                    available: false,
                    reasons: ['background_wake_disabled'],
                },
            },
            capabilities: liveActivityRemoteDiagnosticsState.value.capabilities,
        };
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
            'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.title',
            'settingsNotifications.activitySurfaces.widgets.title',
            'settingsNotifications.badges.title',
            'settingsNotifications.local.title',
            'settingsNotifications.sounds.title',
            'settingsNotifications.push.title',
            'settingsNotifications.webhooks.title',
            'settingsNotifications.types.title',
            'settingsNotifications.foregroundBehavior.title',
        ].map((title) => screen.findGroup(title)?.props.title);

        expect(groupTitles).toEqual([
            'settingsNotifications.activitySurfaces.title',
            'settingsNotifications.activitySurfaces.shared.title',
            'settingsNotifications.activitySurfaces.liveActivities.title',
            'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.title',
            'settingsNotifications.activitySurfaces.widgets.title',
            'settingsNotifications.badges.title',
            'settingsNotifications.local.title',
            'settingsNotifications.sounds.title',
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
        expect(screen.findRow('settings-notifications-sounds-account-happier')).toBeTruthy();
        expect(screen.findRow('settings-notifications-sounds-account-system')).toBeTruthy();
        expect(screen.findRow('settings-notifications-sounds-device-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-account-off')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-account-nightly')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-device-account')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-device-disabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-device-custom-nightly')).toBeTruthy();
        expect(screen.findRow('settings-notifications-push-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-add-webhook')).toBeTruthy();
    });

    it('hides desktop notification diagnostics outside the Tauri app', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.desktop.title')).toBeNull();
        expect(screen.findRow('settings-notifications-desktop-permission')).toBeNull();
    });

    it('shows desktop notification diagnostics inside the Tauri app', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
        tauriIsPermissionGrantedMock.mockResolvedValue(false);
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {});

        expect(screen.findGroup('settingsNotifications.desktop.title')).toBeTruthy();
        expect(screen.findRow('settings-notifications-desktop-permission')).toBeTruthy();
    });

    it('requests Tauri notification permission from the desktop diagnostics row', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
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

    it('marks the Happier sound preset selected for the implicit default policy', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(requireRow(screen, 'settings-notifications-sounds-account-happier').props.selected).toBe(true);
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

    it('renders selected-server Live Activity remote update diagnostics without raw credential material', async () => {
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            liveActivityRemoteUpdates: {
                ...settingsState.attentionDeliveryPolicyV1.liveActivityRemoteUpdates,
                preferredMode: 'direct_apns',
                allowBackgroundWakeFallback: true,
            },
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findGroup('settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.title')).toBeTruthy();
        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-direct-apns').props).toMatchObject({
            subtitle: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsMissingCredentialsSubtitle',
        });
        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-direct-apns').props.detail)
            .toContain('apns_private_key_missing');
        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-background-wake').props.detail)
            .toBe('settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.unavailable');
        const renderedDiagnostics = screen.listRows('settings-notifications-live-activity-remote-updates-')
            .map((row) => ({
                testID: row.props.testID,
                title: row.props.title,
                subtitle: row.props.subtitle,
                detail: row.props.detail,
            }));
        expect(JSON.stringify(renderedDiagnostics)).not.toContain('PRIVATE KEY');
        expect(JSON.stringify(renderedDiagnostics)).not.toContain('rawToken');
    });

    it('labels background wake fallback as best effort and local-only as runtime-only', async () => {
        liveActivityRemoteDiagnosticsState.value = {
            ...liveActivityRemoteDiagnosticsState.value,
            modes: {
                hosted_happier_relay: {
                    available: false,
                    reasons: ['hosted_relay_provider_blocked'],
                },
                direct_apns: {
                    available: false,
                    reasons: ['direct_apns_not_configured'],
                    configurationDiagnostics: [],
                },
                background_wake_best_effort: {
                    available: true,
                    reasons: [],
                },
            },
        };
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            liveActivityRemoteUpdates: {
                ...settingsState.attentionDeliveryPolicyV1.liveActivityRemoteUpdates,
                preferredMode: 'background_wake_best_effort',
            },
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-background-wake').props).toMatchObject({
            detail: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.bestEffort',
            subtitle: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.backgroundWakeBestEffortSubtitle',
        });
        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-local-only').props.subtitle)
            .toBe('settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.localOnlyRuntimeSubtitle');
    });

    it('reflects the device Live Activity remote update override in diagnostics', async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            liveActivities: {
                ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1.liveActivities,
                remoteUpdateModeOverride: 'local_only',
            },
        };
        liveActivityRemoteDiagnosticsState.value = {
            ...liveActivityRemoteDiagnosticsState.value,
            modes: {
                hosted_happier_relay: {
                    available: false,
                    reasons: ['hosted_relay_provider_blocked'],
                },
                direct_apns: {
                    available: true,
                    reasons: [],
                    configurationDiagnostics: [],
                },
                background_wake_best_effort: {
                    available: true,
                    reasons: [],
                },
            },
        };
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            liveActivityRemoteUpdates: {
                ...settingsState.attentionDeliveryPolicyV1.liveActivityRemoteUpdates,
                preferredMode: 'direct_apns',
                allowBackgroundWakeFallback: true,
            },
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-effective-mode').props)
            .toMatchObject({
                detail: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.local_only',
                subtitle: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.local_only',
            });
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

        const delta = applyLocalSettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                badge: expect.objectContaining({
                    enabled: false,
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('activityBadgesEnabled');
    });

    it('writes device-local local-notification topic settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const readyItem = requireRowByTitle(screen, 'settingsNotifications.local.readyTitle');

        await act(async () => {
            readyItem.props.rightElement.props.onValueChange(false);
        });

        const delta = applyLocalSettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                localNotifications: expect.objectContaining({
                    events: expect.objectContaining({
                        ready: false,
                    }),
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('localNotificationsShowReady');
    });

    it('writes device-local ready preview settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.local.readyPreviewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        const delta = applyLocalSettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                localNotifications: expect.objectContaining({
                    previewBehavior: 'status_only',
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('localNotificationsShowReadyMessageText');
    });

    it('allows foreground notifications to inherit the account default again', async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            foregroundBehavior: 'silent',
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const accountDefaultItem = requireRow(screen, 'settings-notifications-foreground-account');

        await act(async () => {
            accountDefaultItem.props.onPress();
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                foregroundBehavior: 'account',
            }),
        }));
    });

    it('writes account quiet-hours presets through the canonical policy', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const nightlyItem = requireRow(screen, 'settings-notifications-quiet-hours-account-nightly');

        await act(async () => {
            nightlyItem.props.onPress();
        });

        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                quietHours: {
                    enabled: true,
                    timezone: expect.any(String),
                    windows: [
                        {
                            startLocalTime: '22:00',
                            endLocalTime: '07:00',
                        },
                    ],
                },
            }),
        }));
    });

    it('writes device quiet-hours overrides through canonical local settings', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const disabledItem = requireRow(screen, 'settings-notifications-quiet-hours-device-disabled');

        await act(async () => {
            disabledItem.props.onPress();
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                quietHoursOverride: {
                    mode: 'disabled',
                },
            }),
        }));
    });

    it('writes custom device quiet-hours overrides through canonical local settings', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const customItem = requireRow(screen, 'settings-notifications-quiet-hours-device-custom-nightly');

        await act(async () => {
            customItem.props.onPress();
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                quietHoursOverride: {
                    mode: 'custom',
                    timezone: expect.any(String),
                    windows: [
                        {
                            startLocalTime: '22:00',
                            endLocalTime: '07:00',
                        },
                    ],
                },
            }),
        }));
    });

    it('writes remote push settings through the synced account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const pushItem = requireRow(screen, 'settings-notifications-push-enabled');

        await act(async () => {
            pushItem.props.rightElement.props.onValueChange(false);
        });

        const delta = applySettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    expo_push: expect.objectContaining({
                        enabled: false,
                    }),
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('notificationsSettingsV1');
        expect(delta).not.toHaveProperty('notificationChannelsV1');
    });

    it('backfills remote push state from legacy notification settings when canonical policy is absent', async () => {
        settingsState.notificationsSettingsV1 = {
            ...settingsState.notificationsSettingsV1,
            pushEnabled: false,
        };
        delete (settingsState as Partial<typeof settingsState>).notificationChannelsV1;
        delete (settingsState as Partial<typeof settingsState>).attentionDeliveryPolicyV1;

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const pushItem = requireRow(screen, 'settings-notifications-push-enabled');

        expect(pushItem.props.rightElement.props.value).toBe(false);
    });

    it('writes synced ready preview settings through the account settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.types.readyPreview.title');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        const delta = applySettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    expo_push: expect.objectContaining({
                        previewBehavior: 'status_only',
                    }),
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('notificationsSettingsV1');
        expect(delta).not.toHaveProperty('notificationChannelsV1');
    });

    it('writes account sound defaults through the canonical policy', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const silentItem = requireRowByTitle(screen, 'settingsNotifications.sounds.accountSilentTitle');

        await act(async () => {
            silentItem.props.onPress();
        });

        const delta = applySettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                sounds: expect.objectContaining({
                    defaultSoundId: 'none',
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('notificationsSettingsV1');
    });

    it('keeps native system notification sounds selectable', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const systemItem = requireRow(screen, 'settings-notifications-sounds-account-system');

        await act(async () => {
            systemItem.props.onPress();
        });

        const delta = applySettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                sounds: expect.objectContaining({
                    defaultSoundId: 'default',
                }),
            }),
        }));
        const policy = delta.attentionDeliveryPolicyV1 as { sounds?: { eventSoundIds?: Record<string, unknown> } };
        expect(policy.sounds?.eventSoundIds).not.toHaveProperty('permission_request');
        expect(policy.sounds?.eventSoundIds).not.toHaveProperty('user_action_request');
    });

    it('writes device sound overrides through canonical local settings', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const soundsItem = requireRow(screen, 'settings-notifications-sounds-device-enabled');

        await act(async () => {
            soundsItem.props.rightElement.props.onValueChange(false);
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                sounds: expect.objectContaining({
                    enabled: false,
                }),
            }),
        }));
    });

    it('previews native notification sounds through the local notification sender', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRow(screen, 'settings-notifications-sounds-preview');

        await act(async () => {
            previewItem.props.onPress();
        });

        expect(sendExpoLocalNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
            title: 'settingsNotifications.sounds.previewNotificationTitle',
            body: 'settingsNotifications.sounds.previewNotificationBody',
            sound: 'happier_soft.wav',
        }));
    });

    it('adds a webhook notification channel from the settings screen', async () => {
        modalPromptMock.mockResolvedValue('https://hooks.example.test/notify');

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        await act(async () => {
            screen.pressRow('settings-notifications-add-webhook');
        });

        const delta = applySettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            notificationChannelsV1: [
                expect.objectContaining({
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: true,
                }),
                expect.objectContaining({
                    v: 1,
                    id: 'webhook-hooks-example-test-notify',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: false,
                }),
            ],
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    webhook: expect.objectContaining({
                        enabled: true,
                        events: expect.objectContaining({
                            ready: { enabled: true },
                            permission_request: { enabled: true },
                            user_action_request: { enabled: true },
                        }),
                    }),
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('notificationsSettingsV1');
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
                topics: enabledLegacyNotificationTopics,
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

        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            notificationChannelsV1: [
                expect.objectContaining({
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: true,
                }),
            ],
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    webhook: expect.objectContaining({
                        enabled: false,
                    }),
                }),
            }),
        }));
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
                topics: enabledLegacyNotificationTopics,
                readyIncludeMessageText: false,
            },
        ];
        modalPromptMock.mockResolvedValue('shared-webhook-secret');

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        await act(async () => {
            screen.pressRowByTitle('settingsNotifications.webhooks.signingSecretTitle');
        });

        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            notificationChannelsV1: [
                expect.objectContaining({
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: true,
                }),
                expect.objectContaining({
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: {
                        _isSecretValue: true,
                        value: 'shared-webhook-secret',
                    },
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: false,
                }),
            ],
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    webhook: expect.objectContaining({
                        enabled: true,
                    }),
                }),
            }),
        }));
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
                topics: enabledLegacyNotificationTopics,
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

        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            notificationChannelsV1: [
                expect.objectContaining({
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: true,
                }),
                expect.objectContaining({
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: expect.objectContaining({
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    }),
                    readyIncludeMessageText: false,
                }),
            ],
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    webhook: expect.objectContaining({
                        enabled: true,
                    }),
                }),
            }),
        }));
    });
});
