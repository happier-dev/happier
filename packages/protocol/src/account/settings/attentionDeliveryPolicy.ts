import { z } from 'zod';

import { PUSH_NOTIFICATION_SOUND_IDS } from '../../push/pushNotificationActions.js';

export const AttentionDeliveryEventIdSchema = z.enum([
  'ready',
  'permission_request',
  'user_action_request',
  'session_started',
  'task_acknowledged',
  'task_completed',
  'task_failed',
  'resource_limit',
  'probe_detected',
  'connected_service_account_switch',
  'connected_service_quota_blocked',
  'connected_service_quota_recovered',
]);
export type AttentionDeliveryEventId = z.infer<typeof AttentionDeliveryEventIdSchema>;

export const AttentionDeliveryChannelIdSchema = z.enum([
  'expo_push',
  'webhook',
  'local_notification',
  'badge',
  'desktop_overlay',
  'live_activity',
  'home_widget',
]);
export type AttentionDeliveryChannelId = z.infer<typeof AttentionDeliveryChannelIdSchema>;

export const AttentionPreviewBehaviorSchema = z.enum(['status_only', 'title_only', 'include_preview']);
export type AttentionPreviewBehavior = z.infer<typeof AttentionPreviewBehaviorSchema>;

export const AttentionQuietHoursBehaviorSchema = z.enum(['deliver', 'silent', 'suppress']);
export type AttentionQuietHoursBehavior = z.infer<typeof AttentionQuietHoursBehaviorSchema>;

export const LiveActivityRemoteUpdateModeSchema = z.enum([
  'disabled',
  'local_only',
  'hosted_happier_relay',
  'direct_apns',
  'background_wake_best_effort',
]);
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

export const AttentionDeliveryEventConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    quietHoursBehavior: AttentionQuietHoursBehaviorSchema.optional().catch(undefined),
    previewBehavior: AttentionPreviewBehaviorSchema.optional().catch(undefined),
    soundId: z.string().trim().min(1).optional().catch(undefined),
  })
  .passthrough()
  .catch({ enabled: true });

export type AttentionDeliveryEventConfig = z.infer<typeof AttentionDeliveryEventConfigSchema>;

const EventMapSchema = z
  .preprocess(
    rekeyEventRecord,
    z.record(z.string(), AttentionDeliveryEventConfigSchema).catch({}),
  )
  .transform((events) => {
    const withDefaults: Record<string, AttentionDeliveryEventConfig> = { ...events };
    for (const id of CANONICAL_EVENT_IDS) {
      withDefaults[id] = AttentionDeliveryEventConfigSchema.parse(withDefaults[id]);
    }
    return withDefaults;
  });

export const AttentionDeliveryChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    events: EventMapSchema.default({}),
    quietHoursBehavior: AttentionQuietHoursBehaviorSchema.optional().catch(undefined),
    previewBehavior: AttentionPreviewBehaviorSchema.optional().catch(undefined),
    soundId: z.string().trim().min(1).optional().catch(undefined),
  })
  .passthrough()
  .catch({
    enabled: true,
    events: EventMapSchema.parse({}),
  });

export type AttentionDeliveryChannelConfig = z.infer<typeof AttentionDeliveryChannelConfigSchema>;

export const ATTENTION_DELIVERY_CHANNEL_DEFAULT_QUIET_HOURS_BEHAVIOR = {
  expo_push: 'suppress',
  webhook: 'deliver',
  local_notification: 'suppress',
  badge: 'deliver',
  desktop_overlay: 'deliver',
  live_activity: 'silent',
  home_widget: 'silent',
} as const satisfies Record<AttentionDeliveryChannelId, AttentionQuietHoursBehavior>;

const ChannelMapSchema = z
  .preprocess(
    (raw) => (isRecord(raw) ? raw : {}),
    z.record(z.string(), AttentionDeliveryChannelConfigSchema).catch({}),
  )
  .transform((channels) => {
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
  });

const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const QuietHoursWindowSchema = z
  .object({
    startLocalTime: LocalTimeSchema,
    endLocalTime: LocalTimeSchema,
    days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional().catch(undefined),
  })
  .passthrough();

const QuietHoursSchema = z
  .object({
    enabled: z.boolean().default(false),
    timezone: z.string().trim().min(1).default('UTC'),
    windows: z.array(QuietHoursWindowSchema).default([]),
  })
  .passthrough()
  .catch({
    enabled: false,
    timezone: 'UTC',
    windows: [],
  });

const SoundsSchema = z
  .object({
    defaultSoundId: z.string().trim().min(1).default(PUSH_NOTIFICATION_SOUND_IDS.soft),
    eventSoundIds: z.preprocess(
      rekeyEventRecord,
      z.record(z.string(), z.string().trim().min(1)).catch({}),
    ).default({}),
    volume: z.number().min(0).max(1).default(1).catch(1),
  })
  .passthrough()
  .catch({
    defaultSoundId: PUSH_NOTIFICATION_SOUND_IDS.soft,
    eventSoundIds: {},
    volume: 1,
  });

const PrivacySchema = z
  .object({
    defaultPreviewBehavior: AttentionPreviewBehaviorSchema.default('include_preview'),
    surfaces: z.record(z.string(), AttentionPreviewBehaviorSchema).default({}).catch({}),
  })
  .passthrough()
  .catch({
    defaultPreviewBehavior: 'include_preview',
    surfaces: {},
  });

const LiveActivityRemoteUpdatesSchema = z
  .object({
    enabled: z.boolean().default(true),
    preferredMode: LiveActivityRemoteUpdateModeSchema.default('local_only'),
    allowBackgroundWakeFallback: z.boolean().default(false),
    defaultStaleAfterSeconds: z.number().int().positive().max(86_400).default(1800).catch(1800),
    quietHoursBehavior: AttentionQuietHoursBehaviorSchema.default('silent'),
  })
  .passthrough()
  .catch({
    enabled: true,
    preferredMode: 'local_only',
    allowBackgroundWakeFallback: false,
    defaultStaleAfterSeconds: 1800,
    quietHoursBehavior: 'silent',
  });

export const AttentionDeliveryPolicyV1Schema = z
  .object({
    v: z.literal(1).default(1),
    events: EventMapSchema.default(EventMapSchema.parse({})),
    channels: ChannelMapSchema.default(ChannelMapSchema.parse({})),
    quietHours: QuietHoursSchema.default(QuietHoursSchema.parse({})),
    foregroundBehavior: z.enum(['full', 'silent', 'off']).default('full'),
    privacy: PrivacySchema.default(PrivacySchema.parse({})),
    sounds: SoundsSchema.default(SoundsSchema.parse({})),
    liveActivityRemoteUpdates: LiveActivityRemoteUpdatesSchema.default(LiveActivityRemoteUpdatesSchema.parse({})),
  })
  .passthrough();

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
  | 'terminal_frontmost';

export type AttentionDeliveryDecision = {
  delivery: 'deliver' | 'silent' | 'suppress';
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
};
