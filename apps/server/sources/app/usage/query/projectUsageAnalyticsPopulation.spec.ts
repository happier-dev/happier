import { describe, expect, it } from 'vitest';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import * as population from './projectUsageAnalyticsPopulation';
import { toScopedUsageEvidenceRow } from './scopedUsageEventRow';

describe('Usage legacy report bridge facts', () => {
    it('synthesizes the same retained reports from complete bridges while only changed source rows are hydrated', () => {
        const bridges = [
            { source: 'legacy_usage_report', sessionId: 'session', metadata: JSON.stringify({ legacyKey: 'bridged' }) },
            { source: 'runtime', sessionId: 'session', metadata: { legacyKey: 'retained' } },
            { source: 'legacy_usage_report', sessionId: null, metadata: { legacyKey: 'other' } },
            { source: 'legacy_usage_report', sessionId: 'session', metadata: '{malformed' },
        ];
        const report = (id: string, key: string, total: number, sessionId: string | null = 'session') => ({
            id, sessionId, key, data: { tokens: { total }, cost: { total: total / 100 } },
            createdAt: new Date(100), updatedAt: new Date(200),
        });
        const reports: UsageAnalyticsSnapshot['legacyReports'] = [report('bridged', 'bridged', 10),
            report('retained', 'retained', 20), report('duplicate', 'retained', 30),
            { ...report('invalid', 'invalid', 40), data: null }, report('unlinked', 'unlinked', 50, null)];
        const bridgeFacts = population.toUsageLegacyBridgeFacts(bridges);
        expect(bridgeFacts).toEqual([{ sessionId: 'session', key: 'bridged' },
            { sessionId: null, key: 'other' }, { sessionId: 'session', key: null }]);
        const complete = population.normalizeUsageAnalyticsEvidenceRows(bridges, reports).slice(bridges.length);
        expect(population.resolveUsageLegacyReportRows(reports, bridgeFacts).map(toScopedUsageEvidenceRow))
            .toEqual(complete);
        expect(complete.map(row => 'id' in row ? row.id : undefined)).toEqual(['legacy-report:retained', 'legacy-report:unlinked']);
    });
});
