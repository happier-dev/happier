import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
  SessionPendingQueueDeliveryTimingSchema,
  SessionPendingQueueDrainModeSchema,
  decideRuntimeIdleAdmission,
  type AccountSettings,
  type SessionRuntimeActivityProjection,
  type SessionPendingQueueDeliveryTiming,
  type SessionPendingQueueDrainMode,
} from '@happier-dev/protocol';
import type { SessionRuntimeActivityProjectionBoundary } from '@/api/session/runtimeActivityProjection';
import type { PendingForegroundSteerability } from './types';

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

export function resolveRuntimeAwarePendingForegroundSteerability(params: Readonly<{
  hasActiveProviderTurn: boolean;
  canSteerPrompt: boolean;
}>): PendingForegroundSteerability {
  return params.hasActiveProviderTurn && !params.canSteerPrompt
    ? 'unsteerable'
    : 'steerable';
}

export type PendingQueueRuntimeActivityProjection = SessionRuntimeActivityProjectionBoundary;

function readProjection(activity: PendingQueueRuntimeActivityProjection | null | undefined): SessionRuntimeActivityProjection {
  if (
    activity?.runtimeActivityState === undefined
    || activity.runtimeActivityActiveCount === undefined
    || activity.runtimeActivityObservedAt === undefined
    || activity.runtimeActivityRevision === undefined
  ) {
    return { state: 'unknown', activeCount: 0, observedAt: null, revision: 0 };
  }
  return {
    state: activity.runtimeActivityState ?? 'unknown',
    activeCount: activity.runtimeActivityActiveCount,
    observedAt: activity.runtimeActivityObservedAt ?? null,
    revision: activity.runtimeActivityRevision,
  };
}

export function resolveSessionPendingQueueDeliveryTiming(
  settings: Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'> | null | undefined,
): SessionPendingQueueDeliveryTiming {
  const parsed = SessionPendingQueueDeliveryTimingSchema.safeParse(settings?.sessionPendingQueueDeliveryTiming);
  return parsed.success ? parsed.data : DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING;
}

export function runtimeIdleForPendingDrain(
  activity: PendingQueueRuntimeActivityProjection | null | undefined,
  nowMs: unknown,
): boolean {
  void nowMs;
  return decideRuntimeIdleAdmission(readProjection(activity)).decision === 'allow';
}

export type PendingRuntimeActivityDeferredReason = "waiting_for_runtime_activity" | "runtime_activity_unknown";

export function resolvePendingRuntimeActivityDeferredReason(
  activity: PendingQueueRuntimeActivityProjection | null | undefined,
  nowMs: unknown,
): PendingRuntimeActivityDeferredReason | null {
  void nowMs;
  const decision = decideRuntimeIdleAdmission(readProjection(activity));
  if (decision.decision === 'allow') return null;
  return decision.reason === 'active' ? 'waiting_for_runtime_activity' : 'runtime_activity_unknown';
}

export function shouldDeferPendingQueueDrainForRuntimeActivity(params: Readonly<{
  settings: Pick<AccountSettings, 'sessionPendingQueueDeliveryTiming'> | null | undefined;
  activity: PendingQueueRuntimeActivityProjection | null | undefined;
  nowMs: unknown;
}>): boolean {
  return resolveSessionPendingQueueDeliveryTiming(params.settings) === 'after_runtime_idle'
    && resolvePendingRuntimeActivityDeferredReason(params.activity, params.nowMs) !== null;
}
