import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS, ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';

import { resolveProviderAccountUsagePaceWindow, hasProviderAccountUsageWitnessedReset, providerAccountUsagePaceWindowIdentityKey } from './deriveProviderAccountUsagePace.js';
import type { PackedProviderAccountUsageDaySummaryV1Schema } from './providerAccountUsageDaySummaryEncoding.js';

const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Day = lazyZodSchema(() => Time.check(z.refine(value => value % PROVIDER_ACCOUNT_USAGE_DAY_MS === 0)));
export const ProviderAccountUsageDaySummaryWindowV1Schema = lazyZodSchema(() => z.strictObject({
  meterId: z.string().check(z.minLength(1)), windowStartAtMs: z.nullable(Time), resetAtMs: z.nullable(Time),
  lastSnapshot: ProviderAccountUsageSnapshotV1Schema, peakUsed: z.nullable(z.number()),
  firstObservedAtMs: Time, lastObservedAtMs: Time,
  resets: z.array(z.strictObject({ resetAtMs: Time, usedBeforeReset: z.nullable(z.number()) })),
}));
export const ProviderAccountUsageDaySummaryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema, dayStartAtMs: Day,
  lastSnapshot: ProviderAccountUsageSnapshotV1Schema,
  /** Sealed provider-clock extrema of the available canonical observation basis. */
  observedAtRange: z.optional(z.strictObject({ startAtMs: Time, endAtMs: Time }).check(z.refine(value => value.endAtMs > value.startAtMs))),
  windows: z.array(ProviderAccountUsageDaySummaryWindowV1Schema),
}));
export type ProviderAccountUsageDaySummaryV1 = z.infer<typeof ProviderAccountUsageDaySummaryV1Schema>;
type PlainDaySummaryV1 = ProviderAccountUsageDaySummaryV1 | z.infer<typeof PackedProviderAccountUsageDaySummaryV1Schema>;

/** Admit the record and day before opening the protected window observations. */
export function matchesProviderAccountUsageDaySummaryIdentityV1(
  value: PlainDaySummaryV1,
  identity: Readonly<{ recordId: string; dayStartAtMs: number }>,
): boolean {
  if (value.recordId !== identity.recordId || value.dayStartAtMs !== identity.dayStartAtMs) return false;
  return 'encoding' in value
    ? value.snapshots.recordId === identity.recordId && value.snapshots.bases.every(base => base.recordId === identity.recordId)
    : value.lastSnapshot.recordId === identity.recordId && value.windows.every(window => window.lastSnapshot.recordId === identity.recordId);
}
/** Quota counters describe distinct canonical windows; same-second reset jitter shares one identity. */
export function buildProviderAccountUsageDaySummaryV1(input: Readonly<{
  recordId: string; dayStartAtMs: number; snapshots: readonly ProviderAccountUsageSnapshotV1[];
  previous?: ProviderAccountUsageDaySummaryV1; precedingSnapshot?: ProviderAccountUsageSnapshotV1;
  /** The producer exhausted this day's retained raw history and proved its coverage before writing. */
  completeDayHistory?: boolean;
}>): ProviderAccountUsageDaySummaryV1 {
  const snapshots = [...input.snapshots].sort((left, right) => left.fetchedAtMs - right.fetchedAtMs);
  const previous = input.previous;
  if (previous && (previous.recordId !== input.recordId || previous.dayStartAtMs !== input.dayStartAtMs)) throw new Error('provider_account_usage_summary_identity_mismatch');
  if (snapshots.some(snapshot => snapshot.recordId !== input.recordId || snapshot.fetchedAtMs < input.dayStartAtMs
    || snapshot.fetchedAtMs >= input.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS)) throw new Error('provider_account_usage_summary_identity_mismatch');
  const candidates = [...(previous ? [previous.lastSnapshot] : []), ...snapshots];
  const lastSnapshot = candidates.reduce<ProviderAccountUsageSnapshotV1 | undefined>((last, next) => !last || next.fetchedAtMs >= last.fetchedAtMs ? next : last, undefined);
  if (!lastSnapshot) throw new Error('provider_account_usage_summary_empty');
  const windows = new Map<string, ProviderAccountUsageDaySummaryV1['windows'][number]>();
  const key = (meterId: string, start: number | null, reset: number | null) => {
    if (start === null || reset === null) return JSON.stringify([meterId, start, reset]);
    return providerAccountUsagePaceWindowIdentityKey({ recordId: input.recordId, meterId, windowStartAtMs: start, resetAtMs: reset,
      windowDurationMs: reset - start });
  };
  const resetKey = (window: ProviderAccountUsageDaySummaryV1['windows'][number], at: number) =>
    window.windowStartAtMs === null || window.resetAtMs === null
      ? String(at) : key(window.meterId, at - (window.resetAtMs - window.windowStartAtMs), at);
  for (const window of previous?.windows ?? []) {
    const identity = key(window.meterId, window.windowStartAtMs, window.resetAtMs);
    const retained = windows.get(identity);
    if (!retained) {
      windows.set(identity, { ...window, resets: window.resets.map(reset => ({ ...reset })) });
      continue;
    }
    // Legacy summaries could retain two jittered clocks for one window. Their
    // terminal samples cannot reconstruct an earlier peak after compaction.
    const [older, newer] = window.lastObservedAtMs >= retained.lastObservedAtMs ? [retained, window] : [window, retained];
    const resets = new Map(older.resets.map(reset => [resetKey(older, reset.resetAtMs), { ...reset }]));
    for (const reset of newer.resets) {
      const id = resetKey(newer, reset.resetAtMs);
      const prior = resets.get(id);
      resets.set(id, { ...reset, usedBeforeReset: reset.usedBeforeReset ?? prior?.usedBeforeReset ?? null });
    }
    const peaks = [older.peakUsed, newer.peakUsed].filter(peak => peak !== null);
    windows.set(identity, { ...newer, resets: [...resets.values()],
      firstObservedAtMs: Math.min(older.firstObservedAtMs, newer.firstObservedAtMs),
      peakUsed: peaks.length ? Math.max(...peaks) : null });
  }
  // Retained last samples allow a late detail row to advance a previous peak
  // after the original detail was removed, without fabricating observations.
  const observations = [...(input.precedingSnapshot ? [input.precedingSnapshot] : []),
    ...(previous?.windows.map(window => window.lastSnapshot) ?? []), ...snapshots]
    .sort((left, right) => left.fetchedAtMs - right.fetchedAtMs);
  const lastByMeter = new Map<string, ProviderAccountUsageSnapshotV1>();
  for (const snapshot of observations) for (const meter of snapshot.meters) {
    const window = resolveProviderAccountUsagePaceWindow(snapshot, meter.meterId);
    const id = window ? providerAccountUsagePaceWindowIdentityKey(window) : key(meter.meterId, null, null);
    const before = lastByMeter.get(meter.meterId);
    const reset = before && window && hasProviderAccountUsageWitnessedReset({ previous: before, current: snapshot, meterId: meter.meterId, nowMs: snapshot.observedAtMs })
      ? resolveProviderAccountUsagePaceWindow(before, meter.meterId) : null;
    lastByMeter.set(meter.meterId, snapshot);
    if (snapshot.fetchedAtMs < input.dayStartAtMs || snapshot.fetchedAtMs >= input.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS) continue;
    const retained = windows.get(id);
    const used = meter.used;
    if (!retained) windows.set(id, { meterId: meter.meterId, windowStartAtMs: window?.windowStartAtMs ?? null, resetAtMs: window?.resetAtMs ?? null,
      lastSnapshot: { ...snapshot, meters: [meter] }, peakUsed: used, firstObservedAtMs: snapshot.fetchedAtMs, lastObservedAtMs: snapshot.fetchedAtMs, resets: [] });
    else {
      retained.firstObservedAtMs = Math.min(retained.firstObservedAtMs, snapshot.fetchedAtMs);
      if (snapshot.fetchedAtMs >= retained.lastObservedAtMs) {
        retained.lastObservedAtMs = snapshot.fetchedAtMs; retained.lastSnapshot = { ...snapshot, meters: [meter] };
      }
      if (used !== null) retained.peakUsed = retained.peakUsed === null ? used : Math.max(retained.peakUsed, used);
    }
    if (reset) {
      const owner = windows.get(key(meter.meterId, reset.windowStartAtMs, reset.resetAtMs)) ?? windows.get(id)!;
      const boundary = resetKey(owner, reset.resetAtMs);
      if (!owner.resets.some(value => resetKey(owner, value.resetAtMs) === boundary)) owner.resets.push({ resetAtMs: reset.resetAtMs,
        usedBeforeReset: before?.meters.find(value => value.meterId === meter.meterId)?.used ?? null });
    }
  }
  for (const window of windows.values()) for (const reset of window.resets) {
    // The terminal used value follows the latest witnessed pre-reset sample,
    // including a newly backfilled sample earlier than the next window.
    if (window.resetAtMs !== null && resetKey(window, reset.resetAtMs) === resetKey(window, window.resetAtMs)) {
      reset.usedBeforeReset = window.lastSnapshot.meters[0]?.used ?? reset.usedBeforeReset;
    }
  }
  let observedAtRange = previous?.observedAtRange;
  if (!previous || previous.observedAtRange || input.completeDayHistory) {
    // Retain witnessed bounds even after their detail has been pruned.
    // A complete legacy rebuild can also use the retained endpoint snapshots.
    const basis = input.completeDayHistory && previous
      ? [previous.lastSnapshot, ...previous.windows.map(window => window.lastSnapshot), ...snapshots] : snapshots;
    for (const snapshot of basis) {
      const at = snapshot.observedAtMs;
      observedAtRange = observedAtRange
        ? { startAtMs: Math.min(observedAtRange.startAtMs, at), endAtMs: Math.max(observedAtRange.endAtMs, at + 1) }
        : { startAtMs: at, endAtMs: at + 1 };
    }
  }
  return { v: 1, recordId: input.recordId, dayStartAtMs: input.dayStartAtMs, lastSnapshot, windows: [...windows.values()],
    ...(observedAtRange ? { observedAtRange } : {}) };
}

/** The same UTC-day chart facts from detail and compacted days; neither path adds quota counters. */
export function deriveProviderAccountUsageDayQuotaHistoryV1(input: Readonly<{
  recordId: string; snapshots: readonly ProviderAccountUsageSnapshotV1[]; summaries?: readonly ProviderAccountUsageDaySummaryV1[];
}>): ProviderAccountUsageDaySummaryV1[] {
  const groups = new Map<number, { previous?: ProviderAccountUsageDaySummaryV1; snapshots: ProviderAccountUsageSnapshotV1[] }>();
  for (const summary of input.summaries ?? []) {
    if (summary.recordId !== input.recordId) throw new Error('provider_account_usage_summary_identity_mismatch');
    groups.set(summary.dayStartAtMs, { previous: summary, snapshots: [] });
  }
  for (const snapshot of input.snapshots) {
    const dayStartAtMs = Math.floor(snapshot.fetchedAtMs / PROVIDER_ACCOUNT_USAGE_DAY_MS) * PROVIDER_ACCOUNT_USAGE_DAY_MS;
    const group = groups.get(dayStartAtMs) ?? { snapshots: [] };
    group.snapshots.push(snapshot); groups.set(dayStartAtMs, group);
  }
  const days: ProviderAccountUsageDaySummaryV1[] = [];
  for (const [dayStartAtMs, group] of [...groups].sort(([left], [right]) => left - right)) {
    days.push(buildProviderAccountUsageDaySummaryV1({ recordId: input.recordId, dayStartAtMs,
      ...group, precedingSnapshot: days.at(-1)?.lastSnapshot }));
  }
  return days;
}
