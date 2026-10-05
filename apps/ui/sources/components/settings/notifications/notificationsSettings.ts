import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { localNotificationForegroundStorageBinding, localNotificationStorageBinding } from '@/components/settings/notifications/localNotificationPreferences';

/** The searchable settings of the `notifications` page. Rows render their labels from these declarations. */
export const NOTIFICATIONS_SETTINGS = defineSettingsPage({
    pageId: 'notifications',
    sections: {
        autoFollow: {
            titleKey: 'session.follow.preferences.title',
            featureId: 'sessions.following',
            settings: {
                autoFollowAssigned: { titleKey: 'session.follow.preferences.assigned' },
                autoFollowDirect: { titleKey: 'session.follow.preferences.direct' },
                autoFollowTeam: { titleKey: 'session.follow.preferences.team' },
                autoFollowGroup: { titleKey: 'session.follow.preferences.group' },
            },
        },
        // Activity surfaces render on iOS; the desktop app shows the shared part only.
        activitySurfaces: {
            titleKey: 'settingsNotifications.activitySurfaces.title',
            host: settingsHosts.iosOrDesktop,
            settings: {
                enabled: { storage: { scope: 'local', key: 'activitySurfacesEnabled', access: 'read_write' }, titleKey: 'common.enabled', descriptionKey: 'settingsNotifications.activitySurfaces.enabledSubtitle' },
            },
        },
        activitySurfacesShared: {
            titleKey: 'settingsNotifications.activitySurfaces.shared.title',
            host: settingsHosts.iosOrDesktop,
            settings: {
                tapTarget: { storage: { scope: 'local', key: 'activitySurfaceTapTarget', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.tapTargetTitle' },
                privacy: { storage: { scope: 'local', key: 'activitySurfacePrivacyMode', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.privacyTitle' },
            },
        },
        liveActivities: {
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.title',
            host: settingsHosts.ios,
            settings: {
                liveActivitiesEnabled: { storage: { scope: 'local', key: 'liveActivitiesEnabled', access: 'read_write' }, titleKey: 'common.enabled', descriptionKey: 'settingsNotifications.activitySurfaces.liveActivities.enabledSubtitle' },
                strategy: { storage: { scope: 'local', key: 'liveActivitiesStrategy', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.strategyTitle', descriptionKey: 'settingsNotifications.activitySurfaces.liveActivities.strategySubtitle' },
                presentation: { storage: { scope: 'local', key: 'liveActivitiesMode', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.presentationTitle', descriptionKey: 'settingsNotifications.activitySurfaces.liveActivities.presentationSubtitle' },
                maxConcurrent: { storage: { scope: 'local', key: 'liveActivitiesMaxConcurrent', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.maxConcurrentTitle' },
                previewText: { storage: { scope: 'local', key: 'liveActivitiesShowPreviewText', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.previewTextTitle' },
                actionButtons: { storage: { scope: 'local', key: 'liveActivitiesAllowActionButtons', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.actionButtonsTitle' },
                includeReady: { storage: { scope: 'local', key: 'liveActivitiesIncludeReady', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.includeReadyTitle' },
                includeThinking: { storage: { scope: 'local', key: 'liveActivitiesIncludeThinking', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.liveActivities.includeThinkingTitle' },
            },
        },
        widgets: {
            titleKey: 'settingsNotifications.activitySurfaces.widgets.title',
            host: settingsHosts.ios,
            settings: {
                widgetsEnabled: { storage: { scope: 'local', key: 'widgetsEnabled', access: 'read_write' }, titleKey: 'common.enabled', descriptionKey: 'settingsNotifications.activitySurfaces.widgets.enabledSubtitle' },
                widgetsMode: { storage: { scope: 'local', key: 'widgetsPresetMode', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.widgets.modeTitle' },
                widgetsPreviewText: { storage: { scope: 'local', key: 'widgetsShowPreviewText', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.widgets.previewTextTitle' },
                machinePath: { storage: { scope: 'local', key: 'widgetsShowMachinePath', access: 'read_write' }, titleKey: 'settingsNotifications.activitySurfaces.widgets.machinePathTitle' },
            },
        },
        badges: {
            titleKey: 'settingsNotifications.badges.title',
            settings: {
                badgesEnabled: { titleKey: 'settingsNotifications.badges.enabledTitle', descriptionKey: 'settingsNotifications.badges.enabledSubtitle' },
                unread: { titleKey: 'settingsNotifications.badges.unreadTitle', descriptionKey: 'settingsNotifications.badges.unreadSubtitle' },
                permissionRequests: { titleKey: 'settingsNotifications.badges.permissionRequestsTitle', descriptionKey: 'settingsNotifications.badges.permissionRequestsSubtitle' },
                userActions: { titleKey: 'settingsNotifications.badges.userActionsTitle', descriptionKey: 'settingsNotifications.badges.userActionsSubtitle' },
                queued: { titleKey: 'settingsNotifications.badges.queuedTitle', descriptionKey: 'settingsNotifications.badges.queuedSubtitle' },
                friendRequests: { titleKey: 'settingsNotifications.badges.friendRequestsTitle', descriptionKey: 'settingsNotifications.badges.friendRequestsSubtitle' },
                desktopDot: { titleKey: 'settingsNotifications.badges.desktopDotTitle', descriptionKey: 'settingsNotifications.badges.desktopDotSubtitle' },
            },
        },
        local: {
            titleKey: 'settingsNotifications.local.title',
            settings: {
                localEnabled: { titleKey: 'common.enabled', descriptionKey: 'settingsNotifications.local.enabledSubtitle', storage: localNotificationStorageBinding('enabled') },
                ready: { titleKey: 'settingsNotifications.local.readyTitle', descriptionKey: 'settingsNotifications.local.readySubtitle', storage: localNotificationStorageBinding('ready') },
                readyPreview: { titleKey: 'settingsNotifications.local.readyPreviewTitle', descriptionKey: 'settingsNotifications.local.readyPreviewSubtitle', storage: localNotificationStorageBinding('readyPreview') },
                requestPreview: { titleKey: 'settingsNotifications.local.requestPreviewTitle', descriptionKey: 'settingsNotifications.local.requestPreviewSubtitle', storage: localNotificationStorageBinding('requestPreview') },
                localPermissionRequests: { titleKey: 'settingsNotifications.local.permissionRequestsTitle', descriptionKey: 'settingsNotifications.local.permissionRequestsSubtitle', storage: localNotificationStorageBinding('permissionRequests') },
                localUserActions: { titleKey: 'settingsNotifications.local.userActionsTitle', descriptionKey: 'settingsNotifications.local.userActionsSubtitle', storage: localNotificationStorageBinding('userActions') },
            },
        },
        push: {
            titleKey: 'settingsNotifications.push.title',
            settings: {
                pushEnabled: { titleKey: 'common.enabled' },
                mutePhoneWhenComputerFocused: {
                    titleKey: 'settingsNotifications.mutePhoneWhenComputerFocusedTitle',
                    descriptionKey: 'settingsNotifications.mutePhoneWhenComputerFocusedSubtitle',
                },
                troubleshoot: { titleKey: 'settingsNotifications.push.troubleshootTitle', descriptionKey: 'settingsNotifications.push.troubleshootSubtitle' },
            },
        },
        remoteAlerts: {
            titleKey: 'settingsNotifications.remoteAlerts.title',
            // Needs Session Follow on the active Home: page state, answered by the section's own line.
            settings: {
                account: { titleKey: 'settingsNotifications.remoteAlerts.accountTitle', descriptionKey: 'settingsNotifications.remoteAlerts.disclosure' },
                device: { titleKey: 'settingsNotifications.remoteAlerts.deviceTitle', host: settingsHosts.native },
            },
        },
        quietHours: {
            titleKey: 'settingsNotifications.quietHours.title',
            settings: {
                quietHoursAccount: { titleKey: 'settingsNotifications.quietHours.accountRowTitle', keywordKeys: ['settingsNotifications.quietHours.nightlyShort'] },
                quietHoursDevice: { titleKey: 'settingsNotifications.quietHours.deviceRowTitle' },
            },
        },
        foreground: {
            titleKey: 'settingsNotifications.foregroundBehavior.title',
            settings: {
                foregroundBehavior: { titleKey: 'settingsNotifications.foregroundBehavior.rowTitle', keywordKeys: ['settingsNotifications.foregroundBehavior.silent'], storage: localNotificationForegroundStorageBinding },
            },
        },
        webhooks: {
            titleKey: 'settingsNotifications.webhooks.title',
            settings: {
                addWebhook: { titleKey: 'settingsNotifications.webhooks.addTitle', descriptionKey: 'settingsNotifications.webhooks.addSubtitle' },
            },
        },
        sounds: {
            titleKey: 'settingsNotifications.sounds.title',
            settings: {
                soundPreset: { titleKey: 'settingsNotifications.sounds.accountRowTitle', keywordKeys: ['settingsNotifications.sounds.accountSilentTitle'] },
                deviceEnabled: { titleKey: 'settingsNotifications.sounds.deviceEnabledTitle', descriptionKey: 'settingsNotifications.sounds.deviceEnabledSubtitle' },
            },
        },
        types: {
            titleKey: 'settingsNotifications.types.title',
            settings: {
                typesReady: { titleKey: 'settingsNotifications.types.ready.title', descriptionKey: 'settingsNotifications.types.ready.subtitle' },
                typesReadyPreview: { titleKey: 'settingsNotifications.types.readyPreview.title', descriptionKey: 'settingsNotifications.types.readyPreview.subtitle' },
                typesRequestPreview: { titleKey: 'settingsNotifications.types.requestPreview.title', descriptionKey: 'settingsNotifications.types.requestPreview.subtitle' },
                typesPermissionRequests: { titleKey: 'settingsNotifications.types.permissionRequests.title', descriptionKey: 'settingsNotifications.types.permissionRequests.subtitle' },
                typesUserActions: { titleKey: 'settingsNotifications.types.userActions.title', descriptionKey: 'settingsNotifications.types.userActions.subtitle' },
                following: { titleKey: 'session.follow.following', descriptionKey: 'session.follow.editor.subtitle' },
            },
        },
    },
});
