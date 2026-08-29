import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createRepeatKeyRetentionRule } from "./repeatKeyRetentionRule";

const now = new Date("2026-08-29T12:00:00.000Z");
const expired = new Date(now.getTime() - 1);
const live = new Date(now.getTime() + 60_000);

function createPolicy(input: Readonly<{
    enabled: boolean;
    repeatKeys: RetentionPolicy["domains"]["repeatKeys"];
    dryRun?: boolean;
}>): RetentionPolicy {
    const keepForever = { mode: "keep_forever" as const };
    return {
        enabled: input.enabled,
        intervalMs: 60_000,
        batchSize: 100,
        dryRun: input.dryRun ?? false,
        maxDeletesPerRulePerRun: 100,
        domains: {
            sessions: keepForever,
            sessionSidechainMessages: keepForever,
            accountChanges: keepForever,
            usageEvents: keepForever,
            voiceSessionLeases: keepForever,
            userFeedItems: keepForever,
            sessionShareAccessLogs: keepForever,
            publicShareAccessLogs: keepForever,
            terminalAuthRequests: keepForever,
            accountAuthRequests: keepForever,
            authPairingSessions: keepForever,
            repeatKeys: input.repeatKeys,
            globalLocks: keepForever,
            automationRuns: keepForever,
            automationRunEvents: keepForever,
        },
    };
}

async function createRows(prefix: string): Promise<void> {
    await db.repeatKey.createMany({
        data: [
            { key: `${prefix}-expired`, value: "expired", expiresAt: expired },
            { key: `${prefix}-boundary`, value: "boundary", expiresAt: now },
            { key: `${prefix}-live`, value: "live", expiresAt: live },
        ],
    });
}

async function runRule(params: Readonly<{
    policy: RetentionPolicy;
    batchSize?: number;
    dryRun?: boolean;
}>) {
    return await createRepeatKeyRetentionRule().run({
        policy: params.policy,
        batchSize: params.batchSize ?? 100,
        dryRun: params.dryRun ?? false,
        maxDeletesPerRulePerRun: params.batchSize ?? 100,
        now,
    });
}

describe("repeatKeyRetentionRule", () => {
    let harness: LightSqliteHarness | null = null;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-repeat-key-retention-",
        });
    }, 600_000);

    afterEach(async () => {
        await db.repeatKey.deleteMany();
    });

    afterAll(async () => {
        await harness?.close();
    });

    it("reclaims intrinsically expired rows when global operator retention is disabled", async () => {
        await createRows("disabled");

        const result = await runRule({
            policy: createPolicy({
                enabled: false,
                repeatKeys: { mode: "keep_forever" },
            }),
        });

        expect(result).toMatchObject({
            id: "repeatKeys",
            deleted: 2,
            candidatesExamined: 2,
            hasMore: false,
        });
        expect(await db.repeatKey.findMany({
            orderBy: { key: "asc" },
            select: { key: true },
        })).toEqual([{ key: "disabled-live" }]);
    });

    it("preserves live rows under enabled keep-forever while enforcing intrinsic expiry", async () => {
        await createRows("keep");

        const result = await runRule({
            policy: createPolicy({
                enabled: true,
                repeatKeys: { mode: "keep_forever" },
            }),
        });

        expect(result.deleted).toBe(2);
        expect(await db.repeatKey.findMany({ select: { key: true } }))
            .toEqual([{ key: "keep-live" }]);
    });

    it("uses intrinsic expiry as the mandatory floor under delete-older-than", async () => {
        await createRows("finite");

        const result = await runRule({
            policy: createPolicy({
                enabled: true,
                repeatKeys: { mode: "delete_older_than", days: 30 },
            }),
        });

        expect(result.deleted).toBe(2);
        expect(await db.repeatKey.findMany({ select: { key: true } }))
            .toEqual([{ key: "finite-live" }]);
    });

    it("retains the indexed bounded scan and exact cutoff recheck across batches", async () => {
        await createRows("batched");
        const policy = createPolicy({
            enabled: false,
            repeatKeys: { mode: "keep_forever" },
        });

        const first = await runRule({ policy, batchSize: 1 });
        const second = await runRule({ policy, batchSize: 1 });
        const exhausted = await runRule({ policy, batchSize: 1 });

        expect(first).toMatchObject({ deleted: 1, candidatesExamined: 1, hasMore: true });
        expect(second).toMatchObject({ deleted: 1, candidatesExamined: 1, hasMore: true });
        expect(exhausted).toMatchObject({ deleted: 0, candidatesExamined: 0, hasMore: false });
        expect(await db.repeatKey.findMany({ select: { key: true } }))
            .toEqual([{ key: "batched-live" }]);
    });

    it("reports intrinsic expiry candidates without deleting them in dry-run mode", async () => {
        await createRows("dry");
        const policy = createPolicy({
            enabled: false,
            repeatKeys: { mode: "keep_forever" },
            dryRun: true,
        });

        const result = await runRule({ policy, dryRun: true });

        expect(result).toMatchObject({
            deleted: 2,
            candidatesExamined: 2,
            hasMore: false,
        });
        expect(await db.repeatKey.count()).toBe(3);
    });

    it("is idempotent under concurrent sweep instances", async () => {
        await createRows("concurrent");
        const policy = createPolicy({
            enabled: false,
            repeatKeys: { mode: "keep_forever" },
        });

        const results = await Promise.all([
            runRule({ policy }),
            runRule({ policy }),
        ]);

        expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBe(2);
        expect(await db.repeatKey.findMany({ select: { key: true } }))
            .toEqual([{ key: "concurrent-live" }]);
    });
});
