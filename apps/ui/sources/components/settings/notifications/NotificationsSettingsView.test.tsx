import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    type NotificationChannelV1} from '@happier-dev/protocol/account/settings/notificationChannels';
import {
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    type AttentionDeliveryPolicyV1,
} from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import {
    type NotificationsSettingsV1} from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installBrowserNotificationApiStub } from '@/dev/testkit/mocks/browserNotification';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { prepareLegacyNotificationChannelCatalogV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1 } from '@happier-dev/protocol/account/settings/notificationChannels';
import { loadNotificationsSettingsActionExecutorForTests, restoreNotificationsSettingsCatalog } from './notificationsSettingsCatalogTestHarness';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { LiveActivityRemoteUpdateCapabilityDiagnostics } from '@happier-dev/protocol/activity/live/remoteUpdateCapabilities';

const nativePickerInstalled = vi.hoisted(() => ({ value: false }));

// Select the real Metro native adapter; only the installed SDK and OS module presence are substituted.
vi.mock('@/components/ui/dateTime/DateTimePickerPopover', () => vi.importActual('@/components/ui/dateTime/DateTimePickerPopover.native'));
vi.mock('@react-native-community/datetimepicker', () => ({
    default: (props: React.Attributes & Record<string, unknown>) => React.createElement('NativeDateTimePicker', props),
}));

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
const translateMock = vi.fn((key: string, _params?: Record<string, unknown>) => key);
const scheduleExpoNotificationMock = vi.hoisted(() => vi.fn());
const getPushPermissionsMock = vi.hoisted(() => vi.fn());
const requestPushPermissionsMock = vi.hoisted(() => vi.fn());
const tauriIsPermissionGrantedMock = vi.hoisted(() => vi.fn(async () => true));
const tauriRequestPermissionMock = vi.hoisted(() => vi.fn(async () => 'granted'));
const enabledLegacyNotificationTopics = { ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1 };
const liveActivityRemoteDiagnosticsState = vi.hoisted((): { value: LiveActivityRemoteUpdateCapabilityDiagnostics } => ({
    value: {
        modes: {
            hosted_happier_relay: {
                available: false,
                reasons: ['hosted_relay_provider_blocked'],
                configurationDiagnostics: [],
            },
            direct_apns: {
                available: false,
                reasons: ['direct_apns_not_configured'],
                configurationDiagnostics: ['apns_private_key_missing'],
            },
            background_wake_best_effort: {
                available: false,
                reasons: ['background_wake_disabled'],
                configurationDiagnostics: [],
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
            // This settings harness has no native layout/animation ticks; the OS preference settles disclosures immediately.
            AccessibilityInfo: { isReduceMotionEnabled: async () => true },
            UIManager: { hasViewManagerConfig: (name: string) => nativePickerInstalled.value && name === 'RNDateTimePicker' },
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

// Static runtime imports can resolve the common mock before its options are installed.
// Attach the OS boundary to this suite's platform fixture after that resolution.
const notificationsNativeBoundary = await import('react-native');
Object.defineProperty(notificationsNativeBoundary.Platform, 'OS', { configurable: true, get: () => platformState.os });

vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('expo-notifications', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    scheduleNotificationAsync: scheduleExpoNotificationMock,
    getPermissionsAsync: getPushPermissionsMock,
    requestPermissionsAsync: requestPushPermissionsMock,
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


// Load the real runtime graph outside behavior-hook deadlines, as the adjacent catalog suite does.
const storage = (await import('@/sync/domains/state/storage')).storage;
await loadSyncSingletonForTests();
const disposeActionBridge = (await loadNotificationsSettingsActionExecutorForTests()).dispose;
await import('@/components/onboarding/personalize/PersonalizeStepBody');
await import('@/components/onboarding/personalize/usePersonalizeFlow');
let fixture: Awaited<ReturnType<typeof restoreNotificationsSettingsCatalog>> | undefined;
let rawBeforeControl: Readonly<Record<string, unknown>> = {};
let settingsWritesBeforeControl: readonly unknown[] = [];
let localBeforeControl: ReturnType<typeof storage.getState>['localSettings'];
let disposeScreen: (() => Promise<void>) | undefined;
let declaredSettingActionsDisabled = false;
let declaredSettingActionsApprovalRequired = false;
let disabledNotificationAction: string | undefined;
const defaultLocalSettings = structuredClone(localSettingsState);
function disableRemotePush() {
    settingsState.notificationChannelsV1 = settingsState.notificationChannelsV1.map(channel => ({ ...channel, enabled: false }));
    settingsState.attentionDeliveryPolicyV1 = {
        ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
        channels: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels,
            expo_push: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push, enabled: false } },
    };
}
afterAll(() => { disposeActionBridge(); });
afterEach(async () => {
    await disposeScreen?.();
    disposeScreen = undefined;
    await fixture?.dispose();
    fixture = undefined;
    storage.getState().clearSettingsScope();
    storage.getState().clearProfileScope();
});
let fixtureHomeName: string | undefined = 'Studio Home';
async function openNotificationsScreen(entry: 'settings' | 'personalize' = 'settings', automaticPriming = false) {
    const source = prepareLegacyNotificationChannelCatalogV1({
        accountId: 'notification-adjacent', raw: settingsState, settingsSecretsReadKeys: [],
    });
    if (source.status !== 'ready') throw new Error('Expected the genuine unsigned predecessor source');
    fixture = await restoreNotificationsSettingsCatalog({
        accountId: 'notification-adjacent', serverUrl: 'https://notification-adjacent.example.test', homeName: fixtureHomeName,
        rawSettings: { ...settingsState, ...(declaredSettingActionsDisabled ? { actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } } : declaredSettingActionsApprovalRequired ? { actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } },
        } } : disabledNotificationAction ? { actionsSettingsV1: {
            v: 1, actions: { [disabledNotificationAction]: { disabledSurfaces: ['ui'] } },
        } } : {}) }, localSettings: localSettingsState,
        catalog: { status: 'present', record: source.record },
        features: createRootLayoutFeaturesResponse({
            features: { sessions: { following: { enabled: followingFeatureState.enabled } } },
            capabilities: { liveActivities: { remoteUpdates: liveActivityRemoteDiagnosticsState.value } },
        }),
    });
    const { NotificationsSettingsView } = await import('./NotificationsSettingsView');
    let content = <NotificationsSettingsView />;
    if (entry === 'personalize') {
        const { PersonalizeStepBody } = await import('@/components/onboarding/personalize/PersonalizeStepBody');
        const { usePersonalizeFlow } = await import('@/components/onboarding/personalize/usePersonalizeFlow');
        function PersonalizeNotifications() {
            const flow = usePersonalizeFlow({ initialPage: 'notifications', onExit: () => {} });
            return <PersonalizeStepBody flow={flow} phone={false} testID="personalize-notifications" />;
        }
        content = <PersonalizeNotifications />;
    }
    if (automaticPriming) {
        const { PushNotificationPermissionPrimingRuntime } = await import('@/activity/notifications/permission/PushNotificationPermissionPrimingRuntime');
        storage.getState().applyReady();
        content = <><PushNotificationPermissionPrimingRuntime />{content}</>;
    }
    const screen = await renderSettingsView(content);
    disposeScreen = screen.unmount;
    const { refreshNotificationChannelCatalog } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
    await act(async () => { await refreshNotificationChannelCatalog(fixture!.scope); });
    rawBeforeControl = structuredClone(fixture.readRaw());
    settingsWritesBeforeControl = structuredClone(fixture.settingsWrites);
    localBeforeControl = structuredClone(storage.getState().localSettings);
    return screen;
}

describe('NotificationsSettingsView', () => {
    beforeEach(() => {
        declaredSettingActionsDisabled = false;
        declaredSettingActionsApprovalRequired = false;
        disabledNotificationAction = undefined;
        clearActiveUnsavedChangesGuard();
        Object.assign(localSettingsState, structuredClone(defaultLocalSettings));
        settingsState.experiments = false;
        settingsState.featureToggles = {};
        settingsState.sessionRemoteAlertsEnabled = false;
        localSettingsState.deviceRemoteAlertsEnabled = true;
        followingFeatureState.enabled = true;
        platformState.os = 'ios';
        nativePickerInstalled.value = false;
        tauriDesktopState.value = false;
        modalPromptMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
        routerPushMock.mockReset();
        translateMock.mockClear();
        scheduleExpoNotificationMock.mockReset();
        scheduleExpoNotificationMock.mockResolvedValue('preview-notification-id');
        getPushPermissionsMock.mockReset();
        getPushPermissionsMock.mockResolvedValue({ status: 'undetermined', granted: false, canAskAgain: true });
        requestPushPermissionsMock.mockReset();
        requestPushPermissionsMock.mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true });
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
                    configurationDiagnostics: [],
                },
                direct_apns: {
                    available: false,
                    reasons: ['direct_apns_not_configured'],
                    configurationDiagnostics: ['apns_private_key_missing'],
                },
                background_wake_best_effort: {
                    available: false,
                    reasons: ['background_wake_disabled'],
                    configurationDiagnostics: [],
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
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(
            'actionConfirmations.turnedOffTitle', 'actionConfirmations.turnedOffMessage', expect.any(Array),
        ));
        expect(fixture!.settingsWrites).toEqual(settingsWritesBeforeControl);
    });

    it('keeps configured declared-setting approval pending without a settings write', async () => {
        declaredSettingActionsApprovalRequired = true;
        const screen = await openNotificationsScreen();
        const row = requireRow(screen, 'settings-notifications-mute-phone-focused-computer');
        await act(async () => { row.props.rightElement.props.onValueChange(true); });
        await vi.waitFor(() => expect(screen.findByTestId('settings-notifications-approval-pending')).not.toBeNull());
        expect(storage.getState().settings.attentionDeliveryPolicyV1).toEqual(rawBeforeControl.attentionDeliveryPolicyV1);
        expect(fixture!.settingsWrites).toEqual(settingsWritesBeforeControl);
        expect(modalAlertMock).not.toHaveBeenCalled();
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
        await vi.waitFor(() => expect(storage.getState().settings).toMatchObject({ sessionRemoteAlertsEnabled: false }));
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

    it('says "this Home" for an unnamed Home instead of printing its address', async () => {
        // A Home this device only knows by address carries the address as its profile label.
        fixtureHomeName = 'notification-adjacent.example.test';
        try {
            await openNotificationsScreen();
        } finally {
            fixtureHomeName = 'Studio Home';
        }
        const homes = translateMock.mock.calls
            .filter(([key]) => key === 'settingsNotifications.push.enabledSubtitle')
            .map(([, params]) => (params as { home: string }).home);
        expect(homes.length).toBeGreaterThan(0);
        expect(homes.every((home) => !home.includes('notification-adjacent.example.test'))).toBe(true);
        expect(homes.at(-1)).toBe('settingsAccount.thisHome');
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

    it('asks the browser for notification permission when device notifications are turned on', async () => {
        platformState.os = 'web';
        const browser = installBrowserNotificationApiStub('default');
        try {
            const screen = await openNotificationsScreen();
            const row = requireRow(screen, 'settings-notifications-local-enabled');
            await act(async () => { row.props.rightElement.props.onValueChange(false); });
            expect(browser.requestPermission).not.toHaveBeenCalled();

            await act(async () => { requireRow(screen, 'settings-notifications-local-enabled').props.rightElement.props.onValueChange(true); });
            expect(browser.requestPermission).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('leaves desktop app notification permission to the desktop permission row', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
        tauriIsPermissionGrantedMock.mockResolvedValue(false);
        const browser = installBrowserNotificationApiStub('default');
        try {
            const screen = await openNotificationsScreen();
            await act(async () => {});
            await act(async () => { requireRow(screen, 'settings-notifications-local-enabled').props.rightElement.props.onValueChange(true); });
            expect(browser.requestPermission).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
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
                    configurationDiagnostics: [],
                },
                direct_apns: {
                    available: false,
                    reasons: ['direct_apns_not_configured'],
                    configurationDiagnostics: [],
                },
                background_wake_best_effort: {
                    available: true,
                    reasons: [],
                    configurationDiagnostics: [],
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
                    configurationDiagnostics: [],
                },
                direct_apns: {
                    available: true,
                    reasons: [],
                    configurationDiagnostics: [],
                },
                background_wake_best_effort: {
                    available: true,
                    reasons: [],
                    configurationDiagnostics: [],
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
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(
            'actionConfirmations.turnedOffTitle', 'actionConfirmations.turnedOffMessage', expect.any(Array),
        ));
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


    it.each(['account', 'device'] as const)('edits custom quiet-hours %s schedules without resetting untouched windows or the other scope', async owner => {
        const schedule = {
            timezone: 'Europe/Amsterdam',
            windows: [
                { startLocalTime: '21:30', endLocalTime: '06:45', days: ['mon', 'fri'] as ('mon' | 'fri')[] },
                { startLocalTime: '12:00', endLocalTime: '13:00', days: ['sun'] as 'sun'[] },
            ],
        };
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1, quietHours: { enabled: true, ...schedule },
        };
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1, quietHoursOverride: { mode: 'custom', ...schedule },
        };
        const screen = await openNotificationsScreen();
        await act(async () => screen.pressRow('settings-notifications-quiet-hours-' + owner + '-edit'));
        const prefix = 'settings-notifications-quiet-hours-' + owner + '-editor';
        expect(screen.findByTestId(prefix + '-timezone')?.props.value).toBe(schedule.timezone);
        expect(screen.findByTestId(prefix + '-window-0-start')?.props.value).toBe('21:30');
        expect(screen.findByTestId(prefix + '-window-1-end')?.props.value).toBe('13:00');
        expect(fixture!.settingsWrites).toEqual(settingsWritesBeforeControl);
        expect(storage.getState().localSettings).toEqual(localBeforeControl);
        await act(async () => screen.changeTextByTestId(prefix + '-window-0-start', '20:15'));
        await act(async () => screen.pressByTestId(prefix + '-save'));
        const expected = { ...schedule, windows: [{ ...schedule.windows[0]!, startLocalTime: '20:15' }, schedule.windows[1]!] };
        if (owner === 'account') {
            await vi.waitFor(() => expect(fixture!.readRaw().attentionDeliveryPolicyV1).toMatchObject({ quietHours: { enabled: true, ...expected } }));
            expect(storage.getState().localSettings).toEqual(localBeforeControl);
        } else {
            await vi.waitFor(() => expect(storage.getState().localSettings.attentionDeviceOverridesV1.quietHoursOverride).toEqual({ mode: 'custom', ...expected }));
            expect(fixture!.readRaw()).toEqual(rawBeforeControl);
        }
        expect(screen.findByTestId(prefix + '-save')).toBeNull();
    });

    it('keeps custom quiet-hours drafts local until valid Save, and discards Cancel without changing the schedule', async () => {
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '23:00', endLocalTime: '05:00' }] },
        };
        const screen = await openNotificationsScreen();
        await act(async () => screen.pressRow('settings-notifications-quiet-hours-account-edit'));
        const prefix = 'settings-notifications-quiet-hours-account-editor';
        await act(async () => screen.changeTextByTestId(prefix + '-window-0-start', '25:99'));
        await act(async () => screen.pressByTestId(prefix + '-save'));
        expect(screen.findByTestId(prefix + '-window-0-start.error')).not.toBeNull();
        expect(fixture!.readRaw()).toEqual(rawBeforeControl);
        await act(async () => screen.changeTextByTestId(prefix + '-window-0-start', '22:00'));
        await act(async () => screen.changeTextByTestId(prefix + '-timezone', 'Not/A_Timezone'));
        await act(async () => screen.pressByTestId(prefix + '-save'));
        expect(screen.findByTestId(prefix + '-timezone.error')).not.toBeNull();
        expect(fixture!.settingsWrites).toEqual(settingsWritesBeforeControl);
        await act(async () => screen.pressByTestId(prefix + '-cancel'));
        await act(async () => screen.pressRow('settings-notifications-quiet-hours-account-edit'));
        expect(screen.findByTestId(prefix + '-window-0-start')?.props.value).toBe('23:00');
        expect(screen.findByTestId(prefix + '-timezone')?.props.value).toBe('UTC');
    });

    it('clears a device schedule weekday restriction through the shared Every day choice', async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            quietHoursOverride: { mode: 'custom', timezone: 'UTC', windows: [
                { startLocalTime: '23:00', endLocalTime: '05:00', days: ['mon'] },
            ] },
        };
        const screen = await openNotificationsScreen();
        await act(async () => screen.pressRow('settings-notifications-quiet-hours-device-edit'));
        const prefix = 'settings-notifications-quiet-hours-device-editor';
        await act(async () => screen.pressByTestId(prefix + '-window-0-days-trigger'));
        await vi.waitFor(() => expect(screen.findByTestId(prefix + '-window-0-days:all')).not.toBeNull());
        await act(async () => screen.pressByTestId(prefix + '-window-0-days:all'));
        await act(async () => screen.pressByTestId(prefix + '-save'));
        await vi.waitFor(() => expect(screen.findByTestId(prefix + '-save')).toBeNull());
        const saved = storage.getState().localSettings.attentionDeviceOverridesV1.quietHoursOverride;
        expect(saved.mode).toBe('custom');
        if (saved.mode !== 'custom') throw new Error('Expected the authored custom schedule');
        expect(saved.windows[0]?.days ?? []).toEqual([]);
        expect(fixture!.readRaw()).toEqual(rawBeforeControl);
    });

    it('closes the interactive quiet-hours native picker while the real Account Save awaits its HTTP response', async () => {
        nativePickerInstalled.value = true;
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '23:00', endLocalTime: '05:00' }] },
        };
        const screen = await openNotificationsScreen();
        await act(async () => screen.pressRow('settings-notifications-quiet-hours-account-edit'));
        const prefix = 'settings-notifications-quiet-hours-account-editor';
        await act(async () => screen.pressByTestId(prefix + '-window-0-start-picker'));
        await act(async () => { await import('@react-native-community/datetimepicker'); });
        await vi.waitFor(() => expect(screen.findAllByType('NativeDateTimePicker')).toHaveLength(1));
        await act(async () => screen.findByType('NativeDateTimePicker').props.onChange({ type: 'set' }, new Date(2000, 0, 1, 22, 30)));
        expect(screen.findByTestId(prefix + '-window-0-start')?.props.value).toBe('22:30');
        const gate = fixture!.deferNextSettingsWrite();
        try {
            await act(async () => screen.pressByTestId(prefix + '-save'));
            await gate.started;
            expect(screen.findAllByType('NativeDateTimePicker')).toHaveLength(0);
        } finally {
            await act(async () => gate.release());
        }
        await vi.waitFor(() => expect(screen.findByTestId(prefix + '-save')).toBeNull());
        expect(fixture!.readRaw().attentionDeliveryPolicyV1).toMatchObject({ quietHours: {
            windows: [{ startLocalTime: '22:30', endLocalTime: '05:00' }],
        } });
    });

    it('authors quiet-hours windows and weekday selections through the shared schedule controls', async () => {
        settingsState.attentionDeliveryPolicyV1 = {
            ...settingsState.attentionDeliveryPolicyV1,
            quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '23:00', endLocalTime: '05:00' }] },
        };
        const screen = await openNotificationsScreen();
        await act(async () => screen.pressRow('settings-notifications-quiet-hours-account-edit'));
        const prefix = 'settings-notifications-quiet-hours-account-editor';
        await act(async () => screen.pressByTestId(prefix + '-add'));
        await act(async () => screen.changeTextByTestId(prefix + '-window-1-end', '08:30'));
        await act(async () => screen.pressByTestId(prefix + '-window-1-days-trigger'));
        await vi.waitFor(() => expect(screen.findByTestId(prefix + '-window-1-days:tue')).not.toBeNull());
        await act(async () => screen.pressByTestId(prefix + '-window-1-days:tue'));
        await act(async () => screen.pressByTestId(prefix + '-window-0-remove'));
        expect(fixture!.settingsWrites).toEqual(settingsWritesBeforeControl);
        await act(async () => screen.pressByTestId(prefix + '-save'));
        await vi.waitFor(() => expect(fixture!.readRaw().attentionDeliveryPolicyV1).toMatchObject({
            quietHours: { enabled: true, timezone: 'UTC', windows: [
                { startLocalTime: '22:00', endLocalTime: '08:30', days: ['tue'] },
            ] },
        }));
        expect(storage.getState().localSettings).toEqual(localBeforeControl);
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


    it('draws no catalog-driven switch while the channel catalog has not answered', async () => {
        const screen = await openNotificationsScreen();
        expect(requireRow(screen, 'settings-notifications-push-enabled').props.rightElement).toBeTruthy();
        const { applyNotificationChannelCatalogSnapshot, beginNotificationChannelCatalogLoad } =
            await import('@/sync/store/settings/notificationChannelCatalogSnapshot');
        await act(async () => {
            // A withdrawn catalog (credentials retired) then a fresh load: no channel is known yet.
            applyNotificationChannelCatalogSnapshot(fixture!.scope, { catalog: { status: 'unavailable', reason: 'unauthorized' },
                rawSettings: {}, sourceSettingsVersion: 0 }, true);
            beginNotificationChannelCatalogLoad(fixture!.scope);
        });
        expect(requireRow(screen, 'settings-notifications-push-enabled').props.rightElement).toBeUndefined();
        // The Account's own Follow update value is not a catalog fact: it keeps its real switch.
        expect(requireRow(screen, 'settings-notifications-type-follow-update').props.rightElement).toBeTruthy();
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
        const previewItem = requireRowByTitle(screen, 'settingsNotifications.sounds.previewTitle');

        await act(async () => {
            previewItem.props.rightElement.props.onPress();
        });

        await vi.waitFor(() => { expect(scheduleExpoNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({
            title: 'settingsNotifications.sounds.previewNotificationTitle',
            body: 'settingsNotifications.sounds.previewNotificationBody',
            sound: 'happier_soft.wav',
        }), trigger: null })); });
    });

    it('offers and plays the bundled sound preview in the desktop webview', async () => {
        platformState.os = 'web';
        tauriDesktopState.value = true;
        const played: string[] = [];
        vi.stubGlobal('Audio', class {
            constructor(readonly src: string) {}
            async play() { played.push(this.src); }
        });
        try {
            const screen = await openNotificationsScreen();
            const previewItem = requireRowByTitle(screen, 'settingsNotifications.sounds.previewTitle');
            await act(async () => { previewItem.props.rightElement.props.onPress(); });
            await vi.waitFor(() => expect(played).toHaveLength(1));
            expect(played[0]).toContain('happier_soft.wav');
            expect(scheduleExpoNotificationMock).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });

    it('refuses the exact permission operation after allowing the Enable channel mutation', async () => {
        disabledNotificationAction = 'notifications.push.permission.request';
        disableRemotePush();
        modalConfirmMock.mockResolvedValue(true);
        const screen = await openNotificationsScreen('settings', true);
        await act(async () => {
            await requireRow(screen, 'settings-notifications-push-enabled').props.rightElement.props.onValueChange(true);
        });
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(
            'actionConfirmations.turnedOffTitle', 'actionConfirmations.turnedOffMessage', expect.any(Array),
        ));
        expect(fixture!.catalogWrites).toHaveLength(1);
        expect(requestPushPermissionsMock).not.toHaveBeenCalled();
        expect(modalConfirmMock.mock.calls.filter(([title]) => title === 'settingsNotifications.pushPriming.title'
            || title === 'settingsNotifications.pushPriming.blockedTitle')).toEqual([]);
        await act(async () => {
            await requireRow(screen, 'settings-notifications-push-enabled').props.rightElement.props.onValueChange(false);
        });
        expect(fixture!.catalogWrites).toHaveLength(2);
        expect(fixture!.readRecord().channels[0]?.enabled).toBe(false);
    });

    it('requests native permission from Enable through the admitted permission owner', async () => {
        disableRemotePush();
        modalConfirmMock.mockResolvedValue(true);
        const screen = await openNotificationsScreen();
        await act(async () => {
            await requireRow(screen, 'settings-notifications-push-enabled').props.rightElement.props.onValueChange(true);
        });
        await vi.waitFor(() => expect(requestPushPermissionsMock).toHaveBeenCalledOnce());
        expect(fixture!.catalogWrites).toHaveLength(1);
    });

    it('keeps a failed native permission observation distinct from unsupported notifications in onboarding', async () => {
        getPushPermissionsMock.mockRejectedValue(new Error('native permission query unavailable'));
        const screen = await openNotificationsScreen('personalize');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('settingsNotifications.pushTroubleshooting.permission.runtimeUnavailableSubtitle'));
        expect(screen.getTextContent()).not.toContain('personalize.notificationsUnsupported');
        expect(screen.getTextContent()).not.toContain('personalize.notificationsNotAllowed');
        expect(screen.findByTestId('personalize-notifications-needs-you')).toBeTruthy();
        expect(screen.findByTestId('personalize-notifications-preview')).toBeTruthy();
        expect(screen.findByTestId('personalize-notifications-allow')).toBeTruthy();
        getPushPermissionsMock.mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true });
        modalConfirmMock.mockResolvedValue(true);
        await act(async () => { screen.pressRow('personalize-notifications-allow'); });
        await vi.waitFor(() => expect(requestPushPermissionsMock).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('personalize.notificationsAllowed'));
    });

    it('refuses the exact permission operation from onboarding Allow', async () => {
        disabledNotificationAction = 'notifications.push.permission.request';
        getPushPermissionsMock.mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true });
        disableRemotePush();
        modalConfirmMock.mockResolvedValue(true);
        const screen = await openNotificationsScreen('personalize');
        await vi.waitFor(() => expect(screen.findByTestId('personalize-notifications-allow')).toBeTruthy());
        await act(async () => { screen.pressRow('personalize-notifications-allow'); });
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(
            'actionConfirmations.turnedOffTitle', 'actionConfirmations.turnedOffMessage', expect.any(Array),
        ));
        expect(requestPushPermissionsMock).not.toHaveBeenCalled();
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('personalize-notifications-allow')).toBeTruthy();
    });

    it('requests local native permission from onboarding Allow while remote push stays disabled', async () => {
        disableRemotePush();
        modalConfirmMock.mockResolvedValue(true);
        const screen = await openNotificationsScreen('personalize');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        expect(await execute('notifications.push.permission.request', {}, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: fixture!.scope.serverId, expectedAccountId: fixture!.scope.accountId,
        })).toEqual({ ok: true, result: { decision: 'skip_push_disabled', granted: false } });
        expect(requestPushPermissionsMock).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('personalize-notifications-allow')).toBeTruthy());
        await act(async () => { screen.pressRow('personalize-notifications-allow'); });
        await vi.waitFor(() => expect(requestPushPermissionsMock).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(screen.findByTestId('personalize-notifications-allow')).toBeNull());
        expect(fixture!.readRaw()).toEqual(rawBeforeControl);
        expect(fixture!.catalogWrites).toEqual([]);
    });

    it('refuses native sound Preview while the neighboring sound preference remains editable', async () => {
        disabledNotificationAction = 'notifications.sounds.preview';
        const screen = await openNotificationsScreen();
        await act(async () => { requireRow(screen, 'settings-notifications-sounds-preview').props.onPress(); });
        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith(
            'actionConfirmations.turnedOffTitle', 'actionConfirmations.turnedOffMessage', expect.any(Array),
        ));
        expect(scheduleExpoNotificationMock).not.toHaveBeenCalled();
        await act(async () => {
            requireRow(screen, 'settings-notifications-sounds-device-enabled').props.rightElement.props.onValueChange(false);
        });
        expect(storage.getState().localSettings.attentionDeviceOverridesV1.sounds.enabled).toBe(false);
    });

    it('previews without sound when the device sound preference is disabled', async () => {
        localSettingsState.attentionDeviceOverridesV1 = {
            ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1,
            sounds: { ...DEFAULT_ATTENTION_DEVICE_OVERRIDES_V1.sounds, enabled: false },
        };
        const screen = await openNotificationsScreen();
        await act(async () => { requireRow(screen, 'settings-notifications-sounds-preview').props.onPress(); });
        await vi.waitFor(() => expect(scheduleExpoNotificationMock).toHaveBeenCalledOnce());
        expect(scheduleExpoNotificationMock.mock.calls[0]?.[0].content).not.toHaveProperty('sound');
    });







});
