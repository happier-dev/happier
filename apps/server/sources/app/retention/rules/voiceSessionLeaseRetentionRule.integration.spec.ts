import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RetentionPolicy } from "@/app/retention/config/retentionPolicyTypes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createVoiceSessionLeaseRetentionRule } from "./voiceSessionLeaseRetentionRule";

function createPolicy(): RetentionPolicy {
    const keepForever = { mode: "keep_forever" as const };
    return {
        enabled: true,
        intervalMs: 60_000,
        batchSize: 100,
        dryRun: false,
        maxDeletesPerRulePerRun: 100,
        domains: {
            sessions: keepForever,
            accountChanges: keepForever,
            usageEvents: keepForever,
            voiceSessionLeases: { mode: "delete_older_than", days: 1 },
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

describe("voiceSessionLeaseRetentionRule", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-voice-lease-retention-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.voiceConversation.deleteMany().catch(() => {});
        await db.voiceSessionLease.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("copies an older writer's exact lease grant before pruning the lease", async () => {
        const now = new Date("2026-07-29T12:00:00.000Z");
        const account = await db.account.create({
            data: { publicKey: "pk-voice-retention-provenance" },
            select: { id: true },
        });
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: account.id,
                periodKey: "2026-07",
                grantedBy: "free",
                elevenLabsAgentId: "agent_dev",
                createdAt: new Date("2026-07-27T10:00:00.000Z"),
                expiresAt: new Date("2026-07-27T10:01:00.000Z"),
            },
            select: { id: true },
        });
        const conversation = await db.voiceConversation.create({
            data: {
                accountId: account.id,
                leaseId: lease.id,
                providerId: "legacy_provider",
                providerConversationId: "legacy_retention_free_1",
                durationSeconds: 60,
                grantedBy: null,
                createdAt: new Date("2026-07-27T10:01:00.000Z"),
            },
            select: { id: true },
        });

        const rule = createVoiceSessionLeaseRetentionRule();
        const concurrentResults = await Promise.all([
            rule.run({
                policy: createPolicy(),
                batchSize: 100,
                dryRun: false,
                maxDeletesPerRulePerRun: 100,
                now,
            }),
            rule.run({
                policy: createPolicy(),
                batchSize: 100,
                dryRun: false,
                maxDeletesPerRulePerRun: 100,
                now,
            }),
        ]);

        expect(concurrentResults.map((result) => result.deleted).sort()).toEqual([0, 1]);
        expect(
            await db.voiceConversation.findUnique({
                where: { id: conversation.id },
                select: { grantedBy: true, grantPeriodKey: true, leaseId: true },
            }),
        ).toEqual({ grantedBy: "free", grantPeriodKey: "2026-07", leaseId: null });

        const repeated = await rule.run({
            policy: createPolicy(),
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 100,
            now,
        });
        expect(repeated).toEqual({ id: "voiceSessionLeases", deleted: 0 });
        expect(
            await db.voiceConversation.findUnique({
                where: { id: conversation.id },
                select: { grantedBy: true, grantPeriodKey: true, leaseId: true },
            }),
        ).toEqual({ grantedBy: "free", grantPeriodKey: "2026-07", leaseId: null });
    });
});
