import { bundledUsageModelPriceCatalog, UsageAnalyticsQueryRequestSchema } from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { queryUsageAnalytics } from "./usageQueryService";
import { recordLegacyUsageReport } from "./usageWriteService";

async function createUsageOwner(label: string): Promise<{ accountId: string; sessionId: string }> {
    const account = await db.account.create({
        data: { publicKey: `pk-usage-query-${label}` },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `usage-query-${label}`,
            encryptionMode: "e2ee",
            metadata: "ciphertext",
        },
        select: { id: true },
    });
    return { accountId: account.id, sessionId: session.id };
}

function buildUsageEvent(params: Readonly<{
    accountId: string;
    sessionId: string;
    observedAt: string;
    scope: "turn_delta" | "session_cumulative" | "session_final";
    totalTokens: number;
}>) {
    return {
        accountId: params.accountId,
        sessionId: params.sessionId,
        observedAt: new Date(params.observedAt),
        agentId: "codex",
        modelId: "gpt-5.4-mini",
        source: "codex_app_server",
        scope: params.scope,
        isCumulative: params.scope !== "turn_delta",
        inputTokens: params.totalTokens,
        totalTokens: params.totalTokens,
        estimatedCostUsd: params.totalTokens / 1_000,
        costSource: "pricing_estimate",
    };
}

async function querySession(
    accountId: string,
    sessionId: string,
    overrides: Readonly<Record<string, unknown>> = {},
) {
    return await queryUsageAnalytics(accountId, UsageAnalyticsQueryRequestSchema.parse({
        filters: { sessionIds: [sessionId] },
        granularity: "day",
        includeSeries: true,
        ...overrides,
    }));
}

describe("usageQueryService scoped aggregation", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-usage-query-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.simpleCache.deleteMany({ where: { key: 'usage:model-price-catalog:v1' } }),
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("retains witnessed Provider binding separately from Agent identity without attributing unknown counters", async () => {
        const owner = await createUsageOwner("provider-binding");
        const binding = { providerId: "happier.provider.openrouter/openrouter", providerConnectionId: "connection-work" };
        await db.usageEvent.createMany({ data: [
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00Z", scope: "turn_delta", totalTokens: 10 }),
                turnId: "bound", metadata: { ...binding, usageAccounting: { path: "runtime" } } },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00Z", scope: "turn_delta", totalTokens: 20 }),
                turnId: "historical" },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-03T10:00:00Z", scope: "turn_delta", totalTokens: 30 }),
                turnId: "native", metadata: { ...binding, usageAccounting: { path: "native" } } },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-04T10:00:00Z", scope: "session_cumulative", totalTokens: 70 }),
                metadata: { ...binding, usageAccounting: { path: "runtime" } } },
        ] });
        const result = await querySession(owner.accountId, owner.sessionId);
        expect(result.contributions?.find(row => row.turnId === "bound")).toMatchObject({ agentId: "codex", ...binding });
        expect(result.contributions?.find(row => row.turnId === "bound")).toHaveProperty("providerAttribution", "unknown");
        expect(result.contributions?.filter(row => row.turnId !== "bound").every(row => row.providerAttribution === "unknown")).toBe(true);
        expect(result.contributions?.filter(row => row.turnId !== "bound")).toEqual([
            expect.objectContaining({ providerId: null, providerConnectionId: null }),
            expect.objectContaining({ providerId: null, providerConnectionId: null }),
            expect.objectContaining({ providerId: null, providerConnectionId: null, modelId: null }),
        ]);
        expect(result.totals.tokens.total).toBe(70);
    });

    it("does not infer response attribution from explicit native, absent or malformed current source dimensions", async () => {
        const owner = await createUsageOwner("native-provider-source");
        await db.usageEvent.createMany({ data: [null, undefined, " bad connection id"].map((connection, index) => ({
            ...buildUsageEvent({ ...owner, observedAt: `2026-07-01T10:0${index}:00Z`, scope: "turn_delta", totalTokens: 10 }),
            turnId: `source-${index}`, metadata: { ...(connection === undefined ? {} : { providerConnectionId: connection }),
                usageAccounting: { path: "runtime" } },
        })) });
        const result = await querySession(owner.accountId, owner.sessionId);
        expect(result.contributions?.find(row => row.turnId === "source-0")).toMatchObject({ providerConnectionId: null, providerAttribution: "unknown" });
        expect(result.contributions?.filter(row => row.turnId !== "source-0").every(row => row.providerAttribution === "unknown")).toBe(true);
    });

    it("ranks token-tied leaders using current API-equivalent prices before truncation", async () => {
        const owner = await createUsageOwner('price-ranking');
        await db.usageEvent.createMany({ data: ['a-model', 'z-model'].map((modelId) => ({
            ...buildUsageEvent({ sessionId: owner.sessionId, accountId: owner.accountId,
                observedAt: '2026-07-01T10:00:00.000Z', scope: 'turn_delta', totalTokens: 1_000_000 }), modelId,
        })) });
        await db.simpleCache.create({ data: { key: 'usage:model-price-catalog:v1', value: JSON.stringify({
            v: 1, models: { 'a-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, 'z-model': { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } },
            provenance: { source: 'litellm', origin: 'fetched', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' },
        }) } });
        const result = await querySession(owner.accountId, owner.sessionId, { costMode: 'api_equivalent', includeLeaders: true, includeModelTimeline: true, topLimit: 1 });
        expect(result.leaders?.models?.[0]?.key).toBe('z-model');
        expect(result.modelTimeline?.[0]?.leaders[0]?.key).toBe('z-model');
    });

    it("re-prices historical API-equivalent tokens from the effective catalog without rewriting reported or retained estimates", async () => {
        const owner = await createUsageOwner("catalog-repricing");
        await db.usageEvent.create({ data: {
            ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00Z", scope: "turn_delta", totalTokens: 1_000_000 }),
            reportedCostUsd: 9, estimatedCostUsd: 7, costSource: "provider_reported",
        } });
        const catalog = (inputUsdPerMillion: number) => JSON.stringify({
            v: 1, models: { "gpt-5.4-mini": { inputUsdPerMillion, outputUsdPerMillion: 4 } },
            provenance: { source: "litellm", origin: "fetched", asOfMs: 1000, revision: "test-catalog", fetchStatus: "ready" },
        });
        await db.simpleCache.upsert({ where: { key: "usage:model-price-catalog:v1" },
            create: { key: "usage:model-price-catalog:v1", value: catalog(2) }, update: { value: catalog(2) } });
        const first = await querySession(owner.accountId, owner.sessionId);
        expect(first.costFacts).toContainEqual(expect.objectContaining({ kind: "api_equivalent", amountUsd: 2 }));
        expect(first.totals.cost).toMatchObject({ reportedUsd: 9, estimatedUsd: 7 });
        await db.simpleCache.update({ where: { key: "usage:model-price-catalog:v1" }, data: { value: catalog(3) } });
        const repriced = await querySession(owner.accountId, owner.sessionId);
        expect(repriced.costFacts).toContainEqual(expect.objectContaining({ kind: "api_equivalent", amountUsd: 3 }));
        expect(repriced.totals.cost).toMatchObject({ reportedUsd: 9, estimatedUsd: 7 });
        process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'false';
        const disabled = await querySession(owner.accountId, owner.sessionId);
        expect(disabled.priceCatalog?.models).toEqual(bundledUsageModelPriceCatalog.models);
        expect(disabled.priceCatalog?.provenance).toMatchObject({ origin: 'bundled', fetchStatus: 'disabled' });
        expect(disabled.totals.cost).toMatchObject({ reportedUsd: 9, estimatedUsd: 7 });
        expect(await db.usageEvent.findFirst({ where: { accountId: owner.accountId },
            select: { reportedCostUsd: true, estimatedCostUsd: true } })).toEqual({ reportedCostUsd: 9, estimatedCostUsd: 7 });
    });

    it("reports actual per-bucket ranked completeness rather than a global imaginary truncation", async () => {
        const owner = await createUsageOwner("timeline-ranked");
        await db.usageEvent.createMany({ data: ["A", "B", "C"].map((modelId, index) => ({
            ...buildUsageEvent({ ...owner, observedAt: `2026-07-0${index + 1}T10:00:00Z`, scope: "turn_delta", totalTokens: 10 }), modelId,
        })) });
        const result = await querySession(owner.accountId, owner.sessionId, { includeModelTimeline: true, topLimit: 1 });
        expect(result.modelTimeline?.flatMap((bucket) => bucket.leaders.map((leader) => leader.key))).toEqual(["A", "B", "C"]);
        expect(result.coverage?.ranked).toContainEqual({ dimension: "model", totalEntries: 3, returnedEntries: 3, complete: true });
        expect(result.coverage?.reasons).not.toContain("ranked_truncation");
    });

    it("reads retained predecessor reports and preserves their baseline through the first bridge write", async () => {
        const owner = await createUsageOwner("predecessor-report");
        await db.usageReport.create({ data: { ...owner, key: "legacy-counter",
            data: { tokens: { total: 100, input: 100 }, cost: { total: 1 } },
            createdAt: new Date("2026-07-01T10:00:00Z"), updatedAt: new Date("2026-07-01T11:00:00Z"),
        } });
        const retained = await querySession(owner.accountId, owner.sessionId);
        expect(retained.totals.tokens.total).toBe(100);
        expect(retained.coverage?.status).not.toBe("complete");
        await recordLegacyUsageReport({ ...owner, key: "legacy-counter", tokens: { total: 120, input: 120 }, cost: { total: 1.2 } });
        const updated = await querySession(owner.accountId, owner.sessionId);
        expect(updated.totals.tokens.total).toBe(120);
        expect(updated.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reported", amountUsd: 1.2 })]));
        await db.usageEvent.create({ data: buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00Z", scope: "turn_delta", totalTokens: 80 }) });
        expect((await querySession(owner.accountId, owner.sessionId)).totals.tokens.total).toBe(80);
    });

    it("subtracts the pre-range baseline before totals, model filtering and activity", async () => {
        const owner = await createUsageOwner("period-baseline");
        await db.usageEvent.createMany({ data: [
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 100 }), modelId: "old-model" },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_cumulative", totalTokens: 120 }), modelId: "new-model" },
        ] });
        const result = await querySession(owner.accountId, owner.sessionId, {
            dateRange: { startMs: Date.parse("2026-07-02T00:00:00Z"), endMs: Date.parse("2026-07-03T00:00:00Z") },
            filters: { sessionIds: [owner.sessionId] },
            breakdowns: ["model"],
            includeActivity: true,
        });
        expect(result.totals.tokens.total).toBe(20);
        expect(result.totals.eventCount).toBe(1);
        expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([20]);
        expect(result.breakdowns?.model?.[0]).toMatchObject({ key: "unknown", tokens: { total: 20 } });
        expect(result.activity?.calendarDays).toEqual([{ date: "2026-07-02", eventCount: 1 }]);
    });

    it("retains per-model inference amounts before applying final-summary/model/source filters", async () => {
        const owner = await createUsageOwner("attribution");
        await db.usageEvent.createMany({ data: [
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 30 }), modelId: "A", turnId: "a", source: "runtime" },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "turn_delta", totalTokens: 40 }), modelId: "B", turnId: "b", source: "runtime" },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-03T10:00:00.000Z", scope: "session_final", totalTokens: 80 }), modelId: "B", source: "native" },
        ] });
        const result = await querySession(owner.accountId, owner.sessionId, { breakdowns: ["model"] });
        expect(result.totals.tokens.total).toBe(80);
        expect(result.breakdowns?.model?.map((entry) => [entry.key, entry.tokens.total])).toEqual([["B", 40], ["A", 30], ["unknown", 10]]);
        const filtered = await querySession(owner.accountId, owner.sessionId, { filters: { sessionIds: [owner.sessionId], modelIds: ["A"], sources: ["runtime"] } });
        expect(filtered.totals.tokens.total).toBe(30);
    });

    it("reconciles native/runtime inference identity before source filtering and admits machine pivots", async () => {
        const owner = await createUsageOwner("overlap-machine");
        await db.usageEvent.createMany({ data: [
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 30 }), source: "runtime", machineId: "machine-one", metadata: { usageAccounting: { inferenceId: "one", path: "runtime", status: "available" } } },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 30 }), source: "native", machineId: "machine-one", metadata: { usageAccounting: { inferenceId: "one", path: "native", status: "partial" } } },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }), source: "runtime", machineId: null },
        ] });
        const result = await querySession(owner.accountId, owner.sessionId, { breakdowns: ["machine"] });
        expect(result.totals.tokens.total).toBe(40);
        expect(result.breakdowns?.machine?.map((entry) => [entry.key, entry.tokens.total])).toEqual([["machine-one", 30], ["unknown", 10]]);
        expect(result.coverage?.status).not.toBe("complete");
        const filtered = await querySession(owner.accountId, owner.sessionId, { filters: { sessionIds: [owner.sessionId], sources: ["runtime"] } });
        expect(filtered.totals.tokens.total).toBeLessThanOrEqual(40);
    });

    it("returns separate cost facts and explicit unpriced/ranked coverage rather than a blended price", async () => {
        const owner = await createUsageOwner("cost-facts");
        await db.usageEvent.createMany({ data: [
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }), modelId: "priced", reportedCostUsd: 0.2, estimatedCostUsd: 0, costSource: "provider_reported_api_equivalent" },
            { ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "turn_delta", totalTokens: 20 }), modelId: "unpriced", estimatedCostUsd: 0, costSource: "none" },
        ] });
        const result = await querySession(owner.accountId, owner.sessionId, { breakdowns: ["model"], topLimit: 1 });
        expect(result.costFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "reported", source: "provider_reported_api_equivalent", amountUsd: 0.2 }),
            expect.objectContaining({ kind: "unpriced", amountUsd: null, tokens: expect.objectContaining({ total: 30 }) }),
        ]));
        expect(result.coverage?.ranked).toContainEqual({ dimension: "model", totalEntries: 2, returnedEntries: 1, complete: false });
        expect(result.coverage?.reasons).toContain("unpriced_tokens");
    });

    it("does not add turn deltas to a cumulative snapshot in the same usage group", async () => {
        const owner = await createUsageOwner("mixed");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "session_cumulative", totalTokens: 100 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(100);
    });

    it("uses only the latest cumulative snapshot", async () => {
        const owner = await createUsageOwner("cumulative");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 100 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "session_cumulative", totalTokens: 140 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(140);
    });

    it("returns the latest context values on each session breakdown row", async () => {
        const owner = await createUsageOwner("session-context");
        await db.usageEvent.createMany({
            data: [
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                    contextUsedTokens: 20_000,
                    contextWindowTokens: 272_000,
                },
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "turn_delta", totalTokens: 20 }),
                    contextUsedTokens: 42_000,
                    contextWindowTokens: 258_400,
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId, {
            breakdowns: ["session"],
        });

        expect(result.breakdowns?.session?.[0]).toMatchObject({
            key: owner.sessionId,
            latestContextUsedTokens: 42_000,
            latestContextWindowTokens: 258_400,
        });
    });

    it("sums persisted cache savings through scoped usage contributions", async () => {
        const owner = await createUsageOwner("cache-savings");
        await db.usageEvent.createMany({
            data: [
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                    costBreakdown: JSON.stringify({ cacheSavingsUsd: 0.25 }),
                },
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "turn_delta", totalTokens: 20 }),
                    costBreakdown: JSON.stringify({ cacheSavingsUsd: 0.75 }),
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId, { includeInsights: true });

        expect(result.insights?.cacheSavingsUsd).toBeCloseTo(1);
    });

    it("prefers a session-final snapshot over cumulative snapshots", async () => {
        const owner = await createUsageOwner("final");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_final", totalTokens: 120 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "session_cumulative", totalTokens: 140 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(120);
    });

    it("keeps pre-final cumulative buildup in the series before the final remainder", async () => {
        const owner = await createUsageOwner("pre-final-series");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 100 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_final", totalTokens: 140 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(140);
        expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([100, 40]);
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(140);
    });

    it("reconciles the provider final without blending its reported fact into earlier estimated inferences", async () => {
        const owner = await createUsageOwner("cross-source-final");
        await db.usageEvent.createMany({
            data: [
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 20 }),
                    agentId: "claude",
                    source: "claude-assistant-usage",
                    estimatedCostUsd: 0.05,
                },
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_final", totalTokens: 100 }),
                    agentId: "claude",
                    source: "claude-sdk-result",
                    reportedCostUsd: 0.12,
                    estimatedCostUsd: 0,
                    costSource: "provider_reported",
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(100);
        expect(result.totals.cost.effectiveUsd).toBeUndefined();
        expect(result.costFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "estimated", amountUsd: 0.05 }),
            expect.objectContaining({ kind: "reported", amountUsd: 0.12 }),
        ]));
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(100);
    });

    it("keeps distinct cost facts when final provenance changes rather than telescoping incomparable bases", async () => {
        const owner = await createUsageOwner("series-cost-provenance");
        await db.usageEvent.createMany({
            data: [
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 80 }),
                    estimatedCostUsd: 0.1,
                },
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_final", totalTokens: 100 }),
                    reportedCostUsd: 0.12,
                    estimatedCostUsd: 0,
                    costSource: "provider_reported",
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.cost.effectiveUsd).toBeUndefined();
        expect(result.series?.map((bucket) => bucket.cost.effectiveUsd)).toEqual([
            expect.closeTo(0.1),
            expect.closeTo(0.12),
        ]);
        expect(result.costFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "estimated", amountUsd: 0.1 }),
            expect.objectContaining({ kind: "reported", amountUsd: 0.12 }),
        ]));
    });

    it("preserves earlier spend and reports discontinuity after a cumulative counter reset", async () => {
        const owner = await createUsageOwner("series-reset");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 100 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_cumulative", totalTokens: 40 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-03T10:00:00.000Z", scope: "session_cumulative", totalTokens: 60 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(160);
        expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([100, 40, 20]);
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(160);
        expect(result.coverage?.reasons).toContain("counter_discontinuity");
    });

    it("attributes cumulative differences to the later snapshot bucket", async () => {
        const owner = await createUsageOwner("series-differences");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 100 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_cumulative", totalTokens: 140 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([100, 40]);
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(140);
    });

    it("continues summing pure turn-delta groups", async () => {
        const owner = await createUsageOwner("deltas");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "turn_delta", totalTokens: 20 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(30);
        expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([30]);
    });

    it("excludes legacy bridge rows when the same in-range session has native usage", async () => {
        const owner = await createUsageOwner("legacy-read-dedup");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:01:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                    agentId: "legacy",
                    source: "legacy_usage_report",
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(10);
        expect(result.totals.eventCount).toBe(1);
    });

    it("excludes Team-only admission and external-terminal rows from personal analytics", async () => {
        const owner = await createUsageOwner("team-only-sources");
        const observedAt = new Date("2026-07-01T10:00:00.000Z");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: observedAt.toISOString(), scope: "turn_delta", totalTokens: 10 }),
                {
                    accountId: owner.accountId,
                    sessionId: owner.sessionId,
                    observedAt,
                    agentId: "team_credential_broker",
                    source: "team_credential_admission",
                    scope: "turn_delta",
                    requestCount: 1,
                    teamCredentialResourceId: "resource-personal-exclusion",
                    teamCredentialActorAccountId: owner.accountId,
                },
                {
                    accountId: owner.accountId,
                    sessionId: owner.sessionId,
                    observedAt,
                    agentId: "team_credential_broker",
                    source: "team_credential_external_terminal",
                    scope: "turn_delta",
                    totalTokens: 40,
                    inputTokens: 40,
                    teamCredentialResourceId: "resource-personal-exclusion",
                    teamCredentialActorAccountId: owner.accountId,
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.eventCount).toBe(1);
        expect(result.totals.tokens.total).toBe(10);
    });

    it("keeps series and premium timeline day buckets aligned regardless of server timezone", async () => {
        const owner = await createUsageOwner("timezone-owner");
        await db.usageEvent.create({
            data: buildUsageEvent({
                ...owner,
                observedAt: "2026-07-01T23:30:00.000Z",
                scope: "turn_delta",
                totalTokens: 10,
            }),
        });
        const previousTimeZone = process.env.TZ;
        process.env.TZ = "Asia/Tokyo";
        try {
            const result = await querySession(owner.accountId, owner.sessionId, {
                includeModelTimeline: true,
            });

            expect(result.series?.[0]?.bucketStartMs).toBe(result.modelTimeline?.[0]?.bucketStartMs);
        } finally {
            process.env.TZ = previousTimeZone;
        }
    });

    it("shifts day boundaries by a client-supplied minutes-east offset", async () => {
        const owner = await createUsageOwner("timezone-offset");
        await db.usageEvent.create({
            data: buildUsageEvent({
                ...owner,
                observedAt: "2026-07-01T23:30:00.000Z",
                scope: "turn_delta",
                totalTokens: 10,
            }),
        });

        const result = await querySession(owner.accountId, owner.sessionId, {
            timeZoneOffsetMinutes: 120,
        });

        expect(result.series?.[0]?.bucketStartMs).toBe(Date.UTC(2026, 6, 1, 22, 0, 0));
    });

    it("uses insights sessionsUsed as the messageStats session count", async () => {
        const owner = await createUsageOwner("message-session-count");
        await db.usageEvent.create({
            data: buildUsageEvent({
                ...owner,
                observedAt: "2026-07-01T10:00:00.000Z",
                scope: "turn_delta",
                totalTokens: 10,
            }),
        });

        const result = await querySession(owner.accountId, owner.sessionId, {
            includeInsights: true,
            includeMessageStats: true,
        });

        expect(result.insights?.sessionsUsed).toBe(1);
        expect(result.messageStats?.sessionCount).toBe(result.insights?.sessionsUsed);
    });

    it("adds mode-consistent effective cost while preserving raw cost sums", async () => {
        const owner = await createUsageOwner("effective-cost");
        await db.usageEvent.createMany({
            data: [
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "turn_delta", totalTokens: 10 }),
                    reportedCostUsd: 0.12,
                    estimatedCostUsd: 0.09,
                },
                {
                    ...buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:05:00.000Z", scope: "turn_delta", totalTokens: 20 }),
                    reportedCostUsd: 0,
                    estimatedCostUsd: 0.2,
                },
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId, {
            costMode: "estimated",
            breakdowns: ["agent"],
            includeLeaders: true,
            includeModelTimeline: true,
        });

        expect(result.totals.cost.reportedUsd).toBe(0.12);
        expect(result.totals.cost.estimatedUsd).toBeCloseTo(0.29);
        expect(result.totals.cost.effectiveUsd).toBeCloseTo(0.29);
        expect(result.breakdowns?.agent?.[0]?.cost.effectiveUsd).toBeCloseTo(0.29);
        expect(result.leaders?.agents?.[0]?.cost?.effectiveUsd).toBeCloseTo(0.29);
        expect(result.modelTimeline?.[0]?.leaders[0]?.cost?.effectiveUsd).toBeCloseTo(0.29);

        const automatic = await querySession(owner.accountId, owner.sessionId, {
            costMode: "auto",
            breakdowns: ["agent"],
            includeLeaders: true,
            includeModelTimeline: true,
        });

        expect(automatic.totals.cost.effectiveUsd).toBeUndefined();
        expect(automatic.breakdowns?.agent?.[0]?.cost.effectiveUsd).toBeUndefined();
        expect(automatic.leaders?.agents?.[0]?.cost?.effectiveUsd).toBeUndefined();
        expect(automatic.modelTimeline?.[0]?.leaders[0]?.cost?.effectiveUsd).toBeUndefined();
        expect(automatic.costPresentation).toBeUndefined();
        expect(automatic.costFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "reported", amountUsd: 0.12 }),
            expect.objectContaining({ kind: "estimated", amountUsd: expect.closeTo(0.29) }),
        ]));
    });
});
