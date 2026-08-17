/** @moduleRealm daemon */
/** @realm any */
export type {
    PluginNotificationCategoryContributionV2 as NotificationCategoryContribution,
    PluginNotificationChannelContributionV2 as NotificationChannelContribution,
} from '@happier-dev/protocol';
export type {
    PluginNotificationRegistrationApi,
    PluginNotificationSendRequest as NotificationSendRequest,
    PluginNotificationSendResult as NotificationSendResult,
    PluginNotificationSender as NotificationSender,
} from './activation.js';
export type {
    PluginNotificationBatchResult as NotificationBatchResult,
    PluginNotificationCategorySummary as NotificationCategorySummary,
    PluginNotificationChannelSummary as NotificationChannelSummary,
    PluginNotificationPreferences as NotificationPreferences,
    NotificationsService,
} from './services/resources.js';
