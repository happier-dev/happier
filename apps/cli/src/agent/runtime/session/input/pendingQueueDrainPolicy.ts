import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
  SessionPendingQueueDeliveryTimingSchema,
  SessionPendingQueueDrainModeSchema,
  isSessionRuntimeActivityProjectionIdleForPendingDrain,
  type AccountSettings,
  type SessionRuntimeActivityProjectionForPendingDrain,
  type SessionPendingQueueDeliveryTiming,
  type SessionPendingQueueDrainMode,
} from '@happier-dev/protocol';

export const PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE = 1;
export const PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE = 25;

export function resolveSessionPendingQueueDrainMode(
  settings: Pick<AccountSettings, 'sessionPendingQueueDrainMode'> | null | undefined,
): SessionPendingQueueDrainMode {
  const parsed = SessionPendingQueueDrainModeSchema.safeParse(settings?.sessionPendingQueueDrainMode);
  return parsed.success ? parsed.data : DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE;
}

export function resolveSessionPendingQueueMaxPopPerWake(
  settings: Pick<AccountSettings, 'sessionPendingQueueDrainMode'> | null | undefined,
): number {
  return resolveSessionPendingQueueDrainMode(settings) === 'drain_all'
    ? PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE
    : PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE;
}

export function resolveSessionPendingQueueDeliveryTiming(
  settings: Partial<Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'>> | null | undefined,
): SessionPendingQueueDeliveryTiming {
  const parsed = SessionPendingQueueDeliveryTimingSchema.safeParse(settings?.sessionPendingQueueDeliveryTiming);
  return parsed.success ? parsed.data : DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING;
}

export type PendingQueueRuntimeActivityProjection = SessionRuntimeActivityProjectionForPendingDrain;

export function runtimeIdleForPendingDrain(
  activity: PendingQueueRuntimeActivityProjection | null | undefined,
  _nowMs: unknown,
): boolean {
  return isSessionRuntimeActivityProjectionIdleForPendingDrain(activity);
}

export type PendingQueueRuntimeActivityDeferral = Readonly<{
  defer: boolean;
}>;

export function resolvePendingQueueRuntimeActivityDeferral(params: Readonly<{
  settings: Partial<Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'>> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
}>): PendingQueueRuntimeActivityDeferral {
  const defer = resolveSessionPendingQueueDeliveryTiming(params.settings) === 'after_runtime_idle'
    && !runtimeIdleForPendingDrain(params.activity, params.nowMs);
  return { defer };
}

export function shouldDeferPendingQueueDrainForRuntimeActivity(params: Readonly<{
  settings: Partial<Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'>> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
}>): boolean {
  return resolvePendingQueueRuntimeActivityDeferral(params).defer;
}
