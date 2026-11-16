import { z } from 'zod/mini';
import { DatabaseEngineIdV1Schema } from './databaseTargets.js';
import { DatabaseStatsRelationV1Schema } from './databaseOperands.js';
import { DatabaseCompletenessV1Schema } from './databaseContinuations.js';

const name = z.string().check(z.minLength(1));
const counter = z.string().check(z.regex(/^\d+$/u));
const nonnegative = z.number().check(z.nonnegative());
export { DatabaseStatsReadV1Schema, DatabaseStatsRelationV1Schema } from './databaseOperands.js';
export type { DatabaseStatsReadV1 } from './databaseOperands.js';
export const DatabaseStatsGroupV1Schema = z.enum(['statements', 'tables', 'indexes', 'activity', 'size', 'indexAdvice']);
export type DatabaseStatsGroupV1 = z.infer<typeof DatabaseStatsGroupV1Schema>;
export const DatabaseStatsReasonV1Schema = z.enum([
    'unsupported_engine', 'unsupported_transport', 'unsupported_group', 'extension_missing',
    'preload_restart_required', 'instrumentation_disabled', 'visibility_restricted',
    'previous_sample_required', 'comparison_unavailable', 'counter_reset', 'row_evicted',
    'partial_observation', 'parameters_required', 'unsupported_extension_version', 'extension_metadata_required',
    'reset_marker_unavailable', 'eviction_possible', 'digest_overflow', 'dbstat_unavailable',
]);
export type DatabaseStatsReasonV1 = z.infer<typeof DatabaseStatsReasonV1Schema>;
export const DatabaseStatsCoverageV1Schema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('complete') }),
    z.strictObject({ status: z.literal('partial'), reasons: z.array(DatabaseStatsReasonV1Schema).check(z.minLength(1)) }),
]);
export const DatabaseStatsIntervalBasisV1Schema = z.strictObject({
    bindingKey: name, databaseIdentity: name, selectionKey: name,
    engineStartedAt: z.optional(name), statsResetAt: z.optional(name), extensionVersion: z.optional(name),
    deallocated: z.optional(counter),
    rowResetMarkers: z.optional(z.record(name, name)),
});
export type DatabaseStatsIntervalBasisV1 = z.infer<typeof DatabaseStatsIntervalBasisV1Schema>;
export const DatabaseStatsStatementV1Schema = z.strictObject({
    key: name, database: name, user: z.optional(name), topLevel: z.optional(z.boolean()),
    shape: z.optional(z.string()), omittedTextReason: z.optional(name),
    calls: counter, totalTimeMs: nonnegative, rows: counter,
    nativeTimeUnit: z.enum(['milliseconds', 'picoseconds']),
    planningTimeMs: z.optional(nonnegative), blocksRead: z.optional(counter), blocksHit: z.optional(counter),
    tempBlocksWritten: z.optional(counter), rowsExamined: z.optional(counter),
});
export type DatabaseStatsStatementV1 = z.infer<typeof DatabaseStatsStatementV1Schema>;
export const DatabaseStatsSizeV1Schema = z.strictObject({
    bytes: counter, measurement: z.enum(['database_bytes', 'table_bytes_estimate', 'page_allocation']),
    relationBytes: z.optional(counter), tableBytes: z.optional(counter), indexBytes: z.optional(counter),
    freeBytes: z.optional(counter),
});
export type DatabaseStatsSizeV1 = z.infer<typeof DatabaseStatsSizeV1Schema>;
export const DatabaseStatsTableV1Schema = z.strictObject({
    relation: DatabaseStatsRelationV1Schema, estimatedRows: z.optional(counter), liveRows: z.optional(counter), deadRows: z.optional(counter),
    sequentialScans: z.optional(counter), indexScans: z.optional(counter), rowsRead: z.optional(counter),
    inserted: z.optional(counter), updated: z.optional(counter), deleted: z.optional(counter),
    lastVacuum: z.optional(name), lastAnalyze: z.optional(name), size: z.optional(DatabaseStatsSizeV1Schema),
});
export const DatabaseStatsIndexV1Schema = z.strictObject({
    relation: DatabaseStatsRelationV1Schema, name, columns: z.array(z.nullable(z.string())),
    definition: z.optional(z.string()), predicate: z.optional(z.string()), unique: z.boolean(), primary: z.boolean(),
    constraint: z.boolean(), scans: z.optional(counter), tuplesRead: z.optional(counter), tuplesFetched: z.optional(counter), bytes: z.optional(counter),
});
export const DatabaseStatsActivityV1Schema = z.strictObject({
    key: name, state: z.optional(name), shape: z.optional(z.string()), omittedTextReason: z.optional(name),
    waitClass: z.optional(name), waitEvent: z.optional(name), transactionStartedAt: z.optional(name), queryStartedAt: z.optional(name),
    blockingKeys: z.array(z.string()), locks: z.optional(z.array(z.strictObject({ relation: z.optional(name), mode: name, granted: z.boolean() }))),
});
const common = {
    v: z.literal(1), observedAtMs: nonnegative, engineId: DatabaseEngineIdV1Schema,
    scope: z.strictObject({ database: name, relation: z.optional(DatabaseStatsRelationV1Schema) }),
    intervalBasis: DatabaseStatsIntervalBasisV1Schema,
};
const available = { ...common, status: z.literal('available'), coverage: DatabaseStatsCoverageV1Schema,
    completeness: DatabaseCompletenessV1Schema };
export const DatabaseStatsObservationV1Schema = z.union([
    z.strictObject({ ...available, group: z.literal('statements'), data: z.array(DatabaseStatsStatementV1Schema) }),
    z.strictObject({ ...available, group: z.literal('tables'), data: z.array(DatabaseStatsTableV1Schema) }),
    z.strictObject({ ...available, group: z.literal('indexes'), data: z.array(DatabaseStatsIndexV1Schema) }),
    z.strictObject({ ...available, group: z.literal('activity'), data: z.array(DatabaseStatsActivityV1Schema) }),
    z.strictObject({ ...available, group: z.literal('size'), data: DatabaseStatsSizeV1Schema }),
    z.strictObject({ ...common, status: z.literal('unavailable'), group: DatabaseStatsGroupV1Schema,
        reason: DatabaseStatsReasonV1Schema, remediation: z.optional(z.string()) }),
]);
export type DatabaseStatsObservationV1 = z.infer<typeof DatabaseStatsObservationV1Schema>;

export const DatabaseStatsCounterTupleV1Schema = z.pick(DatabaseStatsStatementV1Schema, { key: true, calls: true, totalTimeMs: true, rows: true });
export const DatabaseStatsCounterSampleV1Schema = z.strictObject({
    engineId: DatabaseEngineIdV1Schema, observedAtMs: nonnegative,
    intervalBasis: DatabaseStatsIntervalBasisV1Schema, coverage: DatabaseStatsCoverageV1Schema,
    rows: z.array(DatabaseStatsCounterTupleV1Schema),
});
type CounterSample = z.infer<typeof DatabaseStatsCounterSampleV1Schema>;
export type DatabaseStatsCounterSampleV1 = Readonly<Omit<CounterSample, 'rows'> & { rows: readonly Readonly<CounterSample['rows'][number]>[] }>;
export type DatabaseStatsCounterComparisonV1 = Readonly<{
    status: 'available'; fromMs: number; toMs: number;
    rows: readonly Readonly<{ key: string; calls: string; totalTimeMs: number; rows: string; meanTimeMs: number | null }>[];
    missingKeys: readonly string[];
}> | Readonly<{ status: 'unavailable'; reason: DatabaseStatsReasonV1 }>;

/** Compares only displayed keys. Page disappearance is never negative workload. */
export function compareDatabaseStatsCountersV1(previous: DatabaseStatsCounterSampleV1 | undefined, current: DatabaseStatsCounterSampleV1): DatabaseStatsCounterComparisonV1 {
    if (!previous) return { status: 'unavailable', reason: 'previous_sample_required' };
    if (previous.coverage.status !== 'complete' || current.coverage.status !== 'complete') return { status: 'unavailable', reason: 'partial_observation' };
    const before = previous.intervalBasis;
    const after = current.intervalBasis;
    if (previous.engineId !== current.engineId || previous.observedAtMs >= current.observedAtMs
        || before.bindingKey !== after.bindingKey || before.databaseIdentity !== after.databaseIdentity
        || before.selectionKey !== after.selectionKey || before.engineStartedAt !== after.engineStartedAt
        || before.statsResetAt !== after.statsResetAt || before.extensionVersion !== after.extensionVersion
        || before.deallocated !== after.deallocated) return { status: 'unavailable', reason: 'comparison_unavailable' };
    const prior = new Map(previous.rows.map(row => [row.key, row]));
    const rows: Extract<DatabaseStatsCounterComparisonV1, { status: 'available' }>['rows'][number][] = [];
    for (const row of current.rows) {
        const old = prior.get(row.key);
        if (!old) continue;
        if (before.rowResetMarkers?.[row.key] !== after.rowResetMarkers?.[row.key]) return { status: 'unavailable', reason: 'comparison_unavailable' };
        prior.delete(row.key);
        const calls = BigInt(row.calls) - BigInt(old.calls);
        const count = BigInt(row.rows) - BigInt(old.rows);
        const totalTimeMs = row.totalTimeMs - old.totalTimeMs;
        if (calls < 0n || count < 0n || totalTimeMs < 0) return { status: 'unavailable', reason: 'counter_reset' };
        rows.push({ key: row.key, calls: calls.toString(), totalTimeMs, rows: count.toString(), meanTimeMs: calls === 0n ? null : totalTimeMs / Number(calls) });
    }
    return { status: 'available', fromMs: previous.observedAtMs, toMs: current.observedAtMs, rows, missingKeys: [...prior.keys()] };
}

/** Deployment projections retain their pairwise lifecycle and may report shrink. */
export function compareDatabaseStatsSizeV1(previous: Readonly<{ bytes: string; observedAtMs: number; bindingKey: string }> | undefined,
    current: Readonly<{ bytes: string; observedAtMs: number; bindingKey: string }>):
    Readonly<{ status: 'available'; bytes: string; fromMs: number; toMs: number }> | Readonly<{ status: 'unavailable'; reason: DatabaseStatsReasonV1 }> {
    if (!previous) return { status: 'unavailable', reason: 'previous_sample_required' };
    if (previous.bindingKey !== current.bindingKey || previous.observedAtMs >= current.observedAtMs) return { status: 'unavailable', reason: 'comparison_unavailable' };
    return { status: 'available', bytes: (BigInt(current.bytes) - BigInt(previous.bytes)).toString(), fromMs: previous.observedAtMs, toMs: current.observedAtMs };
}
