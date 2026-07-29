import { UsageAnalyticsQueryRequestSchema } from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { queryUsageAnalytics } from "./usageQueryService";

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
        vi.resetModules();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
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

    it("lets a provider final supersede turn deltas emitted under a different source label", async () => {
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
        expect(result.totals.cost.effectiveUsd).toBeCloseTo(0.12);
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(100);
    });

    it("keeps auto-mode series effective cost telescoped when final provenance changes", async () => {
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

        expect(result.totals.cost.effectiveUsd).toBeCloseTo(0.12);
        expect(result.series?.map((bucket) => bucket.cost.effectiveUsd)).toEqual([
            expect.closeTo(0.1),
            expect.closeTo(0.02),
        ]);
        expect(result.series?.reduce((sum, bucket) => sum + (bucket.cost.effectiveUsd ?? 0), 0)).toBeCloseTo(0.12);
    });

    it("restarts snapshot attribution after a cumulative counter reset", async () => {
        const owner = await createUsageOwner("series-reset");
        await db.usageEvent.createMany({
            data: [
                buildUsageEvent({ ...owner, observedAt: "2026-07-01T10:00:00.000Z", scope: "session_cumulative", totalTokens: 100 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-02T10:00:00.000Z", scope: "session_cumulative", totalTokens: 40 }),
                buildUsageEvent({ ...owner, observedAt: "2026-07-03T10:00:00.000Z", scope: "session_cumulative", totalTokens: 60 }),
            ],
        });

        const result = await querySession(owner.accountId, owner.sessionId);

        expect(result.totals.tokens.total).toBe(60);
        expect(result.series?.map((bucket) => bucket.tokens.total)).toEqual([40, 20]);
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(60);
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

        expect(automatic.totals.cost.effectiveUsd).toBeCloseTo(0.32);
        expect(automatic.breakdowns?.agent?.[0]?.cost.effectiveUsd).toBeCloseTo(0.32);
        expect(automatic.leaders?.agents?.[0]?.cost?.effectiveUsd).toBeCloseTo(0.32);
        expect(automatic.modelTimeline?.[0]?.leaders[0]?.cost?.effectiveUsd).toBeCloseTo(0.32);
    });
});
