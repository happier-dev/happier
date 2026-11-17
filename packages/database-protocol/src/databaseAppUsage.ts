import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse, UsageAnalyticsSeriesBucket, UsageAnalyticsTotals } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { addUsageMeasuredTokens, aggregateUsageCosts, createEmptyUsageCost, createEmptyUsageTokens } from '@happier-dev/protocol/usage/usageAggregation';
import { repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { resolveUsageCostBasis, type UsageCostMode } from '@happier-dev/protocol/usage/usageCostFacts';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import type { DatabaseCaptureCostsReadResultV1 } from './databaseCaptureCosts.js';
import type { DatabaseTelemetryMetricIntervalV1 } from './databaseTelemetryMetricSeries.js';

type AppCostRead = Extract<DatabaseCaptureCostsReadResultV1, { ok: true }>;
export type DatabaseAppUsageV1 = Readonly<{
    subject: 'app_calls';
    accounting: UsageAnalyticsQueryResponse;
    coverage: AppCostRead['coverage'];
}>;

function totals(rows: readonly UsageAnalyticsContribution[]): UsageAnalyticsTotals {
    return { eventCount: rows.reduce((count, row) => count + (row.eventCount ?? 0), 0),
        tokens: rows.reduce((sum, row) => addUsageMeasuredTokens(sum, row.tokens), createEmptyUsageTokens()),
        cost: aggregateUsageCosts(rows.map(row => row.cost)) };
}

/**
 * Ephemeral App calls facts for the existing Usage renderers. The host supplies
 * usage.prices.get and the invoking viewer's usageModelPriceOverridesV1, and
 * chooses this subject exclusively; no Agent history is read or written here.
 * Request the same granularity from costs/read so each operand stays in one bucket.
 */
export function projectDatabaseCaptureUsageV1(read: Pick<AppCostRead, 'items' | 'since' | 'until' | 'coverage'>, catalog: UsageModelPriceCatalog,
    viewerOverrides: UsageModelPriceOverridesV1,
    options: Readonly<{ granularity: 'hour' | 'day'; costMode?: UsageCostMode }>): DatabaseAppUsageV1 {
    const contributions: UsageAnalyticsContribution[] = read.items.map((item, index) => ({
        id: `app_calls:${index}`, observedAtMs: item.firstSeenMs, eventCount: item.callCount,
        sessionId: null, turnId: null, agentId: null, modelId: item.modelId ?? item.requestedModel,
        machineId: null, projectKey: null, workspaceId: null, source: 'app_calls',
        tokens: item.tokens, ...(item.tokenCategories ? { tokenCategories: item.tokenCategories } : {}),
        cost: item.reportedCost
            ? { reportedUsd: item.reportedCost.amount, estimatedUsd: null, currency: item.reportedCost.currency,
                billingContext: 'api_usage', costSource: 'provider_reported' }
            : createEmptyUsageCost(),
    }));
    const bucketRows = new Map<number, UsageAnalyticsContribution[]>();
    for (let index = 0; index < read.items.length; index++) {
        const start = read.items[index]!.bucketStartMs;
        const rows = bucketRows.get(start) ?? [];
        rows.push(contributions[index]!);
        bucketRows.set(start, rows);
    }
    const bucketWidthMs = options.granularity === 'hour' ? 3_600_000 : 86_400_000;
    const series: UsageAnalyticsSeriesBucket[] = [...bucketRows].sort(([a], [b]) => a - b).map(([start, rows]) => ({
        bucketStartMs: Math.max(read.since, start), bucketEndMs: Math.min(read.until, start + bucketWidthMs), ...totals(rows),
    }));
    const historyComplete = read.coverage.lostObservations === 0 && read.coverage.reason === null;
    const categoriesComplete = read.coverage.tokenCategoryCallCount === read.coverage.callCount;
    const complete = historyComplete && categoriesComplete;
    const raw: UsageAnalyticsQueryResponse = { v: 1, totals: totals(contributions), series, contributions,
        coverage: { status: complete ? 'complete' : 'partial',
            reasons: [...(historyComplete ? [] : ['incomplete_history' as const]),
                ...(categoriesComplete ? [] : ['unknown_token_categories' as const])],
            sources: [{ source: 'app_calls', path: 'runtime', status: complete ? 'available' : 'partial',
                asOfMs: read.until, eventCount: read.coverage.callCount, historyComplete }],
            missingDimensions: [], range: { startMs: read.since, endMs: read.until, complete: historyComplete },
            ranked: [] },
    };
    return { subject: 'app_calls', coverage: read.coverage,
        accounting: repriceUsageAnalyticsResponse(raw, catalog, viewerOverrides, options.costMode ?? 'api_equivalent',
            { breakdowns: ['model', 'source'], includeLeaders: false, topLimit: contributions.length }) };
}

/** D36: the Metric widget consumes the same viewer-priced buckets as Usage. */
export function projectDatabaseAppCostMetricSeriesV1(usage: DatabaseAppUsageV1): readonly DatabaseTelemetryMetricIntervalV1[] {
    return (usage.accounting.series ?? []).map(bucket => {
        const cost = resolveUsageCostBasis(bucket.cost, 'api_equivalent');
        return { since: bucket.bucketStartMs, until: bucket.bucketEndMs, unit: 'USD', count: bucket.eventCount,
            ...(cost ? { value: cost.amountUsd } : {}) };
    });
}
