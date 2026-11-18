import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderAccountUsageSnapshotV1Schema, PROVIDER_ACCOUNT_USAGE_DAY_MS } from './providerAccountUsagePrimitives.js';
import { ProviderAccountUsageDaySummaryV1Schema, ProviderAccountUsageDaySummaryWindowV1Schema, type ProviderAccountUsageDaySummaryV1 } from './providerAccountUsageDaySummary.js';
import { PackedProviderAccountUsagePageProjectionV1Schema, packProviderAccountUsagePageProjectionV1,
  unpackProviderAccountUsagePageProjectionV1 } from './providerAccountUsagePageProjection.js';

export const PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING = 'snapshot_table_v1' as const;
const Index = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

/** Same day facts, with full snapshots interned and their meter material shared. */
export const PackedProviderAccountUsageDaySummaryV1Schema = lazyZodSchema(() => {
  const summary = ProviderAccountUsageDaySummaryV1Schema.shape;
  const window = ProviderAccountUsageDaySummaryWindowV1Schema.shape;
  return z.strictObject({
    v: summary.v, encoding: z.literal(PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING), recordId: summary.recordId,
    dayStartAtMs: summary.dayStartAtMs, observedAtRange: summary.observedAtRange, lastSnapshot: Index,
    snapshots: PackedProviderAccountUsagePageProjectionV1Schema,
    // Page projections intentionally omit HTTP diagnostics. Summary encoding is
    // lossless, so retain those facts separately from the shared snapshot bases.
    diagnostics: z.array(z.strictObject({ diagnostics: ProviderAccountUsageSnapshotV1Schema.shape.diagnostics })),
    diagnosticRefs: z.array(z.nullable(Index)),
    windows: z.array(z.tuple([window.meterId, window.windowStartAtMs, window.resetAtMs, Index,
      window.peakUsed, window.firstObservedAtMs, window.lastObservedAtMs, window.resets])),
  });
});

export function packProviderAccountUsageDaySummaryV1(summary: ProviderAccountUsageDaySummaryV1): z.infer<typeof PackedProviderAccountUsageDaySummaryV1Schema> {
  const snapshots: ProviderAccountUsageDaySummaryV1['lastSnapshot'][] = [];
  const indexes = new Map<string, number>();
  const reference = (snapshot: ProviderAccountUsageDaySummaryV1['lastSnapshot']) => {
    const key = JSON.stringify(snapshot);
    const retained = indexes.get(key);
    if (retained !== undefined) return retained;
    const index = snapshots.length; snapshots.push(snapshot); indexes.set(key, index); return index;
  };
  const lastSnapshot = reference(summary.lastSnapshot);
  const windows = summary.windows.map(window => [window.meterId, window.windowStartAtMs, window.resetAtMs, reference(window.lastSnapshot),
    window.peakUsed, window.firstObservedAtMs, window.lastObservedAtMs, window.resets] satisfies z.infer<typeof PackedProviderAccountUsageDaySummaryV1Schema>['windows'][number]);
  const diagnostics: z.infer<typeof PackedProviderAccountUsageDaySummaryV1Schema>['diagnostics'] = [];
  const diagnosticIndexes = new Map<string, number>();
  const diagnosticRefs = snapshots.map(snapshot => {
    if (snapshot.diagnostics === undefined) return null;
    const key = JSON.stringify(snapshot.diagnostics);
    const retained = diagnosticIndexes.get(key);
    if (retained !== undefined) return retained;
    const index = diagnostics.length; diagnostics.push({ diagnostics: snapshot.diagnostics }); diagnosticIndexes.set(key, index); return index;
  });
  return { v: 1, encoding: PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING, recordId: summary.recordId, dayStartAtMs: summary.dayStartAtMs,
    ...(summary.observedAtRange ? { observedAtRange: summary.observedAtRange } : {}), lastSnapshot, windows, diagnostics, diagnosticRefs,
    snapshots: packProviderAccountUsagePageProjectionV1({ v: 1, recordId: summary.recordId, resolution: 'accepted_observations',
      range: { startAtMs: summary.dayStartAtMs, endAtMs: summary.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS },
      history: { entries: snapshots.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null } }) };
}

export function unpackProviderAccountUsageDaySummaryV1(value: z.infer<typeof PackedProviderAccountUsageDaySummaryV1Schema>): ProviderAccountUsageDaySummaryV1 {
  const entries = unpackProviderAccountUsagePageProjectionV1(value.snapshots).history.entries;
  if (value.diagnosticRefs.length !== entries.length) throw new Error('provider_account_usage_summary_identity_mismatch');
  const snapshots = entries.map((entry, index) => {
    const reference = value.diagnosticRefs[index]!;
    if (reference === null) return entry.snapshot;
    const diagnostic = value.diagnostics[reference];
    if (!diagnostic) throw new Error('provider_account_usage_summary_identity_mismatch');
    return { ...entry.snapshot, ...diagnostic };
  });
  return ProviderAccountUsageDaySummaryV1Schema.parse({ v: value.v, recordId: value.recordId, dayStartAtMs: value.dayStartAtMs,
    ...(value.observedAtRange ? { observedAtRange: value.observedAtRange } : {}), lastSnapshot: snapshots[value.lastSnapshot],
    windows: value.windows.map(([meterId, windowStartAtMs, resetAtMs, snapshot, peakUsed, firstObservedAtMs, lastObservedAtMs, resets]) => ({
      meterId, windowStartAtMs, resetAtMs, lastSnapshot: snapshots[snapshot], peakUsed, firstObservedAtMs, lastObservedAtMs, resets })) });
}
