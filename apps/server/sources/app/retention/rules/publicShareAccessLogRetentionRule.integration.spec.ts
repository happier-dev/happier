import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readRetentionPolicyFromEnv } from "@/app/retention/config/readRetentionPolicyFromEnv";
import { runRetentionSweep } from "@/app/retention/runtime/runRetentionSweep";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const DAY_MS = 24 * 60 * 60 * 1000;

async function createPublicSessionShare(name: string) {
    const owner = await db.account.create({ data: { publicKey: `pk-${name}` }, select: { id: true } });
    const session = await db.session.create({
        data: { tag: name, accountId: owner.id, metadata: "{}" },
        select: { id: true },
    });
    return db.publicSessionShare.create({
        data: { sessionId: session.id, createdByUserId: owner.id, tokenHash: randomBytes(32) },
        select: { id: true },
    });
}

describe("publicShareAccessLogs retention", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-public-share-log-retention-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.publicShareAccessLog.deleteMany().catch(() => {});
        await db.publicSessionShare.deleteMany().catch(() => {});
        await db.session.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("deletes access logs older than 90 days under the default policy, with automatic deletion off", async () => {
        // Owner ruling 2026-11-15 (Growth decisions final): public share access logs keep 90 days.
        const now = new Date("2026-11-15T12:00:00.000Z");
        const policy = readRetentionPolicyFromEnv({});
        expect(policy.enabled).toBe(false);
        const share = await createPublicSessionShare("public-share-log-retention");
        const expired = await db.publicShareAccessLog.create({
            data: { publicShareId: share.id, accessedAt: new Date(now.getTime() - 91 * DAY_MS) },
            select: { id: true },
        });
        const retained = await db.publicShareAccessLog.create({
            data: { publicShareId: share.id, accessedAt: new Date(now.getTime() - 89 * DAY_MS) },
            select: { id: true },
        });

        const result = await runRetentionSweep({ policy, now });

        expect(result.byRule.publicShareAccessLogs).toBe(1);
        expect(await db.publicShareAccessLog.findMany({ select: { id: true } })).toEqual([retained]);
        expect(await db.publicShareAccessLog.findUnique({ where: { id: expired.id } })).toBeNull();
    });

    it("keeps every access log when the operator selects keep_forever", async () => {
        const now = new Date("2026-11-15T12:00:00.000Z");
        const policy = readRetentionPolicyFromEnv({ HAPPIER_SERVER_RETENTION__PUBLIC_SHARE_ACCESS_LOGS__MODE: "keep_forever" });
        const share = await createPublicSessionShare("public-share-log-keep");
        await db.publicShareAccessLog.create({
            data: { publicShareId: share.id, accessedAt: new Date(now.getTime() - 400 * DAY_MS) },
        });

        const result = await runRetentionSweep({ policy, now });

        expect(result.byRule.publicShareAccessLogs).toBe(0);
        expect(await db.publicShareAccessLog.count()).toBe(1);
    });
});
