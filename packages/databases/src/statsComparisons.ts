import type { HealthCheckResultV1 } from '@happier-dev/plugin-sdk';
import type { DatabaseStatsCounterSampleV1, DatabaseStatsCounterComparisonV1, DatabaseStatsReasonV1 } from '@happier-dev/plugin-sdk/database';

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

export type DatabaseMeasuredWindowV1 = NonNullable<HealthCheckResultV1['measurements']>;
export type DatabaseEvidenceWindowComparisonV1 = Readonly<{
    status: 'comparable'; before: number; after: number; change: number; changePercent: number | null;
}> | Readonly<{ status: 'inconclusive'; reasons: readonly string[] }>;

/** P4 owns comparison arithmetic; telemetry supplies its retained, already measured windows. */
export function compareDatabaseEvidenceWindowsV1(previous: DatabaseMeasuredWindowV1,
    current: DatabaseMeasuredWindowV1): DatabaseEvidenceWindowComparisonV1 {
    // The metric owner retains complete export intervals inside a person’s
    // window. Boundary-only coverage stays visibly partial; it does not mean
    // that those measured intervals are missing, reset or sampled.
    const usable = (window: DatabaseMeasuredWindowV1) => window.completeness === 'complete'
        || window.completeness === 'partial' && window.reasons.length > 0 && window.reasons.every(reason => reason === 'boundary_gap');
    if (!usable(previous) || !usable(current)
        || previous.value === undefined || current.value === undefined) {
        const reasons = [...new Set([...previous.reasons, ...current.reasons])];
        return { status: 'inconclusive', reasons: reasons.length ? reasons : ['incomplete_measurements'] };
    }
    if (previous.measure !== current.measure || previous.unit !== current.unit || previous.basis !== current.basis) {
        return { status: 'inconclusive', reasons: ['incompatible_measurements'] };
    }
    if ([previous, current].some(window => new Set(window.producers?.flatMap(producer =>
        producer.serviceVersion === undefined ? [] : [producer.serviceVersion])).size > 1)) {
        return { status: 'inconclusive', reasons: ['mixed_versions'] };
    }
    const duration = previous.window.until - previous.window.since;
    if (duration <= 0 || current.window.until - current.window.since !== duration
        || previous.window.until > current.window.since) return { status: 'inconclusive', reasons: ['incompatible_windows'] };
    const change = current.value - previous.value;
    return { status: 'comparable', before: previous.value, after: current.value, change,
        changePercent: previous.value === 0 ? null : change / previous.value * 100 };
}
