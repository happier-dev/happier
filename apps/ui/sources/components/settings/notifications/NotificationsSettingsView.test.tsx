import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { prepareLegacyNotificationChannelCatalogV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { loadNotificationsSettingsActionExecutorForTests, restoreNotificationsSettingsCatalog } from './notificationsSettingsCatalogTestHarness';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { LiveActivityRemoteUpdateCapabilityDiagnostics } from '@happier-dev/protocol/activity/live/remoteUpdateCapabilities';

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
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const modalPromptMock = vi.fn();
const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();
const routerPushMock = vi.fn();
const translateMock = vi.fn((key: string) => key);
const scheduleExpoNotificationMock = vi.hoisted(() => vi.fn());
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
const liveActivityRemoteDiagnosticsState = vi.hoisted((): { value: LiveActivityRemoteUpdateCapabilityDiagnostics } => ({
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
    experiments: boolean;
    featureToggles: Record<string, boolean>;
    sessionRemoteAlertsEnabled: boolean;
    notificationsSettingsV1: NotificationsSettingsV1;
    notificationChannelsV1: NotificationChannelV1[];
    attentionDeliveryPolicyV1: AttentionDeliveryPolicyV1;
} = {
    experiments: false,
    featureToggles: {},
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

installDisconnectedServerSocketBoundary();
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
    storage: 'real',
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

vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('expo-notifications', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    scheduleNotificationAsync: scheduleExpoNotificationMock,
}));

vi.mock('@/activity/notifications/channels/tauriNotificationPlugin', () => ({
    isPermissionGranted: tauriIsPermissionGrantedMock,
    requestPermission: tauriRequestPermissionMock,
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


let storage: typeof import('@/sync/domains/state/storage').storage;
let disposeActionBridge: (() => void) | undefined;
let fixture: Awaited<ReturnType<typeof restoreNotificationsSettingsCatalog>> | undefined;
let rawBeforeControl: Readonly<Record<string, unknown>> = {};
let localBeforeControl: ReturnType<typeof storage.getState>['localSettings'];
let disposeScreen: (() => Promise<void>) | undefined;
let declaredSettingActionsDisabled = false;
const defaultLocalSettings = structuredClone(localSettingsState);
beforeAll(async () => {
    storage = (await import('@/sync/domains/state/storage')).storage;
    await loadSyncSingletonForTests();
    disposeActionBridge = (await loadNotificationsSettingsActionExecutorForTests()).dispose;
});
afterAll(() => { disposeActionBridge?.(); });
afterEach(async () => {
    await disposeScreen?.();
    disposeScreen = undefined;
    await fixture?.dispose();
    fixture = undefined;
    storage.getState().clearSettingsScope();
    storage.getState().clearProfileScope();
});
async function openNotificationsScreen() {
    const source = prepareLegacyNotificationChannelCatalogV1({
        accountId: 'notification-adjacent', raw: settingsState, settingsSecretsReadKeys: [],
    });
    if (source.status !== 'ready') throw new Error('Expected the genuine unsigned predecessor source');
    fixture = await restoreNotificationsSettingsCatalog({
        accountId: 'notification-adjacent', serverUrl: 'https://notification-adjacent.example.test', homeName: 'Studio Home',
        rawSettings: { ...settingsState, ...(declaredSettingActionsDisabled ? { actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } } : {}) }, localSettings: localSettingsState,
        catalog: { status: 'present', record: source.record },
        features: createRootLayoutFeaturesResponse({
            features: { sessions: { following: { enabled: followingFeatureState.enabled } } },
            capabilities: { liveActivities: { remoteUpdates: liveActivityRemoteDiagnosticsState.value } },
        }),
    });
    const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
    const screen = await renderSettingsView(<NotificationsSettingsView />);
    disposeScreen = screen.unmount;
    const { refreshNotificationChannelCatalog } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
    await act(async () => { await refreshNotificationChannelCatalog(fixture!.scope); });
    rawBeforeControl = structuredClone(fixture.readRaw());
    localBeforeControl = structuredClone(storage.getState().localSettings);
    return screen;
}

describe('NotificationsSettingsView', () => {
    beforeEach(() => {
        declaredSettingActionsDisabled = false;
        clearActiveUnsavedChangesGuard();
        Object.assign(localSettingsState, structuredClone(defaultLocalSettings));
        settingsState.experiments = false;
        settingsState.featureToggles = {};
        settingsState.sessionRemoteAlertsEnabled = false;
        localSettingsState.deviceRemoteAlertsEnabled = true;
        followingFeatureState.enabled = true;
        platformState.os = 'ios';
        tauriDesktopState.value = false;
        modalPromptMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
        routerPushMock.mockReset();
        translateMock.mockClear();
        scheduleExpoNotificationMock.mockReset();
        scheduleExpoNotificationMock.mockResolvedValue('preview-notification-id');
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

    it.each(['account', 'local'] as const)('honors disabled settings Actions for the %s notification switch', async (owner) => {
        declaredSettingActionsDisabled = true;
        const screen = await openNotificationsScreen();
        const row = requireRow(screen, owner === 'account'
            ? 'settings-notifications-mute-phone-focused-computer' : 'settings-notifications-local-enabled');
        await act(async () => row.props.rightElement.props.onValueChange(owner === 'account'));
        expect(storage.getState().settings.attentionDeliveryPolicyV1).toEqual(rawBeforeControl.attentionDeliveryPolicyV1);
        expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual(localBeforeControl.attentionDeviceOverridesV1);
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(expect.any(String), 'action_disabled'));
        expect(fixture!.settingsWrites).toEqual([]);
    });

    it('navigates to push notification troubleshooting', async () => {
        const screen = await openNotificationsScreen();

        screen.pressRow('settings-notifications-push-troubleshoot');

        expect(routerPushMock).toHaveBeenCalledWith('/settings/notifications/push');
    });

    it('lets an opted-in Account withdraw remote alert consent without changing push or device preferences', async () => {
        settingsState.sessionRemoteAlertsEnabled = true;
        const screen = await openNotificationsScreen();
        const row = requireRow(screen, 'settings-notifications-remote-account');
        expect(row.props.rightElement.props.value).toBe(true);
        expect(row.props.rightElement.props.disabled).toBe(false);
        await act(async () => { row.props.rightElement.props.onValueChange(false); });
        expect(storage.getState().settings).toMatchObject({ sessionRemoteAlertsEnabled: false });
        expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual(localSettingsState.attentionDeviceOverridesV1);
    });

    it('does not expose remote-alert settings while Session Follow is disabled', async () => {
        followingFeatureState.enabled = false;
        const screen = await openNotificationsScreen();

        expect(screen.findRow('settings-notifications-remote-account')).toBeNull();
        expect(screen.findRow('settings-notifications-remote-device')).toBeNull();
        // The section stays and says why, so a search for its settings lands on an explanation.
        expect(screen.findRow('settings-notifications-remote-unavailable')).toBeTruthy();
    });

    it('names the focused Home for synced push consent', async () => {
        const screen = await openNotificationsScreen();

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

        const screen = await openNotificationsScreen();
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

        const screen = await openNotificationsScreen();

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

        const screen = await openNotificationsScreen();

        expect(screen.findGroup('settingsNotifications.desktop.title')).toBeNull();
        expect(screen.findRow('settings-notifications-desktop-permission')).toBeNull();
    });

    it('shows desktop notification diagnostics inside the Tauri app', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
        tauriIsPermissionGrantedMock.mockResolvedValue(false);

        const screen = await openNotificationsScreen();
        await act(async () => {});

        expect(screen.findGroup('settingsNotifications.desktop.title')).toBeTruthy();
        expect(screen.findRow('settings-notifications-desktop-permission')).toBeTruthy();
    });

    it('requests Tauri notification permission from the desktop diagnostics row', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
        tauriIsPermissionGrantedMock.mockResolvedValue(false);
        tauriRequestPermissionMock.mockResolvedValue('granted');

        const screen = await openNotificationsScreen();
        await act(async () => {});

        await act(async () => {
            screen.pressRow('settings-notifications-desktop-permission');
        });

        expect(tauriRequestPermissionMock).toHaveBeenCalledTimes(1);
    });

    it('marks the Happier sound preset selected for the implicit default policy', async () => {

        const screen = await openNotificationsScreen();

        expect(requireRow(screen, 'settings-notifications-sounds-account').props.value).toBe('happier');
    });

    it('writes the activity surfaces master toggle through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        const activitySurfacesItem = requireRow(screen, 'settings-notifications-activity-surfaces-enabled');

        await act(async () => {
            activitySurfacesItem.props.rightElement.props.onValueChange(false);
        });

        expect(storage.getState().localSettings).toMatchObject({ activitySurfacesEnabled: false });
    });

    it('writes the live activities mode through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        await selectFromMenu(screen, 'settings-notifications-live-activities-mode', 'focused');

        expect(storage.getState().localSettings).toMatchObject({ liveActivitiesMode: 'focused' });
    });

    it('writes the live activities strategy through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        await selectFromMenu(screen, 'settings-notifications-live-activities-strategy', 'dynamic_primary');

        expect(storage.getState().localSettings).toMatchObject({ liveActivitiesStrategy: 'dynamic_primary' });
    });

    it('renders a labeled live activities presentation cluster', async () => {

        const screen = await openNotificationsScreen();

        expect(screen.findRowByTitle('settingsNotifications.activitySurfaces.liveActivities.presentationTitle')).toBeTruthy();
    });

    it('disables live-activity concurrency controls unless the session-specific strategy is selected', async () => {

        const screen = await openNotificationsScreen();

        expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent').props.disabled).toBe(true);
        expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent:2').props.disabled).toBe(true);
    });

    it('enables live-activity concurrency controls for the session-specific strategy', async () => {
        const previousStrategy = localSettingsState.liveActivitiesStrategy;
        localSettingsState.liveActivitiesStrategy = 'session_specific';

        try {

            const screen = await openNotificationsScreen();

            expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent').props.disabled).toBe(false);
            expect(requireRow(screen, 'settings-notifications-live-activities-max-concurrent:2').props.disabled).toBe(false);
        } finally {
            localSettingsState.liveActivitiesStrategy = previousStrategy;
        }
    });

    it('writes the widget mode through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        await selectFromMenu(screen, 'settings-notifications-widgets-mode', 'summary');

        expect(storage.getState().localSettings).toMatchObject({ widgetsPresetMode: 'summary' });
    });

    it('does not show the removed frequent-updates toggle', async () => {

        const screen = await openNotificationsScreen();

        expect(screen.findRowByTitle('settingsNotifications.activitySurfaces.liveActivities.preferMoreFrequentUpdatesTitle')).toBeFalsy();
    });

    it('renders selected-server Live Activity remote update diagnostics without raw credential material', async () => {
        settingsState.experiments = true;
        settingsState.featureToggles = { 'app.ui.liveActivities': true };
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            liveActivityRemoteUpdates: {
                ...settingsState.attentionDeliveryPolicyV1.liveActivityRemoteUpdates,
                preferredMode: 'direct_apns',
                allowBackgroundWakeFallback: true,
            },
        };

        const screen = await openNotificationsScreen();

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
        settingsState.experiments = true;
        settingsState.featureToggles = { 'app.ui.liveActivities': true };
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
                enabled: true,
            },
        };

        const screen = await openNotificationsScreen();

        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-background-wake').props).toMatchObject({
            detail: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.bestEffort',
            subtitle: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.backgroundWakeBestEffortSubtitle',
        });
        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-local-only').props.subtitle)
            .toBe('settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.localOnlyRuntimeSubtitle');
    });

    it('reflects the device Live Activity remote update override in diagnostics', async () => {
        settingsState.experiments = true;
        settingsState.featureToggles = { 'app.ui.liveActivities': true };
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

        const screen = await openNotificationsScreen();

        expect(requireRow(screen, 'settings-notifications-live-activity-remote-updates-effective-mode').props)
            .toMatchObject({
                detail: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.local_only',
                subtitle: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.local_only',
            });
    });

    it('hides the activity surfaces section on non-iOS non-desktop platforms', async () => {
        platformState.os = 'web';

        const screen = await openNotificationsScreen();

        expect(screen.findRow('settings-notifications-activity-surfaces-enabled')).toBeFalsy();
    });

    it('renders the shared activity-surface controls on Tauri desktop without the iOS-only groups', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;

        const screen = await openNotificationsScreen();

        expect(screen.findGroup('settingsNotifications.activitySurfaces.title')).toBeTruthy();
        expect(screen.findGroup('settingsNotifications.activitySurfaces.shared.title')).toBeTruthy();
        expect(screen.findRow('settings-notifications-activity-surfaces-enabled')).toBeTruthy();
        expect(screen.findGroup('settingsNotifications.activitySurfaces.liveActivities.title')).toBeFalsy();
        expect(screen.findGroup('settingsNotifications.activitySurfaces.widgets.title')).toBeFalsy();
    });

    it('writes device-local badge settings through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        const badgeItem = requireRow(screen, 'settings-notifications-badges-enabled');

        await act(async () => {
            badgeItem.props.rightElement.props.onValueChange(false);
        });

        const delta = storage.getState().localSettings;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                badge: expect.objectContaining({
                    enabled: false,
                }),
            }),
        }));
        expect(delta.activityBadgesEnabled).toBe(localBeforeControl.activityBadgesEnabled);
        expect(delta.localNotificationsEnabled).toBe(localBeforeControl.localNotificationsEnabled);
    });

    it('writes device-local local-notification topic settings through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        const readyItem = requireRowByTitle(screen, 'settingsNotifications.local.readyTitle');

        await act(async () => {
            readyItem.props.rightElement.props.onValueChange(false);
        });

        const delta = storage.getState().localSettings;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                localNotifications: expect.objectContaining({
                    events: expect.objectContaining({
                        ready: false,
                    }),
                }),
            }),
        }));
        expect(delta.localNotificationsShowReady).toBe(localBeforeControl.localNotificationsShowReady);
        expect(delta.activityBadgesEnabled).toBe(localBeforeControl.activityBadgesEnabled);
    });

    it('writes device-local ready preview settings through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.local.readyPreviewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        const delta = storage.getState().localSettings;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                localNotifications: expect.objectContaining({
                    previewBehavior: 'status_only',
                }),
            }),
        }));
        expect(delta.localNotificationsShowReadyMessageText).toBe(localBeforeControl.localNotificationsShowReadyMessageText);
        expect(delta.localNotificationsShowPendingPermissionRequests).toBe(localBeforeControl.localNotificationsShowPendingPermissionRequests);
    });

    it('writes device-local request preview settings through the local settings writer', async () => {

        const screen = await openNotificationsScreen();
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.local.requestPreviewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onValueChange(false);
        });

        const delta = storage.getState().localSettings;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                localNotifications: expect.objectContaining({
                    requestPreviewBehavior: 'status_only',
                }),
            }),
        }));
        expect(Object.hasOwn(delta, 'localNotificationsShowRequestMessageText'))
            .toBe(Object.hasOwn(localBeforeControl, 'localNotificationsShowRequestMessageText'));
        expect(Reflect.get(delta, 'localNotificationsShowRequestMessageText'))
            .toBe(Reflect.get(localBeforeControl, 'localNotificationsShowRequestMessageText'));
        expect(delta.localNotificationsShowReadyMessageText).toBe(localBeforeControl.localNotificationsShowReadyMessageText);
    });

    it('allows foreground notifications to inherit the account default again', async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            foregroundBehavior: 'silent',
        };

        const screen = await openNotificationsScreen();
        await act(async () => {
            screen.pressRow('settings-notifications-foreground:account');
        });

        expect(storage.getState().localSettings).toMatchObject(expect.objectContaining({
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

        const screen = await openNotificationsScreen();

        // Following the Account stays available; the choices this device cannot apply say so.
        expect(screen.findByTestId('settings-notifications-foreground:account')?.props.accessibilityState?.disabled).toBe(false);
        for (const id of ['full', 'silent', 'off']) {
            expect(screen.findByTestId(`settings-notifications-foreground:${id}`)?.props.accessibilityState?.disabled).toBe(true);
        }
    });

    it.each([
        ['account', 'off'], ['account', 'nightly'],
        ['device', 'account'], ['device', 'disabled'], ['device', 'nightly'],
    ] as const)('honors disabled settings Actions for quiet-hours %s/%s', async (owner, choice) => {
        declaredSettingActionsDisabled = true;
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            quietHours: { ...settingsState.attentionDeliveryPolicyV1.quietHours, enabled: choice === 'off' },
        };
        localSettingsState.attentionDeviceOverridesV1 = {
            ...localSettingsState.attentionDeviceOverridesV1,
            quietHoursOverride: { mode: choice === 'account' ? 'disabled' : 'account' },
        };
        const screen = await openNotificationsScreen();
        await act(async () => screen.pressRow(`settings-notifications-quiet-hours-${owner}:${choice}`));
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(expect.any(String), 'action_disabled'));
        expect(storage.getState().settings.attentionDeliveryPolicyV1).toEqual(rawBeforeControl.attentionDeliveryPolicyV1);
        expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual(localBeforeControl.attentionDeviceOverridesV1);
        expect(fixture!.readRaw().attentionDeliveryPolicyV1).toEqual(rawBeforeControl.attentionDeliveryPolicyV1);
        // Catalog restoration can retire predecessor fields; no request may change the denied policy.
        for (const write of fixture!.settingsWrites) {
            const content = AccountSettingsV2UpdateRequestSchema.parse(write).content;
            expect(content?.t).toBe('plain');
            if (content?.t === 'plain') expect(content.v.attentionDeliveryPolicyV1).toEqual(rawBeforeControl.attentionDeliveryPolicyV1);
        }
    });

    it.each(['off', 'nightly'] as const)('writes account quiet-hours %s through the canonical policy', async (choice) => {
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            quietHours: {
                enabled: choice === 'off',
                timezone: 'Europe/Amsterdam',
                windows: [{ startLocalTime: '12:00', endLocalTime: '13:00' }],
            },
        };
        const screen = await openNotificationsScreen();
        const expectedPolicy = {
            ...storage.getState().settings.attentionDeliveryPolicyV1,
            quietHours: {
                enabled: choice === 'nightly',
                timezone: 'Europe/Amsterdam',
                windows: choice === 'nightly' ? [{ startLocalTime: '22:00', endLocalTime: '07:00' }] : [],
            },
        };
        await act(async () => {
            screen.pressRow(`settings-notifications-quiet-hours-account:${choice}`);
        });
        await vi.waitFor(() => expect(fixture!.readRaw().attentionDeliveryPolicyV1).toEqual(expectedPolicy));
        expect(storage.getState().settings.attentionDeliveryPolicyV1).toEqual(expectedPolicy);
        expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual(localBeforeControl.attentionDeviceOverridesV1);
        expect(modalAlertMock).not.toHaveBeenCalled();
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

        const screen = await openNotificationsScreen();
        const accountSchedule = requireRow(screen, 'settings-notifications-quiet-hours-account');

        expect(accountSchedule.props.value).toBe('custom');
        expect(requireRow(screen, 'settings-notifications-quiet-hours-account:nightly').props.accessibilityState).toMatchObject({ checked: false });
        expect(requireRow(screen, 'settings-notifications-quiet-hours-account:off').props.accessibilityState).toMatchObject({ checked: false });
        expect(accountSchedule.props.subtitle).toBe('settingsNotifications.quietHours.customSubtitle');
    });

    it.each(['account', 'disabled'] as const)('writes device quiet-hours %s through canonical local settings', async (choice) => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...localSettingsState.attentionDeviceOverridesV1,
            quietHoursOverride: { mode: choice === 'account' ? 'disabled' : 'account' },
        };
        const screen = await openNotificationsScreen();
        await act(async () => {
            screen.pressRow(`settings-notifications-quiet-hours-device:${choice}`);
        });
        await vi.waitFor(() => expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual({
            ...localBeforeControl.attentionDeviceOverridesV1,
            quietHoursOverride: { mode: choice },
        }));
        expect(fixture!.readRaw()).toEqual(rawBeforeControl);
        expect(modalAlertMock).not.toHaveBeenCalled();
    });

    it('writes custom device quiet-hours overrides through canonical local settings', async () => {

        const screen = await openNotificationsScreen();
        await act(async () => {
            screen.pressRow('settings-notifications-quiet-hours-device:nightly');
        });

        await vi.waitFor(() => expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual({
            ...localBeforeControl.attentionDeviceOverridesV1,
            quietHoursOverride: {
                mode: 'custom',
                timezone: expect.any(String),
                windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }],
            },
        }));
        expect(fixture!.readRaw()).toEqual(rawBeforeControl);
        expect(modalAlertMock).not.toHaveBeenCalled();
    });

    it('defaults focus muting off and writes only the canonical policy without changing other choices', async () => {
        const screen = await openNotificationsScreen();
        const row = requireRow(screen, 'settings-notifications-mute-phone-focused-computer');
        expect(row.props.rightElement.props.value).toBe(false);
        await act(async () => row.props.rightElement.props.onValueChange(true));
        expect(storage.getState().settings).toMatchObject({ attentionDeliveryPolicyV1: {
            ...settingsState.attentionDeliveryPolicyV1, mutePhoneWhenComputerFocused: true,
        } });
        expect(storage.getState().localSettings.attentionDeviceOverridesV1).toEqual(localSettingsState.attentionDeviceOverridesV1);
    });



    it('backfills remote push state from legacy notification settings when canonical policy is absent', async () => {
        settingsState.notificationsSettingsV1 = {
            ...settingsState.notificationsSettingsV1,
            pushEnabled: false,
        };
        delete (settingsState as Partial<typeof settingsState>).notificationChannelsV1;
        delete (settingsState as Partial<typeof settingsState>).attentionDeliveryPolicyV1;


        const screen = await openNotificationsScreen();
        const pushItem = requireRow(screen, 'settings-notifications-push-enabled');

        expect(pushItem.props.rightElement.props.value).toBe(false);
    });


    it('edits the canonical global Follow update event without creating per-reason settings', async () => {
        const screen = await openNotificationsScreen();
        const followUpdatesItem = requireRow(screen, 'settings-notifications-type-follow-update');

        expect(followUpdatesItem.props.rightElement.props.value).toBe(true);
        await act(async () => {
            followUpdatesItem.props.rightElement.props.onValueChange(false);
        });

        expect(storage.getState().settings).toMatchObject(expect.objectContaining({
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


    it('writes account sound defaults through the canonical policy', async () => {

        const screen = await openNotificationsScreen();
        await act(async () => {
            screen.pressRow('settings-notifications-sounds-account:silent');
        });

        const delta = storage.getState().settings;
        expect(delta).toEqual(expect.objectContaining({
            attentionDeliveryPolicyV1: expect.objectContaining({
                sounds: expect.objectContaining({
                    defaultSoundId: 'none',
                }),
            }),
        }));
        expect(fixture!.readRaw().notificationsSettingsV1).toEqual(rawBeforeControl.notificationsSettingsV1);
    });

    it('keeps native system notification sounds selectable', async () => {

        const screen = await openNotificationsScreen();
        await act(async () => {
            screen.pressRow('settings-notifications-sounds-account:system');
        });

        const delta = storage.getState().settings;
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

        const screen = await openNotificationsScreen();
        const soundsItem = requireRow(screen, 'settings-notifications-sounds-device-enabled');

        await act(async () => {
            soundsItem.props.rightElement.props.onValueChange(false);
        });

        expect(storage.getState().localSettings).toMatchObject(expect.objectContaining({
            attentionDeviceOverridesV1: expect.objectContaining({
                sounds: expect.objectContaining({
                    enabled: false,
                }),
            }),
        }));
    });

    it('previews native notification sounds through the local notification sender', async () => {

        const screen = await openNotificationsScreen();
        const previewItem = requireRow(screen, 'settings-notifications-sounds-preview');

        await act(async () => {
            previewItem.props.onPress();
        });

        await vi.waitFor(() => { expect(scheduleExpoNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({
            title: 'settingsNotifications.sounds.previewNotificationTitle',
            body: 'settingsNotifications.sounds.previewNotificationBody',
            sound: 'happier_soft.wav',
        }), trigger: null })); });
    });







});
