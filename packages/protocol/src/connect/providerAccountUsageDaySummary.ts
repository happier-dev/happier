import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS, ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { resolveProviderAccountUsagePaceWindow, hasProviderAccountUsageWitnessedReset, providerAccountUsagePaceWindowIdentityKey } from './deriveProviderAccountUsagePace.js';
import { PackedProviderAccountUsageDaySummaryV1Schema, packProviderAccountUsageDaySummaryV1,
  unpackProviderAccountUsageDaySummaryV1, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING } from './providerAccountUsageDaySummaryEncoding.js';

export { packProviderAccountUsageDaySummaryV1, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING } from './providerAccountUsageDaySummaryEncoding.js';

export { PROVIDER_ACCOUNT_USAGE_DAY_MS } from './providerAccountUsagePrimitives.js';
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
export const ProviderAccountUsageDaySummaryCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  observationCount: z.number().check(z.int(), z.nonnegative()),
  frontier: z.nullable(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: Time })),
}));
export const ProviderAccountUsageDaySummaryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: z.union([PackedProviderAccountUsageDaySummaryV1Schema, ProviderAccountUsageDaySummaryV1Schema]) }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export const StoredProviderAccountUsageDaySummaryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), coverage: ProviderAccountUsageDaySummaryCoverageV1Schema, content: ProviderAccountUsageDaySummaryContentV1Schema,
  clockBoundsVersion: z.optional(z.literal(1)),
  encoding: z.optional(z.literal(PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING)),
}));
export type StoredProviderAccountUsageDaySummaryV1 = z.infer<typeof StoredProviderAccountUsageDaySummaryV1Schema>;
export const ProviderAccountUsageDaySummaryReadV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema,
  /** Omit only for all-days coverage; no client-selected timestamp ceiling. */
  range: z.optional(z.strictObject({ startAtMs: Time, endAtMs: Time }).check(z.refine(value => value.endAtMs > value.startAtMs))),
  includeMissingDays: z.optional(z.boolean()),
  /** Return all selected envelopes with pending coverage, without producer predecessor bodies. */
  includeCoverage: z.optional(z.boolean()),
  requireClockBounds: z.optional(z.boolean()),
  requireCompact: z.optional(z.boolean()),
}).check(z.refine(value => value.range !== undefined || value.includeCoverage === true)));
export const ProviderAccountUsageDaySummaryResponseV1Schema = lazyZodSchema(() => z.strictObject({
  summaries: z.array(z.strictObject({ dayStartAtMs: Day, payload: StoredProviderAccountUsageDaySummaryV1Schema })),
  missingDays: z.array(z.strictObject({ dayStartAtMs: Day, coverage: ProviderAccountUsageDaySummaryCoverageV1Schema,
    /** Selected only to rewrite the encoding, with no pending observations. */
    rewriteOnly: z.optional(z.literal(true)),
    precedingSummary: z.optional(z.strictObject({ dayStartAtMs: Day, payload: StoredProviderAccountUsageDaySummaryV1Schema })) })),
}));
export const ProviderAccountUsageDaySummaryWriteV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema, dayStartAtMs: Day, payload: StoredProviderAccountUsageDaySummaryV1Schema,
}));

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
  let observedAtRange: ProviderAccountUsageDaySummaryV1['observedAtRange'];
  if (!previous || previous.observedAtRange || input.completeDayHistory) {
    if (previous && !input.completeDayHistory) observedAtRange = previous.observedAtRange && { ...previous.observedAtRange };
    // A complete legacy rebuild includes the retained endpoints after detail
    // retention. It proves today's available basis, never deleted observations.
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

export function sealProviderAccountUsageDaySummaryV1(input: Readonly<{ summary: ProviderAccountUsageDaySummaryV1; material: AccountScopedCryptoMaterial; randomBytes: (length: number) => Uint8Array }>) {
  return { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_day_summary', material: input.material,
    payload: packProviderAccountUsageDaySummaryV1(ProviderAccountUsageDaySummaryV1Schema.parse(input.summary)), randomBytes: input.randomBytes }) };
}
export function openProviderAccountUsageDaySummaryV1(input: Readonly<{ recordId: string; dayStartAtMs: number; accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial; content: z.infer<typeof ProviderAccountUsageDaySummaryContentV1Schema> }>): ProviderAccountUsageDaySummaryV1 {
  if ((input.accountMode === 'plain') !== (input.content.t === 'plain')) throw new Error('provider_account_usage_summary_mode_mismatch');
  const opened = input.content.t === 'plain' ? input.content.v : input.material
    ? openAccountScopedBlobCiphertext({ kind: 'provider_account_usage_day_summary', material: input.material, ciphertext: input.content.c })?.value : null;
  const packed = PackedProviderAccountUsageDaySummaryV1Schema.safeParse(opened);
  const summary = packed.success ? unpackProviderAccountUsageDaySummaryV1(packed.data) : ProviderAccountUsageDaySummaryV1Schema.parse(opened);
  if (summary.recordId !== input.recordId || summary.dayStartAtMs !== input.dayStartAtMs || summary.lastSnapshot.recordId !== input.recordId
    || summary.windows.some(window => window.lastSnapshot.recordId !== input.recordId)) throw new Error('provider_account_usage_summary_identity_mismatch');
  return summary;
}
