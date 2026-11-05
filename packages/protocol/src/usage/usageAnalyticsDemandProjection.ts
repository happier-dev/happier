import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsBreakdownDimension, type UsageAnalyticsCoverage,
    type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';

/** Price availability does not change the completeness of the acquired money evidence. */
export function hasCompleteUsageCostEvidence(value: Pick<UsageAnalyticsQueryResponse, 'coverage'>): boolean {
  return value.coverage?.status === 'complete' || value.coverage?.status === 'partial'
    && value.coverage.reasons.every(reason => reason === 'unpriced_tokens');
}

/** Pricing owns completeness after a demand has selected its coverage/rankings. */
export function repriceUsageAnalyticsCoverage(admitted: UsageAnalyticsQueryResponse['coverage'],
  ranked: UsageAnalyticsQueryResponse['coverage'], unpriced: boolean): UsageAnalyticsQueryResponse['coverage'] {
  return ranked && { ...ranked, status: unpriced && hasCompleteUsageCostEvidence({ coverage: admitted }) ? 'partial' as const
    : !unpriced && hasCompleteUsageCostEvidence({ coverage: ranked }) ? 'complete' as const : ranked.status,
    reasons: [...ranked.reasons.filter(reason => reason !== 'unpriced_tokens'), ...(unpriced ? ['unpriced_tokens' as const] : [])] };
}

/** The same requested rankings determine server coverage and retained output selection. */
export function getUsageAnalyticsRankedDimensions(request: UsageAnalyticsQueryRequest): Set<UsageAnalyticsBreakdownDimension> {
    const dimensions = new Set(request.breakdowns ?? []);
    if (request.includeLeaders) for (const dimension of ['agent', 'model', 'session', 'project', 'workspace', 'backendMode'] as const) dimensions.add(dimension);
    return dimensions;
}

/** Source/category admission stays fixed; only requested dimension badges change. */
export function projectUsageAnalyticsCoverage(input: Omit<UsageAnalyticsCoverage, 'status'>,
    request: UsageAnalyticsQueryRequest): UsageAnalyticsCoverage {
    const dimensions = new Set<UsageAnalyticsBreakdownDimension>(['model', 'machine', ...request.breakdowns ?? []]);
    const missingDimensions = [...dimensions].filter(dimension => input.missingDimensions.includes(dimension));
    const status = input.sources.length === 0 || input.sources.every(source => source.status === 'unknown') ? 'unknown'
        : input.reasons.length > 0 || missingDimensions.length > 0 ? 'partial' : 'complete';
    return { ...input, missingDimensions, status };
}

/** Select covered output without admitting another population, price basis or private-evidence demand. */
export function projectUsageAnalyticsResponseDemand(value: UsageAnalyticsQueryResponse,
    admitted: UsageAnalyticsQueryRequest, requested: UsageAnalyticsQueryRequest): UsageAnalyticsQueryResponse | undefined {
    if (admitted.includeInsights !== requested.includeInsights
        && !(admitted.includeInsights === true && requested.includeInsights === false)) return undefined;
    const selectActivity = admitted.includeActivity === true && requested.includeActivity === true
        && admitted.activityResolution === 'both'
        && (requested.activityResolution === 'calendar' || requested.activityResolution === 'weekdayHour');
    if (admitted.activityResolution !== requested.activityResolution && !selectActivity) return undefined;
    if (getUsageAnalyticsQueryRequestKey({ ...admitted, includeInsights: requested.includeInsights,
        activityResolution: requested.activityResolution, breakdowns: requested.breakdowns })
        !== getUsageAnalyticsQueryRequestKey(requested)) return undefined;
    const supplied = new Set(admitted.breakdowns ?? []);
    if (requested.breakdowns?.some(dimension => !supplied.has(dimension))) return undefined;
    const dimensions = new Set<string>(requested.breakdowns ?? []);
    const removed = [...supplied].filter(dimension => !dimensions.has(dimension));
    let coverage = value.coverage;
    if (removed.length) {
        // A model breakdown and model timeline have different ranking coverage.
        // The response has only one badge and cannot invert that selection.
        if (requested.includeModelTimeline && removed.includes('model')) return undefined;
        const ranked = getUsageAnalyticsRankedDimensions(requested);
        if (requested.includeModelTimeline) ranked.add('model');
        // ranked_truncation does not say whether it came from the selected
        // output or underlying history. Removing an incomplete rank cannot
        // recover that provenance; acquire the exact answer in that case.
        if (!coverage) return undefined;
        const admittedRanks = coverage.ranked;
        if (removed.some(dimension => !ranked.has(dimension)
            && !admittedRanks.some(row => row.dimension === dimension && row.complete))) return undefined;
        const selected = projectUsageAnalyticsCoverage({ ...coverage,
            ranked: [...ranked].flatMap(dimension => admittedRanks.filter(row => row.dimension === dimension)) }, requested);
        coverage = value.costFacts === undefined ? selected
            : repriceUsageAnalyticsCoverage(selected, selected, value.costFacts.some(fact => fact.kind === 'unpriced'));
    }
    const rankedPricing = value.summary?.rankedPricing;
    return { ...value, coverage,
        ...(selectActivity ? { activity: value.activity && (requested.activityResolution === 'calendar'
            ? { calendarDays: value.activity.calendarDays } : { weekdayHourBuckets: value.activity.weekdayHourBuckets }) } : {}),
        insights: requested.includeInsights ? value.insights : undefined,
        messageStats: requested.includeInsights || requested.includeMessageStats ? value.messageStats : undefined,
        ...(removed.length ? {
            breakdowns: requested.breakdowns?.length
                ? Object.fromEntries(requested.breakdowns.map(dimension => [dimension, value.breakdowns?.[dimension]])) : undefined,
            summary: value.summary && { ...value.summary,
                rankedPricing: rankedPricing && Object.fromEntries([
                    ...(requested.breakdowns ?? []).flatMap(dimension => {
                        const key = `breakdowns:${dimension}`;
                        const entries = rankedPricing[key];
                        return entries === undefined ? [] : [[key, entries] as const];
                    }),
                    ...Object.entries(rankedPricing).filter(([key]) => !key.startsWith('breakdowns:')),
                ]) },
        } : {}),
    };
}
