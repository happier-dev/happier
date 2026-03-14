import { z } from 'zod';

import { ActionsSettingsV1Schema, type ActionsSettingsV1 } from '../../actions/actionSettings.js';
import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  NotificationChannelsV1Schema,
  deriveExpoPushNotificationChannelFromLegacySettings,
  type NotificationChannelV1,
  type NotificationChannelsV1,
} from './notificationChannels.js';

export const ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION = 2;

export const ForegroundBehaviorSchema = z.enum(['full', 'silent', 'off']);
export type ForegroundBehavior = z.infer<typeof ForegroundBehaviorSchema>;

export const NotificationsSettingsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    pushEnabled: z.boolean().default(true),
    ready: z.boolean().default(true),
    readyIncludeMessageText: z.boolean().default(true),
    permissionRequest: z.boolean().default(true),
    userActionRequest: z.boolean().default(true),
    foregroundBehavior: ForegroundBehaviorSchema.default('full'),
  })
  .catch({
    v: 1,
    pushEnabled: true,
    ready: true,
    readyIncludeMessageText: true,
    permissionRequest: true,
    userActionRequest: true,
    foregroundBehavior: 'full',
  });

export type NotificationsSettingsV1 = z.infer<typeof NotificationsSettingsV1Schema>;

export const DEFAULT_NOTIFICATIONS_SETTINGS_V1: NotificationsSettingsV1 = NotificationsSettingsV1Schema.parse({});

export const DEFAULT_ACTIONS_SETTINGS_V1: ActionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1 });

const BackendEnabledByIdSchema = z.record(z.string(), z.boolean()).catch({});

function backfillNotificationChannelsV1(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };

  if (next.notificationChannelsV1 !== undefined) {
    const parsed = NotificationChannelsV1Schema.safeParse(next.notificationChannelsV1);
    if (parsed.success) {
      next.notificationChannelsV1 = parsed.data;
    } else {
      delete next.notificationChannelsV1;
    }
  }

  if (next.notificationChannelsV1 === undefined) {
    next.notificationChannelsV1 = [
      deriveExpoPushNotificationChannelFromLegacySettings(
        NotificationsSettingsV1Schema.parse(raw.notificationsSettingsV1),
      ),
    ];
  }

  return next;
}

// This is the canonical, forward-compatible schema for the server-synced account settings blob.
// It MUST preserve unknown keys so newer clients can add fields without breaking older ones.
export const AccountSettingsSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return backfillNotificationChannelsV1(raw as Record<string, unknown>);
  },
  z
    .object({
      schemaVersion: z
        .number()
        .int()
        .min(0)
        .catch(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION)
        .default(ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION),
      backendEnabledById: BackendEnabledByIdSchema.default({}),
      scmIncludeCoAuthoredBy: z.boolean().optional().catch(undefined),
      actionsSettingsV1: ActionsSettingsV1Schema.catch(DEFAULT_ACTIONS_SETTINGS_V1).default(DEFAULT_ACTIONS_SETTINGS_V1),
      notificationsSettingsV1: NotificationsSettingsV1Schema.default(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
      notificationChannelsV1: NotificationChannelsV1Schema.default([
        deriveExpoPushNotificationChannelFromLegacySettings(DEFAULT_NOTIFICATIONS_SETTINGS_V1),
      ]),
    })
    .passthrough(),
);

export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export function accountSettingsParse(raw: unknown): AccountSettings {
  return AccountSettingsSchema.parse(raw);
}

export function getNotificationsSettingsV1FromAccountSettings(settingsLike: unknown): NotificationsSettingsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  return NotificationsSettingsV1Schema.parse(rec?.notificationsSettingsV1);
}

export function resolveNotificationChannelsV1FromAccountSettings(settingsLike: unknown): NotificationChannelsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  const explicit = NotificationChannelsV1Schema.parse(rec?.notificationChannelsV1);
  if (rec && Object.prototype.hasOwnProperty.call(rec, 'notificationChannelsV1')) return explicit;
  return [deriveExpoPushNotificationChannelFromLegacySettings(getNotificationsSettingsV1FromAccountSettings(rec))];
}

export { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID };
export type { NotificationChannelV1, NotificationChannelsV1 };
