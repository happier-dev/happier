import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse, UsageAnalyticsSeriesBucket, UsageAnalyticsTotals } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { addUsageMeasuredTokens, aggregateUsageCosts, createEmptyUsageCost, createEmptyUsageTokens } from '@happier-dev/protocol/usage/usageAggregation';
import { repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { resolveUsageCostBasis, type UsageCostMode } from '@happier-dev/protocol/usage/usageCostFacts';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import type { DatabaseCaptureCostsReadResultV1 } from './databaseCaptureCosts.js';
import type { DatabaseTelemetryMetricIntervalV1 } from './databaseTelemetryMetricSeries.js';
export { UsageModelPriceOverridesV1Schema } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
export { UsageModelPriceReadResultSchema } from '@happier-dev/protocol/usage/usageModelPriceDelivery';
export type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
export { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';

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

type AppCostWindow = Pick<AppCostRead, 'items' | 'since' | 'until' | 'coverage'>;
/** One Environment's operands under its own App calls source; the label names it in the shared breakdowns. */
export type DatabaseAppUsagePartV1 = Readonly<{ source: string; label?: string; read: AppCostWindow }>;

/**
 * Ephemeral App calls facts for the existing Usage renderers. The host supplies
 * usage.prices.get and the invoking viewer's usageModelPriceOverridesV1, and
 * chooses this subject exclusively; no Agent history is read or written here.
 * Request the same granularity from costs/read so each operand stays in one bucket.
 */
export function projectDatabaseCaptureUsageV1(read: AppCostWindow, catalog: UsageModelPriceCatalog,
    viewerOverrides: UsageModelPriceOverridesV1,
    options: Readonly<{ granularity: 'hour' | 'day'; costMode?: UsageCostMode }>): DatabaseAppUsageV1 {
    return projectDatabaseCaptureUsageSourcesV1([{ source: 'app_calls', read }], catalog, viewerOverrides, options);
}

/** Several Environments' windows (same since/until) as one App calls population, one source per Environment. */
export function projectDatabaseCaptureUsageSourcesV1(parts: readonly DatabaseAppUsagePartV1[], catalog: UsageModelPriceCatalog,
    viewerOverrides: UsageModelPriceOverridesV1,
    options: Readonly<{ granularity: 'hour' | 'day'; costMode?: UsageCostMode }>): DatabaseAppUsageV1 {
    const since = Math.min(...parts.map(part => part.read.since));
    const until = Math.max(...parts.map(part => part.read.until));
    const rows = parts.flatMap(part => part.read.items.map(item => ({ item, source: part.source })));
    const contributions: UsageAnalyticsContribution[] = rows.map(({ item, source }, index) => ({
        id: `app_calls:${index}`, observedAtMs: item.firstSeenMs, eventCount: item.callCount,
        sessionId: null, turnId: null, agentId: null, modelId: item.modelId ?? item.requestedModel,
        machineId: null, projectKey: null, workspaceId: null, source,
        tokens: item.tokens, ...(item.tokenCategories ? { tokenCategories: item.tokenCategories } : {}),
        cost: item.reportedCost
            ? { reportedUsd: item.reportedCost.amount, estimatedUsd: null, currency: item.reportedCost.currency,
                billingContext: 'api_usage', costSource: 'provider_reported' }
            : createEmptyUsageCost(),
    }));
    const bucketRows = new Map<number, UsageAnalyticsContribution[]>();
    for (let index = 0; index < rows.length; index++) {
        const start = rows[index]!.item.bucketStartMs;
        const bucket = bucketRows.get(start) ?? [];
        bucket.push(contributions[index]!);
        bucketRows.set(start, bucket);
    }
    const bucketWidthMs = options.granularity === 'hour' ? 3_600_000 : 86_400_000;
    const series: UsageAnalyticsSeriesBucket[] = [...bucketRows].sort(([a], [b]) => a - b).map(([start, bucket]) => ({
        bucketStartMs: Math.max(since, start), bucketEndMs: Math.min(until, start + bucketWidthMs), ...totals(bucket),
    }));
    const coverage: AppCostRead['coverage'] = parts.reduce((sum, { read }) => ({
        callCount: sum.callCount + read.coverage.callCount,
        tokenCategoryCallCount: sum.tokenCategoryCallCount + read.coverage.tokenCategoryCallCount,
        reportedCostCallCount: sum.reportedCostCallCount + read.coverage.reportedCostCallCount,
        lostObservations: sum.lostObservations + read.coverage.lostObservations,
        reason: sum.reason ?? read.coverage.reason,
    }), { callCount: 0, tokenCategoryCallCount: 0, reportedCostCallCount: 0, lostObservations: 0, reason: null as string | null });
    const partComplete = (read: AppCostWindow) => read.coverage.lostObservations === 0 && read.coverage.reason === null;
    const historyComplete = parts.every(part => partComplete(part.read));
    const categoriesComplete = coverage.tokenCategoryCallCount === coverage.callCount;
    const complete = historyComplete && categoriesComplete;
    const raw: UsageAnalyticsQueryResponse = { v: 1, totals: totals(contributions), series, contributions,
        coverage: { status: complete ? 'complete' : 'partial',
            reasons: [...(historyComplete ? [] : ['incomplete_history' as const]),
                ...(categoriesComplete ? [] : ['unknown_token_categories' as const])],
            sources: parts.map(({ source, read }) => {
                const available = partComplete(read) && read.coverage.tokenCategoryCallCount === read.coverage.callCount;
                return { source, path: 'runtime' as const, status: available ? 'available' as const : 'partial' as const,
                    asOfMs: read.until, eventCount: read.coverage.callCount, historyComplete: partComplete(read) };
            }),
            missingDimensions: [], range: { startMs: since, endMs: until, complete: historyComplete },
            ranked: [] },
    };
    const accounting = repriceUsageAnalyticsResponse(raw, catalog, viewerOverrides, options.costMode ?? 'api_equivalent',
        { breakdowns: ['model', 'source'], includeLeaders: false, topLimit: Math.max(contributions.length, 1) });
    // Name each Environment where the shared breakdowns show it; repricing keeps these labels.
    const labels = new Map(parts.flatMap(part => part.label ? [[part.source, part.label] as const] : []));
    const sources = accounting.breakdowns?.source;
    return { subject: 'app_calls', coverage,
        accounting: sources && labels.size ? { ...accounting, breakdowns: { ...accounting.breakdowns,
            source: sources.map(entry => labels.has(entry.key) ? { ...entry, label: labels.get(entry.key)! } : entry) } } : accounting };
}

/** D36: the Metric widget consumes the same viewer-priced buckets as Usage. */
export function projectDatabaseAppCostMetricSeriesV1(usage: DatabaseAppUsageV1): readonly DatabaseTelemetryMetricIntervalV1[] {
    return (usage.accounting.series ?? []).map(bucket => {
        const cost = resolveUsageCostBasis(bucket.cost, 'api_equivalent');
        return { since: bucket.bucketStartMs, until: bucket.bucketEndMs, unit: 'USD', count: bucket.eventCount,
            ...(cost ? { value: cost.amountUsd } : {}) };
    });
}
