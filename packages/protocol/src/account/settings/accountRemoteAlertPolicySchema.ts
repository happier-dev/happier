import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  AttentionPreviewBehaviorSchema,
  AttentionQuietHoursBehaviorSchema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS,
  type RemoteAlertAttentionDeliveryEventId,
} from './attentionDeliveryPolicy.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES } from './catalog/accountSettingBounds.js';
import { PUSH_NOTIFICATION_SOUND_IDS } from '../../push/pushNotificationActions.js';
import { DEFAULT_MACHINE_OFFLINE_ALERTS_V1, MachineOfflineAlertsV1Schema } from './machineOfflineAlertsV1.js';

// Wire admission must not load Settings derivation or the effective Action catalog.
export const RemoteAlertSoundIdSchema = lazyZodSchema(() => z.enum([
  PUSH_NOTIFICATION_SOUND_IDS.none,
  PUSH_NOTIFICATION_SOUND_IDS.systemDefault,
  PUSH_NOTIFICATION_SOUND_IDS.soft,
  PUSH_NOTIFICATION_SOUND_IDS.urgent,
]));
export type RemoteAlertSoundId = z.infer<typeof RemoteAlertSoundIdSchema>;

const RemoteAlertEventPolicySchema = lazyZodSchema(() => z.strictObject({
  enabled: z.boolean(),
  quietHoursBehavior: z.optional(AttentionQuietHoursBehaviorSchema),
  previewBehavior: z.optional(AttentionPreviewBehaviorSchema),
  soundId: z.optional(RemoteAlertSoundIdSchema),
}));

const RemoteAlertEventPolicyMapV1Shape = Object.fromEntries(
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS.map((eventId) => [eventId,
    eventId === 'machine_offline' ? z._default(RemoteAlertEventPolicySchema, { enabled: false }) : RemoteAlertEventPolicySchema,
  ]),
) as Record<RemoteAlertAttentionDeliveryEventId, typeof RemoteAlertEventPolicySchema | z.ZodMiniDefault<typeof RemoteAlertEventPolicySchema>>;

export const RemoteAlertEventPolicyMapV1Schema = lazyZodSchema(() => z.strictObject(RemoteAlertEventPolicyMapV1Shape));
export type RemoteAlertEventPolicyMapV1 = z.infer<typeof RemoteAlertEventPolicyMapV1Schema>;

const RemoteAlertChannelPolicyV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RemoteAlertEventPolicySchema, {
  events: RemoteAlertEventPolicyMapV1Schema,
})));

const RemoteAlertQuietHoursWindowV1Schema = lazyZodSchema(() => z.strictObject({
  startLocalTime: z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
  endLocalTime: z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
  days: z.optional(z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))),
}));

export const RemoteAlertQuietHoursV1Schema = lazyZodSchema(() => z.strictObject({
  enabled: z.boolean(),
  timezone: z.string().check(z.trim(), z.minLength(1)),
  windows: z.array(RemoteAlertQuietHoursWindowV1Schema),
}));
export type RemoteAlertQuietHoursV1 = z.infer<typeof RemoteAlertQuietHoursV1Schema>;

const RemoteAlertEventSoundMapV1Schema = lazyZodSchema(() => z.strictObject(Object.fromEntries(
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS.map((eventId) => [eventId, z.optional(RemoteAlertSoundIdSchema)]),
) as Record<RemoteAlertAttentionDeliveryEventId, z.ZodMiniOptional<typeof RemoteAlertSoundIdSchema>>));

// A projection only removes private fields and normalizes supported choices. Reserve
// the complete existing settings budget plus canonical default expansion; do not
// introduce a separate quiet-hours window count or truncate a valid schedule.
export const ACCOUNT_REMOTE_ALERT_POLICY_MAX_UTF8_BYTES = ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES
  + new TextEncoder().encode(JSON.stringify(DEFAULT_ATTENTION_DELIVERY_POLICY_V1)).byteLength;

export const AccountRemoteAlertPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineOffline: z._default(MachineOfflineAlertsV1Schema, DEFAULT_MACHINE_OFFLINE_ALERTS_V1),
  events: RemoteAlertEventPolicyMapV1Schema,
  channels: z.strictObject({ expo_push: RemoteAlertChannelPolicyV1Schema }),
  quietHours: RemoteAlertQuietHoursV1Schema,
  foregroundBehavior: z.enum(['full', 'silent', 'off']),
  mutePhoneWhenComputerFocused: z.optional(z.boolean()),
  privacy: z.strictObject({
    defaultPreviewBehavior: AttentionPreviewBehaviorSchema,
    surfaces: z.strictObject({ expo_push: z.optional(AttentionPreviewBehaviorSchema) }),
  }),
  sounds: z.strictObject({
    defaultSoundId: RemoteAlertSoundIdSchema,
    eventSoundIds: RemoteAlertEventSoundMapV1Schema,
    volume: z.number().check(z.minimum(0), z.maximum(1)),
  }),
}).check(z.superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ACCOUNT_REMOTE_ALERT_POLICY_MAX_UTF8_BYTES) {
    ctx.addIssue({ code: "custom", message: 'Remote alert policy exceeds the Account settings encoding bound' });
  }
})));
export type AccountRemoteAlertPolicyV1 = z.infer<typeof AccountRemoteAlertPolicyV1Schema>;

export const AccountRemoteAlertPolicyBindingV1Schema = lazyZodSchema(() => z.strictObject({
  settingsVersion: z.number().check(z.int(), z.nonnegative()),
  policy: AccountRemoteAlertPolicyV1Schema,
}));

export const DeviceRemoteAlertPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  enabled: z.boolean(),
  nativeConsumer: z.enum(['ios_service_extension_v1', 'android_native_v1']),
  quietHoursOverride: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('account') }),
    z.strictObject({ mode: z.literal('disabled') }),
    z.strictObject({ mode: z.literal('custom'), timezone: z.string().check(z.trim(), z.minLength(1)), windows: z.array(RemoteAlertQuietHoursWindowV1Schema) }),
  ]),
  foregroundBehavior: z.enum(['account', 'full', 'silent', 'off']),
  previewCeiling: z.enum(['account', 'status_only', 'title_only', 'include_preview']),
  soundVolume: z.number().check(z.minimum(0), z.maximum(1)),
}));
export type DeviceRemoteAlertPolicyV1 = z.infer<typeof DeviceRemoteAlertPolicyV1Schema>;
