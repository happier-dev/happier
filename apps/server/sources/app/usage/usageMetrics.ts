import type { UsageObservationCost, UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

type LegacyNumberMap = Record<string, number>;
export { normalizeLegacyUsageTokens } from '@happier-dev/protocol/usage/legacyUsageTokens';
export { createEmptyUsageTokens, createEmptyUsageCost, addUsageTokens, addUsageCost } from '@happier-dev/protocol/usage/usageAggregation';

function clampNonNegative(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return value;
}

export function usageHasAnyValue(tokens: UsageObservationTokens, cost: UsageObservationCost): boolean {
    return tokens.input !== null && tokens.input > 0
        || tokens.output !== null && tokens.output > 0
        || tokens.reasoning !== null && tokens.reasoning > 0
        || tokens.cacheRead !== null && tokens.cacheRead > 0
        || tokens.cacheWrite !== null && tokens.cacheWrite > 0
        || tokens.total !== null && tokens.total > 0
        || cost.reportedUsd !== null && cost.reportedUsd > 0
        || cost.estimatedUsd !== null && cost.estimatedUsd > 0
        || cost.invoiceUsd != null && cost.invoiceUsd > 0;
}

export function normalizeLegacyUsageCost(source: LegacyNumberMap): UsageObservationCost {
    return {
        reportedUsd: source.total === undefined ? null : clampNonNegative(source.total),
        estimatedUsd: null,
        invoiceUsd: null,
        billingContext: 'unknown',
        costSource: 'provider_reported',
        currency: 'USD',
    };
}

function subtractMeasurement(next: number | null | undefined, previous: number | null | undefined): number | null {
    if (next == null) return null;
    return previous == null ? next : clampNonNegative(next - previous);
}

export function subtractUsageTokens(
    nextValue: UsageObservationTokens,
    previousValue: UsageObservationTokens,
): UsageObservationTokens {
    return {
        input: subtractMeasurement(nextValue.input, previousValue.input),
        output: subtractMeasurement(nextValue.output, previousValue.output),
        reasoning: subtractMeasurement(nextValue.reasoning, previousValue.reasoning),
        cacheRead: subtractMeasurement(nextValue.cacheRead, previousValue.cacheRead),
        cacheWrite: subtractMeasurement(nextValue.cacheWrite, previousValue.cacheWrite),
        total: subtractMeasurement(nextValue.total, previousValue.total),
    };
}

export function subtractUsageCost(
    nextValue: UsageObservationCost,
    previousValue: UsageObservationCost,
): UsageObservationCost {
    return {
        reportedUsd: subtractMeasurement(nextValue.reportedUsd, previousValue.reportedUsd),
        estimatedUsd: subtractMeasurement(nextValue.estimatedUsd, previousValue.estimatedUsd),
        invoiceUsd: subtractMeasurement(nextValue.invoiceUsd, previousValue.invoiceUsd),
        billingContext: nextValue.billingContext ?? previousValue.billingContext ?? 'unknown',
        costSource: nextValue.costSource ?? previousValue.costSource ?? 'none',
        currency: nextValue.currency || previousValue.currency || 'USD',
        breakdown: subtractCostBreakdowns(nextValue.breakdown, previousValue.breakdown),
    };
}

function subtractCostBreakdowns(
    nextValue: UsageObservationCost['breakdown'],
    previousValue: UsageObservationCost['breakdown'],
): Record<string, number> | undefined {
    const keys = new Set([...Object.keys(nextValue ?? {}), ...Object.keys(previousValue ?? {})]);
    if (keys.size === 0) return undefined;
    const breakdown: Record<string, number> = {};
    for (const key of keys) {
        breakdown[key] = clampNonNegative((nextValue?.[key] ?? 0) - (previousValue?.[key] ?? 0));
    }
    return breakdown;
}
