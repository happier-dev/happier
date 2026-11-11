import type { ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { ProviderAccountUsageRecordIdSchema } from './providerAccountUsagePrimitives.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isConnectedServiceQuotaObservationFresh } from './quotaObservationTime.js';
import type { ConnectedServiceQuotaMeterV1 } from './connectedServiceSchemas.js';

export const ProviderAccountUsagePaceWindowV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema, meterId: z.string().check(z.minLength(1)),
  resetAtMs: z.number().check(z.int(), z.nonnegative()), windowStartAtMs: z.number().check(z.int(), z.nonnegative()), windowDurationMs: z.number().check(z.int(), z.positive()),
}));
export type ProviderAccountUsagePaceWindowV1 = z.infer<typeof ProviderAccountUsagePaceWindowV1Schema>;
export const ProviderAccountUsagePaceV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), window: ProviderAccountUsagePaceWindowV1Schema, usedFraction: z.number().check(z.nonnegative()), elapsedFraction: z.number().check(z.positive(), z.maximum(1)), evenPaceFraction: z.number().check(z.positive(), z.maximum(1)), pace: z.number().check(z.nonnegative()), projectedResetUtilizationFraction: z.number().check(z.nonnegative()), qualification: z.enum(['confirmed', 'estimated']), sampleCount: z.number().check(z.int(), z.positive()), empiricalRange: z.optional(z.strictObject({ min: z.number().check(z.nonnegative()), max: z.number().check(z.nonnegative()) })),
    observedCurve: z.optional(z.array(z.strictObject({ observedAtMs: z.number().check(z.int(), z.nonnegative()), usedFraction: z.number().check(z.nonnegative()) }))),
    depletesAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['not_loaded','stale','unknown_window','zero_elapsed','outside_window','unknown_utilization','inconsistent_counters','counter_reset','reset_changed','denominator_changed','entitlement_changed','non_renewing_end']) }),
]));
export type ProviderAccountUsagePaceV1 = z.infer<typeof ProviderAccountUsagePaceV1Schema>;
export const ProviderAccountUsageUnusedCapacityV1Schema = lazyZodSchema(() => z.strictObject({
  historyStatus: z.enum(['not_loaded', 'unavailable', 'partial', 'returned_page']),
  windows: z.array(z.strictObject({ window: ProviderAccountUsagePaceWindowV1Schema, value: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available'), unusedAmount: z.number().check(z.nonnegative()), unusedFraction: z.number().check(z.minimum(0), z.maximum(1)), unit: z.string().check(z.minLength(1)), observedAtMs: z.number().check(z.int(), z.nonnegative()), sampleCount: z.number().check(z.int(), z.positive()), qualification: z.enum(['confirmed', 'estimated']), method: z.enum(['terminal_observation', 'linear_pace_at_last_observation']) }),
    z.strictObject({ status: z.literal('insufficient_basis'), reason: z.string().check(z.minLength(1)) }),
  ]) })),
}));

function readMeterPaceWindow(meter: ConnectedServiceQuotaMeterV1) {
  const reset = meter.resetAtMs;
  const legacyReset = meter.resetsAt;
  const resetAtMs = reset ?? legacyReset;
  const duration = meter.windowDurationMs;
  if (resetAtMs == null || duration == null || duration <= 0 || resetAtMs < duration) return null;
  if (reset != null && legacyReset != null && reset !== legacyReset) return null;
  return { resetAtMs, windowStartAtMs: resetAtMs - duration, windowDurationMs: duration };
}

function readSnapshotComparison(snapshot: ProviderAccountUsageSnapshotV1) {
  const subscription = snapshot.subscription;
  return { planLabel: snapshot.planLabel ?? null, status: subscription?.status ?? null, renewal: subscription?.renewal ?? null,
    periodStartAtMs: subscription?.currentPeriodStartAtMs ?? null, periodEndAtMs: subscription?.currentPeriodEndAtMs ?? null };
}

/** Operands for one derivation pass; never retained across quota reads or clock changes. */
export class ProviderAccountUsageDerivationOperands {
  private readonly windows = new Map<ConnectedServiceQuotaMeterV1, ReturnType<typeof readMeterPaceWindow>>();
  private readonly snapshots = new Map<ProviderAccountUsageSnapshotV1, ReturnType<typeof readSnapshotComparison>>();
  private readonly denominators = new Map<ConnectedServiceQuotaMeterV1, string>();

  readWindow(meter: ConnectedServiceQuotaMeterV1) {
    const value = this.windows.get(meter);
    if (value !== undefined) return value;
    const window = readMeterPaceWindow(meter);
    this.windows.set(meter, window);
    return window;
  }

  readSnapshot(snapshot: ProviderAccountUsageSnapshotV1) {
    let value = this.snapshots.get(snapshot);
    if (!value) { value = readSnapshotComparison(snapshot); this.snapshots.set(snapshot, value); }
    return value;
  }

  readDenominator(meter: ConnectedServiceQuotaMeterV1): string {
    let value = this.denominators.get(meter);
    if (value === undefined) {
      value = JSON.stringify([meter.limit, meter.unit, meter.modelId ?? null, meter.providerLimitId ?? null, meter.limitScope ?? null, meter.scope ?? null]);
      this.denominators.set(meter, value);
    }
    return value;
  }
}

export function resolveProviderAccountUsagePaceWindow(snapshot: ProviderAccountUsageSnapshotV1, meterId: string, operands?: ProviderAccountUsageDerivationOperands): ProviderAccountUsagePaceWindowV1 | null {
  const meter = snapshot.meters.find(value => value.meterId === meterId);
  if (!meter) return null;
  const window = operands ? operands.readWindow(meter) : readMeterPaceWindow(meter);
  return window ? { recordId: snapshot.recordId, meterId, resetAtMs: window.resetAtMs,
    windowStartAtMs: window.windowStartAtMs, windowDurationMs: window.windowDurationMs } : null;
}

/** Clock interval in which unchanged observations have the same pace/ended-window facts. Not read authority. */
export function getProviderAccountUsageDerivationInterval(input: Readonly<{
  current: ProviderAccountUsageSnapshotV1 | null; history: readonly ProviderAccountUsageSnapshotV1[]; nowMs: number;
}>): Readonly<{ fromMs: number; untilMs: number }> | null {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) return null;
  let fromMs = 0;
  let untilMs = Number.POSITIVE_INFINITY;
  const boundary = (atMs: number) => {
    if (!Number.isFinite(atMs) || atMs < 0) return;
    if (atMs <= input.nowMs) fromMs = Math.max(fromMs, atMs);
    else untilMs = Math.min(untilMs, atMs);
  };
  if (input.current) {
    boundary(input.current.observedAtMs);
    boundary(input.current.observedAtMs + input.current.staleAfterMs);
    for (const meter of input.current.meters) {
      const window = resolveProviderAccountUsagePaceWindow(input.current, meter.meterId);
      if (window) boundary(window.resetAtMs);
    }
  }
  // Unused capacity includes a historical window only once it actually ends,
  // including meters no longer present in the current observation.
  for (const snapshot of input.history) for (const meter of snapshot.meters) {
    const window = resolveProviderAccountUsagePaceWindow(snapshot, meter.meterId);
    if (window) boundary(window.resetAtMs);
  }
  return { fromMs, untilMs };
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

function exceedsNonRenewingEntitlement(snapshot: ProviderAccountUsageSnapshotV1, window: ProviderAccountUsagePaceWindowV1): boolean {
  const subscription = snapshot.subscription;
  return subscription?.renewal === 'off' && subscription.currentPeriodEndAtMs != null && subscription.currentPeriodEndAtMs < window.resetAtMs;
}

/** Shared pace/reset comparability; cycle dates themselves are checked by the caller. */
export function readProviderAccountUsageWindowComparabilityReason(input: Readonly<{ previous: ProviderAccountUsageSnapshotV1; current: ProviderAccountUsageSnapshotV1; meterId: string }>, operands = new ProviderAccountUsageDerivationOperands()): 'unknown_window' | 'entitlement_changed' | 'denominator_changed' | null {
  const { previous, current, meterId } = input;
  const before = previous.meters.find(value => value.meterId === meterId);
  const after = current.meters.find(value => value.meterId === meterId);
  if (previous.recordId !== current.recordId || !before || !after) return 'unknown_window';
  const currentWindow = resolveProviderAccountUsagePaceWindow(current, meterId, operands);
  if (currentWindow && exceedsNonRenewingEntitlement(current, currentWindow)) return 'entitlement_changed';
  const previousFacts = operands.readSnapshot(previous);
  const currentFacts = operands.readSnapshot(current);
  if (previousFacts.planLabel !== currentFacts.planLabel || previousFacts.status !== currentFacts.status
    || previousFacts.renewal !== currentFacts.renewal) return 'entitlement_changed';
  const previousPeriod = previous.subscription;
  const currentPeriod = current.subscription;
  if (previousFacts.periodStartAtMs !== currentFacts.periodStartAtMs || previousFacts.periodEndAtMs !== currentFacts.periodEndAtMs) {
    const beforeWindow = resolveProviderAccountUsagePaceWindow(previous, meterId, operands);
    const afterWindow = currentWindow;
    const alignedRollover = beforeWindow && afterWindow
      && beforeWindow.windowDurationMs === afterWindow.windowDurationMs
      && beforeWindow.resetAtMs === afterWindow.windowStartAtMs
      && previousPeriod?.currentPeriodStartAtMs === beforeWindow.windowStartAtMs
      && previousPeriod?.currentPeriodEndAtMs === beforeWindow.resetAtMs
      && currentPeriod?.currentPeriodStartAtMs === afterWindow.windowStartAtMs
      && currentPeriod?.currentPeriodEndAtMs === afterWindow.resetAtMs;
    if (!alignedRollover) return 'entitlement_changed';
  }
  if (operands.readDenominator(before) !== operands.readDenominator(after)) return 'denominator_changed';
  return null;
}

/** A ratio at the witnessed observation, not an assumed extrapolation to now. */
export function deriveProviderAccountUsagePace(input: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; meterId: string; nowMs: number; history?: readonly ProviderAccountUsageSnapshotV1[] }>, operands = new ProviderAccountUsageDerivationOperands()): ProviderAccountUsagePaceV1 {
  return deriveWitnessedPace(input, false, operands);
}

export type ProviderAccountUsageHeadroomV1 =
  | Readonly<{ status: 'available'; window: ProviderAccountUsagePaceWindowV1; remainingFraction: number; qualification: 'confirmed' | 'estimated' }>
  | Extract<ProviderAccountUsagePaceV1, { status: 'unavailable' }>;

/** Present quota needs a witnessed meter and window, but not positive elapsed time for a forecast. */
export function deriveProviderAccountUsageHeadroom(input: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; meterId: string; nowMs: number }>): ProviderAccountUsageHeadroomV1 {
  const { snapshot, meterId, nowMs } = input;
  if (snapshot.state === 'not_loaded' || snapshot.state === 'loaded_empty') return { status: 'unavailable', reason: 'not_loaded' };
  if (snapshot.state !== 'loaded_data' || !isConnectedServiceQuotaObservationFresh({ observedAtMs: snapshot.observedAtMs, nowMs, maxAgeMs: snapshot.staleAfterMs })) return { status: 'unavailable', reason: 'stale' };
  const window = resolveProviderAccountUsagePaceWindow(snapshot, meterId);
  if (!window) return { status: 'unavailable', reason: 'unknown_window' };
  if (exceedsNonRenewingEntitlement(snapshot, window)) return { status: 'unavailable', reason: 'non_renewing_end' };
  if (snapshot.observedAtMs < window.windowStartAtMs || snapshot.observedAtMs > window.resetAtMs || nowMs >= window.resetAtMs) return { status: 'unavailable', reason: 'outside_window' };
  const meter = snapshot.meters.find(value => value.meterId === meterId)!;
  const used = fraction(meter);
  if (used === null) return { status: 'unavailable', reason: 'unknown_utilization' };
  if (hasInconsistentCounters(meter)) return { status: 'unavailable', reason: 'inconsistent_counters' };
  return { status: 'available', window, remainingFraction: Math.max(0, Math.min(1, 1 - used)),
    qualification: snapshot.confidence === 'confirmed' && meter.status === 'ok' ? 'confirmed' : 'estimated' };
}

/** The accepted B lifecycle reset witness, shared by notifications and recorded-history projections. */
export function hasProviderAccountUsageWitnessedReset(input: Readonly<{ previous: ProviderAccountUsageSnapshotV1; current: ProviderAccountUsageSnapshotV1; meterId: string; nowMs: number }>, operands = new ProviderAccountUsageDerivationOperands()): boolean {
  const { previous, current, meterId, nowMs } = input;
  if (previous.recordId !== current.recordId || previous.observedAtMs >= current.observedAtMs
    || previous.state !== 'loaded_data' || current.state !== 'loaded_data'
    || !isConnectedServiceQuotaObservationFresh({ observedAtMs: current.observedAtMs, nowMs, maxAgeMs: current.staleAfterMs })) return false;
  const beforeWindow = resolveProviderAccountUsagePaceWindow(previous, meterId, operands);
  const afterWindow = resolveProviderAccountUsagePaceWindow(current, meterId, operands);
  if (!beforeWindow || !afterWindow || afterWindow.windowStartAtMs !== beforeWindow.resetAtMs
    || afterWindow.windowDurationMs !== beforeWindow.windowDurationMs) return false;
  const before = deriveProviderAccountUsagePace({ snapshot: previous, meterId, nowMs: previous.observedAtMs }, operands);
  const after = deriveProviderAccountUsagePace({ snapshot: current, meterId, nowMs }, operands);
  return (before.status === 'available' || before.reason === 'zero_elapsed'
      || (before.reason === 'outside_window' && previous.observedAtMs === beforeWindow.resetAtMs))
    && (after.status === 'available' || after.reason === 'zero_elapsed')
    && readProviderAccountUsageWindowComparabilityReason({ previous, current, meterId }, operands) === null;
}

function deriveWitnessedPace(input: Readonly<{ snapshot: ProviderAccountUsageSnapshotV1; meterId: string; nowMs: number; history?: readonly ProviderAccountUsageSnapshotV1[] }>, terminal: boolean, operands: ProviderAccountUsageDerivationOperands): ProviderAccountUsagePaceV1 {
  const { snapshot, meterId, nowMs } = input;
  const unavailable = (reason: Extract<ProviderAccountUsagePaceV1, { status: 'unavailable' }>['reason']): ProviderAccountUsagePaceV1 => ({ status: 'unavailable', reason });
  if (snapshot.state === 'not_loaded' || snapshot.state === 'loaded_empty') return unavailable('not_loaded');
  if (snapshot.state !== 'loaded_data' || !isConnectedServiceQuotaObservationFresh({ observedAtMs: snapshot.observedAtMs, nowMs, maxAgeMs: snapshot.staleAfterMs })) return unavailable('stale');
  const window = resolveProviderAccountUsagePaceWindow(snapshot, meterId, operands);
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
    const previousWindow = resolveProviderAccountUsagePaceWindow(previous, meterId, operands);
    // A completed cycle can have its final observation at the next cycle's
    // exact start. It is not a sample of the current actual window.
    if (previousWindow && previousWindow.resetAtMs <= window.windowStartAtMs && previous.observedAtMs <= previousWindow.resetAtMs) continue;
    const incompatible = readProviderAccountUsageWindowComparabilityReason({ previous, current: snapshot, meterId }, operands);
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
export function deriveProviderAccountUsageUnusedCapacity(input: Readonly<{ history?: readonly ProviderAccountUsageSnapshotV1[]; partial?: boolean; nowMs: number }>, operands = new ProviderAccountUsageDerivationOperands()): z.infer<typeof ProviderAccountUsageUnusedCapacityV1Schema> {
  const groups = new Map<string, { window: ProviderAccountUsagePaceWindowV1; samples: ProviderAccountUsageSnapshotV1[] }>();
  for (const snapshot of input.history ?? []) for (const meter of snapshot.meters) {
    const window = resolveProviderAccountUsagePaceWindow(snapshot, meter.meterId, operands);
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
      const incompatible = readProviderAccountUsageWindowComparabilityReason({ previous, current: latest, meterId: window.meterId }, operands);
      if (incompatible) return insufficient(incompatible);
    }
    const meter = latest.meters.find(value => value.meterId === window.meterId)!;
    if (meter.limit == null || meter.limit <= 0 || meter.used == null || !meter.unit) return insufficient('unknown_denominator');
    const terminal = latest.observedAtMs === window.resetAtMs;
    const pace = deriveWitnessedPace({ snapshot: latest, meterId: window.meterId, nowMs: latest.observedAtMs, history: sorted }, terminal, operands);
    if (pace.status === 'unavailable') return insufficient(pace.reason);
    const unusedFraction = Math.max(0, 1 - pace.projectedResetUtilizationFraction);
    return { window, value: { status: 'available' as const, unusedAmount: unusedFraction * meter.limit, unusedFraction, unit: meter.unit,
      observedAtMs: latest.observedAtMs, sampleCount: pace.sampleCount, qualification: terminal ? pace.qualification : 'estimated' as const,
      method: terminal ? 'terminal_observation' as const : 'linear_pace_at_last_observation' as const } };
  }) };
}

export const ProviderAccountUsageEarlierWindowCurvesV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['not_loaded', 'unknown_window']) }),
  z.strictObject({ status: z.literal('available'),
    curves: z.array(z.strictObject({ window: ProviderAccountUsagePaceWindowV1Schema,
      points: z.array(z.strictObject({ elapsedFraction: z.number().check(z.minimum(0), z.maximum(1)), usedFraction: z.number().check(z.nonnegative()) })) })),
    excluded: z.array(z.strictObject({ window: ProviderAccountUsagePaceWindowV1Schema,
      reason: z.enum(['unknown_window', 'entitlement_changed', 'denominator_changed', 'reset_changed', 'inconsistent_counters', 'counter_reset', 'single_reading']) })),
  }),
]));
export type ProviderAccountUsageEarlierWindowCurvesV1 = z.infer<typeof ProviderAccountUsageEarlierWindowCurvesV1Schema>;

/**
 * Earlier ended windows of the current record's meter as curves for a "usual week" comparison. Window
 * identity and comparability are the pace owner's own; nothing is averaged or forecast here.
 */
export function deriveProviderAccountUsageEarlierWindowCurves(input: Readonly<{ current: ProviderAccountUsageSnapshotV1; meterId: string; history?: readonly ProviderAccountUsageSnapshotV1[] }>, operands = new ProviderAccountUsageDerivationOperands()): ProviderAccountUsageEarlierWindowCurvesV1 {
  if (input.history === undefined) return { status: 'unavailable', reason: 'not_loaded' };
  const currentWindow = resolveProviderAccountUsagePaceWindow(input.current, input.meterId, operands);
  if (!currentWindow) return { status: 'unavailable', reason: 'unknown_window' };
  const groups = new Map<string, { window: ProviderAccountUsagePaceWindowV1; samples: ProviderAccountUsageSnapshotV1[] }>();
  for (const snapshot of input.history) {
    if (snapshot.recordId !== input.current.recordId || !snapshot.meters.some(meter => meter.meterId === input.meterId)) continue;
    const window = resolveProviderAccountUsagePaceWindow(snapshot, input.meterId, operands);
    if (!window || window.resetAtMs > currentWindow.windowStartAtMs) continue;
    const key = JSON.stringify(window);
    const group = groups.get(key) ?? { window, samples: [] };
    group.samples.push(snapshot); groups.set(key, group);
  }
  const curves: { window: ProviderAccountUsagePaceWindowV1; points: { elapsedFraction: number; usedFraction: number }[] }[] = [];
  const excluded: { window: ProviderAccountUsagePaceWindowV1; reason: Extract<ProviderAccountUsageEarlierWindowCurvesV1, { status: 'available' }>['excluded'][number]['reason'] }[] = [];
  for (const { window, samples } of [...groups.values()].sort((a, b) => b.window.resetAtMs - a.window.resetAtMs)) {
    const exclude = (reason: (typeof excluded)[number]['reason']) => { excluded.push({ window, reason }); };
    if (window.windowDurationMs !== currentWindow.windowDurationMs) { exclude('reset_changed'); continue; }
    const incompatible = samples.map(previous => readProviderAccountUsageWindowComparabilityReason({ previous, current: input.current, meterId: input.meterId }, operands)).find(Boolean);
    if (incompatible) { exclude(incompatible); continue; }
    const points = new Map<number, number>();
    let previous: number | undefined;
    let failure: (typeof excluded)[number]['reason'] | null = null;
    for (const sample of [...samples].sort((a, b) => a.observedAtMs - b.observedAtMs)) {
      const meter = sample.meters.find(value => value.meterId === input.meterId)!;
      if (hasInconsistentCounters(meter)) { failure = 'inconsistent_counters'; break; }
      const used = fraction(meter);
      const elapsedFraction = (sample.observedAtMs - window.windowStartAtMs) / window.windowDurationMs;
      if (used == null || elapsedFraction < 0 || elapsedFraction > 1) continue;
      if (previous !== undefined && used < previous) { failure = 'counter_reset'; break; }
      points.set(elapsedFraction, used);
      previous = used;
    }
    if (failure) { exclude(failure); continue; }
    if (points.size < 2) { exclude('single_reading'); continue; }
    curves.push({ window, points: [...points].map(([elapsedFraction, usedFraction]) => ({ elapsedFraction, usedFraction })) });
  }
  return { status: 'available', curves, excluded };
}
