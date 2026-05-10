import { describe, expect, it } from 'vitest';

import { ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS } from './registry/local/localSettingDefinitions.activitySurfaces';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettingsParse', () => {
    it('does not accept the dead shortcut_only desktop overlay expanded behavior in the rollout schema', () => {
        expect(
            ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS.desktopOverlayExpandedBehavior.schema.safeParse('shortcut_only').success,
        ).toBe(false);
    });

    it('includes multi-pane and pane tab defaults', () => {
        const parsed = localSettingsParse(null);
        expect(parsed.uiBackdropBlurEnabled).toBe(true);
        expect(parsed.uiMultiPanePanelsEnabled).toBe(true);
        expect(parsed.uiItemDensity).toBe('cozy');
        expect(parsed.detailsPaneTabsBehavior).toBe('preview');
        expect(parsed.settingsNavSidebarWidthPx).toBe(230);
        expect(parsed.sessionsListStorageTab).toBe('persisted');
        expect(parsed.activityBadgesEnabled).toBe(true);
        expect(parsed.activityBadgeShowUnread).toBe(true);
        expect(parsed.activityBadgeShowPendingPermissionRequests).toBe(true);
        expect(parsed.activityBadgeShowPendingUserActionRequests).toBe(true);
        expect(parsed.activityBadgeShowQueuedUserInput).toBe(true);
        expect(parsed.activityBadgeShowFriendRequestsInboxCount).toBe(true);
        expect(parsed.activityBadgeShowDesktopNonNumericDot).toBe(true);
        expect(parsed.localNotificationsEnabled).toBe(true);
        expect(parsed.localNotificationsShowReady).toBe(true);
        expect(parsed.localNotificationsShowReadyMessageText).toBe(true);
        expect(parsed.localNotificationsShowPendingPermissionRequests).toBe(true);
        expect(parsed.localNotificationsShowPendingUserActionRequests).toBe(true);
        expect(parsed.localNotificationsForegroundBehavior).toBe('full');
        expect(parsed.activitySurfacesEnabled).toBe(true);
        expect(parsed.liveActivitiesEnabled).toBe(true);
        expect(parsed.liveActivitiesStrategy).toBe('dynamic_primary');
        expect(parsed.iosLiveActivitiesEnabled).toBe(true);
        expect(parsed.widgetsEnabled).toBe(true);
        expect(parsed.liveActivitiesMode).toBe('focused');
        expect(parsed.liveActivitiesMaxConcurrent).toBe(1);
        expect(parsed.liveActivitiesShowPreviewText).toBe(true);
        expect(parsed.liveActivitiesAllowActionButtons).toBe(true);
        expect(parsed.liveActivitiesIncludeReady).toBe(true);
        expect(parsed.liveActivitiesIncludeThinking).toBe(true);
        expect(parsed.widgetsPresetMode).toBe('summary');
        expect(parsed.widgetsShowPreviewText).toBe(true);
        expect(parsed.widgetsShowMachinePath).toBe(true);
        expect(parsed.homeScreenWidgetsMode).toBe('summary');
        expect(parsed.homeScreenWidgetsShowPreviewText).toBe(true);
        expect(parsed.homeScreenWidgetsShowMachinePath).toBe(true);
        expect(parsed.activitySurfaceTapTarget).toBe('open_session');
        expect(parsed.activitySurfacePrivacyMode).toBe('title_only');
        expect(parsed.desktopOverlayEnabled).toBe(false);
        expect(parsed.desktopOverlayVisibilityMode).toBe('attention_only');
        expect(parsed.desktopOverlayShowWhenRunning).toBe(true);
        expect(parsed.desktopOverlayShowWhenAttentionRequired).toBe(true);
        expect(parsed.desktopOverlayShowWhenReady).toBe(true);
        expect(parsed.desktopOverlayAlwaysOnTop).toBe(true);
        expect(parsed.desktopOverlayAutoHideEnabled).toBe(true);
        expect(parsed.desktopOverlayAutoHideDelayMs).toBe(6_000);
        expect(parsed.desktopOverlayExpandedBehavior).toBe('click');
        expect(parsed.desktopOverlayInteractiveCollapsed).toBe(true);
        expect(parsed.desktopOverlayPresentationMode).toBe('automatic');
        expect(parsed.desktopOverlayEnableDragReposition).toBe(false);
        expect(parsed.desktopOverlayLockPosition).toBe(true);
        expect(parsed.desktopOverlayPlacementMode).toBe('anchored');
        expect(parsed.desktopOverlayAnchor).toBe('top_center');
        expect(parsed.desktopOverlayOffsetX).toBe(0);
        expect(parsed.desktopOverlayOffsetY).toBe(0);
        expect(parsed.desktopOverlayClickAction).toBe('expand_overlay');
        expect(parsed.desktopOverlayDensity).toBe('compact');
        expect(parsed.desktopOverlayShowSessionCount).toBe(true);
        expect(parsed.desktopOverlayShowPreviewText).toBe(false);
        expect(parsed.desktopOverlayCompactStyle).toBe('pill');
        expect(parsed.attentionDeviceOverridesV1).toMatchObject({
            v: 1,
            enabled: true,
            foregroundBehavior: 'account',
            localNotifications: {
                enabled: true,
                events: {
                    ready: true,
                    permission_request: true,
                    user_action_request: true,
                },
                previewBehavior: 'account',
            },
            badge: {
                enabled: true,
                includeUnread: true,
                includePendingPermissionRequests: true,
                includePendingUserActionRequests: true,
                includeQueuedUserInput: true,
            },
            quietHoursOverride: {
                mode: 'account',
            },
            desktopOverlay: {
                hoverExpandDelay: 'normal',
                compactCollapsedMode: false,
                collapsedCarouselEnabled: true,
                physicalNotchMode: 'automatic',
                autoDismissDelayMs: 10_000,
                quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
            },
            liveActivities: {
                registerRemoteUpdateTargets: true,
                allowBackgroundWakeFallback: false,
                privacyMode: 'account',
                showFreshnessDiagnostics: false,
                remoteUpdateModeOverride: 'account',
            },
            terminalSmartSuppression: {
                enabled: true,
            },
        });
        expect(typeof (parsed as any).sidebarWidthPx).toBe('number');
        expect(typeof (parsed as any).sidebarWidthBasisPx).toBe('number');
        expect((parsed as any).bottomPaneHeightPx).toBe(320);
        expect((parsed as any).bottomPaneHeightBasisPx).toBe(900);
        expect((parsed as any).embeddedTerminalDockLocation).toBe('bottom');
        expect(parsed).not.toHaveProperty('mobileWorkspaceExperienceV1');
    });

    it('returns defaults for non-object input', () => {
        expect(localSettingsParse(null)).toEqual(localSettingsDefaults);
        expect(localSettingsParse(undefined)).toEqual(localSettingsDefaults);
        expect(localSettingsParse('nope')).toEqual(localSettingsDefaults);
    });

    it('migrates legacy settings sidebar width defaults to the new fixed default', () => {
        const parsed = localSettingsParse({
            settingsNavSidebarWidthPx: 280,
            settingsNavSidebarWidthBasisPx: 1200,
        });
        expect(parsed.settingsNavSidebarWidthPx).toBe(230);
    });

    it('migrates legacy uiFontSize to uiFontScale when uiFontScale is missing', () => {
        const parsed = localSettingsParse({ uiFontSize: 'large' });
        expect(parsed.uiFontScale).toBeCloseTo(1.1, 5);
    });

    it('prefers uiFontScale over legacy uiFontSize when both are present', () => {
        const parsed = localSettingsParse({ uiFontScale: 1.42, uiFontSize: 'xsmall' });
        expect(parsed.uiFontScale).toBeCloseTo(1.42, 5);
    });

    it('clamps uiFontScale to the supported range', () => {
        const tooSmall = localSettingsParse({ uiFontScale: 0.01 });
        expect(tooSmall.uiFontScale).toBeGreaterThanOrEqual(0.5);

        const tooBig = localSettingsParse({ uiFontScale: 100 });
        expect(tooBig.uiFontScale).toBeLessThanOrEqual(2.5);
    });

    it('accepts direct sessions list tab selection', () => {
        const parsed = localSettingsParse({ sessionsListStorageTab: 'direct' });
        expect(parsed.sessionsListStorageTab).toBe('direct');
    });

    it('accepts the middle ui item density selection', () => {
        const parsed = localSettingsParse({ uiItemDensity: 'cozy' });
        expect(parsed.uiItemDensity).toBe('cozy');
    });

    it('accepts explicit badge and local notification toggles', () => {
        const parsed = localSettingsParse({
            activityBadgesEnabled: false,
            activityBadgeShowUnread: false,
            activityBadgeShowFriendRequestsInboxCount: false,
            localNotificationsEnabled: false,
            localNotificationsShowReady: false,
            localNotificationsShowReadyMessageText: false,
            localNotificationsShowPendingPermissionRequests: false,
            localNotificationsShowPendingUserActionRequests: false,
            localNotificationsForegroundBehavior: 'silent',
            activitySurfacesEnabled: false,
            liveActivitiesEnabled: false,
            liveActivitiesStrategy: 'session_specific',
            iosLiveActivitiesEnabled: false,
            widgetsEnabled: false,
            widgetsPresetMode: 'attention',
            liveActivitiesMode: 'running',
            liveActivitiesMaxConcurrent: 4,
            liveActivitiesShowPreviewText: false,
            liveActivitiesAllowActionButtons: false,
            liveActivitiesIncludeReady: false,
            liveActivitiesIncludeThinking: false,
            homeScreenWidgetsMode: 'attention',
            widgetsShowPreviewText: false,
            widgetsShowMachinePath: false,
            homeScreenWidgetsShowPreviewText: false,
            homeScreenWidgetsShowMachinePath: false,
            activitySurfaceTapTarget: 'open_sessions',
            activitySurfacePrivacyMode: 'include_preview',
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'always_when_enabled',
            desktopOverlayShowWhenRunning: false,
            desktopOverlayShowWhenAttentionRequired: false,
            desktopOverlayShowWhenReady: false,
            desktopOverlayAlwaysOnTop: false,
            desktopOverlayAutoHideEnabled: false,
            desktopOverlayAutoHideDelayMs: 30_000,
            desktopOverlayExpandedBehavior: 'click',
            desktopOverlayInteractiveCollapsed: false,
            desktopOverlayPresentationMode: 'notch_integrated',
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 12,
            desktopOverlayOffsetY: -8,
            desktopOverlayClickAction: 'open_sessions',
            desktopOverlayDensity: 'comfortable',
            desktopOverlayShowSessionCount: false,
            desktopOverlayShowPreviewText: true,
            desktopOverlayCompactStyle: 'panel',
        });

        expect(parsed.activityBadgesEnabled).toBe(false);
        expect(parsed.activityBadgeShowUnread).toBe(false);
        expect(parsed.activityBadgeShowFriendRequestsInboxCount).toBe(false);
        expect(parsed.localNotificationsEnabled).toBe(false);
        expect(parsed.localNotificationsShowReady).toBe(false);
        expect(parsed.localNotificationsShowReadyMessageText).toBe(false);
        expect(parsed.localNotificationsShowPendingPermissionRequests).toBe(false);
        expect(parsed.localNotificationsShowPendingUserActionRequests).toBe(false);
        expect(parsed.localNotificationsForegroundBehavior).toBe('silent');
        expect(parsed.activitySurfacesEnabled).toBe(false);
        expect(parsed.liveActivitiesEnabled).toBe(false);
        expect(parsed.liveActivitiesStrategy).toBe('session_specific');
        expect(parsed.iosLiveActivitiesEnabled).toBe(false);
        expect(parsed.widgetsEnabled).toBe(false);
        expect(parsed.widgetsPresetMode).toBe('attention');
        expect(parsed.liveActivitiesMode).toBe('running');
        expect(parsed.liveActivitiesMaxConcurrent).toBe(4);
        expect(parsed.liveActivitiesShowPreviewText).toBe(false);
        expect(parsed.liveActivitiesAllowActionButtons).toBe(false);
        expect(parsed.liveActivitiesIncludeReady).toBe(false);
        expect(parsed.liveActivitiesIncludeThinking).toBe(false);
        expect(parsed.homeScreenWidgetsMode).toBe('attention');
        expect(parsed.widgetsShowPreviewText).toBe(false);
        expect(parsed.widgetsShowMachinePath).toBe(false);
        expect(parsed.homeScreenWidgetsShowPreviewText).toBe(false);
        expect(parsed.homeScreenWidgetsShowMachinePath).toBe(false);
        expect(parsed.activitySurfaceTapTarget).toBe('open_sessions');
        expect(parsed.activitySurfacePrivacyMode).toBe('include_preview');
        expect(parsed.desktopOverlayEnabled).toBe(true);
        expect(parsed.desktopOverlayVisibilityMode).toBe('always_when_enabled');
        expect(parsed.desktopOverlayShowWhenRunning).toBe(false);
        expect(parsed.desktopOverlayShowWhenAttentionRequired).toBe(false);
        expect(parsed.desktopOverlayShowWhenReady).toBe(false);
        expect(parsed.desktopOverlayAlwaysOnTop).toBe(false);
        expect(parsed.desktopOverlayAutoHideEnabled).toBe(false);
        expect(parsed.desktopOverlayAutoHideDelayMs).toBe(30_000);
        expect(parsed.desktopOverlayExpandedBehavior).toBe('click');
        expect(parsed.desktopOverlayInteractiveCollapsed).toBe(false);
        expect(parsed.desktopOverlayPresentationMode).toBe('notch_integrated');
        expect(parsed.desktopOverlayEnableDragReposition).toBe(true);
        expect(parsed.desktopOverlayLockPosition).toBe(false);
        expect(parsed.desktopOverlayPlacementMode).toBe('custom');
        expect(parsed.desktopOverlayAnchor).toBe('bottom_right');
        expect(parsed.desktopOverlayOffsetX).toBe(12);
        expect(parsed.desktopOverlayOffsetY).toBe(-8);
        expect(parsed.desktopOverlayClickAction).toBe('open_sessions');
        expect(parsed.desktopOverlayDensity).toBe('comfortable');
        expect(parsed.desktopOverlayShowSessionCount).toBe(false);
        expect(parsed.desktopOverlayShowPreviewText).toBe(true);
        expect(parsed.desktopOverlayCompactStyle).toBe('panel');
    });

    it('accepts explicit attention device overrides and preserves a disabled quiet-hours override', () => {
        const parsed = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                enabled: true,
                foregroundBehavior: 'silent',
                localNotifications: {
                    enabled: false,
                    events: {
                        ready: false,
                        permission_request: true,
                        user_action_request: false,
                    },
                    previewBehavior: 'status_only',
                },
                quietHoursOverride: {
                    mode: 'disabled',
                },
                desktopOverlay: {
                    hoverExpandDelay: 'slow',
                    compactCollapsedMode: true,
                    collapsedCarouselEnabled: false,
                    physicalNotchMode: 'force_virtual',
                    autoDismissDelayMs: 12_000,
                    quickReplyPhrases: ['Ship', 'Explain', 'Retry', 'More', 'Stop', 'Thanks', 'Ignored'],
                },
                liveActivities: {
                    registerRemoteUpdateTargets: false,
                    allowBackgroundWakeFallback: true,
                    privacyMode: 'status_only',
                    showFreshnessDiagnostics: true,
                    remoteUpdateModeOverride: 'local_only',
                },
                terminalSmartSuppression: {
                    enabled: false,
                },
            },
        });

        expect(parsed.attentionDeviceOverridesV1).toMatchObject({
            foregroundBehavior: 'silent',
            localNotifications: {
                enabled: false,
                events: {
                    ready: false,
                    permission_request: true,
                    user_action_request: false,
                },
                previewBehavior: 'status_only',
            },
            quietHoursOverride: {
                mode: 'disabled',
            },
            desktopOverlay: {
                hoverExpandDelay: 'slow',
                compactCollapsedMode: true,
                collapsedCarouselEnabled: false,
                physicalNotchMode: 'force_virtual',
                autoDismissDelayMs: 12_000,
                quickReplyPhrases: ['Ship', 'Explain', 'Retry', 'More', 'Stop', 'Thanks'],
            },
            liveActivities: {
                registerRemoteUpdateTargets: false,
                allowBackgroundWakeFallback: true,
                privacyMode: 'status_only',
                showFreshnessDiagnostics: true,
                remoteUpdateModeOverride: 'local_only',
            },
            terminalSmartSuppression: {
                enabled: false,
            },
        });
    });

    it('backfills attention device overrides from legacy local notification and surface settings', () => {
        const parsed = localSettingsParse({
            localNotificationsEnabled: false,
            localNotificationsShowReady: false,
            localNotificationsShowReadyMessageText: false,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: false,
            localNotificationsForegroundBehavior: 'silent',
            activityBadgesEnabled: false,
            activityBadgeShowUnread: false,
            activityBadgeShowPendingPermissionRequests: true,
            activityBadgeShowPendingUserActionRequests: false,
            activityBadgeShowQueuedUserInput: false,
            desktopOverlayAutoHideDelayMs: 30_000,
            liveActivitiesShowPreviewText: false,
            liveActivitiesAllowActionButtons: false,
            widgetsEnabled: false,
            widgetsShowPreviewText: false,
            activitySurfacePrivacyMode: 'include_preview',
        });

        expect(parsed.attentionDeviceOverridesV1).toMatchObject({
            foregroundBehavior: 'silent',
            localNotifications: {
                enabled: false,
                events: {
                    ready: false,
                    permission_request: true,
                    user_action_request: false,
                },
                previewBehavior: 'status_only',
            },
            badge: {
                enabled: false,
                includeUnread: false,
                includePendingPermissionRequests: true,
                includePendingUserActionRequests: false,
                includeQueuedUserInput: false,
            },
            desktopOverlay: {
                autoDismissDelayMs: 30_000,
            },
            liveActivities: {
                privacyMode: 'status_only',
            },
            widgets: {
                enabled: false,
                privacyMode: 'status_only',
            },
        });
    });

    it('migrates the legacy shortcut_only desktop overlay expanded behavior before validation', () => {
        const parsed = localSettingsParse({
            desktopOverlayExpandedBehavior: 'shortcut_only',
        });

        expect(parsed.desktopOverlayExpandedBehavior).toBe('click');
    });

    it('syncs canonical activity surface aliases when applying local settings', () => {
        const applied = applyLocalSettings(localSettingsDefaults, {
            iosLiveActivitiesEnabled: false,
            homeScreenWidgetsMode: 'running',
            homeScreenWidgetsShowPreviewText: false,
            homeScreenWidgetsShowMachinePath: false,
            desktopOverlayExpandedBehavior: 'click',
        });

        expect(applied.liveActivitiesEnabled).toBe(false);
        expect(applied.iosLiveActivitiesEnabled).toBe(false);
        expect(applied.widgetsPresetMode).toBe('running');
        expect(applied.homeScreenWidgetsMode).toBe('running');
        expect(applied.widgetsShowPreviewText).toBe(false);
        expect(applied.homeScreenWidgetsShowPreviewText).toBe(false);
        expect(applied.widgetsShowMachinePath).toBe(false);
        expect(applied.homeScreenWidgetsShowMachinePath).toBe(false);
        expect(applied.desktopOverlayExpandedBehavior).toBe('click');
    });

    it('keeps attention device overrides in sync when applying legacy local setting deltas', () => {
        const applied = applyLocalSettings(localSettingsDefaults, {
            localNotificationsEnabled: false,
            localNotificationsShowReady: false,
            localNotificationsForegroundBehavior: 'off',
            desktopOverlayAutoHideDelayMs: 25_000,
        });

        expect(applied.attentionDeviceOverridesV1).toMatchObject({
            foregroundBehavior: 'off',
            localNotifications: {
                enabled: false,
                events: {
                    ready: false,
                },
            },
            desktopOverlay: {
                autoDismissDelayMs: 25_000,
            },
        });
    });

    it('drops the deprecated persisted editor focus mode flag while parsing and applying settings', () => {
        const parsed = localSettingsParse({ editorFocusModeEnabled: true });
        expect(parsed).not.toHaveProperty('editorFocusModeEnabled');

        const staleDelta: Record<'editorFocusModeEnabled', boolean> = { editorFocusModeEnabled: true };
        const applied = applyLocalSettings(localSettingsDefaults, staleDelta);
        expect(applied).not.toHaveProperty('editorFocusModeEnabled');
    });
});
