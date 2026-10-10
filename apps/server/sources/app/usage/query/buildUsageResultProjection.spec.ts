import { describe, expect, it } from "vitest";
import { createEmptyUsageCost, createEmptyUsageTokens } from "../usageMetrics";
import type { ScopedUsageContribution } from "./resolveScopedUsageContributions";
import { buildUsageResultProjection } from "./buildUsageResultProjection";

function row(id: string, total: number): ScopedUsageContribution {
    return {
        id, sessionId: "session", observedAt: new Date(100), createdAt: new Date(100),
        agentId: "agent", modelId: "model", backendMode: null, projectKey: null, workspaceId: null,
        machineId: "machine", source: "runtime", scope: "turn_delta", isCumulative: false, turnId: id,
        contextUsedTokens: null, contextWindowTokens: null, contributingEventIds: [id],
        tokens: { ...createEmptyUsageTokens(), input: total, cacheRead: total / 2, total },
        cost: createEmptyUsageCost(),
        metadata: { usageAccounting: { path: "runtime", status: "available", historyComplete: true, asOfMs: 100 } },
    };
}

describe("canonical usage result projection", () => {
    it("keeps delayed same-model response Provider attribution unknown after a current binding switch", () => {
        // The runtime publisher reads metadata after asynchronous transcript admission;
        // this retained dimension is the then-current binding, not the old response's source.
        const delayed = { ...row("old-provider-response", 10), metadata: {
            providerId: "happier.provider.openrouter/openrouter", providerConnectionId: "switched-provider",
            usageAccounting: { path: "runtime", status: "unknown" },
        } };
        const currentNative = { ...row("old-provider-response-after-native-switch", 10), metadata: {
            providerConnectionId: null, usageAccounting: { path: "runtime", status: "unknown" },
        } };
        const result = buildUsageResultProjection({ contributions: [delayed, currentNative], evidenceRows: [delayed, currentNative],
            coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.contributions).toEqual([
            expect.objectContaining({ providerConnectionId: "switched-provider", providerAttribution: "unknown" }),
            expect.objectContaining({ providerConnectionId: null, providerAttribution: "unknown" }),
        ]);
    });

    it("retains named monetary facts without recovering an unavailable presentation basis", () => {
        const unknown = { ...row("unknown-basis", 10), cost: { ...createEmptyUsageCost(), reportedUsd: 2 } };
        const result = buildUsageResultProjection({ contributions: [unknown], evidenceRows: [unknown], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reported", amountUsd: 2 })]));
        expect(result.costPresentation).toBeUndefined();
    });
    it("groups cost kinds without blending them and preserves vendor token categories", () => {
        const api = { ...row("api", 10), cost: { ...createEmptyUsageCost(), reportedUsd: 0.2, costSource: "provider_reported_api_equivalent" as const } };
        const unpriced = row("unpriced", 20);
        const result = buildUsageResultProjection({ contributions: [api, unpriced], evidenceRows: [api, unpriced], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 1 }, ranked: [{ dimension: "model", totalEntries: 2, returnedEntries: 1, complete: false }] });
        expect(result.costFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "api_equivalent", amountUsd: 0.2, tokens: expect.objectContaining({ input: 10, cacheRead: 5, total: 10 }) }),
            expect.objectContaining({ kind: "unpriced", amountUsd: null, tokens: expect.objectContaining({ total: 20 }) }),
        ]));
        expect(result.costPresentation).toBeUndefined();
        expect(result.coverage.reasons).toEqual(expect.arrayContaining(["unpriced_tokens", "ranked_truncation"]));
    });

    it("uses producer status even for zero rows and keeps absent evidence unknown", () => {
        const pending = { ...row("pending", 0), metadata: { usageAccounting: { path: "native", status: "pending", historyComplete: false } } };
        const result = buildUsageResultProjection({ contributions: [pending], evidenceRows: [pending], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.coverage.sources[0].status).toBe("pending");
        expect(result.coverage.status).toBe("partial");
        expect(result.coverage.range.complete).toBe(false);
        const unknown = buildUsageResultProjection({ contributions: [], evidenceRows: [], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(unknown.coverage.status).toBe("unknown");
    });

    it("distinguishes a proven zero price from defaults and separates invoice from API-equivalent", () => {
        const free = { ...row("free", 10), cost: { ...createEmptyUsageCost(), costSource: "pricing_estimate" as const } };
        const paid = { ...row("paid", 20), cost: { ...createEmptyUsageCost(), reportedUsd: 2, invoiceUsd: 1, costSource: "provider_reported_api_equivalent" as const } };
        const result = buildUsageResultProjection({ contributions: [free, paid], evidenceRows: [free, paid], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.costFacts.map((fact) => [fact.kind, fact.amountUsd])).toEqual(expect.arrayContaining([["estimated", 0], ["api_equivalent", 2], ["invoice", 1]]));
        expect(result.costFacts.some((fact) => fact.kind === "unpriced")).toBe(false);
        expect(result.costPresentation).toBeUndefined();
    });
    it("projects every selected row's categories only with witnessed overlap semantics", () => {
        const inclusive = { ...row("inclusive", 120), tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 30, cacheWrite: 0, total: 120 }, metadata: { usageAccounting: { inputIncludesCache: true, outputIncludesReasoning: true } } };
        const result = buildUsageResultProjection({ contributions: [inclusive], evidenceRows: [inclusive], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.tokenCategories).toEqual({ input: 70, output: 15, reasoning: 5, cacheRead: 30, cacheWrite: 0, total: 120 });
        expect(result.contributions[0].tokens.input).toBe(100);
        expect(result.contributions[0].tokenCategories?.input).toBe(70);
        const unknown = row("unknown", 10);
        const partial = buildUsageResultProjection({ contributions: [inclusive, unknown], evidenceRows: [inclusive, unknown], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(partial.tokenCategories).toBeUndefined();
        expect(partial.coverage.reasons).toContain("unknown_token_categories");
    });
});
