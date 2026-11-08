import { describe, expect, it } from 'vitest';
import * as coverage from './projectUsageCoverageEvidence';

describe('Usage coverage evidence partitions', () => {
    it('merges ordered day and report evidence with the same sources and reasons as the complete population', () => {
        const complete = (machineId: string, asOfMs: number) => ({ source: 'runtime', machineId,
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true, asOfMs } } });
        const unspecified = { source: 'runtime', machineId: 'unspecified',
            metadata: { usageAccounting: { path: 'runtime', status: 'available' } } };
        const days = [
            [complete('shared', 100), unspecified, { source: 'unsupported', machineId: null,
                metadata: { usageAccounting: { path: 'unknown', status: 'unsupported' } } }],
            [],
            [complete('shared', 50), { source: 'runtime', machineId: 'shared',
                metadata: { usageAccounting: { path: 'runtime', status: 'available' } } },
                complete('unspecified', 200), { ...unspecified, machineId: 'both-unspecified' }],
            [{ ...unspecified, machineId: 'both-unspecified' }],
            [{ source: 'legacy_usage_report', machineId: null,
                metadata: { usageAccounting: { path: 'legacy', status: 'unknown', historyComplete: false, asOfMs: 300 } } }],
        ];
        expect(coverage.mergeUsageCoverageEvidence(days.map(coverage.projectUsageCoverageEvidence)))
            .toEqual(coverage.projectUsageCoverageEvidence(days.flat()));
        expect(coverage.mergeUsageCoverageEvidence([
            coverage.projectUsageCoverageEvidence([complete('complete', 100)]), coverage.projectUsageCoverageEvidence([]),
        ])).toEqual(coverage.projectUsageCoverageEvidence([complete('complete', 100)]));
        expect(coverage.mergeUsageCoverageEvidence([])).toEqual(coverage.projectUsageCoverageEvidence([]));
    });
});
