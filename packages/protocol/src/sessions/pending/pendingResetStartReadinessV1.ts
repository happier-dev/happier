import type { ProviderAccountUsageSnapshotV1 } from '../../connect/providerAccountUsagePrimitives.js';
import { readProviderAccountUsageWindowComparabilityReason, resolveProviderAccountUsagePaceWindow } from '../../connect/deriveProviderAccountUsagePace.js';
import { isConnectedServiceQuotaObservationFresh } from '../../connect/quotaObservationTime.js';
import type { PendingResetStartBindingV1 } from './pendingRequestedActionV1.js';
import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const PendingResetStartWaitingReasonV1Schema = lazyZodSchema(() => z.enum([
  'authority_unavailable', 'witness_unavailable', 'unknown_window', 'before_reset',
  'quota_unavailable', 'quota_stale', 'reset_not_observed', 'window_changed',
  'window_expired', 'entitlement_changed', 'denominator_changed',
]));
export const PendingResetStartReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready') }).strict(),
  z.object({ status: z.literal('waiting'), reason: PendingResetStartWaitingReasonV1Schema,
    nextCheckAtMs: z.number().int().nonnegative().optional() }).strict(),
]));
export type PendingResetStartWaitingReasonV1 = z.infer<typeof PendingResetStartWaitingReasonV1Schema>;
export type PendingResetStartReadinessV1 = z.infer<typeof PendingResetStartReadinessV1Schema>;

/** Called only after protected B snapshots have been opened under current authority. */
export function evaluatePendingResetStartReadinessV1(input: Readonly<{
  reset: PendingResetStartBindingV1;
  witness: ProviderAccountUsageSnapshotV1 | null;
  current: ProviderAccountUsageSnapshotV1 | null;
  nowMs: number;
  authorityCurrent: boolean;
}>): PendingResetStartReadinessV1 {
  let nextCheckAtMs: number | undefined;
  const wait = (reason: PendingResetStartWaitingReasonV1): PendingResetStartReadinessV1 => ({ status: 'waiting', reason,
    ...(nextCheckAtMs !== undefined ? { nextCheckAtMs } : {}) });
  if (!input.authorityCurrent) return wait('authority_unavailable');
  const previous = input.witness;
  if (!previous || previous.state !== 'loaded_data' || previous.recordId !== input.reset.recordId || previous.fetchedAtMs !== input.reset.witness.observedAtMs) return wait('witness_unavailable');
  const window = resolveProviderAccountUsagePaceWindow(previous, input.reset.meterId);
  if (!window) return wait('unknown_window');
  if (input.nowMs < window.resetAtMs) nextCheckAtMs = window.resetAtMs;
  const current = input.current;
  if (!current || current.state !== 'loaded_data' || current.recordId !== input.reset.recordId
    || current.meters.find(meter => meter.meterId === input.reset.meterId)?.status === 'unavailable') return wait('quota_unavailable');
  if (!isConnectedServiceQuotaObservationFresh({ observedAtMs: current.observedAtMs, nowMs: input.nowMs, maxAgeMs: current.staleAfterMs })) return wait('quota_stale');
  const next = resolveProviderAccountUsagePaceWindow(current, input.reset.meterId);
  if (!next) return wait('unknown_window');
  const reason = readProviderAccountUsageWindowComparabilityReason({ previous, current, meterId: input.reset.meterId });
  if (reason) return wait(reason);
  if (nextCheckAtMs !== undefined) {
    if (next.windowStartAtMs !== window.windowStartAtMs || next.resetAtMs !== window.resetAtMs
      || next.windowDurationMs !== window.windowDurationMs) return wait('window_changed');
    return wait('before_reset');
  }
  if (current.observedAtMs < window.resetAtMs) return wait('reset_not_observed');
  if (input.nowMs >= next.resetAtMs) return wait('window_expired');
  if (next.windowStartAtMs !== window.resetAtMs || next.windowDurationMs !== window.windowDurationMs) return wait('window_changed');
  return { status: 'ready' };
}
