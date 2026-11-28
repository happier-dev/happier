import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { billingRoutes } from "@/app/billing/registerBillingRoutes";
import { isPublicAccountScopedKvKey } from "@/app/kv/reservedAccountScopedKvRow";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("account asks on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-asks-",
            env: { HAPPIER_FEATURE_SUPPORTER__ENABLED: "true" },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("requires five completed turns, separates the asks, and closes each permanently", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const addTurn = (status: string) => db.sessionTurn.create({
            data: { sessionId: session.id, turnId: randomUUID(), status, startedAt: 0n, updatedAt: 1n },
        });
        await db.sessionTurn.createMany({
            data: Array.from({ length: 4 }, () => ({
                sessionId: session.id, turnId: randomUUID(), status: "completed", startedAt: 0n, updatedAt: 1n,
            })),
        });
        await addTurn("failed");

        await withAuthenticatedTestApp(billingRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const read = async () => {
                const response = await app.inject({ url: "/v1/account/asks", headers });
                expect(response.statusCode).toBe(200);
                return response.json().due;
            };
            const close = (ask: string) => app.inject({ method: "POST", url: "/v1/account/asks/close", headers, payload: { ask } });

            expect(await read()).toBeNull();
            await addTurn("completed");
            expect(await read()).toBe("star");
            expect((await close("star")).statusCode).toBe(200);
            expect(await read()).toBeNull();
            await db.account.update({ where: { id: account.id }, data: { createdAt: new Date(Date.now() - 11 * 86_400_000) } });
            expect(await read()).toBe("supporter_prompt");
            const record = await db.supporterRecord.create({
                data: { accountId: account.id, code: "a".repeat(32), number: 1, kind: "supporter_once" },
            });
            expect(await read()).toBeNull();
            await db.supporterRecord.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
            expect(await read()).toBeNull();
            await db.supporterRecord.delete({ where: { id: record.id } });
            await db.account.update({ where: { id: account.id }, data: { plan: "plus", planSource: "manual" } });
            expect(await read()).toBeNull();
            await db.account.update({ where: { id: account.id }, data: { plan: null, planSource: null } });
            expect(await read()).toBe("supporter_prompt");
            expect((await close("supporter_prompt")).statusCode).toBe(200);
            expect((await close("supporter_prompt")).statusCode).toBe(200);
            expect(await read()).toBeNull();
        });
        const rows = await db.userKVStore.findMany({ where: { accountId: account.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe("@happier/account/supporter/asks/v1");
        expect(isPublicAccountScopedKvKey(rows[0].key)).toBe(false);
        expect(rows[0].version).toBe(1);
    });
});
