import { describe, expect, it } from "vitest";

import { addUsageCostForMode, resolveEffectiveUsageCostUsd, withEffectiveUsageCost } from "./resolveUsageCostMode";

describe("usage cost basis", () => {
    it("retains current API-equivalent aggregate prices without forgetting an unpriced population", () => {
        const zero = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
        const priced = { ...zero, apiEquivalentUsd: 2, pricingSource: 'litellm:test' };
        const combined = addUsageCostForMode(addUsageCostForMode(zero, priced, 'api_equivalent'), priced, 'api_equivalent');
        expect(withEffectiveUsageCost(combined, 'api_equivalent')).toMatchObject({ apiEquivalentUsd: 4, effectiveUsd: 4 });
        const unpriced = addUsageCostForMode(combined, zero, 'api_equivalent');
        expect(withEffectiveUsageCost(unpriced, 'api_equivalent').effectiveUsd).toBeUndefined();
    });
    it("does not turn different auto bases into a blended effective cost", () => {
        const reported = { reportedUsd: 1, estimatedUsd: 0, currency: "USD", costSource: "provider_reported" as const };
        const estimated = { reportedUsd: 0, estimatedUsd: 2, currency: "USD", costSource: "pricing_estimate" as const };
        const combined = addUsageCostForMode(reported, estimated, "auto");
        expect(combined.effectiveUsd).toBeUndefined();
        expect(resolveEffectiveUsageCostUsd(combined, "auto")).toBe(0);
    });
    it("retains vendor-reported API-equivalent money as a reported fact", () => {
        const reported = { reportedUsd: 1, estimatedUsd: 0, currency: "USD", costSource: "provider_reported" as const };
        const equivalent = { reportedUsd: 2, estimatedUsd: 0, currency: "USD", costSource: "provider_reported_api_equivalent" as const };
        const mixed = addUsageCostForMode(addUsageCostForMode(reported, equivalent, "reported"), reported, "reported");
        expect(withEffectiveUsageCost(mixed, "reported").effectiveUsd).toBe(4);
        expect(resolveEffectiveUsageCostUsd(mixed, "reported")).toBe(4);
    });
    it("does not forget an unpriced population when the priced population was free", () => {
        const free = { reportedUsd: 0, estimatedUsd: 0, currency: "USD", costSource: "provider_reported" as const };
        const unknown = { reportedUsd: 0, estimatedUsd: 0, currency: "USD", costSource: "none" as const };
        const paid = { ...free, reportedUsd: 1 };
        const unavailable = withEffectiveUsageCost(addUsageCostForMode(free, unknown, "auto"), "auto");
        const mixed = addUsageCostForMode(unavailable, paid, "auto");
        expect(mixed.effectiveUsd).toBeUndefined();
        expect(withEffectiveUsageCost(mixed, "auto").effectiveUsd).toBeUndefined();
    });
});
