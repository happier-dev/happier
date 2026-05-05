import {
  PUSH_NOTIFICATION_SOUND_IDS,
  isPushNotificationBundledSoundId,
} from '../../push/pushNotificationActions.js';
import {
  ATTENTION_DELIVERY_CHANNEL_DEFAULT_QUIET_HOURS_BEHAVIOR,
  AttentionDeliveryChannelConfigSchema,
  AttentionDeliveryChannelIdSchema,
  AttentionDeliveryEventConfigSchema,
  AttentionDeliveryPolicyV1Schema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  normalizeAttentionDeliveryEventId,
  type AttentionDeliveryChannelConfig,
  type AttentionDeliveryChannelId,
  type AttentionDeliveryDecision,
  type AttentionDeliveryDecisionReason,
  type AttentionDeliveryEventConfig,
  type AttentionDeliveryPolicyV1,
  type AttentionPreviewBehavior,
  type ResolveAttentionDeliveryPolicyDecisionParams,
} from './attentionDeliveryPolicy.js';

const TERMINAL_FRONTMOST_INTERRUPTIVE_CHANNELS = new Set<AttentionDeliveryChannelId>([
  'expo_push',
  'local_notification',
  'desktop_overlay',
]);

function normalizeDecisionEventId(event: string): string {
  return normalizeAttentionDeliveryEventId(event);
}

function parseDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function timeToMinutes(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

function getLocalTimeParts(now: Date, timezone: string): { minuteOfDay: number; day: string } {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const weekday = (parts.find((part) => part.type === 'weekday')?.value ?? 'sun').slice(0, 3).toLowerCase();
  return {
    minuteOfDay: hour * 60 + minute,
    day: weekday,
  };
}

function isQuietHoursActive(
  policy: AttentionDeliveryPolicyV1,
  now: Date,
  currentTimezone?: string,
): boolean {
  if (!policy.quietHours.enabled) return false;
  let localTimeParts: { minuteOfDay: number; day: string };
  try {
    localTimeParts = getLocalTimeParts(now, currentTimezone ?? policy.quietHours.timezone);
  } catch {
    return false;
  }
  const { minuteOfDay, day } = localTimeParts;
  return policy.quietHours.windows.some((window) => {
    const start = timeToMinutes(window.startLocalTime);
    const end = timeToMinutes(window.endLocalTime);
    if (start === end) return false;
    if (window.days && window.days.length > 0 && !window.days.includes(day as typeof window.days[number])) {
      return false;
    }
    if (start < end) {
      return minuteOfDay >= start && minuteOfDay < end;
    }
    return minuteOfDay >= start || minuteOfDay < end;
  });
}

function resolveSound(params: {
  policy: AttentionDeliveryPolicyV1;
  eventConfig: AttentionDeliveryEventConfig;
  channelConfig: AttentionDeliveryChannelConfig;
  channelEventConfig: AttentionDeliveryEventConfig;
  event: string;
}): AttentionDeliveryDecision['sound'] {
  const id =
    params.channelEventConfig.soundId
    ?? params.eventConfig.soundId
    ?? params.channelConfig.soundId
    ?? params.policy.sounds.eventSoundIds[params.event]
    ?? (
      params.policy.sounds.defaultSoundId === PUSH_NOTIFICATION_SOUND_IDS.soft
      && (params.event === 'permission_request' || params.event === 'user_action_request')
        ? PUSH_NOTIFICATION_SOUND_IDS.urgent
        : params.policy.sounds.defaultSoundId
    );
  if (id === PUSH_NOTIFICATION_SOUND_IDS.none) return { kind: 'none', volume: params.policy.sounds.volume };
  if (id === PUSH_NOTIFICATION_SOUND_IDS.systemDefault) return { kind: 'system_default', id, volume: params.policy.sounds.volume };
  if (isPushNotificationBundledSoundId(id)) return { kind: 'bundled', id, volume: params.policy.sounds.volume };
  return { kind: 'custom', id, volume: params.policy.sounds.volume };
}

function shouldSuppressForTerminalFrontmost(channel: string): boolean {
  const parsed = AttentionDeliveryChannelIdSchema.safeParse(channel);
  return parsed.success && TERMINAL_FRONTMOST_INTERRUPTIVE_CHANNELS.has(parsed.data);
}

function buildLiveActivityRemoteBehavior(
  policy: AttentionDeliveryPolicyV1,
  now: Date,
): NonNullable<AttentionDeliveryDecision['liveActivityRemoteBehavior']> {
  const remote = policy.liveActivityRemoteUpdates;
  if (!remote.enabled) {
    return { mode: 'disabled', freshness: 'unknown', reason: 'disabled' };
  }
  const staleAt = new Date(now.getTime() + remote.defaultStaleAfterSeconds * 1000).toISOString();
  return {
    mode: remote.preferredMode,
    freshness: 'fresh',
    staleAt,
    reason: 'policy',
  };
}

function buildDecision(params: {
  policy: AttentionDeliveryPolicyV1;
  event: string;
  channel: string;
  delivery: 'deliver' | 'silent' | 'suppress';
  reason: AttentionDeliveryDecisionReason;
  quietHoursActive: boolean;
  sound: AttentionDeliveryDecision['sound'];
  previewBehavior: AttentionPreviewBehavior;
  now: Date;
}): AttentionDeliveryDecision {
  const sound = params.delivery === 'silent'
    ? { kind: 'none' as const, volume: params.sound.volume }
    : params.sound;
  return {
    delivery: params.delivery,
    reason: params.reason,
    sound,
    foregroundBehavior: params.policy.foregroundBehavior,
    previewBehavior: params.previewBehavior,
    channelMetadata: {
      channel: params.channel,
      event: params.event,
      quietHoursActive: params.quietHoursActive,
    },
    badgeBehavior: {
      include: params.channel === 'badge' && params.delivery !== 'suppress',
    },
    surfaceBehavior: {
      channel: params.channel,
      suppressed: params.delivery === 'suppress',
    },
    liveActivityRemoteBehavior: params.channel === 'live_activity'
      ? buildLiveActivityRemoteBehavior(params.policy, params.now)
      : undefined,
  };
}

function parseAttentionDeliveryPolicyForDecision(policy: unknown): AttentionDeliveryPolicyV1 {
  const parsed = AttentionDeliveryPolicyV1Schema.safeParse(policy);
  return parsed.success ? parsed.data : DEFAULT_ATTENTION_DELIVERY_POLICY_V1;
}

export function resolveAttentionDeliveryPolicyDecision(
  params: ResolveAttentionDeliveryPolicyDecisionParams,
): AttentionDeliveryDecision {
  const policy = parseAttentionDeliveryPolicyForDecision(params.policy);
  const event = normalizeDecisionEventId(params.event);
  const channel = params.channel;
  const supportedChannel = AttentionDeliveryChannelIdSchema.safeParse(channel).success;
  const now = parseDate(params.now);
  const eventConfig = policy.events[event] ?? AttentionDeliveryEventConfigSchema.parse({});
  const channelConfig = policy.channels[channel] ?? AttentionDeliveryChannelConfigSchema.parse({});
  const channelEventConfig = channelConfig.events[event] ?? AttentionDeliveryEventConfigSchema.parse({});
  const quietHoursActive = isQuietHoursActive(policy, now, params.currentTimezone);
  const previewBehavior =
    channelEventConfig.previewBehavior
    ?? eventConfig.previewBehavior
    ?? channelConfig.previewBehavior
    ?? policy.privacy.surfaces[channel]
    ?? policy.privacy.defaultPreviewBehavior;
  const sound = resolveSound({ policy, eventConfig, channelConfig, channelEventConfig, event });

  const base = {
    policy,
    event,
    channel,
    quietHoursActive,
    sound,
    previewBehavior,
    now,
  };

  if (params.featureEnabled === false) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'feature_disabled' });
  }
  if (params.platformSupported === false) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'unsupported_surface' });
  }
  if (!supportedChannel) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'unsupported_surface' });
  }
  if (eventConfig.enabled === false) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'event_disabled' });
  }
  if (channelConfig.enabled === false) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'channel_disabled' });
  }
  if (channelEventConfig.enabled === false) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'event_disabled' });
  }
  if (params.sameSessionVisible === true) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'same_session_visible' });
  }
  if (params.terminalFrontmost === true && shouldSuppressForTerminalFrontmost(channel)) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'terminal_frontmost' });
  }
  if (
    params.foregroundState === 'foreground'
    && (channel === 'expo_push' || channel === 'local_notification')
    && policy.foregroundBehavior !== 'full'
  ) {
    return buildDecision({
      ...base,
      delivery: policy.foregroundBehavior === 'silent' ? 'silent' : 'suppress',
      reason: 'foreground_suppressed',
    });
  }
  if (quietHoursActive) {
    const behavior =
      channel === 'live_activity'
        ? policy.liveActivityRemoteUpdates.quietHoursBehavior
        : channelEventConfig.quietHoursBehavior
          ?? eventConfig.quietHoursBehavior
          ?? channelConfig.quietHoursBehavior
          ?? ATTENTION_DELIVERY_CHANNEL_DEFAULT_QUIET_HOURS_BEHAVIOR[channel as AttentionDeliveryChannelId]
          ?? 'suppress';
    if (behavior !== 'deliver') {
      return buildDecision({ ...base, delivery: behavior, reason: 'quiet_hours' });
    }
  }

  return buildDecision({ ...base, delivery: 'deliver', reason: 'deliver' });
}
