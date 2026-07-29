import type { UsageAnalyticsQueryRequest, UsageObservationCost } from "@happier-dev/protocol";
import { addUsageCost } from "../usageMetrics";

export type UsageCostMode = NonNullable<UsageAnalyticsQueryRequest["costMode"]> | "auto";

export function resolveUsageCostMode(mode: UsageAnalyticsQueryRequest["costMode"]): UsageCostMode {
    return mode ?? "auto";
}

export function resolveEffectiveUsageCostUsd(cost: UsageObservationCost, mode: UsageCostMode): number {
    if (mode === "reported") {
        return cost.reportedUsd;
    }
    if (mode === "estimated") {
        return cost.estimatedUsd;
    }
    if (cost.effectiveUsd !== undefined) {
        return cost.effectiveUsd;
    }
    if ((cost.invoiceUsd ?? 0) > 0) {
        return cost.invoiceUsd ?? 0;
    }
    if (cost.reportedUsd > 0) {
        return cost.reportedUsd;
    }
    return cost.estimatedUsd;
}

export function addUsageCostForMode(
    left: UsageObservationCost,
    right: UsageObservationCost,
    mode: UsageCostMode,
): UsageObservationCost {
    return {
        ...addUsageCost(left, right),
        effectiveUsd: resolveEffectiveUsageCostUsd(left, mode) + resolveEffectiveUsageCostUsd(right, mode),
    };
}

export function withEffectiveUsageCost(
    cost: UsageObservationCost,
    mode: UsageCostMode,
): UsageObservationCost {
    return {
        ...cost,
        effectiveUsd: resolveEffectiveUsageCostUsd(cost, mode),
    };
}

export function resolveUsageCostPresentationSource(cost: UsageObservationCost, mode: UsageCostMode): string {
    if (mode === "reported") {
        return cost.reportedUsd > 0 ? cost.costSource ?? "provider_reported" : "none";
    }
    if (mode === "estimated") {
        return cost.estimatedUsd > 0 ? "pricing_estimate" : "none";
    }
    if ((cost.invoiceUsd ?? 0) > 0) {
        return "invoice";
    }
    if (cost.reportedUsd > 0) {
        return cost.costSource ?? "provider_reported";
    }
    if (cost.estimatedUsd > 0) {
        return "pricing_estimate";
    }
    return "none";
}
