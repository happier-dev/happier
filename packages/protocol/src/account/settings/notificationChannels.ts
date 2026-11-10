import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  SecretStringV1Schema,
  type SecretStringV1,
} from '../../crypto/settingsSecretStringSchemasV1.js';
import type { NotificationsSettingsV1 } from './accountSettings.js';

export const BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID = 'builtin:expo_push';

function normalizeNotificationChannelTopicsV1Input(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(record, 'connectedServiceQuotaRecovered')
    && record.connectedServiceQuotaBlocked === false
  ) {
    return {
      ...record,
      connectedServiceQuotaRecovered: false,
    };
  }
  return raw;
}

const NotificationChannelTopicsFieldsV1Schema = lazyZodSchema(() => z.object({
  ready: z._default(z.boolean(), true),
  permissionRequest: z._default(z.boolean(), true),
  userActionRequest: z._default(z.boolean(), true),
  connectedServiceAccountSwitch: z._default(z.boolean(), true),
  connectedServiceQuotaBlocked: z._default(z.boolean(), true),
  connectedServiceQuotaRecovered: z._default(z.boolean(), true),
  connectedServiceUsage: z._default(z.boolean(), false),
  machines: z._default(z.boolean(), true),
}));

export const NotificationChannelTopicsStrictV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeNotificationChannelTopicsV1Input), (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(NotificationChannelTopicsFieldsV1Schema)));

export const NotificationChannelTopicsV1Schema = lazyZodSchema(() => z.catch((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeNotificationChannelTopicsV1Input), NotificationChannelTopicsFieldsV1Schema), {
    ready: true,
    permissionRequest: true,
    userActionRequest: true,
    connectedServiceAccountSwitch: true,
    connectedServiceQuotaBlocked: true,
    connectedServiceQuotaRecovered: true,
    connectedServiceUsage: false,
    machines: true,
  }));

export type NotificationChannelTopicsV1 = z.infer<typeof NotificationChannelTopicsV1Schema>;

export const DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1: NotificationChannelTopicsV1 =
  NotificationChannelTopicsV1Schema.parse({});

const NotificationChannelBaseV1Schema = lazyZodSchema(() => z.object({
  v: z._default(z.literal(1), 1),
  id: z.string().check(z.trim(), z.minLength(1)),
  enabled: z._default(z.boolean(), true),
  topics: z._default(NotificationChannelTopicsV1Schema, DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1),
  readyIncludeMessageText: z._default(z.boolean(), true),
  requestIncludeMessageText: z._default(z.boolean(), true),
}));

export const ExpoPushNotificationChannelV1Schema = lazyZodSchema(() => z.extend(NotificationChannelBaseV1Schema, {
  kind: z.literal('expo_push'),
}));

export type ExpoPushNotificationChannelV1 = z.infer<typeof ExpoPushNotificationChannelV1Schema>;

const WebhookUrlSchema = lazyZodSchema(() => z.url().check(z.refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, {
  message: 'Webhook notification channels must use http or https URLs',
})));

export const WebhookNotificationChannelV1Schema = lazyZodSchema(() => z.extend(NotificationChannelBaseV1Schema, {
  kind: z.literal('webhook'),
  url: WebhookUrlSchema,
  signingSecret: z._default(z.nullable(SecretStringV1Schema), null),
}));

export type WebhookNotificationChannelV1 = z.infer<typeof WebhookNotificationChannelV1Schema>;

export function hasConfiguredSecretStringValue(secret: SecretStringV1 | null | undefined): boolean {
  if (!secret) return false;
  if (typeof secret.value === 'string' && secret.value.length > 0) return true;
  return secret.encryptedValue !== undefined;
}

export const NotificationChannelV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ExpoPushNotificationChannelV1Schema,
  WebhookNotificationChannelV1Schema,
]));

export type NotificationChannelV1 = z.infer<typeof NotificationChannelV1Schema>;

export const NotificationChannelsV1Schema = lazyZodSchema(() => z._default(z.array(NotificationChannelV1Schema), []));

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
      connectedServiceAccountSwitch: settings.connectedServiceAccountSwitch !== false,
      connectedServiceQuotaBlocked: settings.connectedServiceQuotaBlocked !== false,
      connectedServiceQuotaRecovered: settings.connectedServiceQuotaRecovered !== false,
    },
    readyIncludeMessageText: settings.readyIncludeMessageText !== false,
    requestIncludeMessageText: settings.requestIncludeMessageText !== false,
  });
}
