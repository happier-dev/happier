import type { UsageCostMode, UsageObservationCost } from "@happier-dev/protocol";
import { resolveUsageCostBasis } from "@happier-dev/protocol";
import { addUsageCost } from "../usageMetrics";

export { resolveEffectiveUsageCostUsd, resolveUsageCostMode, resolveUsageCostPresentationSource, type UsageCostMode } from "@happier-dev/protocol";

// Aggregation-only evidence distinguishes an initial zero accumulator from a
// zero-valued population that has already lost its monetary basis. Symbols do
// not enter the serialized contract, and object spreads retain this local fact.
const aggregateBasisAvailable = Symbol("aggregateBasisAvailable");
type AggregatedUsageCost = UsageObservationCost & { [aggregateBasisAvailable]?: boolean };

export function addUsageCostForMode(
    left: UsageObservationCost,
    right: UsageObservationCost,
    mode: UsageCostMode,
): AggregatedUsageCost {
    const leftBasis = resolveUsageCostBasis(left, mode);
    const rightBasis = resolveUsageCostBasis(right, mode);
    const leftAggregate: AggregatedUsageCost = left;
    const leftEmpty = leftAggregate[aggregateBasisAvailable] !== false && left.apiEquivalentUsd === undefined && left.costSource === "none" && left.reportedUsd === 0 && left.estimatedUsd === 0 && (left.invoiceUsd ?? 0) === 0;
    const apiEquivalentUsd = leftEmpty ? right.apiEquivalentUsd
        : left.apiEquivalentUsd !== undefined && right.apiEquivalentUsd !== undefined ? left.apiEquivalentUsd + right.apiEquivalentUsd : undefined;
    const combined = { ...addUsageCost(left, right), ...(apiEquivalentUsd !== undefined ? {
        apiEquivalentUsd, pricingSource: leftEmpty ? right.pricingSource
            : left.pricingSource === right.pricingSource ? left.pricingSource : 'effective_model_prices',
    } : {}) };
    if (leftEmpty && rightBasis) return { ...combined, currency: right.currency, costSource: right.costSource, effectiveUsd: rightBasis.amountUsd, [aggregateBasisAvailable]: true } satisfies AggregatedUsageCost;
    if (leftBasis && rightBasis && leftBasis.kind === rightBasis.kind && leftBasis.currency === rightBasis.currency) {
        return { ...combined, costSource: left.costSource, effectiveUsd: leftBasis.amountUsd + rightBasis.amountUsd, [aggregateBasisAvailable]: true } satisfies AggregatedUsageCost;
    }
    return { ...combined, costSource: "none", [aggregateBasisAvailable]: false } satisfies AggregatedUsageCost;
}

export function withEffectiveUsageCost(
    cost: UsageObservationCost,
    mode: UsageCostMode,
): UsageObservationCost {
    const basis = resolveUsageCostBasis(cost, mode);
    const { effectiveUsd: _previous, ...raw } = cost;
    return basis ? { ...raw, effectiveUsd: basis.amountUsd } : raw;
}
