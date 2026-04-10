import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { recordLegacyUsageReport, recordUsageEvent } from "./usageWriteService";

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: vi.fn() },
    buildUsageEphemeral: vi.fn(() => ({ type: "usage" })),
}));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

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
