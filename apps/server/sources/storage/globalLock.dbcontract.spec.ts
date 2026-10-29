import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres, isPrismaErrorCode } from "@/storage/db";
import { acquireGlobalLock } from "./globalLock";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("Global lock persistence contract", () => {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const keys: string[] = [];
    let connected = false;
    let sqlite: LightSqliteHarness | undefined;

    beforeAll(async () => {
        if (provider === "sqlite") {
            sqlite = await createLightSqliteHarness({ tempDirPrefix: "happier-global-lock-" });
            connected = true;
            return;
        }
        const supplied = provider === "mysql"
            ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
            : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || supplied !== process.env.DATABASE_URL) {
            throw new Error("Use the disposable database-contract harness");
        }
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (!connected) return;
        await db.globalLock.deleteMany({ where: { key: { in: keys } } });
        if (sqlite) await sqlite.close();
        else await db.$disconnect();
    });

    function lockKey() {
        const key = `db-hotspots-${randomUUID()}`;
        keys.push(key);
        return key;
    }

    it("settles repeated held-lock admission without unique violations or owner mutation", async () => {
        const key = lockKey();
        const now = new Date("2026-10-25T17:30:00Z");
        const owner = await acquireGlobalLock({ key, ttlMs: 60_000, now });
        expect(owner).not.toBeNull();
        const before = await db.globalLock.findUniqueOrThrow({ where: { key } });
        let violations = 0;
        const delegate = db.globalLock;
        const create = delegate.create;
        // Observe real constraint errors at the database boundary, including
        // errors the lock owner catches. No storage/domain behavior is replaced.
        delegate.create = new Proxy(create, { apply(target, receiver, args: unknown[]) {
            return Reflect.apply(target, receiver, args).catch((error: unknown) => {
                if (isPrismaErrorCode(error, "P2002")) violations++;
                throw error;
            });
        } });
        try {
            for (let index = 0; index < 16; index++) {
                expect(await acquireGlobalLock({ key, ttlMs: 60_000, now })).toBeNull();
            }
        } finally {
            delegate.create = create;
        }
        expect(await db.globalLock.findUniqueOrThrow({ where: { key } })).toEqual(before);
        expect(violations).toBe(0);
        await owner?.release();
        expect(await db.globalLock.findUnique({ where: { key } })).toBeNull();
    });

    it("admits one concurrent owner, renews it and protects a replacement from the old lease", async () => {
        const key = lockKey();
        const now = new Date("2026-10-25T17:30:00Z");
        const results = await Promise.all(Array.from({ length: 16 }, () => acquireGlobalLock({ key, ttlMs: 60_000, now })));
        const owners = results.filter(owner => owner !== null);
        expect(owners).toHaveLength(1);
        const owner = owners[0]!;
        expect(await owner.renew({ ttlMs: 60_000, now: new Date(now.getTime() + 30_000) })).toBe(true);
        expect(await acquireGlobalLock({ key, ttlMs: 60_000, now: new Date(now.getTime() + 60_000) })).toBeNull();
        const replacements = await Promise.all(Array.from({ length: 16 }, () => acquireGlobalLock({
            key, ttlMs: 60_000, now: new Date(now.getTime() + 90_001),
        })));
        const replacementOwners = replacements.filter(lease => lease !== null);
        expect(replacementOwners).toHaveLength(1);
        expect(await owner.renew({ ttlMs: 60_000, now })).toBe(false);
        await owner.release();
        expect(await db.globalLock.findUnique({ where: { key } })).not.toBeNull();
        await replacementOwners[0]!.release();
        expect(await db.globalLock.findUnique({ where: { key } })).toBeNull();
    });
});
