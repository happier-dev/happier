import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eventRouter } from "@/app/events/eventRouter";
import { register } from "@/app/monitoring/metrics/registry";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { recordLegacyUsageReport, recordUsageEvent } from "./usageWriteService";

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: vi.fn() },
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

type MetricSample = {
    labels: Record<string, string>;
    value: number;
};

async function readMetricSamples(name: string): Promise<MetricSample[]> {
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((entry) => entry.name === name);
    if (!metric) return [];
    return metric.values.map((value) => ({
        labels: Object.fromEntries(
            Object.entries(value.labels ?? {}).map(([key, labelValue]) => [key, String(labelValue)]),
        ),
        value: Number(value.value),
    }));
}

describe("usageWriteService", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-usage-write-", initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        register.resetMetrics();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("does not rewrite or re-emit unchanged session legacy usage reports", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-unchanged" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-unchanged",
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

        const first = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-unchanged",
            sessionId: session.id,
            tokens: { total: 12, input: 7, output: 5 },
            cost: { total: 0.12 },
        });
        const duplicate = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-unchanged",
            sessionId: session.id,
            tokens: { total: 12, input: 7, output: 5 },
            cost: { total: 0.12 },
        });

        expect(first).toMatchObject({ ok: true, changed: true, usageEventId: expect.any(String) });
        expect(duplicate).toMatchObject({
            ok: true,
            changed: false,
            usageEventId: null,
            report: first.ok ? first.report : expect.anything(),
        });

        expect(await db.usageReport.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(1);
        expect(eventRouter.emitEphemeral).toHaveBeenCalledTimes(1);

        expect(await readMetricSamples("usage_report_writes_total")).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    labels: { scope: "session", result: "created" },
                    value: 1,
                }),
                expect.objectContaining({
                    labels: { scope: "session", result: "unchanged" },
                    value: 1,
                }),
            ]),
        );
    });

    it("writes sessionless legacy usage reports into the append-only ledger", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-sessionless" },
            select: { id: true },
        });

        const result = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-sessionless",
            sessionId: null,
            tokens: { total: 7, input: 4, output: 3 },
            cost: { total: 0.07 },
        });

        expect(result).toMatchObject({
            ok: true,
            usageEventId: expect.any(String),
        });

        const stored = await db.usageEvent.findMany({
            where: { accountId: account.id },
            select: {
                sessionId: true,
                source: true,
                providerId: true,
                totalTokens: true,
                inputTokens: true,
                outputTokens: true,
                reportedCostUsd: true,
            },
        });
        expect(stored).toEqual([
            {
                sessionId: null,
                source: "legacy_usage_report",
                providerId: "legacy",
                totalTokens: 7,
                inputTokens: 4,
                outputTokens: 3,
                reportedCostUsd: 0.07,
            },
        ]);
    });

    it("canonicalizes duplicate account-level legacy usage reports before writing the next delta", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-account-dedup" },
            select: { id: true },
        });
        await db.usageReport.create({
            data: {
                accountId: account.id,
                sessionId: null,
                key: "legacy-account-total",
                data: { tokens: { total: 1, input: 1 }, cost: { total: 0.01 } },
            },
        });
        await db.usageReport.create({
            data: {
                accountId: account.id,
                sessionId: null,
                key: "legacy-account-total",
                data: { tokens: { total: 2, input: 2 }, cost: { total: 0.02 } },
            },
        });

        const result = await recordLegacyUsageReport({
            accountId: account.id,
            key: "legacy-account-total",
            sessionId: null,
            tokens: { total: 7, input: 7 },
            cost: { total: 0.07 },
        });

        expect(result).toMatchObject({ ok: true, changed: true, usageEventId: expect.any(String) });
        await expect(db.usageReport.findMany({
            where: {
                accountId: account.id,
                sessionId: null,
                key: "legacy-account-total",
            },
            select: { sessionId: true, data: true },
        })).resolves.toEqual([
            {
                sessionId: null,
                data: { tokens: { total: 7, input: 7 }, cost: { total: 0.07 } },
            },
        ]);
        await expect(db.usageEvent.findMany({
            where: { accountId: account.id, source: "legacy_usage_report" },
            select: { sessionId: true, totalTokens: true, inputTokens: true, reportedCostUsd: true },
        })).resolves.toEqual([
            {
                sessionId: null,
                totalTokens: 5,
                inputTokens: 5,
                reportedCostUsd: 0.05,
            },
        ]);
    });

    it("deduplicates append-only usage events by session, source, and external key", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-dedupe" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-dedupe",
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

        const first = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_000_000,
            providerId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey: "vendor-turn-1",
            turnId: "turn-1",
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 12, windowTokens: 200000 },
        });
        const second = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_001_000,
            providerId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey: "vendor-turn-1",
            turnId: "turn-1",
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 12, windowTokens: 200000 },
        });

        expect(first).toMatchObject({ ok: true });
        expect(second).toMatchObject({ ok: true });
        if (!first.ok || !second.ok) {
            throw new Error("Expected usage events to be accepted");
        }

        expect(second.event.id).toBe(first.event.id);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("persists a bounded stable idempotency key for external-keyed usage events", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-idempotency-key" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-idempotency-key",
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

        const externalKey = `vendor-turn-2-${"x".repeat(512)}`;
        const result = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_010_000,
            providerId: "codex",
            backendMode: "appServer",
            modelId: "gpt-5-codex",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "token_count",
            scope: "session_cumulative",
            externalKey,
            turnId: "turn-2",
            isCumulative: true,
            tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 16 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0.09, currency: "USD" },
            context: { usedTokens: 16, windowTokens: 200000 },
        });

        expect(result).toMatchObject({ ok: true });

        const rows = await db.$queryRaw<Array<{ idempotencyKey: string | null }>>`
            SELECT "idempotencyKey"
            FROM "UsageEvent"
            WHERE "accountId" = ${account.id}
              AND "sessionId" = ${session.id}
              AND "source" = ${"token_count"}
              AND "externalKey" = ${externalKey}
        `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.idempotencyKey).toBeTruthy();
        expect(rows[0]?.idempotencyKey?.length ?? 0).toBeLessThanOrEqual(191);
        expect(rows[0]?.idempotencyKey).not.toContain(externalKey);
    });

    it("treats retries against legacy raw idempotency rows as duplicates during rollout", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-legacy-idempotency" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-legacy-idempotency",
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

        const externalKey = "vendor-turn-legacy";
        const legacyIdempotencyKey = JSON.stringify([account.id, session.id, "claude_sdk", externalKey]);
        const legacyRow = await db.usageEvent.create({
            data: {
                accountId: account.id,
                sessionId: session.id,
                observedAt: new Date(1_714_000_020_000),
                providerId: "claude",
                backendMode: "remote",
                modelId: "claude-sonnet",
                projectKey: null,
                workspaceId: null,
                machineId: null,
                source: "claude_sdk",
                scope: "turn_delta",
                externalKey,
                idempotencyKey: legacyIdempotencyKey,
                turnId: "turn-legacy",
                isCumulative: false,
                inputTokens: 8,
                outputTokens: 4,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 12,
                reportedCostUsd: 0.11,
                estimatedCostUsd: 0,
                invoiceCostUsd: 0,
                billingContext: null,
                costSource: null,
                currency: "USD",
                contextUsedTokens: 12,
                contextWindowTokens: 200000,
                metadata: null,
            },
            select: { id: true, idempotencyKey: true },
        });

        const retried = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_021_000,
            providerId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude_sdk",
            scope: "turn_delta",
            externalKey,
            turnId: "turn-legacy",
            isCumulative: false,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: { reportedUsd: 0.11, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 12, windowTokens: 200000 },
        });

        expect(retried).toMatchObject({ ok: true });
        if (!retried.ok) {
            throw new Error("Expected usage event retry to be accepted");
        }

        expect(retried.event.id).toBe(legacyRow.id);
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("persists invoice, billing context, and cost source on usage events", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-usage-service-cost-metadata" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-service-cost-metadata",
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

        const result = await recordUsageEvent(account.id, {
            sessionId: session.id,
            observedAt: 1_714_000_000_000,
            providerId: "claude",
            backendMode: "remote",
            modelId: "claude-sonnet",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "claude-sdk-result",
            scope: "session_final",
            externalKey: "sdk-result-1",
            turnId: null,
            isCumulative: true,
            tokens: { input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: {
                reportedUsd: 0.11,
                estimatedUsd: 0.09,
                invoiceUsd: 0.08,
                billingContext: "api_usage",
                costSource: "provider_reported",
                currency: "USD",
            },
            context: { usedTokens: 12, windowTokens: 200000 },
        });

        expect(result).toMatchObject({ ok: true });

        const stored = await db.usageEvent.findFirst({
            where: {
                accountId: account.id,
                sessionId: session.id,
                source: "claude-sdk-result",
                externalKey: "sdk-result-1",
            },
            select: {
                reportedCostUsd: true,
                estimatedCostUsd: true,
                invoiceCostUsd: true,
                billingContext: true,
                costSource: true,
            },
        });

        expect(stored).toEqual({
            reportedCostUsd: 0.11,
            estimatedCostUsd: 0.09,
            invoiceCostUsd: 0.08,
            billingContext: "api_usage",
            costSource: "provider_reported",
        });
    });
});
