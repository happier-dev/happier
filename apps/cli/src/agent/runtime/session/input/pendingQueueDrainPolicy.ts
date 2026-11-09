import { DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING, SessionPendingQueueDeliveryTimingSchema } from '@happier-dev/protocol/account/settings/sessionPendingQueueDeliveryTiming';
import { isSessionRuntimeActivityProjectionIdleForPendingDrain } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import type { AccountSettings, SessionRuntimeActivityProjectionForPendingDrain, SessionPendingQueueDeliveryTiming } from '@happier-dev/protocol';

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
