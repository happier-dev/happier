import type { UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageAnalyticsSummary } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { hasCompleteUsageCostEvidence, projectUsageAnalyticsSummarySteps } from '@happier-dev/protocol/usage/usageCost';
import { compareUsageMeasurementsDescending } from '@happier-dev/protocol/usage/usageAggregation';
import { prepareUsageAnalyticsProjectionSteps, type UsageAnalyticsProjectionContext } from '../usageQueryService';
import type { UsageAnalyticsPopulation } from './projectUsageAnalyticsPopulation';
import { setImmediate } from 'node:timers/promises';
import type { UsageQueryTiming } from './usageQueryTiming';

export function assertUsageReaderOpen(isReaderClosed?: () => boolean): void {
    if (isReaderClosed?.()) throw new Error('Usage reader closed');
}

/** Service native callbacks between the accounting owner's actual projection units. */
export async function completeUsageAnalyticsProjection<T>(projection: Generator<void, T, void>,
    isReaderClosed?: () => boolean): Promise<T> {
    assertUsageReaderOpen(isReaderClosed);
    let next = projection.next();
    while (!next.done) {
        await setImmediate();
        assertUsageReaderOpen(isReaderClosed);
        next = projection.next();
    }
    return next.value;
}

/** Combine output demand only after the caller admits one population and chart coordinate. */
export function unionUsageAnalyticsProjectionDemands(queries: readonly UsageAnalyticsQueryRequest[]): UsageAnalyticsQueryRequest {
    return { ...queries[0]!,
        topLimit: Math.max(...queries.map(query => query.topLimit)),
        includeSeries: queries.some(query => query.includeSeries),
        includeInsights: queries.some(query => query.includeInsights),
        includeActivity: queries.some(query => query.includeActivity),
        includeLeaders: queries.some(query => query.includeLeaders),
        includeModelTimeline: queries.some(query => query.includeModelTimeline),
        includeMessageStats: queries.some(query => query.includeMessageStats),
        activityResolution: queries[0]!.population === 'public_eligible_personal' ? queries[0]!.activityResolution : 'both',
        breakdowns: [...new Set(queries.flatMap(query => query.breakdowns ?? []))],
    };
}

/** Output demand is a union over one admitted population and chart coordinate, not another row projection. */
export async function projectUsageAnalyticsDemands(snapshot: UsageAnalyticsProjectionContext, queries: readonly UsageAnalyticsQueryRequest[],
    catalog: UsageModelPriceCatalog, population: UsageAnalyticsPopulation, prepareSummary: boolean, timing?: UsageQueryTiming,
    groupPrices = false, isReaderClosed?: () => boolean, retainContributions = true):
    Promise<(query: UsageAnalyticsQueryRequest, captured: UsageAnalyticsProjectionContext) => Promise<UsageAnalyticsQueryResponse>> {
    const union = unionUsageAnalyticsProjectionDemands(queries);
    const prepared = await completeUsageAnalyticsProjection(prepareUsageAnalyticsProjectionSteps(snapshot, union, catalog, population, timing, groupPrices, retainContributions), isReaderClosed);
    // Completeness of total-price evidence can differ with a truncated requested
    // ranking. It has two states, not one row pass per requesting widget.
    const summaries = new Map<boolean, UsageAnalyticsSummary>();
    return async (query: UsageAnalyticsQueryRequest, captured: UsageAnalyticsProjectionContext) => {
        const value = prepared.select(query, captured);
        if (!prepareSummary) return value;
        const complete = hasCompleteUsageCostEvidence(value);
        let summary = summaries.get(complete);
        if (!summary) {
            const projected = await completeUsageAnalyticsProjection(projectUsageAnalyticsSummarySteps({ ...prepared.value,
                coverage: value.coverage, costFacts: value.costFacts }, union, prepared.pricingPartitions), isReaderClosed);
            summary = projected.summary!;
            summaries.set(complete, summary);
        }
        const pricing = summary.pricing && Object.fromEntries(Object.entries(summary.pricing).filter(([key]) =>
            !key.startsWith('series:') || query.includeSeries));
        const rankedPricing = summary.rankedPricing && Object.fromEntries(Object.entries(summary.rankedPricing).filter(([key]) => {
            if (key.startsWith('breakdowns:')) return query.breakdowns?.some(dimension => key === `breakdowns:${dimension}`);
            if (key.startsWith('leaders:')) return query.includeLeaders;
            return query.includeModelTimeline;
        }).map(([key, candidates]) => {
            // Private prices can reorder every candidate tied at the displayed
            // token frontier. Retain that whole tie, not just N priced entries.
            const frontier = candidates[Math.min(query.topLimit, candidates.length) - 1]?.value.tokens.total;
            return [key, frontier === undefined ? [] : candidates.filter(candidate =>
                compareUsageMeasurementsDescending(candidate.value.tokens.total, frontier) <= 0)];
        }));
        return { ...value, summary: { ...summary, pricing, rankedPricing,
            accountingCalendar: query.includeActivity || query.includeModelTimeline ? summary.accountingCalendar : undefined } };
    };
}
