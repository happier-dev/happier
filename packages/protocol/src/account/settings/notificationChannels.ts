import { z } from 'zod';

import { SecretStringV1Schema, type SecretStringV1 } from '../../crypto/settingsSecretStringsV1.js';
import type { NotificationsSettingsV1 } from './accountSettings.js';

export const BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID = 'builtin:expo_push';

export const NotificationChannelTopicsV1Schema = z
  .object({
    ready: z.boolean().default(true),
    permissionRequest: z.boolean().default(true),
    userActionRequest: z.boolean().default(true),
  })
  .catch({
    ready: true,
    permissionRequest: true,
    userActionRequest: true,
  });

export type NotificationChannelTopicsV1 = z.infer<typeof NotificationChannelTopicsV1Schema>;

export const DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1: NotificationChannelTopicsV1 =
  NotificationChannelTopicsV1Schema.parse({});

const NotificationChannelBaseV1Schema = z.object({
  v: z.literal(1).default(1),
  id: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  topics: NotificationChannelTopicsV1Schema.default(DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1),
  readyIncludeMessageText: z.boolean().default(true),
});

export const ExpoPushNotificationChannelV1Schema = NotificationChannelBaseV1Schema.extend({
  kind: z.literal('expo_push'),
});

export type ExpoPushNotificationChannelV1 = z.infer<typeof ExpoPushNotificationChannelV1Schema>;

const WebhookUrlSchema = z.url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, {
  message: 'Webhook notification channels must use http or https URLs',
});

export const WebhookNotificationChannelV1Schema = NotificationChannelBaseV1Schema.extend({
  kind: z.literal('webhook'),
  url: WebhookUrlSchema,
  signingSecret: SecretStringV1Schema.nullable().default(null),
});

export type WebhookNotificationChannelV1 = z.infer<typeof WebhookNotificationChannelV1Schema>;

export function hasConfiguredSecretStringValue(secret: SecretStringV1 | null | undefined): boolean {
  if (!secret) return false;
  if (typeof secret.value === 'string' && secret.value.trim().length > 0) return true;
  return secret.encryptedValue !== undefined;
}

export const NotificationChannelV1Schema = z.discriminatedUnion('kind', [
  ExpoPushNotificationChannelV1Schema,
  WebhookNotificationChannelV1Schema,
]);

export type NotificationChannelV1 = z.infer<typeof NotificationChannelV1Schema>;

export const NotificationChannelsV1Schema = z.array(NotificationChannelV1Schema).default([]);

export type NotificationChannelsV1 = z.infer<typeof NotificationChannelsV1Schema>;

export function deriveExpoPushNotificationChannelFromLegacySettings(
  settings: Readonly<NotificationsSettingsV1>,
): ExpoPushNotificationChannelV1 {
  return ExpoPushNotificationChannelV1Schema.parse({
    v: 1,
    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    kind: 'expo_push',
    enabled: settings.pushEnabled !== false,
    topics: {
      ready: settings.ready !== false,
      permissionRequest: settings.permissionRequest !== false,
      userActionRequest: settings.userActionRequest !== false,
    },
    readyIncludeMessageText: settings.readyIncludeMessageText !== false,
  });
}
