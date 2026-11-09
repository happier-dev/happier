import {
  PUSH_NOTIFICATION_SOUND_IDS,
  isPushNotificationBundledSoundId,
} from '../../push/pushNotificationActions.js';
import { resolveFollowDeliveryV1, resolveInboxItemAttentionV1 } from '../../sessions/follow/sessionFollowPolicyV1.js';
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

/** An explicit Account opt-in and observed computer focus are both required. */
export function shouldMuteMobileAlertsForComputerFocus(params: Readonly<{
  mutePhoneWhenComputerFocused: unknown;
  computerFocused: unknown;
}>): boolean {
  return params.mutePhoneWhenComputerFocused === true && params.computerFocused === true;
}

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

function createLocalTimeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function getLocalTimeParts(now: Date, formatter: Intl.DateTimeFormat): { minuteOfDay: number; day: string } {
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const weekday = (parts.find((part) => part.type === 'weekday')?.value ?? 'sun').slice(0, 3).toLowerCase();
  return {
    minuteOfDay: hour * 60 + minute,
    day: weekday,
  };
}

const PREVIOUS_WEEKDAY = {
  mon: 'sun',
  tue: 'mon',
  wed: 'tue',
  thu: 'wed',
  fri: 'thu',
  sat: 'fri',
  sun: 'sat',
} as const;

function isQuietHoursActive(
  policy: AttentionDeliveryPolicyV1,
  now: Date,
  currentTimezone?: string,
): boolean {
  if (!policy.quietHours.enabled) return false;
  let localTimeParts: { minuteOfDay: number; day: string };
  try {
    localTimeParts = getLocalTimeParts(now, createLocalTimeFormatter(currentTimezone ?? policy.quietHours.timezone));
  } catch {
    return false;
  }
  return isQuietHoursActiveAtLocalTime(policy, localTimeParts);
}

function isQuietHoursActiveAtLocalTime(
  policy: AttentionDeliveryPolicyV1,
  { minuteOfDay, day }: { minuteOfDay: number; day: string },
): boolean {
  return policy.quietHours.windows.some((window) => {
    const start = timeToMinutes(window.startLocalTime);
    const end = timeToMinutes(window.endLocalTime);
    if (start === end) return false;
    const days = window.days;
    const includesDay = (candidate: string): boolean =>
      !days || days.length === 0 || days.includes(candidate as typeof days[number]);
    if (start < end) {
      return includesDay(day) && minuteOfDay >= start && minuteOfDay < end;
    }
    if (minuteOfDay >= start) return includesDay(day);
    if (minuteOfDay >= end) return false;
    return includesDay(PREVIOUS_WEEKDAY[day as keyof typeof PREVIOUS_WEEKDAY] ?? day);
  });
}

/** Exact next change of the canonical quiet-hours predicate, for one-shot wakeups.
 * HH:mm schedules change on minute boundaries. Enumerate actual instants rather
 * than converting wall times ourselves: IANA gaps, repeats and overnight days
 * then have exactly the same meaning as delivery decisions. Callers retain this
 * deadline until it elapses or their immutable policy changes, never per commit.
 */
export function readNextAttentionQuietHoursBoundaryMs(
  policy: AttentionDeliveryPolicyV1,
  now: Date,
  currentTimezone?: string,
): number | null {
  if (!policy.quietHours.enabled || !Number.isFinite(now.getTime())) return null;
  const days = Object.keys(PREVIOUS_WEEKDAY);
  // An empty or fully covered weekly schedule cannot change. Check its only
  // possible local transition points before searching actual time; this also
  // avoids a made-up search horizon that could miss a DST-skipped weekly window.
  const hasTransition = days.some((day) => policy.quietHours.windows.some((window) =>
    [window.startLocalTime, window.endLocalTime].some((time) => {
      const minuteOfDay = timeToMinutes(time);
      return isQuietHoursActiveAtLocalTime(policy, { day, minuteOfDay }) !== isQuietHoursActiveAtLocalTime(policy, {
        day: minuteOfDay === 0 ? PREVIOUS_WEEKDAY[day as keyof typeof PREVIOUS_WEEKDAY] : day,
        minuteOfDay: minuteOfDay === 0 ? 1_439 : minuteOfDay - 1,
      });
    })));
  if (!hasTransition) return null;
  try {
    const formatter = createLocalTimeFormatter(currentTimezone ?? policy.quietHours.timezone);
    const active = isQuietHoursActiveAtLocalTime(policy, getLocalTimeParts(now, formatter));
    for (let instant = (Math.floor(now.getTime() / 60_000) + 1) * 60_000; ; instant += 60_000) {
      if (isQuietHoursActiveAtLocalTime(policy, getLocalTimeParts(new Date(instant), formatter)) !== active) return instant;
    }
  } catch {
    // Match delivery admission for invalid/unavailable IANA zones or dates.
    return null;
  }
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
    ...(params.policy.mutePhoneWhenComputerFocused === true
      && params.channel === 'expo_push'
      && ['ready', 'permission_request', 'user_action_request'].includes(params.event)
      ? { suppressIfComputerFocused: true as const }
      : {}),
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

// Surface passes decide once per candidate from one immutable policy object, so a parse
// per decision scales with the Session count. Callers hold their policy object stable
// (readEffectivePolicy keys it by settings identity), and a new policy is a new object.
const parsedDecisionPolicies = new WeakMap<object, AttentionDeliveryPolicyV1>();

function parseAttentionDeliveryPolicyForDecision(policy: unknown): AttentionDeliveryPolicyV1 {
  const retainable = typeof policy === 'object' && policy !== null;
  const retained = retainable ? parsedDecisionPolicies.get(policy) : undefined;
  if (retained) return retained;
  const parsed = AttentionDeliveryPolicyV1Schema.safeParse(policy);
  const result = parsed.success ? parsed.data : DEFAULT_ATTENTION_DELIVERY_POLICY_V1;
  if (retainable) parsedDecisionPolicies.set(policy, result);
  return result;
}

export function resolveAttentionDeliveryPreviewBehavior(params: Readonly<{
  policy: unknown;
  event: string;
  channel: string;
}>): AttentionPreviewBehavior {
  const policy = parseAttentionDeliveryPolicyForDecision(params.policy);
  const event = normalizeDecisionEventId(params.event);
  const channel = params.channel;
  const eventConfig = policy.events[event] ?? AttentionDeliveryEventConfigSchema.parse({});
  const channelConfig = policy.channels[channel] ?? AttentionDeliveryChannelConfigSchema.parse({});
  const channelEventConfig = channelConfig.events[event] ?? AttentionDeliveryEventConfigSchema.parse({});
  return resolveParsedPreviewBehavior({ policy, event, channel, eventConfig, channelConfig, channelEventConfig });
}

function resolveParsedPreviewBehavior({ policy, event, channel, eventConfig, channelConfig, channelEventConfig }: Readonly<{
  policy: AttentionDeliveryPolicyV1;
  event: string;
  channel: string;
  eventConfig: AttentionDeliveryEventConfig;
  channelConfig: AttentionDeliveryChannelConfig;
  channelEventConfig: AttentionDeliveryEventConfig;
}>): AttentionPreviewBehavior {
  return channelEventConfig.previewBehavior
    ?? eventConfig.previewBehavior
    // Keep request previews independent of ready previews; explicit request policies take precedence.
    ?? ((channel === 'expo_push' || channel === 'webhook' || channel === 'live_activity')
      && (event === 'permission_request' || event === 'user_action_request') ? 'include_preview' : undefined)
    ?? channelConfig.previewBehavior
    ?? policy.privacy.surfaces[channel]
    ?? policy.privacy.defaultPreviewBehavior;
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
  const previewBehavior = resolveParsedPreviewBehavior({ policy, event, channel, eventConfig, channelConfig, channelEventConfig });
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
  const follow = params.follow ? resolveFollowDeliveryV1(params.follow)
    : params.inboxItemType ? resolveInboxItemAttentionV1(params.inboxItemType) : null;
  if (follow && (!follow.person.inbox || !follow.person.push
    && channel !== 'badge' && channel !== 'live_activity' && channel !== 'home_widget')) {
    return buildDecision({ ...base, delivery: 'suppress', reason: 'follow_policy' });
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
