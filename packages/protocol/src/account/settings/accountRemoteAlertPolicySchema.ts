import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  AttentionPreviewBehaviorSchema,
  AttentionQuietHoursBehaviorSchema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS,
  type RemoteAlertAttentionDeliveryEventId,
} from './attentionDeliveryPolicy.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES } from './catalog/accountSettingBounds.js';
import { PUSH_NOTIFICATION_SOUND_IDS } from '../../push/pushNotificationActions.js';

// Wire admission must not load Settings derivation or the effective Action catalog.
export const RemoteAlertSoundIdSchema = lazyZodSchema(() => z.enum([
  PUSH_NOTIFICATION_SOUND_IDS.none,
  PUSH_NOTIFICATION_SOUND_IDS.systemDefault,
  PUSH_NOTIFICATION_SOUND_IDS.soft,
  PUSH_NOTIFICATION_SOUND_IDS.urgent,
]));
export type RemoteAlertSoundId = z.infer<typeof RemoteAlertSoundIdSchema>;

const RemoteAlertEventPolicySchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  quietHoursBehavior: AttentionQuietHoursBehaviorSchema.optional(),
  previewBehavior: AttentionPreviewBehaviorSchema.optional(),
  soundId: RemoteAlertSoundIdSchema.optional(),
}).strict());

const RemoteAlertEventPolicyMapV1Shape = Object.fromEntries(
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS.map((eventId) => [eventId, RemoteAlertEventPolicySchema]),
) as Record<RemoteAlertAttentionDeliveryEventId, typeof RemoteAlertEventPolicySchema>;

export const RemoteAlertEventPolicyMapV1Schema = lazyZodSchema(() => z.object(RemoteAlertEventPolicyMapV1Shape).strict());
export type RemoteAlertEventPolicyMapV1 = z.infer<typeof RemoteAlertEventPolicyMapV1Schema>;

const RemoteAlertChannelPolicyV1Schema = lazyZodSchema(() => RemoteAlertEventPolicySchema.extend({
  events: RemoteAlertEventPolicyMapV1Schema,
}).strict());

const RemoteAlertQuietHoursWindowV1Schema = lazyZodSchema(() => z.object({
  startLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
}).strict());

export const RemoteAlertQuietHoursV1Schema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  timezone: z.string().trim().min(1),
  windows: z.array(RemoteAlertQuietHoursWindowV1Schema),
}).strict());
export type RemoteAlertQuietHoursV1 = z.infer<typeof RemoteAlertQuietHoursV1Schema>;

const RemoteAlertEventSoundMapV1Schema = lazyZodSchema(() => z.object(Object.fromEntries(
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS.map((eventId) => [eventId, RemoteAlertSoundIdSchema.optional()]),
) as Record<RemoteAlertAttentionDeliveryEventId, z.ZodOptional<typeof RemoteAlertSoundIdSchema>>).strict());

// A projection only removes private fields and normalizes supported choices. Reserve
// the complete existing settings budget plus canonical default expansion; do not
// introduce a separate quiet-hours window count or truncate a valid schedule.
export const ACCOUNT_REMOTE_ALERT_POLICY_MAX_UTF8_BYTES = ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES
  + new TextEncoder().encode(JSON.stringify(DEFAULT_ATTENTION_DELIVERY_POLICY_V1)).byteLength;

export const AccountRemoteAlertPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  events: RemoteAlertEventPolicyMapV1Schema,
  channels: z.object({ expo_push: RemoteAlertChannelPolicyV1Schema }).strict(),
  quietHours: RemoteAlertQuietHoursV1Schema,
  foregroundBehavior: z.enum(['full', 'silent', 'off']),
  mutePhoneWhenComputerFocused: z.boolean().optional(),
  privacy: z.object({
    defaultPreviewBehavior: AttentionPreviewBehaviorSchema,
    surfaces: z.object({ expo_push: AttentionPreviewBehaviorSchema.optional() }).strict(),
  }).strict(),
  sounds: z.object({
    defaultSoundId: RemoteAlertSoundIdSchema,
    eventSoundIds: RemoteAlertEventSoundMapV1Schema,
    volume: z.number().min(0).max(1),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ACCOUNT_REMOTE_ALERT_POLICY_MAX_UTF8_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Remote alert policy exceeds the Account settings encoding bound' });
  }
}));
export type AccountRemoteAlertPolicyV1 = z.infer<typeof AccountRemoteAlertPolicyV1Schema>;

export const AccountRemoteAlertPolicyBindingV1Schema = lazyZodSchema(() => z.object({
  settingsVersion: z.number().int().nonnegative(),
  policy: AccountRemoteAlertPolicyV1Schema,
}).strict());

export const DeviceRemoteAlertPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  enabled: z.boolean(),
  nativeConsumer: z.enum(['ios_service_extension_v1', 'android_native_v1']),
  quietHoursOverride: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('account') }).strict(),
    z.object({ mode: z.literal('disabled') }).strict(),
    z.object({ mode: z.literal('custom'), timezone: z.string().trim().min(1), windows: z.array(RemoteAlertQuietHoursWindowV1Schema) }).strict(),
  ]),
  foregroundBehavior: z.enum(['account', 'full', 'silent', 'off']),
  previewCeiling: z.enum(['account', 'status_only', 'title_only', 'include_preview']),
  soundVolume: z.number().min(0).max(1),
}).strict());
export type DeviceRemoteAlertPolicyV1 = z.infer<typeof DeviceRemoteAlertPolicyV1Schema>;
