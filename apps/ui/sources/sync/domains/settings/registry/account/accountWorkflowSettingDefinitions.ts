import { NotificationChannelsV1Schema, AttentionDeliveryPolicyV1Schema, ExternalSessionsSettingsV1Schema, NotificationsSettingsV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';
import { SessionHandoffDefaultsV1Schema } from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';
import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

export const ACCOUNT_WORKFLOW_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    externalSessionsSettingsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'count_only',
        identityScope: 'person',
        currentPropertyValueKinds: {
            keepPassivelyFollowingAfterRestart: 'boolean',
            autoLinkSourcePolicyEnabledCount: 'count',
        },
        serializeCurrentProperties: (value: z.infer<typeof ExternalSessionsSettingsV1Schema>) => ({
            keepPassivelyFollowingAfterRestart: value.keepPassivelyFollowingAfterRestart,
            autoLinkSourcePolicyEnabledCount: value.autoLinkSourcePolicies.length,
        }),
    },
    preferredLanguage: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrent: (value: string | null): string => value ?? 'auto',
    },
    notificationsSettingsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof NotificationsSettingsV1Schema>) => ({
            pushEnabled: value.pushEnabled,
            ready: value.ready,
            readyIncludeMessageText: value.readyIncludeMessageText,
            permissionRequest: value.permissionRequest,
            userActionRequest: value.userActionRequest,
            foregroundBehavior: value.foregroundBehavior,
        }),
    },
    notificationChannelsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof NotificationChannelsV1Schema>) => ({
            channelCount: value.length,
            kinds: value.map((channel) => channel.kind).join(','),
        }),
    },
    attentionDeliveryPolicyV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof AttentionDeliveryPolicyV1Schema>) => ({
            quietHoursEnabled: value.quietHours.enabled,
            foregroundBehavior: value.foregroundBehavior,
            expoPushEnabled: value.channels.expo_push.enabled,
            localNotificationEnabled: value.channels.local_notification.enabled,
            liveActivityEnabled: value.channels.live_activity.enabled,
            liveActivityRemoteMode: value.liveActivityRemoteUpdates.preferredMode,
        }),
    },
    sessionHandoffDefaultsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: (value: z.infer<typeof SessionHandoffDefaultsV1Schema>) => ({
            workspaceTransferEnabled: value.workspaceTransferEnabled,
            conflictPolicy: value.conflictPolicy,
            includeIgnoredMode: value.includeIgnoredMode,
            directTargetMode: value.directTargetMode,
        }),
    },
});
