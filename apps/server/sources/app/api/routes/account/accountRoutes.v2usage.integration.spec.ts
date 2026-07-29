import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

const { emitEphemeral, buildUsageEphemeral } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral },
    buildUpdateAccountUpdate: vi.fn(),
    buildUsageEphemeral,
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accountRoutes v2 usage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-usage-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("upserts usage report and emits ephemeral when sessionId is provided", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-upsert" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-session",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "k1",
                        sessionId: session.id,
                        tokens: { total: 10, prompt: 5 },
                        cost: { total: 0.1 },
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toMatchObject({
                    success: true,
                    reportId: expect.any(String),
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                });
            },
        );

        const stored = await db.usageReport.findUnique({
            where: {
                accountId_sessionId_key: {
                    accountId: account.id,
                    sessionId: session.id,
                    key: "k1",
                },
            },
            select: { id: true, data: true },
        });
        expect(stored).toEqual(
            expect.objectContaining({
                id: expect.any(String),
                data: { tokens: { total: 10, prompt: 5 }, cost: { total: 0.1 } },
            }),
        );
        expect(buildUsageEphemeral).toHaveBeenCalledWith(session.id, "k1", { total: 10, prompt: 5 }, { total: 0.1 });
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when sessionId does not belong to user", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-missing-session" },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { key: "k1", sessionId: "missing-session", tokens: { total: 1 }, cost: { total: 1 } },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "Session not found" });
            },
        );

        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(await db.usageReport.count()).toBe(0);
    });

    it("preserves legacy usage-report writes while exposing delta-based totals through v2 analytics", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-legacy-bridge" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-legacy-bridge",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const first = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-k1",
                        sessionId: session.id,
                        tokens: { total: 10, input: 6, output: 4 },
                        cost: { total: 0.1 },
                    },
                });
                expect(first.statusCode).toBe(200);

                const second = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-k1",
                        sessionId: session.id,
                        tokens: { total: 15, input: 9, output: 6 },
                        cost: { total: 0.15 },
                    },
                });
                expect(second.statusCode).toBe(200);

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        filters: { sessionIds: [session.id] },
                        includeSeries: true,
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    v: 1,
                    totals: {
                        eventCount: 2,
                        tokens: { total: 15, input: 9, output: 6 },
                        cost: { reportedUsd: 0.15, estimatedUsd: 0, currency: "USD" },
                    },
                });
            },
        );
    });

    it("treats decreased legacy cumulative snapshots as a fresh baseline delta", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-legacy-reset" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-legacy-reset",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-reset-k1",
                        sessionId: session.id,
                        tokens: { total: 20, input: 12, output: 8 },
                        cost: { total: 0.2 },
                    },
                });

                await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-reset-k1",
                        sessionId: session.id,
                        tokens: { total: 5, input: 3, output: 2 },
                        cost: { total: 0.05 },
                    },
                });

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        filters: { sessionIds: [session.id] },
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    totals: {
                        eventCount: 2,
                        tokens: { total: 25, input: 15, output: 10 },
                        cost: { reportedUsd: 0.25, estimatedUsd: 0, currency: "USD" },
                    },
                });
            },
        );
    });

    it("accepts append-only usage events and returns structured v2 breakdowns", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-events-v2" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-events-v2",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const ingest = await app.inject({
                    method: "POST",
                    url: "/v2/usage-events",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        sessionId: session.id,
                        observedAt: 1_714_000_000_000,
                        agentId: "claude",
                        backendMode: "remote",
                        modelId: "claude-sonnet-4-6",
                        projectKey: "project:abc",
                        workspaceId: "workspace-1",
                        machineId: "machine-1",
                        source: "claude_sdk",
                        scope: "turn_delta",
                        externalKey: "vendor-1",
                        turnId: "turn-1",
                        isCumulative: false,
                        tokens: {
                            input: 10,
                            output: 5,
                            reasoning: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 15,
                        },
                        cost: {
                            reportedUsd: 0.12,
                            estimatedUsd: 0,
                            currency: "USD",
                        },
                        context: {
                            usedTokens: 15,
                            windowTokens: 200000,
                        },
                    },
                });

                expect(ingest.statusCode).toBe(200);
                expect(ingest.json()).toMatchObject({
                    success: true,
                    eventId: expect.any(String),
                });
                expect(buildUsageEphemeral).toHaveBeenCalledWith(
                    session.id,
                    "claude:claude-sonnet-4-6",
                    {
                        total: 15,
                        input: 10,
                        output: 5,
                        reasoning: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    {
                        total: 0.12,
                        reportedUsd: 0.12,
                        estimatedUsd: 0,
                        invoiceUsd: 0,
                    },
                );
                expect(emitEphemeral).toHaveBeenCalledWith({
                    userId: account.id,
                    payload: { type: "usage" },
                    recipientFilter: { type: "user-scoped-only" },
                });

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        breakdowns: ["agent", "model"],
                        filters: { sessionIds: [session.id], agentIds: ["claude"] },
                        includeSeries: true,
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    v: 1,
                    totals: {
                        eventCount: 1,
                        tokens: { total: 15 },
                        cost: { reportedUsd: 0.12, estimatedUsd: 0, currency: "USD" },
                    },
                    breakdowns: {
                        agent: [
                            expect.objectContaining({
                                key: "claude",
                                eventCount: 1,
                                tokens: expect.objectContaining({ total: 15 }),
                            }),
                        ],
                        model: [
                            expect.objectContaining({
                                key: "claude-sonnet-4-6",
                                eventCount: 1,
                                tokens: expect.objectContaining({ total: 15 }),
                            }),
                        ],
                    },
                });
            },
        );
    });

    it("returns additive insights, activity, leaders, and cost presentation for premium analytics queries", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-events-premium" },
            select: { id: true },
        });
        const sessionA = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-events-premium-a",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });
        const sessionB = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-events-premium-b",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const events = [
                    {
                        sessionId: sessionA.id,
                        observedAt: Date.UTC(2024, 3, 25, 13, 0, 0),
                        agentId: "claude",
                        backendMode: "remote",
                        modelId: "claude-sonnet-4-6",
                        source: "claude_sdk",
                        externalKey: "premium-1",
                        tokens: { input: 12, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 18 },
                        cost: { reportedUsd: 0.18, estimatedUsd: 0.11, invoiceUsd: 0.09, billingContext: "api_usage", costSource: "provider_reported", currency: "USD" },
                    },
                    {
                        sessionId: sessionB.id,
                        observedAt: Date.UTC(2024, 3, 26, 14, 0, 0),
                        agentId: "codex",
                        backendMode: "appServer",
                        modelId: "gpt-5-codex",
                        source: "codex_app_server",
                        externalKey: "premium-2",
                        tokens: { input: 20, output: 10, reasoning: 2, cacheRead: 3, cacheWrite: 0, total: 33 },
                        cost: { reportedUsd: 0, estimatedUsd: 0.21, invoiceUsd: 0, billingContext: "unknown", costSource: "pricing_estimate", currency: "USD" },
                    },
                ] as const;

                for (const event of events) {
                    const ingest = await app.inject({
                        method: "POST",
                        url: "/v2/usage-events",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: {
                            ...event,
                            projectKey: "project:premium",
                            workspaceId: "workspace-premium",
                            machineId: "machine-premium",
                            scope: "turn_delta",
                            turnId: null,
                            isCumulative: false,
                            context: {
                                usedTokens: event.tokens.total,
                                windowTokens: 200000,
                            },
                        },
                    });

                    expect(ingest.statusCode).toBe(200);
                }

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        granularity: "day",
                        costMode: "estimated",
                        includeSeries: true,
                        includeInsights: true,
                        includeActivity: true,
                        includeLeaders: true,
                        includeModelTimeline: true,
                        includeMessageStats: true,
                        activityResolution: "both",
                        breakdowns: ["agent", "model", "session"],
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    v: 1,
                    totals: {
                        eventCount: 2,
                        tokens: { total: 51 },
                        cost: {
                            reportedUsd: 0.18,
                            estimatedUsd: 0.32,
                            invoiceUsd: 0.09,
                            currency: "USD",
                        },
                    },
                    insights: {
                        activeDays: 2,
                        longestStreakDays: 2,
                        sessionsUsed: 2,
                        modelsTried: 2,
                        favoriteModelChangeCount: 1,
                    },
                    activity: {
                        calendarDays: [
                            expect.objectContaining({ date: "2024-04-25", eventCount: 1 }),
                            expect.objectContaining({ date: "2024-04-26", eventCount: 1 }),
                        ],
                        weekdayHourBuckets: [
                            expect.objectContaining({ weekday: 4, hour: 13, eventCount: 1 }),
                            expect.objectContaining({ weekday: 5, hour: 14, eventCount: 1 }),
                        ],
                    },
                    leaders: {
                        agents: expect.arrayContaining([
                            expect.objectContaining({ key: "codex", eventCount: 1 }),
                            expect.objectContaining({ key: "claude", eventCount: 1 }),
                        ]),
                        engines: expect.arrayContaining([
                            expect.objectContaining({ key: "claude:remote", eventCount: 1 }),
                            expect.objectContaining({ key: "codex:appServer", eventCount: 1 }),
                        ]),
                    },
                    messageStats: {
                        sessionCount: 2,
                    },
                    costPresentation: {
                        mode: "estimated",
                        effectiveUsd: 0.32,
                        currency: "USD",
                    },
                });
            },
        );
    });
});
