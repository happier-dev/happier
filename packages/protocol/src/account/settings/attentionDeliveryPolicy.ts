import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PUSH_NOTIFICATION_SOUND_IDS } from '../../push/pushNotificationActions.js';
import type { InboxItemAttentionTypeV1, ResolveFollowDeliveryV1Params } from '../../sessions/follow/sessionFollowPolicyV1.js';

const ATTENTION_DELIVERY_EVENT_DEFINITIONS = [
  { id: 'ready', remoteAlert: true },
  { id: 'permission_request', remoteAlert: true },
  { id: 'user_action_request', remoteAlert: true },
  { id: 'follow_update', remoteAlert: true },
  { id: 'machine_offline', remoteAlert: true },
  { id: 'service_health', remoteAlert: true },
  { id: 'notify_me', remoteAlert: false },
  { id: 'session_started', remoteAlert: false },
  { id: 'task_acknowledged', remoteAlert: false },
  { id: 'task_completed', remoteAlert: false },
  { id: 'task_failed', remoteAlert: false },
  { id: 'resource_limit', remoteAlert: false },
  { id: 'guard_stop_warning', remoteAlert: false },
  { id: 'guard_attention', remoteAlert: false },
  { id: 'machine_guard_activity', remoteAlert: false },
  { id: 'probe_detected', remoteAlert: false },
  { id: 'connected_service_account_switch', remoteAlert: false },
  { id: 'connected_service_quota_blocked', remoteAlert: false },
  { id: 'connected_service_quota_recovered', remoteAlert: false },
  { id: 'connected_service_usage', remoteAlert: false },
] as const;

type AttentionDeliveryEventDefinition = (typeof ATTENTION_DELIVERY_EVENT_DEFINITIONS)[number];
type AttentionDeliveryEventIdTuple = {
  [Index in keyof typeof ATTENTION_DELIVERY_EVENT_DEFINITIONS]:
    (typeof ATTENTION_DELIVERY_EVENT_DEFINITIONS)[Index] extends Readonly<{ id: infer EventId extends string }>
      ? EventId
      : never;
};

const ATTENTION_DELIVERY_EVENT_IDS = ATTENTION_DELIVERY_EVENT_DEFINITIONS
  .map(({ id }) => id) as unknown as AttentionDeliveryEventIdTuple;

export const AttentionDeliveryEventIdSchema = lazyZodSchema(() => z.enum(ATTENTION_DELIVERY_EVENT_IDS));
export type AttentionDeliveryEventId = z.infer<typeof AttentionDeliveryEventIdSchema>;

/**
 * The remote-alert projection is derived from the one canonical event
 * definition behind `AttentionDeliveryEventIdSchema`; consumers never repeat
 * the supported string set.
 */
export type RemoteAlertAttentionDeliveryEventId =
  Extract<AttentionDeliveryEventDefinition, Readonly<{ remoteAlert: true }>>['id'];
export const REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS = ATTENTION_DELIVERY_EVENT_DEFINITIONS
  .filter(
    (definition): definition is Extract<AttentionDeliveryEventDefinition, Readonly<{ remoteAlert: true }>> =>
      definition.remoteAlert,
  )
  .map(({ id }) => id);

export const AttentionDeliveryChannelIdSchema = lazyZodSchema(() => z.enum([
  'expo_push',
  'webhook',
  'plugin',
  'local_notification',
  'badge',
  'desktop_overlay',
  'live_activity',
  'home_widget',
]));
export type AttentionDeliveryChannelId = z.infer<typeof AttentionDeliveryChannelIdSchema>;

export const AttentionPreviewBehaviorSchema = lazyZodSchema(() => z.enum(['status_only', 'title_only', 'include_preview']));
export type AttentionPreviewBehavior = z.infer<typeof AttentionPreviewBehaviorSchema>;

export const AttentionQuietHoursBehaviorSchema = lazyZodSchema(() => z.enum(['deliver', 'silent', 'suppress']));
export type AttentionQuietHoursBehavior = z.infer<typeof AttentionQuietHoursBehaviorSchema>;

export const LiveActivityRemoteUpdateModeSchema = lazyZodSchema(() => z.enum([
  'disabled',
  'local_only',
  'hosted_happier_relay',
  'direct_apns',
  'background_wake_best_effort',
]));
export type LiveActivityRemoteUpdateMode = z.infer<typeof LiveActivityRemoteUpdateModeSchema>;

const CANONICAL_EVENT_IDS = AttentionDeliveryEventIdSchema.options;
const CANONICAL_CHANNEL_IDS = AttentionDeliveryChannelIdSchema.options;

const LEGACY_EVENT_ID_MAP: Record<string, AttentionDeliveryEventId> = {
  ready: 'ready',
  permissionRequest: 'permission_request',
  permission_request: 'permission_request',
  userActionRequest: 'user_action_request',
  user_action_request: 'user_action_request',
  connectedServiceAccountSwitch: 'connected_service_account_switch',
  connected_service_account_switch: 'connected_service_account_switch',
  connectedServiceQuotaBlocked: 'connected_service_quota_blocked',
  connected_service_quota_blocked: 'connected_service_quota_blocked',
  connectedServiceQuotaRecovered: 'connected_service_quota_recovered',
  connected_service_quota_recovered: 'connected_service_quota_recovered',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAttentionDeliveryEventId(id: string): string {
  return LEGACY_EVENT_ID_MAP[id] ?? id;
}

function rekeyEventRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    result[normalizeAttentionDeliveryEventId(key)] = value;
  }
  return result;
}

export const AttentionDeliveryEventConfigSchema = lazyZodSchema(() => z.catch(z.looseObject({
    enabled: z._default(z.boolean(), true),
    quietHoursBehavior: z.catch(z.optional(AttentionQuietHoursBehaviorSchema), undefined),
    previewBehavior: z.catch(z.optional(AttentionPreviewBehaviorSchema), undefined),
    soundId: z.catch(z.optional(z.string().check(z.trim(), z.minLength(1))), undefined),
  }), { enabled: true }));

export type AttentionDeliveryEventConfig = z.infer<typeof AttentionDeliveryEventConfigSchema>;

const EventMapSchema = lazyZodSchema(() => z.pipe((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(rekeyEventRecord), z.catch(z.record(z.string(), AttentionDeliveryEventConfigSchema), {})), z.transform((events) => {
    const withDefaults: Record<string, AttentionDeliveryEventConfig> = { ...events };
    for (const id of CANONICAL_EVENT_IDS) {
      withDefaults[id] = AttentionDeliveryEventConfigSchema.parse(withDefaults[id]);
    }
    return withDefaults;
  })));

export const AttentionDeliveryChannelConfigSchema = lazyZodSchema(() => z.catch(z.looseObject({
    enabled: z._default(z.boolean(), true),
    events: z._default(EventMapSchema, {}),
    quietHoursBehavior: z.catch(z.optional(AttentionQuietHoursBehaviorSchema), undefined),
    previewBehavior: z.catch(z.optional(AttentionPreviewBehaviorSchema), undefined),
    soundId: z.catch(z.optional(z.string().check(z.trim(), z.minLength(1))), undefined),
  }), {
    enabled: true,
    events: EventMapSchema.parse({}),
  }));

export type AttentionDeliveryChannelConfig = z.infer<typeof AttentionDeliveryChannelConfigSchema>;

export const ATTENTION_DELIVERY_CHANNEL_DEFAULT_QUIET_HOURS_BEHAVIOR = {
  expo_push: 'suppress',
  webhook: 'deliver',
  // Preserve the policy owner's suppress fallback for an otherwise unspecified channel.
  plugin: 'suppress',
  local_notification: 'suppress',
  badge: 'deliver',
  desktop_overlay: 'deliver',
  live_activity: 'silent',
  home_widget: 'silent',
} as const satisfies Record<AttentionDeliveryChannelId, AttentionQuietHoursBehavior>;

const ChannelMapSchema = lazyZodSchema(() => z.pipe((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => (isRecord(raw) ? raw : {})), z.catch(z.record(z.string(), AttentionDeliveryChannelConfigSchema), {})), z.transform((channels) => {
    const withDefaults: Record<string, AttentionDeliveryChannelConfig> = { ...channels };
    for (const id of CANONICAL_CHANNEL_IDS) {
      withDefaults[id] = {
        ...AttentionDeliveryChannelConfigSchema.parse(withDefaults[id]),
        quietHoursBehavior:
          AttentionDeliveryChannelConfigSchema.parse(withDefaults[id]).quietHoursBehavior
          ?? ATTENTION_DELIVERY_CHANNEL_DEFAULT_QUIET_HOURS_BEHAVIOR[id],
      };
    }
    return withDefaults;
  })));

const LocalTimeSchema = lazyZodSchema(() => z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/)));

/** Current schedule authoring uses the existing local-time and weekday contract. */
export const AttentionQuietHoursWindowInputSchema = lazyZodSchema(() => z.strictObject({
    startLocalTime: LocalTimeSchema,
    endLocalTime: LocalTimeSchema,
    days: z.optional(z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))),
  }));
export const AttentionQuietHoursInputSchema = lazyZodSchema(() => z.strictObject({
    enabled: z.boolean(),
    timezone: z.string().check(z.trim(), z.minLength(1), z.refine(timezone => {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); return true; }
      catch { return false; }
    })),
    windows: z.array(AttentionQuietHoursWindowInputSchema),
  }));
export type AttentionQuietHoursInput = z.infer<typeof AttentionQuietHoursInputSchema>;

const QuietHoursWindowSchema = lazyZodSchema(() => z.looseObject({
    ...AttentionQuietHoursWindowInputSchema.shape,
    days: z.catch(AttentionQuietHoursWindowInputSchema.shape.days, undefined),
  }));

const QuietHoursSchema = lazyZodSchema(() => z.catch(z.looseObject({
    enabled: z._default(z.boolean(), false),
    timezone: z._default(z.string().check(z.trim(), z.minLength(1)), 'UTC'),
    windows: z._default(z.array(QuietHoursWindowSchema), []),
  }), {
    enabled: false,
    timezone: 'UTC',
    windows: [],
  }));

const SoundsSchema = lazyZodSchema(() => z.catch(z.looseObject({
    defaultSoundId: z._default(z.string().check(z.trim(), z.minLength(1)), PUSH_NOTIFICATION_SOUND_IDS.soft),
    eventSoundIds: z._default((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(rekeyEventRecord), z.catch(z.record(z.string(), z.string().check(z.trim(), z.minLength(1))), {})), {}),
    volume: z.catch(z._default(z.number().check(z.minimum(0), z.maximum(1)), 1), 1),
  }), {
    defaultSoundId: PUSH_NOTIFICATION_SOUND_IDS.soft,
    eventSoundIds: {},
    volume: 1,
  }));

const PrivacySchema = lazyZodSchema(() => z.catch(z.looseObject({
    defaultPreviewBehavior: z._default(AttentionPreviewBehaviorSchema, 'include_preview'),
    surfaces: z.catch(z._default(z.record(z.string(), AttentionPreviewBehaviorSchema), {}), {}),
  }), {
    defaultPreviewBehavior: 'include_preview',
    surfaces: {},
  }));

const LiveActivityRemoteUpdatesSchema = lazyZodSchema(() => z.catch(z.looseObject({
    enabled: z._default(z.boolean(), true),
    preferredMode: z._default(LiveActivityRemoteUpdateModeSchema, 'local_only'),
    allowBackgroundWakeFallback: z._default(z.boolean(), false),
    defaultStaleAfterSeconds: z.catch(z._default(z.number().check(z.int(), z.positive(), z.maximum(86_400)), 1800), 1800),
    quietHoursBehavior: z._default(AttentionQuietHoursBehaviorSchema, 'silent'),
  }), {
    enabled: true,
    preferredMode: 'local_only',
    allowBackgroundWakeFallback: false,
    defaultStaleAfterSeconds: 1800,
    quietHoursBehavior: 'silent',
  }));

export const AttentionDeliveryPolicyV1Schema = lazyZodSchema(() => z.looseObject({
    v: z._default(z.literal(1), 1),
    events: z._default(EventMapSchema, EventMapSchema.parse({})),
    channels: z._default(ChannelMapSchema, ChannelMapSchema.parse({})),
    quietHours: z._default(QuietHoursSchema, QuietHoursSchema.parse({})),
    foregroundBehavior: z._default(z.enum(['full', 'silent', 'off']), 'full'),
    mutePhoneWhenComputerFocused: z.catch(z.optional(z.boolean()), undefined),
    privacy: z._default(PrivacySchema, PrivacySchema.parse({})),
    sounds: z._default(SoundsSchema, SoundsSchema.parse({})),
    liveActivityRemoteUpdates: z._default(LiveActivityRemoteUpdatesSchema, LiveActivityRemoteUpdatesSchema.parse({})),
  }));

export type AttentionDeliveryPolicyV1 = z.infer<typeof AttentionDeliveryPolicyV1Schema>;

export const DEFAULT_ATTENTION_DELIVERY_POLICY_V1: AttentionDeliveryPolicyV1 =
  AttentionDeliveryPolicyV1Schema.parse({});

export type AttentionDeliveryDecisionReason =
  | 'deliver'
  | 'event_disabled'
  | 'channel_disabled'
  | 'quiet_hours'
  | 'same_session_visible'
  | 'foreground_suppressed'
  | 'unsupported_surface'
  | 'feature_disabled'
  | 'privacy_restricted'
  | 'follow_policy'
  | 'terminal_frontmost';

export type AttentionDeliveryDecision = {
  delivery: 'deliver' | 'silent' | 'suppress';
  suppressIfComputerFocused?: true;
  reason: AttentionDeliveryDecisionReason;
  sound: {
    kind: 'none' | 'system_default' | 'bundled' | 'custom';
    id?: string;
    volume: number;
  };
  foregroundBehavior: 'full' | 'silent' | 'off';
  previewBehavior: AttentionPreviewBehavior;
  channelMetadata: {
    channel: string;
    event: string;
    quietHoursActive: boolean;
  };
  badgeBehavior: {
    include: boolean;
  };
  surfaceBehavior: {
    channel: string;
    suppressed: boolean;
  };
  liveActivityRemoteBehavior?: {
    mode: LiveActivityRemoteUpdateMode;
    freshness: 'fresh' | 'stale' | 'unknown';
    staleAt?: string;
    reason: 'policy' | 'disabled';
  };
};

export type ResolveAttentionDeliveryPolicyDecisionParams = {
  policy?: unknown;
  event: string;
  channel: string;
  now: Date | string;
  currentTimezone?: string;
  foregroundState?: 'foreground' | 'background';
  sameSessionVisible?: boolean;
  terminalFrontmost?: boolean;
  featureEnabled?: boolean;
  platformSupported?: boolean;
  follow?: ResolveFollowDeliveryV1Params;
  inboxItemType?: InboxItemAttentionTypeV1;
};

export function composeAttentionDeliveryPolicyDeviceOverrides(policy: AttentionDeliveryPolicyV1, overrides: Readonly<{
  quietHoursOverride:
    | Readonly<{ mode: 'account' | 'disabled' }>
    | Readonly<{
        mode: 'custom';
        timezone: string;
        windows: ReadonlyArray<Readonly<{
          startLocalTime: string;
          endLocalTime: string;
          days?: ReadonlyArray<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>;
        }>>;
      }>;
  foregroundBehavior: 'account' | AttentionDeliveryPolicyV1['foregroundBehavior'];
  previewBehavior: 'account' | AttentionPreviewBehavior;
  soundVolume: number;
}>): AttentionDeliveryPolicyV1 {
  const result = AttentionDeliveryPolicyV1Schema.parse(policy);
  const quiet = overrides.quietHoursOverride;
  if (quiet.mode === 'disabled') result.quietHours = { ...result.quietHours, enabled: false, windows: [] };
  if (quiet.mode === 'custom') result.quietHours = {
    enabled: true, timezone: quiet.timezone,
    windows: quiet.windows.map((window) => ({ ...window, days: window.days ? [...window.days] : undefined })),
  };
  if (overrides.foregroundBehavior !== 'account') result.foregroundBehavior = overrides.foregroundBehavior;
  if (overrides.previewBehavior !== 'account') result.privacy.defaultPreviewBehavior = overrides.previewBehavior;
  result.sounds.volume = overrides.soundVolume;
  return result;
}
