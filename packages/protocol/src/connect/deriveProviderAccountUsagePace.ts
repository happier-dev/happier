import type { ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { ProviderAccountUsageRecordIdSchema } from './providerAccountUsagePrimitives.js';
import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isConnectedServiceQuotaObservationFresh } from './quotaObservationTime.js';
import type { ConnectedServiceQuotaMeterV1 } from './connectedServiceSchemas.js';

export const ProviderAccountUsagePaceWindowV1Schema = lazyZodSchema(() => z.object({
  recordId: ProviderAccountUsageRecordIdSchema, meterId: z.string().min(1),
  resetAtMs: z.number().int().nonnegative(), windowStartAtMs: z.number().int().nonnegative(), windowDurationMs: z.number().int().positive(),
}).strict());
export type ProviderAccountUsagePaceWindowV1 = z.infer<typeof ProviderAccountUsagePaceWindowV1Schema>;
export const ProviderAccountUsagePaceV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), window: ProviderAccountUsagePaceWindowV1Schema, usedFraction: z.number().finite().nonnegative(), elapsedFraction: z.number().finite().positive().max(1), evenPaceFraction: z.number().finite().positive().max(1), pace: z.number().finite().nonnegative(), projectedResetUtilizationFraction: z.number().finite().nonnegative(), qualification: z.enum(['confirmed', 'estimated']), sampleCount: z.number().int().positive(), empiricalRange: z.object({ min: z.number().finite().nonnegative(), max: z.number().finite().nonnegative() }).strict().optional(),
    observedCurve: z.array(z.object({ observedAtMs: z.number().int().nonnegative(), usedFraction: z.number().finite().nonnegative() }).strict()).optional(),
    depletesAtMs: z.number().int().nonnegative().nullable().optional(),
  }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['not_loaded','stale','unknown_window','zero_elapsed','outside_window','unknown_utilization','inconsistent_counters','counter_reset','reset_changed','denominator_changed','entitlement_changed','non_renewing_end']) }).strict(),
]));
export type ProviderAccountUsagePaceV1 = z.infer<typeof ProviderAccountUsagePaceV1Schema>;
export const ProviderAccountUsageUnusedCapacityV1Schema = lazyZodSchema(() => z.object({
  historyStatus: z.enum(['not_loaded', 'unavailable', 'partial', 'returned_page']),
  windows: z.array(z.object({ window: ProviderAccountUsagePaceWindowV1Schema, value: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), unusedAmount: z.number().finite().nonnegative(), unusedFraction: z.number().finite().min(0).max(1), unit: z.string().min(1), observedAtMs: z.number().int().nonnegative(), sampleCount: z.number().int().positive(), qualification: z.enum(['confirmed', 'estimated']), method: z.enum(['terminal_observation', 'linear_pace_at_last_observation']) }).strict(),
    z.object({ status: z.literal('insufficient_basis'), reason: z.string().min(1) }).strict(),
  ]) }).strict()),
}).strict());

export function resolveProviderAccountUsagePaceWindow(snapshot: ProviderAccountUsageSnapshotV1, meterId: string): ProviderAccountUsagePaceWindowV1 | null {
  const meter = snapshot.meters.find(value => value.meterId === meterId);
  const resetAtMs = meter?.resetAtMs ?? meter?.resetsAt;
  const duration = meter?.windowDurationMs;
  if (resetAtMs == null || duration == null || duration <= 0 || resetAtMs < duration) return null;
  if (meter?.resetAtMs != null && meter.resetsAt != null && meter.resetAtMs !== meter.resetsAt) return null;
  return { recordId: snapshot.recordId, meterId, resetAtMs, windowStartAtMs: resetAtMs - duration, windowDurationMs: duration };
}

function fraction(meter: ConnectedServiceQuotaMeterV1): number | null {
  if (meter.status === 'unavailable') return null;
  if (meter.used != null && meter.limit != null) return meter.limit > 0 && meter.used >= 0 ? meter.used / meter.limit : null;
  if (meter.usedPct != null) return meter.usedPct / 100;
  if (meter.utilizationPct != null) return meter.utilizationPct / 100;
  if (meter.remainingPct != null) return 1 - meter.remainingPct / 100;
  return null;
}

function hasInconsistentCounters(meter: ConnectedServiceQuotaMeterV1): boolean {
  if (meter.remaining == null || meter.limit == null || meter.used == null) return false;
  const total = meter.used + meter.remaining;
  // Decimal credits permit representation/addition error, not a percentage
  // discrepancy or a product quota threshold.
  const roundingError = Number.EPSILON * Math.abs(meter.used) + Number.EPSILON * Math.abs(meter.remaining) + Number.EPSILON * Math.abs(meter.limit);
  return !Number.isFinite(total) || Math.abs(total - meter.limit) > roundingError;
}

function entitlement(snapshot: ProviderAccountUsageSnapshotV1): string {
  const subscription = snapshot.subscription;
  return JSON.stringify([snapshot.planLabel ?? null, subscription?.status ?? null, subscription?.renewal ?? null]);
}

function exceedsNonRenewingEntitlement(snapshot: ProviderAccountUsageSnapshotV1, window: ProviderAccountUsagePaceWindowV1): boolean {
  const subscription = snapshot.subscription;
  return subscription?.renewal === 'off' && subscription.currentPeriodEndAtMs != null && subscription.currentPeriodEndAtMs < window.resetAtMs;
}

/** Shared pace/reset comparability; cycle dates themselves are checked by the caller. */
export function readProviderAccountUsageWindowComparabilityReason(input: Readonly<{ previous: ProviderAccountUsageSnapshotV1; current: ProviderAccountUsageSnapshotV1; meterId: string }>): 'unknown_window' | 'entitlement_changed' | 'denominator_changed' | null {
  const { previous, current, meterId } = input;
  const before = previous.meters.find(value => value.meterId === meterId);
  const after = current.meters.find(value => value.meterId === meterId);
  if (previous.recordId !== current.recordId || !before || !after) return 'unknown_window';
  const currentWindow = resolveProviderAccountUsagePaceWindow(current, meterId);
  if (currentWindow && exceedsNonRenewingEntitlement(current, currentWindow)) return 'entitlement_changed';
  if (entitlement(previous) !== entitlement(current)) return 'entitlement_changed';
  const previousPeriod = previous.subscription;
  const currentPeriod = current.subscription;
  if (JSON.stringify([previousPeriod?.currentPeriodStartAtMs ?? null, previousPeriod?.currentPeriodEndAtMs ?? null]) !== JSON.stringify([currentPeriod?.currentPeriodStartAtMs ?? null, currentPeriod?.currentPeriodEndAtMs ?? null])) {
    const beforeWindow = resolveProviderAccountUsagePaceWindow(previous, meterId);
    const afterWindow = resolveProviderAccountUsagePaceWindow(current, meterId);
    const alignedRollover = beforeWindow && afterWindow
      && beforeWindow.windowDurationMs === afterWindow.windowDurationMs
      && beforeWindow.resetAtMs === afterWindow.windowStartAtMs
      && previousPeriod?.currentPeriodStartAtMs === beforeWindow.windowStartAtMs
      && previousPeriod?.currentPeriodEndAtMs === beforeWindow.resetAtMs
      && currentPeriod?.currentPeriodStartAtMs === afterWindow.windowStartAtMs
      && currentPeriod?.currentPeriodEndAtMs === afterWindow.resetAtMs;
    if (!alignedRollover) return 'entitlement_changed';
  }
  if (JSON.stringify([before.limit, before.unit, before.modelId ?? null, before.providerLimitId ?? null, before.limitScope ?? null, before.scope ?? null]) !== JSON.stringify([after.limit, after.unit, after.modelId ?? null, after.providerLimitId ?? null, after.limitScope ?? null, after.scope ?? null])) return 'denominator_changed';
  return null;
}

/** A ratio at the witnessed observation, not an assumed extrapolation to now. */
export function deriveProviderAccountUsagePace(input: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; meterId: string; nowMs: number; history?: readonly ProviderAccountUsageSnapshotV1[] }>): ProviderAccountUsagePaceV1 {
  return deriveWitnessedPace(input, false);
}

function deriveWitnessedPace(input: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; meterId: string; nowMs: number; history?: readonly ProviderAccountUsageSnapshotV1[] }>, terminal: boolean): ProviderAccountUsagePaceV1 {
  const { snapshot, meterId, nowMs } = input;
  const unavailable = (reason: Extract<ProviderAccountUsagePaceV1, { status: 'unavailable' }>['reason']): ProviderAccountUsagePaceV1 => ({ status: 'unavailable', reason });
  if (snapshot.state === 'not_loaded' || snapshot.state === 'loaded_empty') return unavailable('not_loaded');
  if (snapshot.state !== 'loaded_data' || !isConnectedServiceQuotaObservationFresh({ observedAtMs: snapshot.observedAtMs, nowMs, maxAgeMs: snapshot.staleAfterMs })) return unavailable('stale');
  const window = resolveProviderAccountUsagePaceWindow(snapshot, meterId);
  if (!window) return unavailable('unknown_window');
  if (exceedsNonRenewingEntitlement(snapshot, window)) return unavailable('non_renewing_end');
  const elapsedFraction = (snapshot.observedAtMs - window.windowStartAtMs) / window.windowDurationMs;
  if (elapsedFraction === 0) return unavailable('zero_elapsed');
  if (elapsedFraction < 0 || elapsedFraction > 1 || (terminal ? nowMs > window.resetAtMs : nowMs >= window.resetAtMs)) return unavailable('outside_window');
  const meter = snapshot.meters.find(value => value.meterId === meterId)!;
  const usedFraction = fraction(meter);
  if (usedFraction == null) return unavailable('unknown_utilization');
  if (hasInconsistentCounters(meter)) return unavailable('inconsistent_counters');
  const rates = new Map<string, number>();
  const observedCurve = new Map<number, number>();
  for (const previous of input.history ?? []) {
    if (previous.recordId !== snapshot.recordId || previous.observedAtMs >= snapshot.observedAtMs || previous.observedAtMs < window.windowStartAtMs) continue;
    const previousMeter = previous.meters.find(value => value.meterId === meterId);
    if (!previousMeter) continue;
    const previousWindow = resolveProviderAccountUsagePaceWindow(previous, meterId);
    // A completed cycle can have its final observation at the next cycle's
    // exact start. It is not a sample of the current actual window.
    if (previousWindow && previousWindow.resetAtMs <= window.windowStartAtMs && previous.observedAtMs <= previousWindow.resetAtMs) continue;
    const incompatible = readProviderAccountUsageWindowComparabilityReason({ previous, current: snapshot, meterId });
    if (incompatible) return unavailable(incompatible);
    if (!previousWindow) return unavailable('unknown_window');
    if (previousWindow.resetAtMs !== window.resetAtMs || previousWindow.windowDurationMs !== window.windowDurationMs) return unavailable('reset_changed');
    if (hasInconsistentCounters(previousMeter)) return unavailable('inconsistent_counters');
    const previousFraction = fraction(previousMeter);
    if (previousFraction == null) continue;
    if (previousFraction > usedFraction) return unavailable('counter_reset');
    observedCurve.set(previous.observedAtMs, previousFraction);
    const previousElapsed = (previous.observedAtMs - window.windowStartAtMs) / window.windowDurationMs;
    if (previousElapsed > 0 && previousElapsed <= 1) rates.set(JSON.stringify([previous.observedAtMs, previousFraction]), previousFraction / previousElapsed);
  }
  const pace = usedFraction / elapsedFraction;
  rates.set(JSON.stringify([snapshot.observedAtMs, usedFraction]), pace);
  observedCurve.set(snapshot.observedAtMs, usedFraction);
  const depletesAtMs = pace > 1 ? Math.round(window.windowStartAtMs + window.windowDurationMs / pace) : null;
  const values = [...rates.values()];
  return { status: 'available', window, usedFraction, elapsedFraction, evenPaceFraction: elapsedFraction, pace, projectedResetUtilizationFraction: pace, qualification: snapshot.confidence === 'confirmed' && meter.status === 'ok' ? 'confirmed' : 'estimated', sampleCount: values.length, ...(values.length > 1 ? { empiricalRange: { min: Math.min(...values), max: Math.max(...values) } } : {}),
    observedCurve: [...observedCurve].sort(([left], [right]) => left - right).map(([observedAtMs, usedFraction]) => ({ observedAtMs, usedFraction })),
    depletesAtMs: depletesAtMs !== null && depletesAtMs < window.resetAtMs ? depletesAtMs : null,
  };
}

/** Returned accepted history only; a pre-reset projection is never a measured loss. */
export function deriveProviderAccountUsageUnusedCapacity(input: Readonly<{ history?: readonly ProviderAccountUsageSnapshotV1[]; partial?: boolean; nowMs: number }>): z.infer<typeof ProviderAccountUsageUnusedCapacityV1Schema> {
  const groups = new Map<string, { window: ProviderAccountUsagePaceWindowV1; samples: ProviderAccountUsageSnapshotV1[] }>();
  for (const snapshot of input.history ?? []) for (const meter of snapshot.meters) {
    const window = resolveProviderAccountUsagePaceWindow(snapshot, meter.meterId);
    if (!window || window.resetAtMs > input.nowMs) continue;
    const key = JSON.stringify(window);
    const group = groups.get(key) ?? { window, samples: [] };
    group.samples.push(snapshot); groups.set(key, group);
  }
  return { historyStatus: input.history === undefined ? 'not_loaded' : input.partial ? 'partial' : 'returned_page', windows: [...groups.values()].map(({ window, samples }) => {
    const sorted = [...samples].sort((a, b) => a.observedAtMs - b.observedAtMs);
    const latest = sorted[sorted.length - 1]!;
    const insufficient = (reason: string) => ({ window, value: { status: 'insufficient_basis' as const, reason } });
    for (const previous of sorted.slice(0, -1)) {
      const incompatible = readProviderAccountUsageWindowComparabilityReason({ previous, current: latest, meterId: window.meterId });
      if (incompatible) return insufficient(incompatible);
    }
    const meter = latest.meters.find(value => value.meterId === window.meterId)!;
    if (meter.limit == null || meter.limit <= 0 || meter.used == null || !meter.unit) return insufficient('unknown_denominator');
    const terminal = latest.observedAtMs === window.resetAtMs;
    const pace = deriveWitnessedPace({ snapshot: latest, meterId: window.meterId, nowMs: latest.observedAtMs, history: sorted }, terminal);
    if (pace.status === 'unavailable') return insufficient(pace.reason);
    const unusedFraction = Math.max(0, 1 - pace.projectedResetUtilizationFraction);
    return { window, value: { status: 'available' as const, unusedAmount: unusedFraction * meter.limit, unusedFraction, unit: meter.unit,
      observedAtMs: latest.observedAtMs, sampleCount: pace.sampleCount, qualification: terminal ? pace.qualification : 'estimated' as const,
      method: terminal ? 'terminal_observation' as const : 'linear_pace_at_last_observation' as const } };
  }) };
}
