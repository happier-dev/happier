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
import type { PendingMaterializationActiveTurnPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';

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

export function resolveSessionPendingActiveTurnDeliveryPolicy(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): PendingMaterializationActiveTurnPolicy | undefined {
  return settings?.sessionBusySteerSendPolicy === 'server_pending'
    ? undefined
    : 'allow_live_delivery';
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
  nowMs: unknown,
): boolean {
  // The local runner owns wake scheduling, not an infinite activity lease: malformed or elapsed
  // projection expiry must still fail open so queued delivery cannot be stranded permanently.
  return isSessionRuntimeActivityProjectionIdleForPendingDrain(activity, nowMs, true);
}

export type PendingQueueRuntimeActivityDeferral = Readonly<{
  defer: boolean;
  runtimeActivityExpiresAt: number | null;
}>;

export function resolvePendingQueueRuntimeActivityDeferral(params: Readonly<{
  settings: Partial<Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'>> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
}>): PendingQueueRuntimeActivityDeferral {
  const nowMs = typeof params.nowMs === 'number' && Number.isInteger(params.nowMs) && params.nowMs >= 0
    ? params.nowMs
    : null;
  const expiresAt = typeof params.activity?.runtimeActivityExpiresAt === 'number'
    && Number.isInteger(params.activity.runtimeActivityExpiresAt)
    && params.activity.runtimeActivityExpiresAt >= 0
    ? params.activity.runtimeActivityExpiresAt
    : null;
  const defer = resolveSessionPendingQueueDeliveryTiming(params.settings) === 'after_runtime_idle'
    && !runtimeIdleForPendingDrain(params.activity, params.nowMs);
  return {
    defer,
    runtimeActivityExpiresAt: defer && nowMs !== null && expiresAt !== null && expiresAt > nowMs
      ? expiresAt
      : null,
  };
}

export function shouldDeferPendingQueueDrainForRuntimeActivity(params: Readonly<{
  settings: Partial<Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'>> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
}>): boolean {
  return resolvePendingQueueRuntimeActivityDeferral(params).defer;
}
