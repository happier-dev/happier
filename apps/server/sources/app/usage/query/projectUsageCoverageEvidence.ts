import type { UsageAccountingCoverageReason, UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { readScopedUsageAccountingEvidence } from './scopedUsageEventRow';

export interface UsageCoverageEvidence {
    sources: UsageAnalyticsCoverage['sources'];
    reasons: UsageAccountingCoverageReason[];
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
        sources.set(key, {
            source, path, status,
            ...(row.machineId ? { machineId: row.machineId } : {}),
            ...(captureKind ? { captureKind } : {}),
            eventCount: (previous?.eventCount ?? 0) + 1,
            ...(asOfMs !== undefined || previous?.asOfMs !== undefined ? { asOfMs: Math.max(asOfMs ?? 0, previous?.asOfMs ?? 0) } : {}),
            ...(accounting?.historyComplete !== undefined || previous?.historyComplete !== undefined ? { historyComplete: accounting?.historyComplete === true && (!previous || previous.historyComplete === true) } : {}),
        });
        if (path === 'unknown' || status === 'unknown' || source === 'unknown') reasons.add('unknown_source');
        if (accounting?.historyComplete !== true || status !== 'available') reasons.add('incomplete_history');
    }
    if (sources.size === 0) reasons.add('unknown_source');
    return { sources: [...sources.values()], reasons: [...reasons] };
}
