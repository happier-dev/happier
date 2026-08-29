import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { createRepeatKeyRetentionRule } from "./repeatKeyRetentionRule";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported contract provider: ${raw}`);
}

function disabledPolicy(): RetentionPolicy {
    const keepForever = { mode: "keep_forever" as const };
    return {
        enabled: false,
        intervalMs: 60_000,
        batchSize: 100,
        dryRun: false,
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
            repeatKeys: keepForever,
            globalLocks: keepForever,
            automationRuns: keepForever,
            automationRunEvents: keepForever,
        },
    };
}

describe("RepeatKey intrinsic-expiry provider contract", () => {
    const provider = resolveContractProvider();
    const prefixes = new Set<string>();
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterEach(async () => {
        if (!connected) return;
        for (const prefix of prefixes) {
            await db.repeatKey.deleteMany({
                where: { key: { startsWith: prefix } },
            });
        }
        prefixes.clear();
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
    });

    it("reclaims each expired row once across concurrent sweep instances and preserves live rows", async () => {
        const now = new Date("2026-08-29T12:00:00.000Z");
        const prefix = `repeat-retention-${provider}-${randomUUID()}`;
        prefixes.add(prefix);
        await db.repeatKey.createMany({
            data: [
                ...Array.from({ length: 10 }, (_, index) => ({
                    key: `${prefix}-expired-${index}`,
                    value: "expired",
                    expiresAt: new Date(now.getTime() - index - 1),
                })),
                { key: `${prefix}-boundary`, value: "boundary", expiresAt: now },
                { key: `${prefix}-live`, value: "live", expiresAt: new Date(now.getTime() + 60_000) },
            ],
        });
        const run = async () => await createRepeatKeyRetentionRule().run({
            policy: disabledPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now,
        });

        const results = await Promise.all([run(), run()]);

        expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBe(11);
        expect(await db.repeatKey.findMany({
            where: { key: { startsWith: prefix } },
            select: { key: true },
        })).toEqual([{ key: `${prefix}-live` }]);
    });
});
