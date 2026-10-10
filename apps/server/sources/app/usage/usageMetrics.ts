import type {
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";

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
    return (
        tokens.input > 0 ||
        tokens.output > 0 ||
        tokens.reasoning > 0 ||
        tokens.cacheRead > 0 ||
        tokens.cacheWrite > 0 ||
        tokens.total > 0 ||
        cost.reportedUsd > 0 ||
        cost.estimatedUsd > 0 ||
        (cost.invoiceUsd ?? 0) > 0
    );
}

export function normalizeLegacyUsageCost(source: LegacyNumberMap): UsageObservationCost {
    return {
        reportedUsd: clampNonNegative(source.total ?? 0),
        estimatedUsd: 0,
        invoiceUsd: 0,
        billingContext: 'unknown',
        costSource: 'provider_reported',
        currency: 'USD',
    };
}

export function subtractUsageTokens(
    nextValue: UsageObservationTokens,
    previousValue: UsageObservationTokens,
): UsageObservationTokens {
    return {
        input: clampNonNegative(nextValue.input - previousValue.input),
        output: clampNonNegative(nextValue.output - previousValue.output),
        reasoning: clampNonNegative(nextValue.reasoning - previousValue.reasoning),
        cacheRead: clampNonNegative(nextValue.cacheRead - previousValue.cacheRead),
        cacheWrite: clampNonNegative(nextValue.cacheWrite - previousValue.cacheWrite),
        total: clampNonNegative(nextValue.total - previousValue.total),
    };
}

export function subtractUsageCost(
    nextValue: UsageObservationCost,
    previousValue: UsageObservationCost,
): UsageObservationCost {
    return {
        reportedUsd: clampNonNegative(nextValue.reportedUsd - previousValue.reportedUsd),
        estimatedUsd: clampNonNegative(nextValue.estimatedUsd - previousValue.estimatedUsd),
        invoiceUsd: clampNonNegative((nextValue.invoiceUsd ?? 0) - (previousValue.invoiceUsd ?? 0)),
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
