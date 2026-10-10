import type {
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";

type LegacyNumberMap = Record<string, number>;
export { normalizeLegacyUsageTokens } from '@happier-dev/protocol/usage/legacyUsageTokens';

function clampNonNegative(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return value;
}

export function createEmptyUsageTokens(): UsageObservationTokens {
    return {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
    };
}

export function createEmptyUsageCost(currency: string = 'USD'): UsageObservationCost {
    return {
        reportedUsd: 0,
        estimatedUsd: 0,
        invoiceUsd: 0,
        billingContext: 'unknown',
        costSource: 'none',
        currency,
    };
}

export function addUsageTokens(
    left: UsageObservationTokens,
    right: UsageObservationTokens,
): UsageObservationTokens {
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        reasoning: left.reasoning + right.reasoning,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        total: left.total + right.total,
    };
}

export function addUsageCost(
    left: UsageObservationCost,
    right: UsageObservationCost,
): UsageObservationCost {
    return {
        reportedUsd: left.reportedUsd + right.reportedUsd,
        estimatedUsd: left.estimatedUsd + right.estimatedUsd,
        invoiceUsd: (left.invoiceUsd ?? 0) + (right.invoiceUsd ?? 0),
        billingContext: left.billingContext === right.billingContext ? left.billingContext : 'unknown',
        costSource: left.costSource === right.costSource ? left.costSource : 'none',
        currency: left.currency === right.currency ? left.currency : 'MIXED',
        breakdown: addCostBreakdowns(left.breakdown, right.breakdown),
    };
}

function addCostBreakdowns(
    left: UsageObservationCost['breakdown'],
    right: UsageObservationCost['breakdown'],
): Record<string, number> | undefined {
    const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
    if (keys.size === 0) return undefined;
    const breakdown: Record<string, number> = {};
    for (const key of keys) {
        breakdown[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
    }
    return breakdown;
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
