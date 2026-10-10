import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { localNotificationForegroundStorageBinding, localNotificationStorageBinding } from '@/components/settings/notifications/localNotificationPreferences';
import { accountNotificationStorageBinding, notificationBadgeStorageBinding, notificationDeviceQuietHoursStorageBinding, notificationDeviceSoundsStorageBinding } from './notificationPreferences';

/** The searchable settings of the `notifications` page. Rows render their labels from these declarations. */
export const NOTIFICATIONS_SETTINGS = defineSettingsPage({
    pageId: 'notifications',
    sections: {
        autoFollow: {
            titleKey: 'session.follow.preferences.title',
            featureId: 'sessions.following',
            settings: {
                autoFollowAssigned: {},
                autoFollowDirect: {},
                autoFollowTeam: {},
                autoFollowGroup: {},
            },
        },
        // Activity surfaces render on iOS; the desktop app shows the shared part only.
        activitySurfaces: {
            titleKey: 'settingsNotifications.activitySurfaces.title',
            host: settingsHosts.iosOrDesktop,
            settings: {
                enabled: {},
            },
        },
        activitySurfacesShared: {
            titleKey: 'settingsNotifications.activitySurfaces.shared.title',
            host: settingsHosts.iosOrDesktop,
            settings: {
                tapTarget: {},
                privacy: {},
            },
        },
        liveActivities: {
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.title',
            host: settingsHosts.ios,
            settings: {
                liveActivitiesEnabled: {},
                strategy: {},
                presentation: {},
                maxConcurrent: {},
                previewText: {},
                actionButtons: {},
                includeReady: {},
                includeThinking: {},
            },
        },
        widgets: {
            titleKey: 'settingsNotifications.activitySurfaces.widgets.title',
            host: settingsHosts.ios,
            settings: {
                widgetsEnabled: {},
                widgetsMode: {},
                widgetsPreviewText: {},
                machinePath: {},
            },
        },
        badges: {
            titleKey: 'settingsNotifications.badges.title',
            settings: {
                badgesEnabled: { storage: notificationBadgeStorageBinding('enabled') },
                unread: { storage: notificationBadgeStorageBinding('includeUnread') },
                permissionRequests: { storage: notificationBadgeStorageBinding('includePendingPermissionRequests') },
                userActions: { storage: notificationBadgeStorageBinding('includePendingUserActionRequests') },
                queued: { storage: notificationBadgeStorageBinding('includeQueuedUserInput') },
                friendRequests: { storage: notificationBadgeStorageBinding('includeFriendRequestsInboxCount') },
                desktopDot: { storage: notificationBadgeStorageBinding('includeDesktopNonNumericDot') },
            },
        },
        local: {
            titleKey: 'settingsNotifications.local.title',
            settings: {
                localEnabled: { storage: localNotificationStorageBinding('enabled') },
                ready: { storage: localNotificationStorageBinding('ready') },
                readyPreview: { storage: localNotificationStorageBinding('readyPreview') },
                requestPreview: { storage: localNotificationStorageBinding('requestPreview') },
                localPermissionRequests: { storage: localNotificationStorageBinding('permissionRequests') },
                localUserActions: { storage: localNotificationStorageBinding('userActions') },
            },
        },
        push: {
            titleKey: 'settingsNotifications.push.title',
            settings: {
                pushEnabled: { storage: accountNotificationStorageBinding('pushEnabled'), operation: { kind: 'interaction', requiresHumanInteraction: true } },
                mutePhoneWhenComputerFocused: {

                    storage: accountNotificationStorageBinding('mutePhoneWhenComputerFocused'),
                },
                troubleshoot: {},
            },
        },
        remoteAlerts: {
            titleKey: 'settingsNotifications.remoteAlerts.title',
            featureId: 'sessions.following',
            // Needs Session Follow on the active Home: page state, answered by the section's own line.
            settings: {
                account: {},
                device: { host: settingsHosts.native, },
            },
        },
        quietHours: {
            titleKey: 'settingsNotifications.quietHours.title',
            settings: {
                quietHoursAccount: { storage: accountNotificationStorageBinding('quietHours') },
                quietHoursDevice: { storage: notificationDeviceQuietHoursStorageBinding },
            },
        },
        foreground: {
            titleKey: 'settingsNotifications.foregroundBehavior.title',
            settings: {
                foregroundBehavior: { storage: localNotificationForegroundStorageBinding },
            },
        },
        webhooks: {
            titleKey: 'settingsNotifications.webhooks.title',
            settings: {
                addWebhook: {   operation: { kind: 'interaction', requiresHumanInteraction: true } },
            },
        },
        sounds: {
            titleKey: 'settingsNotifications.sounds.title',
            settings: {
                soundPreset: { storage: accountNotificationStorageBinding('soundPreset') },
                deviceEnabled: { storage: notificationDeviceSoundsStorageBinding },
            },
        },
        types: {
            titleKey: 'settingsNotifications.types.title',
            settings: {
                typesReady: { storage: accountNotificationStorageBinding('ready') },
                typesReadyPreview: { storage: accountNotificationStorageBinding('readyPreview') },
                typesRequestPreview: { storage: accountNotificationStorageBinding('requestPreview') },
                typesPermissionRequests: { storage: accountNotificationStorageBinding('permission_request') },
                typesUserActions: { storage: accountNotificationStorageBinding('user_action_request') },
                following: { storage: accountNotificationStorageBinding('follow_update') },
            },
        },
    },
});
