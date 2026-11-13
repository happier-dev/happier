import { describe, expect, it } from "vitest";

import { addUsageCostForMode, resolveEffectiveUsageCostUsd, withEffectiveUsageCost } from "./resolveUsageCostMode";
import { resolveUsageCostBasis } from '@happier-dev/protocol';

describe("usage cost basis", () => {
    it("retains the known API-equivalent subtotal when another population is unpriced", () => {
        // Owner ruling 2026-11-10: unknown measurements are NULL; aggregates skip them.
        const unknown = { reportedUsd: null, estimatedUsd: null, currency: 'USD', costSource: 'none' as const };
        expect(resolveEffectiveUsageCostUsd(unknown, 'api_equivalent')).toBeNull();
        const priced = { ...unknown, apiEquivalentUsd: 2, pricingSource: 'litellm:test' };
        const combined = addUsageCostForMode(addUsageCostForMode(unknown, priced, 'api_equivalent'), priced, 'api_equivalent');
        expect(withEffectiveUsageCost(combined, 'api_equivalent')).toMatchObject({ apiEquivalentUsd: 4, effectiveUsd: 4 });
        const unpriced = addUsageCostForMode(combined, unknown, 'api_equivalent');
        expect(withEffectiveUsageCost(unpriced, 'api_equivalent').effectiveUsd).toBe(4);
    });
    it("labels best available same-currency facts as mixed instead of dropping them to zero", () => {
        const reported = { reportedUsd: 1, estimatedUsd: 0, currency: "USD", costSource: "provider_reported" as const };
        const estimated = { reportedUsd: 0, estimatedUsd: 2, currency: "USD", costSource: "pricing_estimate" as const };
        const combined = addUsageCostForMode(reported, estimated, "auto");
        expect(combined.effectiveUsd).toBe(3);
        expect(resolveEffectiveUsageCostUsd(combined, "auto")).toBe(3);
        expect(resolveUsageCostBasis(combined, 'auto')).toMatchObject({ kind: 'mixed', source: 'best_available', currency: 'USD' });
    });
    it("retains vendor-reported API-equivalent money as a reported fact", () => {
        const reported = { reportedUsd: 1, estimatedUsd: 0, currency: "USD", costSource: "provider_reported" as const };
        const equivalent = { reportedUsd: 2, estimatedUsd: 0, currency: "USD", costSource: "provider_reported_api_equivalent" as const };
        const mixed = addUsageCostForMode(addUsageCostForMode(reported, equivalent, "reported"), reported, "reported");
        expect(withEffectiveUsageCost(mixed, "reported").effectiveUsd).toBe(4);
        expect(resolveEffectiveUsageCostUsd(mixed, "reported")).toBe(4);
    });
    it("preserves measured free and paid costs while skipping unknown measurements", () => {
        const free = { reportedUsd: 0, estimatedUsd: 0, currency: "USD", costSource: "provider_reported" as const };
        const unknown = { reportedUsd: null, estimatedUsd: null, currency: "USD", costSource: "none" as const };
        const paid = { ...free, reportedUsd: 1 };
        expect(resolveEffectiveUsageCostUsd(unknown, "auto")).toBeNull();
        const measured = withEffectiveUsageCost(addUsageCostForMode(free, unknown, "auto"), "auto");
        expect(measured.effectiveUsd).toBe(0);
        const mixed = addUsageCostForMode(measured, paid, "auto");
        expect(mixed.effectiveUsd).toBe(1);
        expect(withEffectiveUsageCost(mixed, "auto").effectiveUsd).toBe(1);
    });
});
