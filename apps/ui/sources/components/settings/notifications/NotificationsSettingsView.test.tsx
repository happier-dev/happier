import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    type NotificationChannelV1,
    type NotificationsSettingsV1,
    type AttentionDeliveryPolicyV1,
    WebhookNotificationChannelV1Schema,
} from '@happier-dev/protocol';
import { DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web' | 'android',
}));
// Notification rows render no Markdown; the real internal renderer must never call this absent SDK export.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in notifications settings'); },
}));
const tauriDesktopState = vi.hoisted(() => ({
    value: false,
}));
const accountScopeState = vi.hoisted(() => ({ value: { serverId: 'home-studio', accountId: 'account-a' } }));


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsMock = vi.fn();
const applyLocalSettingsMock = vi.fn();
const pushReconcilerMocks = vi.hoisted(() => ({
    schedulePushTokenReconciliation: vi.fn(),
    registerPushTokenIfAvailable: vi.fn(),
}));
const activeHomeState = vi.hoisted(() => ({
    generation: 1,
    snapshot: {
        serverId: 'home-studio',
        serverUrl: 'https://studio-home.example.test',
        generation: 1,
    },
    profiles: {
        'home-studio': { id: 'home-studio', name: 'Studio Home' },
        'home-travel': { id: 'home-travel', name: 'Travel Home' },
    } as Record<string, Readonly<{ id: string; name: string }>>,
}));
const modalPromptMock = vi.fn();
const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();
const routerPushMock = vi.fn();
const translateMock = vi.fn((key: string) => key);
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
const followingFeatureState = vi.hoisted(() => ({ enabled: true }));

const settingsState: {
    sessionRemoteAlertsEnabled: boolean;
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelV1[];
    attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1;
} = {
    sessionRemoteAlertsEnabled: false,
    notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: false,
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
            requestIncludeMessageText: true,
        },
    ],
    attentionDeliveryPolicyV1: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
};

const localSettingsState = {
    deviceRemoteAlertsEnabled: true,
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

/** The row component itself (the outermost element with this test id), with the props it was given. */
function requireRow(screen: NotificationsSettingsScreen, testID: string) {
    const row = screen.findAllByTestId(testID)[0];
    expect(row).toBeTruthy();
    return row!;
}

function requireRowByTitle(screen: NotificationsSettingsScreen, title: string) {
    const row = screen.findRowByTitle(title);
    expect(row).toBeTruthy();
    return row!;
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
        return createTextModuleMock({ translate: translateMock });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => settingsState,
            useLocalSettings: () => localSettingsState,
            useSettingsVersion: () => null,
            useAccountSettingsSyncStatus: () => ({ state: 'idle', lastSyncedAt: null }),
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

// This unrelated Session-envelope HTTP/process API must never run in this settings journey.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session-envelope API call'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('@/activity/notifications/channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification: sendExpoLocalNotificationMock,
}));

vi.mock('@/activity/notifications/channels/tauriNotificationPlugin', () => ({
    isPermissionGranted: tauriIsPermissionGrantedMock,
    requestPermission: tauriRequestPermissionMock,
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useAccountSettingsScope: () => accountScopeState.value,
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/sync/engine/account/syncAccount', () => ({
    schedulePushTokenReconciliation: pushReconcilerMocks.schedulePushTokenReconciliation,
    registerPushTokenIfAvailable: pushReconcilerMocks.registerPushTokenIfAvailable,
}));

vi.mock('@/hooks/server/useFeatureDetails', () => ({
    useFeatureDetails: () => liveActivityRemoteDiagnosticsState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => followingFeatureState.enabled,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeHomeState.snapshot,
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => activeHomeState.generation,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getServerProfileById: (serverId: string) => activeHomeState.profiles[serverId] ?? null,
}));

// The page renders through the real list rows, segmented controls and switches.

/**
 * Choices whose labels are too long for a phone-width segmented control are field selects (R5); pick
 * one through the menu the way a user does.
 */
async function selectFromMenu(screen: { findAll: (predicate: (node: any) => boolean) => any[] }, menuTestID: string, id: string) {
    const menu = screen.findAll((node) => node.props?.testID === menuTestID && typeof node.props?.onSelect === 'function')[0];
    expect(menu).toBeTruthy();
    await act(async () => {
        menu.props.onSelect(id);
    });
}

describe('NotificationsSettingsView', () => {
    beforeEach(() => {
        clearActiveUnsavedChangesGuard();
        accountScopeState.value = { serverId: 'home-studio', accountId: 'account-a' };
        settingsState.sessionRemoteAlertsEnabled = false;
        localSettingsState.deviceRemoteAlertsEnabled = true;
        followingFeatureState.enabled = true;
        activeHomeState.generation = 1;
        activeHomeState.snapshot = {
            serverId: 'home-studio',
            serverUrl: 'https://studio-home.example.test',
            generation: 1,
        };
        platformState.os = 'ios';
        tauriDesktopState.value = false;
        applySettingsMock.mockReset();
        applyLocalSettingsMock.mockReset();
        pushReconcilerMocks.schedulePushTokenReconciliation.mockReset();
        pushReconcilerMocks.registerPushTokenIfAvailable.mockReset();
        modalPromptMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
        routerPushMock.mockReset();
        translateMock.mockClear();
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
            requestIncludeMessageText: false,
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
                requestIncludeMessageText: true,
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

    it('lets an opted-in Account withdraw remote alert consent without changing push or device preferences', async () => {
        settingsState.sessionRemoteAlertsEnabled = true;
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const row = requireRow(screen, 'settings-notifications-remote-account');
        expect(row.props.rightElement.props.value).toBe(true);
        expect(row.props.rightElement.props.disabled).toBe(false);
        await act(async () => { row.props.rightElement.props.onValueChange(false); });
        expect(applySettingsMock).toHaveBeenCalledWith({ sessionRemoteAlertsEnabled: false });
        expect(applyLocalSettingsMock).not.toHaveBeenCalled();
    });

    it('does not expose remote-alert settings while Session Follow is disabled', async () => {
        followingFeatureState.enabled = false;
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findRow('settings-notifications-remote-account')).toBeNull();
        expect(screen.findRow('settings-notifications-remote-device')).toBeNull();
        // The section stays and says why, so a search for its settings lands on an explanation.
        expect(screen.findRow('settings-notifications-remote-unavailable')).toBeTruthy();
    });

    it('names the focused Home for synced push consent', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(translateMock).toHaveBeenCalledWith(
            'settingsNotifications.push.footer',
            { home: 'Studio Home' },
        );
        expect(translateMock).toHaveBeenCalledWith(
            'settingsNotifications.push.enabledSubtitle',
            { home: 'Studio Home' },
        );
        expect(screen.findAllByTestId('settings-notifications-sounds-device-enabled')
            .find((node) => node.props.subtitle !== undefined)?.props.subtitle).toBe(
            'settingsNotifications.sounds.deviceEnabledSubtitle',
        );
    });

    it('orders the notification sections by task', async () => {
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
            'settingsNotifications.quietHours.title',
            'settingsNotifications.push.title',
            'settingsNotifications.webhooks.title',
            'settingsNotifications.types.title',
            'settingsNotifications.foregroundBehavior.title',
        ];
        const renderedOrder = screen.findAll((node) => (
            typeof node.props?.title === 'string'
            && node.props.title.startsWith('settingsNotifications.')
            && groupTitles.includes(node.props.title)
            && node.props.children !== undefined
            && node.props.description !== undefined
        )).map((node) => node.props.title as string).filter((title, index, all) => all.indexOf(title) === index);

        // Sections read in task order: the channel, what it sends, how it sounds, when it is
        // quiet, then this device, glanceable surfaces and extra endpoints.
        expect(renderedOrder).toEqual([
            'settingsNotifications.push.title',
            'settingsNotifications.types.title',
            'settingsNotifications.sounds.title',
            'settingsNotifications.quietHours.title',
            'settingsNotifications.local.title',
            'settingsNotifications.foregroundBehavior.title',
            'settingsNotifications.badges.title',
            'settingsNotifications.activitySurfaces.title',
            'settingsNotifications.activitySurfaces.shared.title',
            'settingsNotifications.activitySurfaces.liveActivities.title',
            'settingsNotifications.activitySurfaces.widgets.title',
            'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.title',
            'settingsNotifications.webhooks.title',
        ]);
    });

    it('exposes stable test ids for the notifications screen and primary controls', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        expect(screen.findByTestId('settings-notifications-screen')).toBeTruthy();
        expect(screen.findRow('settings-notifications-activity-surfaces-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-badges-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-local-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-sounds-account:happier')).toBeTruthy();
        expect(screen.findRow('settings-notifications-sounds-account:system')).toBeTruthy();
        expect(screen.findRow('settings-notifications-sounds-device-enabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-account:off')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-account:nightly')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-device:account')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-device:disabled')).toBeTruthy();
        expect(screen.findRow('settings-notifications-quiet-hours-device:nightly')).toBeTruthy();
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

        expect(requireRow(screen, 'settings-notifications-sounds-account').props.value).toBe('happier');
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
        await selectFromMenu(screen, 'settings-notifications-live-activities-mode', 'focused');

        expect(applyLocalSettingsMock).toHaveBeenCalledWith({ liveActivitiesMode: 'focused' });
    });

    it('writes the live activities strategy through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await selectFromMenu(screen, 'settings-notifications-live-activities-strategy', 'dynamic_primary');

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

        expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent').props.disabled).toBe(true);
        expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent:2').props.disabled).toBe(true);
    });

    it('enables live-activity concurrency controls for the session-specific strategy', async () => {
        const previousStrategy = localSettingsState.liveActivitiesStrategy;
        localSettingsState.liveActivitiesStrategy = 'session_specific';

        try {
            const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

            const screen = await renderSettingsView(<NotificationsSettingsView />);

            expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent').props.disabled).toBe(false);
            expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent:2').props.disabled).toBe(false);
        } finally {
            localSettingsState.liveActivitiesStrategy = previousStrategy;
        }
    });

    it('writes the widget mode through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await selectFromMenu(screen, 'settings-notifications-widgets-mode', 'summary');

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

    it('writes device-local request preview settings through the local settings writer', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.local.requestPreviewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        const delta = applyLocalSettingsMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                localNotifications: expect.objectContaining({
                    requestPreviewBehavior: 'status_only',
                }),
            }),
        }));
        expect(delta).not.toHaveProperty('localNotificationsShowRequestMessageText');
    });

    it('allows foreground notifications to inherit the account default again', async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            foregroundBehavior: 'silent',
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {
            screen.pressRow('settings-notifications-foreground:account');
        });

        expect(applyLocalSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                foregroundBehavior: 'account',
            }),
        }));
    });

    it("shows the foreground choices that need this device's notifications as unavailable while they are off", async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            localNotifications: {
                ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1.localNotifications,
                enabled: false,
            },
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        // Following the Account stays available; the choices this device cannot apply say so.
        expect(screen.findByTestId('settings-notifications-foreground:account')?.props.accessibilityState?.disabled).toBe(false);
        for (const id of ['full', 'silent', 'off']) {
            expect(screen.findByTestId(`settings-notifications-foreground:${id}`)?.props.accessibilityState?.disabled).toBe(true);
        }
    });

    it('writes account quiet-hours presets through the canonical policy', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {
            screen.pressRow('settings-notifications-quiet-hours-account:nightly');
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

    it('shows a quiet-hours schedule the presets do not describe without selecting a preset', async () => {
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            quietHours: {
                enabled: true,
                timezone: 'UTC',
                windows: [{ startLocalTime: '12:00', endLocalTime: '13:00' }],
            },
        };
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const accountSchedule = requireRow(screen, 'settings-notifications-quiet-hours-account');

        expect(accountSchedule.props.value).toBe('custom');
        expect(requireRow(screen, 'settings-notifications-quiet-hours-account:nightly').props.accessibilityState).toMatchObject({ selected: false });
        expect(requireRow(screen, 'settings-notifications-quiet-hours-account:off').props.accessibilityState).toMatchObject({ selected: false });
        expect(accountSchedule.props.subtitle).toBe('settingsNotifications.quietHours.customSubtitle');
    });

    it('writes device quiet-hours overrides through canonical local settings', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {
            screen.pressRow('settings-notifications-quiet-hours-device:disabled');
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
        await act(async () => {
            screen.pressRow('settings-notifications-quiet-hours-device:nightly');
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

    it('defaults focus muting off and writes only the canonical policy without changing other choices', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const row = requireRow(screen, 'settings-notifications-mute-phone-focused-computer');
        expect(row.props.rightElement.props.value).toBe(false);
        await act(async () => row.props.rightElement.props.onValueChange(true));
        expect(applySettingsMock).toHaveBeenCalledWith({ attentionDeliveryPolicyV1: {
            ...settingsState.attentionDeliveryPolicyV1, mutePhoneWhenComputerFocused: true,
        } });
        expect(applyLocalSettingsMock).not.toHaveBeenCalled();
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

    it('schedules device reconciliation after the durable settings write and never registers directly', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const pushItem = requireRow(screen, 'settings-notifications-push-enabled');

        await act(async () => {
            pushItem.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalled();
        expect(pushReconcilerMocks.schedulePushTokenReconciliation).toHaveBeenCalledTimes(1);
        expect(pushReconcilerMocks.registerPushTokenIfAvailable).not.toHaveBeenCalled();
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

    it('writes request preview opt-out through the canonical event policy', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.types.requestPreview.title');
        expect(previewItem.props.rightElement.props.value).toBe(true);
        await act(async () => { previewItem.props.rightElement.props.onValueChange(false); });
        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({ channels: expect.objectContaining({
                expo_push: expect.objectContaining({ events: expect.objectContaining({
                    permission_request: expect.objectContaining({ enabled: true, previewBehavior: 'status_only' }),
                    user_action_request: expect.objectContaining({ enabled: true, previewBehavior: 'status_only' }),
                }) }),
            }) }),
        }));
        expect(applySettingsMock.mock.calls[0]?.[0]).not.toHaveProperty('notificationsSettingsV1');
    });

    it('edits the canonical global Follow update event without creating per-reason settings', async () => {
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        const followUpdatesItem = requireRow(screen, 'settings-notifications-type-follow-update');

        expect(followUpdatesItem.props.rightElement.props.value).toBe(true);
        await act(async () => {
            followUpdatesItem.props.rightElement.props.onValueChange(false);
        });

        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                events: expect.objectContaining({ follow_update: expect.objectContaining({ enabled: false }) }),
                channels: expect.objectContaining({
                    expo_push: expect.objectContaining({
                        events: expect.objectContaining({ follow_update: expect.objectContaining({ enabled: false }) }),
                    }),
                }),
            }),
        }));
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
        await act(async () => {
            screen.pressRow('settings-notifications-sounds-account:silent');
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
        await act(async () => {
            screen.pressRow('settings-notifications-sounds-account:system');
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

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        await act(async () => {
            screen.pressRow('settings-notifications-add-webhook');
        });

        expect(applySettingsMock).not.toHaveBeenCalled();
        act(() => screen.changeTextByTestId('settings-notifications-webhook-new-url', 'ftp://hooks.example.test/notify'));
        act(() => screen.pressRow('settings-notifications-webhook-new-url-save'));
        expect(applySettingsMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-notifications-webhook-new-url.error')).toBeTruthy();
        act(() => screen.pressRow('settings-notifications-webhook-new-url-cancel'));
        expect(screen.findByTestId('settings-notifications-webhook-new-url')).toBeNull();
        expect(applySettingsMock).not.toHaveBeenCalled();
        act(() => screen.pressRow('settings-notifications-add-webhook'));
        act(() => screen.changeTextByTestId('settings-notifications-webhook-new-url', ' https://hooks.example.test/notify '));
        act(() => screen.pressRow('settings-notifications-webhook-new-url-save'));

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
                    requestIncludeMessageText: true,
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
                    requestIncludeMessageText: true,
                }),
            ],
            attentionDeliveryPolicyV1: expect.objectContaining({
                channels: expect.objectContaining({
                    webhook: expect.objectContaining({
                        enabled: true,
                        events: expect.objectContaining({
                            ready: { enabled: true },
                            permission_request: { enabled: true, previewBehavior: 'include_preview' },
                            user_action_request: { enabled: true, previewBehavior: 'include_preview' },
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
                requestIncludeMessageText: false,
            },
        ];
        modalConfirmMock.mockResolvedValue(true);

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        // A webhook's settings open in place from its row.
        expect(screen.findRow('settings-notifications-webhook-webhook-primary-delete')).toBeNull();
        await act(async () => {
            screen.pressRow('settings-notifications-webhook-webhook-primary');
        });
        await act(async () => {
            await requireRow(screen, 'settings-notifications-webhook-webhook-primary-delete').props.onPress();
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
                    requestIncludeMessageText: true,
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

    it('edits a webhook URL inline without replacing its id or topics', async () => {
        const channel = WebhookNotificationChannelV1Schema.parse({
            v: 1, id: 'webhook-primary', kind: 'webhook', enabled: true,
            url: 'https://hooks.example.test/notify', signingSecret: null,
            topics: enabledLegacyNotificationTopics,
            readyIncludeMessageText: false, requestIncludeMessageText: false,
        });
        settingsState.notificationChannelsV1 = [...settingsState.notificationChannelsV1, channel];
        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
        const screen = await renderSettingsView(<NotificationsSettingsView />);
        act(() => screen.pressRow('settings-notifications-webhook-webhook-primary'));
        act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-edit'));
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-url')!.props.value).toBe(channel.url);
        act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-url', 'https://replacement.example.test/hook'));
        expect(applySettingsMock).not.toHaveBeenCalled();
        act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-url-save'));
        expect(applySettingsMock).toHaveBeenCalledWith(expect.objectContaining({
            notificationChannelsV1: expect.arrayContaining([{ ...channel, url: 'https://replacement.example.test/hook' }]),
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
                requestIncludeMessageText: false,
            },
        ];

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);

        await act(async () => {
            screen.pressRow('settings-notifications-webhook-webhook-primary');
        });
        await act(async () => {
            await requireRow(screen, 'settings-notifications-webhook-webhook-primary-set-secret').props.onPress();
        });
        expect(applySettingsMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')!.props.secureTextEntry).toBe(true);
        act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-secret-input', ' shared-webhook-secret '));
        act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-secret-save'));
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')).toBeNull();

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
                    requestIncludeMessageText: true,
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
                    requestIncludeMessageText: false,
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

    it('retires webhook signing drafts on Account changes and explicit cancellation', async () => {
        const channel = WebhookNotificationChannelV1Schema.parse({
            v: 1, id: 'webhook-primary', kind: 'webhook', enabled: true,
            url: 'https://hooks.example.test/notify', signingSecret: null,
            topics: enabledLegacyNotificationTopics,
            readyIncludeMessageText: false, requestIncludeMessageText: false,
        });
        const { NotificationWebhooksSection } = await import('./NotificationWebhooksSection');
        const save = vi.fn();
        // Updating the real section's public props exercises its lifecycle without relying on
        // the page's memoization or a mocked settings subscription to deliver an Account change.
        const element = (channels: typeof channel[]) => <NotificationWebhooksSection webhookChannels={channels} setWebhookChannels={save} />;
        const screen = await renderSettingsView(element([channel]));
        const openSecret = () => {
            act(() => screen.pressRow('settings-notifications-webhook-webhook-primary'));
            act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-set-secret'));
        };
        openSecret();
        act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-secret-input', 'discard-on-account-change'));
        accountScopeState.value = { serverId: 'home-studio', accountId: 'account-b' };
        await screen.update(element([channel]));
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')).toBeNull();
        openSecret();
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')!.props.value).toBe('');
        act(() => screen.changeTextByTestId('settings-notifications-webhook-webhook-primary-secret-input', 'discard-on-cancel'));
        act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-secret-cancel'));
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')).toBeNull();
        act(() => screen.pressRow('settings-notifications-webhook-webhook-primary-set-secret'));
        expect(screen.findByTestId('settings-notifications-webhook-webhook-primary-secret-input')!.props.value).toBe('');
        expect(save).not.toHaveBeenCalled();
    });

    it('clears a configured webhook signing secret from the settings screen', async () => {
        modalConfirmMock.mockResolvedValueOnce(true);
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
                requestIncludeMessageText: false,
            },
        ];

        const { NotificationsSettingsView } = await import('./NotificationsSettingsView');

        const screen = await renderSettingsView(<NotificationsSettingsView />);
        await act(async () => {
            screen.pressRow('settings-notifications-webhook-webhook-primary');
        });
        await act(async () => {
            await requireRow(screen, 'settings-notifications-webhook-webhook-primary-clear-secret').props.onPress();
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
                    requestIncludeMessageText: true,
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
                    requestIncludeMessageText: false,
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
