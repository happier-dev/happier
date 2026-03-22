import {
    NotificationChannelsV1Schema,
    deriveExpoPushNotificationChannelFromLegacySettings,
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
    NotificationsSettingsV1Schema,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
    DEFAULT_SESSION_HANDOFF_DEFAULTS_V1,
    SessionHandoffDefaultsV1Schema,
} from '@/sync/domains/sessionHandoff/sessionHandoffDefaults';

export const ACCOUNT_WORKFLOW_SETTING_DEFINITIONS = defineSettingDefinitions({
    preferredLanguage: {
        schema: z.string().nullable(),
        default: null,
        description: 'Preferred UI language (null for auto-detect from device locale)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrent: (value: string | null): string => value ?? 'auto',
        },
    },
    notificationsSettingsV1: {
        schema: NotificationsSettingsV1Schema,
        default: DEFAULT_NOTIFICATIONS_SETTINGS_V1,
        description: 'Push notification preferences (account-level)',
        storageScope: 'account',
        analytics: {
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
    },
    notificationChannelsV1: {
        schema: NotificationChannelsV1Schema,
        default: [deriveExpoPushNotificationChannelFromLegacySettings(DEFAULT_NOTIFICATIONS_SETTINGS_V1)],
        description: 'Canonical outbound notification channels (account-level)',
        storageScope: 'account',
        analytics: {
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
    },
    sessionHandoffDefaultsV1: {
        schema: SessionHandoffDefaultsV1Schema,
        default: DEFAULT_SESSION_HANDOFF_DEFAULTS_V1,
        description: 'Default options for session handoff between machines',
        storageScope: 'account',
        analytics: {
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
    },
});

export const ACCOUNT_WORKFLOW_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_WORKFLOW_SETTING_DEFINITIONS);
