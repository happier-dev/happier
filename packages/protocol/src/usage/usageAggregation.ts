import type { UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { resolveUsageCostBasis, type UsageCostMode } from './usageCost.js';

export function createEmptyUsageTokens(): UsageObservationTokens {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function createEmptyUsageCost(currency = 'USD'): UsageObservationCost {
    return { reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0, billingContext: 'unknown', costSource: 'none', currency };
}

export function addUsageTokens(left: UsageObservationTokens, right: UsageObservationTokens): UsageObservationTokens {
    return { input: left.input + right.input, output: left.output + right.output, reasoning: left.reasoning + right.reasoning,
        cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, total: left.total + right.total };
}

export function addUsageCost(left: UsageObservationCost, right: UsageObservationCost): UsageObservationCost {
    const keys = new Set([...Object.keys(left.breakdown ?? {}), ...Object.keys(right.breakdown ?? {})]);
    const breakdown = keys.size ? Object.fromEntries([...keys].map(key => [key, (left.breakdown?.[key] ?? 0) + (right.breakdown?.[key] ?? 0)])) : undefined;
    return { reportedUsd: left.reportedUsd + right.reportedUsd, estimatedUsd: left.estimatedUsd + right.estimatedUsd,
        invoiceUsd: (left.invoiceUsd ?? 0) + (right.invoiceUsd ?? 0),
        billingContext: left.billingContext === right.billingContext ? left.billingContext : 'unknown',
        costSource: left.costSource === right.costSource ? left.costSource : 'none',
        currency: left.currency === right.currency ? left.currency : 'MIXED', breakdown };
}

// Distinguish the initial zero accumulator from an already unpriced population.
// This aggregation-only evidence never enters the serialized contract.
const aggregateBasisAvailable = Symbol('aggregateBasisAvailable');
type AggregatedUsageCost = UsageObservationCost & { [aggregateBasisAvailable]?: boolean };

export function addUsageCostForMode(left: UsageObservationCost, right: UsageObservationCost, mode: UsageCostMode): AggregatedUsageCost {
    const leftBasis = resolveUsageCostBasis(left, mode);
    const rightBasis = resolveUsageCostBasis(right, mode);
    const leftAggregate: AggregatedUsageCost = left;
    const leftEmpty = leftAggregate[aggregateBasisAvailable] !== false && left.apiEquivalentUsd === undefined && left.costSource === 'none'
        && left.reportedUsd === 0 && left.estimatedUsd === 0 && (left.invoiceUsd ?? 0) === 0;
    const apiEquivalentUsd = leftEmpty ? right.apiEquivalentUsd
        : left.apiEquivalentUsd !== undefined && right.apiEquivalentUsd !== undefined ? left.apiEquivalentUsd + right.apiEquivalentUsd : undefined;
    const combined = { ...addUsageCost(left, right), ...(apiEquivalentUsd !== undefined ? {
        apiEquivalentUsd, pricingSource: leftEmpty ? right.pricingSource
            : left.pricingSource === right.pricingSource ? left.pricingSource : 'effective_model_prices',
    } : {}) };
    if (leftEmpty && rightBasis) return { ...combined, currency: right.currency, costSource: right.costSource,
        effectiveUsd: rightBasis.amountUsd, [aggregateBasisAvailable]: true };
    if (leftBasis && rightBasis && leftBasis.kind === rightBasis.kind && leftBasis.currency === rightBasis.currency) {
        return { ...combined, costSource: left.costSource, effectiveUsd: leftBasis.amountUsd + rightBasis.amountUsd, [aggregateBasisAvailable]: true };
    }
    return { ...combined, costSource: 'none', [aggregateBasisAvailable]: false };
}

export function withEffectiveUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
    const basis = resolveUsageCostBasis(cost, mode);
    const { effectiveUsd: _previous, ...raw } = cost;
    return basis ? { ...raw, effectiveUsd: basis.amountUsd } : raw;
}
