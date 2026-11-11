import type { UsageAccountingCoverageReason, UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { readScopedUsageAccountingEvidence } from './scopedUsageEventRow';

export interface UsageCoverageEvidence {
    sources: UsageAnalyticsCoverage['sources'];
    reasons: UsageAccountingCoverageReason[];
}

function mergeCoverageSource(source: UsageAnalyticsCoverage['sources'][number],
    previous?: UsageAnalyticsCoverage['sources'][number]): UsageAnalyticsCoverage['sources'][number] {
    const { eventCount, asOfMs, historyComplete, ...identity } = source;
    return { ...identity, eventCount: (previous?.eventCount ?? 0) + eventCount,
        ...(asOfMs !== undefined || previous?.asOfMs !== undefined ? { asOfMs: Math.max(asOfMs ?? 0, previous?.asOfMs ?? 0) } : {}),
        ...(historyComplete !== undefined || previous?.historyComplete !== undefined
            ? { historyComplete: historyComplete === true && (!previous || previous.historyComplete === true) } : {}) };
}

/** Ordered nonempty partitions preserve the complete evidence population's source and reason order. */
export function mergeUsageCoverageEvidence(parts: readonly UsageCoverageEvidence[]): UsageCoverageEvidence {
    const sources = new Map<string, UsageAnalyticsCoverage['sources'][number]>();
    const reasons = new Set<UsageAccountingCoverageReason>();
    for (const part of parts) {
        if (part.sources.length === 0) continue;
        for (const source of part.sources) {
            const key = JSON.stringify([source.source, source.path, source.status, source.machineId]);
            sources.set(key, mergeCoverageSource(source, sources.get(key)));
        }
        for (const reason of part.reasons) reasons.add(reason);
    }
    return { sources: [...sources.values()], reasons: [...reasons] };
}

/** After reconciliation, coverage needs producer groups rather than historical row bodies. */
export function projectUsageCoverageEvidence(rows: readonly Pick<ScopedUsageEventRow,
    'source' | 'machineId' | 'metadata' | 'accountingEvidence'>[]): UsageCoverageEvidence {
    const sources = new Map<string, UsageAnalyticsCoverage['sources'][number]>();
    const reasons = new Set<UsageAccountingCoverageReason>();
    for (const row of rows) {
        const { accounting } = readScopedUsageAccountingEvidence(row);
        const source = row.source ?? 'unknown';
        const path = accounting?.path ?? 'unknown';
        const status = accounting?.status ?? 'unknown';
        const key = JSON.stringify([source, path, status, row.machineId]);
        const previous = sources.get(key);
        const asOfMs = accounting?.asOfMs;
        // Legacy is a transport bridge, not evidence of log capture.
        const captureKind = path === 'runtime' ? 'measured' : path === 'native' ? 'from_logs'
            : status === 'unsupported' ? 'not_added' : undefined;
        sources.set(key, mergeCoverageSource({
            source, path, status,
            ...(row.machineId ? { machineId: row.machineId } : {}),
            ...(captureKind ? { captureKind } : {}),
            eventCount: 1,
            ...(asOfMs !== undefined ? { asOfMs } : {}),
            ...(accounting?.historyComplete !== undefined ? { historyComplete: accounting.historyComplete } : {}),
        }, previous));
        if (path === 'unknown' || status === 'unknown' || source === 'unknown') reasons.add('unknown_source');
        if (accounting?.historyComplete !== true || status !== 'available') reasons.add('incomplete_history');
    }
    return { sources: [...sources.values()], reasons: [...reasons] };
}
