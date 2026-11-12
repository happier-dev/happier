import { Session, type Profiler } from 'node:inspector';
import { expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { prepareUsageAnalyticsProjection } from './usageQueryService';
import type { ScopedUsageContribution } from './query/resolveScopedUsageContributions';

it('prices each Work contribution once and folds series money per bucket without discarded raw cost facts', async () => {
    const query = UsageAnalyticsQueryRequestSchema.parse({ granularity: 'day', includeSeries: true });
    const catalog = { ...bundledUsageModelPriceCatalog,
        models: { measured: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } };
    for (const count of [128, 256]) {
        const rows: ScopedUsageContribution[] = Array.from({ length: count }, (_, index) => ({
            id: `row-${index}`, sessionId: `session-${index}`, turnId: `turn-${index}`,
            observedAt: new Date(index % 2 * 86_400_000), createdAt: new Date(0),
            agentId: 'codex', backendMode: null, modelId: 'measured', machineId: 'machine',
            projectKey: 'project', workspaceId: null, source: 'runtime', scope: 'turn_delta', isCumulative: false,
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
            contextUsedTokens: null, contextWindowTokens: null, contributingEventIds: [`row-${index}`],
            tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
            cost: { reportedUsd: 0.1, estimatedUsd: 0.2, invoiceUsd: null,
                billingContext: 'api', costSource: 'provider_reported', currency: 'USD' },
        }));
        const inspector = new Session();
        inspector.connect();
        const post = (method: 'Profiler.enable' | 'Profiler.stopPreciseCoverage' | 'Profiler.disable') =>
            new Promise<void>((resolve, reject) => inspector.post(method, error => error ? reject(error) : resolve()));
        let coverage: Profiler.TakePreciseCoverageReturnType;
        let value: ReturnType<typeof prepareUsageAnalyticsProjection>['value'];
        try {
            await post('Profiler.enable');
            await new Promise<void>((resolve, reject) => inspector.post('Profiler.startPreciseCoverage',
                { callCount: true, detailed: true }, error => error ? reject(error) : resolve()));
            value = prepareUsageAnalyticsProjection({ messageCountsBySession: undefined }, query, catalog,
                { totalContributions: rows, evidenceRows: [], costMode: 'auto' }).value;
            coverage = await new Promise<Profiler.TakePreciseCoverageReturnType>((resolve, reject) =>
                inspector.post('Profiler.takePreciseCoverage', (error, result) => error ? reject(error) : resolve(result)));
            await post('Profiler.stopPreciseCoverage');
            await post('Profiler.disable');
        } finally { inspector.disconnect(); }
        const calls = (file: string, name: string) => coverage.result.filter(script => script.url.includes(file))
            .flatMap(script => script.functions).filter(fn => fn.functionName === name)
            .reduce((sum, fn) => sum + fn.ranges[0]!.count, 0);
        expect(value.contributions).toHaveLength(count);
        expect(new Set(value.contributions!.map(row => row.id)).size).toBe(count);
        expect(value.totals.tokens.total).toBe(count * 100);
        expect(resolveUsageCostBasis(value.totals.cost, 'auto')?.amountUsd).toBe(count * 0.1);
        expect(value.totals.cost.apiEquivalentUsd).toBe(count * 0.0001);
        expect(value.series).toHaveLength(2);
        for (const bucket of value.series!) {
            expect(bucket.tokens.total).toBe(count / 2 * 100);
            expect(resolveUsageCostBasis(bucket.cost, 'auto')?.amountUsd).toBe(count / 2 * 0.1);
            expect(bucket.cost.apiEquivalentUsd).toBe(count / 2 * 0.0001);
        }
        expect.soft(calls('usageCost.', 'priceUsageObservation'), 'actual tariff projection visits each admitted row once').toBe(count);
        expect.soft(calls('buildUsageResultProjection.', 'costFactsForRow'), 'repricing owns the published cost facts').toBe(0);
        expect.soft(calls('usageAggregation.', 'addUsageCostForMode'), 'series must not rebuild and publish money for every input row').toBe(0);
        expect.soft(calls('usageAggregation.', 'aggregateUsageContributionCosts'), 'one raw total and one fold per rendered bucket').toBe(3);
    }
});
