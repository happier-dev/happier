import { describe, expect, it } from "vitest";
import { Session } from "node:inspector";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createEmptyUsageCost, createEmptyUsageTokens } from "../usageMetrics";
import type { ScopedUsageContribution } from "./resolveScopedUsageContributions";
import { buildUsageResultProjection, resolveUsageContributionProviderAttribution } from "./buildUsageResultProjection";

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
    it("exposes the same witnessed attribution tuple for native and unknown hourly contributions", () => {
        const service = { pluginId: "acme.accounts", localId: "native" };
        const known = { ...row("known", 10), metadata: {
            usageAccounting: { path: "runtime", status: "available", historyComplete: true },
            usageAttribution: { v: 1, turnId: "known", source: { kind: "native",
                connectedAccount: { service, accountId: "account-a" } } },
        } };
        const unknown = { ...row("unknown", 10), metadata: {
            usageAccounting: { path: "runtime", status: "available", historyComplete: true },
            usageAttribution: { v: 1, turnId: "another-turn", source: { kind: "native",
                connectedAccount: { service, accountId: "account-b" } } },
        } };
        expect(resolveUsageContributionProviderAttribution(known)).toEqual({
            providerId: null, providerConnectionId: null, providerAttribution: "known",
            providerSource: "native", connectedAccount: { service, accountId: "account-a" },
        });
        expect(resolveUsageContributionProviderAttribution(unknown)).toEqual({
            providerId: null, providerConnectionId: null, providerAttribution: "unknown",
            providerSource: "unknown", connectedAccount: null,
        });
        const projected = buildUsageResultProjection({ contributions: [known, unknown], evidenceRows: [],
            coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0,
                includeSeries: false, topLimit: 20 } });
        expect(projected.contributions.map(({ providerId, providerConnectionId, providerAttribution,
            providerSource, connectedAccount }) => ({ providerId, providerConnectionId, providerAttribution,
            providerSource, connectedAccount }))).toEqual([
            resolveUsageContributionProviderAttribution(known), resolveUsageContributionProviderAttribution(unknown),
        ]);
    });
    it("releases historical evidence after materializing coverage while keeping its selector usable", async () => {
        const request = { granularity: "day" as const, timeZoneOffsetMinutes: 0, includeSeries: false, topLimit: 20 };
        const prepare = () => {
            const evidence = row("historical-evidence", 10);
            const weak = new WeakRef(evidence);
            const projection = buildUsageResultProjection({ contributions: [], evidenceRows: [evidence],
                coverageReasons: [], request });
            return { weak, projection };
        };
        const { weak, projection } = prepare();
        // A WeakRef keeps its target alive until the current job finishes.
        await nextTurn();
        const inspector = new Session();
        inspector.connect();
        try {
            await new Promise<void>((resolve, reject) => inspector.post("HeapProfiler.collectGarbage",
                error => error ? reject(error) : resolve()));
        } finally { inspector.disconnect(); }
        expect(weak.deref(), "coverage retains aggregated facts, not the historical evidence population").toBeUndefined();
        expect(projection.projectCoverage(request, [], false)).toEqual(projection.coverage);
    });
    it("retains witnessed machine origins and capture kinds without publishing private source metadata", () => {
        const measured = row("measured", 10);
        const otherMachine = { ...measured, id: "measured-other-machine", machineId: "other-machine" };
        const logs = { ...row("logs", 20), machineId: "second-machine", metadata: {
            path: "/private/project", root: "/private/logs", host: "private-host",
            usageAccounting: { path: "native", status: "available", historyComplete: true },
        } };
        // A legacy report can be a live runtime transport fallback; its stored path does not witness log capture.
        const legacy = { ...row("legacy-fallback", 10), source: "legacy_usage_report", machineId: "legacy-machine",
            metadata: { usageAccounting: { path: "legacy", status: "unknown" } } };
        const unknown = { ...row("unknown", 0), machineId: null, metadata: null };
        const unsupported = { ...unknown, id: "unsupported", source: "unsupported-source",
            metadata: { usageAccounting: { path: "unknown", status: "unsupported" } } };
        const result = buildUsageResultProjection({ contributions: [measured, otherMachine, logs, legacy], evidenceRows: [measured, otherMachine, logs, legacy, unknown, unsupported],
            coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.coverage.sources).toEqual([
            expect.objectContaining({ source: "runtime", machineId: "machine", captureKind: "measured", eventCount: 1 }),
            expect.objectContaining({ source: "runtime", machineId: "other-machine", captureKind: "measured", eventCount: 1 }),
            expect.objectContaining({ source: "runtime", machineId: "second-machine", captureKind: "from_logs", eventCount: 1 }),
            { source: "legacy_usage_report", machineId: "legacy-machine", path: "legacy", status: "unknown", eventCount: 1 },
            { source: "runtime", path: "unknown", status: "unknown", eventCount: 1 },
            { source: "unsupported-source", path: "unknown", status: "unsupported", captureKind: "not_added", eventCount: 1 },
        ]);
        expect(JSON.stringify(result.coverage)).not.toContain("/private/");
        expect(JSON.stringify(result.coverage)).not.toContain("private-host");
    });
    it("projects only request-bound attribution, retaining distinct switched accounts and no cumulative owner", () => {
        const service = { pluginId: "acme.accounts", localId: "native" };
        const attributed = (id: string, accountId: string) => ({ ...row(id, 10), metadata: {
            usageAccounting: { path: "runtime", status: "unknown" },
            usageAttribution: { v: 1, turnId: id, source: { kind: "native", connectedAccount: { service, accountId } } },
        } });
        const first = attributed("first", "account-a");
        const second = attributed("second", "account-b");
        const remainder = { ...attributed("remainder", "account-b"), scope: "session_cumulative", isCumulative: true };
        const mismatched = { ...attributed("mismatch", "account-b"), turnId: "other-turn" };
        const result = buildUsageResultProjection({ contributions: [first, second, remainder, mismatched], evidenceRows: [],
            coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.contributions).toEqual([
            expect.objectContaining({ connectedAccount: { service, accountId: "account-a" }, providerSource: "native", providerAttribution: "known", providerConnectionId: null }),
            expect.objectContaining({ connectedAccount: { service, accountId: "account-b" }, providerSource: "native", providerAttribution: "known" }),
            expect.objectContaining({ connectedAccount: null, providerSource: "unknown", providerAttribution: "unknown" }),
            expect.objectContaining({ connectedAccount: null, providerSource: "unknown", providerAttribution: "unknown" }),
        ]);
    });
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
            expect.objectContaining({ kind: "reported", source: "provider_reported_api_equivalent", amountUsd: 0.2, tokens: expect.objectContaining({ input: 10, cacheRead: 5, total: 10 }) }),
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

    it("distinguishes a proven zero price from defaults and separates invoice from vendor reported money", () => {
        const free = { ...row("free", 10), cost: { ...createEmptyUsageCost(), costSource: "pricing_estimate" as const } };
        const paid = { ...row("paid", 20), cost: { ...createEmptyUsageCost(), reportedUsd: 2, invoiceUsd: 1, costSource: "provider_reported_api_equivalent" as const } };
        const result = buildUsageResultProjection({ contributions: [free, paid], evidenceRows: [free, paid], coverageReasons: [], request: { granularity: "day", timeZoneOffsetMinutes: 0, includeSeries: true, topLimit: 20 } });
        expect(result.costFacts.map((fact) => [fact.kind, fact.amountUsd])).toEqual(expect.arrayContaining([["estimated", 0], ["reported", 2], ["invoice", 1]]));
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
