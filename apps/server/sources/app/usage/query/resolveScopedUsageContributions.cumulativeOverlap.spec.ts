import { describe, expect, it } from 'vitest';

import { resolveUsageMeasuredTokens } from '@happier-dev/protocol/usage/usageAggregation';

import { createEmptyUsageCost, createEmptyUsageTokens } from '../usageMetrics';
import { resolveScopedUsageContributions, type ScopedUsageEventRow } from './resolveScopedUsageContributions';

function checkpoint(id: string, time: number, input: number, cacheRead: number | null,
    counterEpoch: string, inputIncludesCache?: boolean): ScopedUsageEventRow {
    return {
        id, sessionId: 'session', agentId: 'claude', source: 'native', scope: 'session_cumulative',
        observedAt: new Date(time), createdAt: new Date(time), isCumulative: true,
        backendMode: null, modelId: null, projectKey: null, workspaceId: null, machineId: null, turnId: null,
        tokens: { ...createEmptyUsageTokens(), input, cacheRead }, cost: createEmptyUsageCost(),
        metadata: { usageAccounting: { historyComplete: true, counterEpoch,
            ...(inputIncludesCache === undefined ? {} : { inputIncludesCache }) } },
    };
}

describe('cumulative overlap accounting', () => {
    it.each([
        ['declared overlap', true, [100, 100, 130, 170]],
        ['declared disjoint', false, [100, 120, 160, 208]],
        ['undeclared', undefined, [100, 120, 160, 208]],
    ] as const)('conserves measured levels and retains newly witnessed raw cache for %s',
        (_name, inputIncludesCache, expectedTotals) => {
            const rows = [
                checkpoint('initial', 1, 100, null, 'first', inputIncludesCache),
                checkpoint('cache-witness', 2, 100, 20, 'first', inputIncludesCache),
                checkpoint('increase', 3, 130, 30, 'first', inputIncludesCache),
                checkpoint('restart', 4, 40, 8, 'next', inputIncludesCache),
            ];
            const result = resolveScopedUsageContributions(rows);
            expect(result.coverageReasons).toEqual([]);
            expect(result.totalContributions.map(({ id, tokens }) => [id, tokens.cacheRead, tokens.total])).toEqual([
                ['initial', null, null], ['cache-witness', 20, null], ['increase', 10, null], ['restart', 8, null],
            ]);
            let cumulativeTotal = 0;
            expect(result.totalContributions.map(({ tokens }) => {
                cumulativeTotal += resolveUsageMeasuredTokens(tokens).total ?? 0;
                return cumulativeTotal;
            })).toEqual(expectedTotals);
        });
});
