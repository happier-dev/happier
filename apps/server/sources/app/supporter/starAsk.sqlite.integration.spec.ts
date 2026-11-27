import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { billingRoutes } from "@/app/billing/registerBillingRoutes";
import { isReservedAccountScopedKvKey } from "@/app/kv/accountScopedKv";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const dayMs = 86_400_000;
const plansConfig = JSON.stringify({
    v: 1,
    graceDays: 30,
    plans: [{
        id: "plus", name: "Plus", prices: [],
        limits: { sessionRetentionDays: null, subagentRetentionDays: null, toolOutputRetentionDays: null, pinnedSessions: null, artifactStorageBytes: null },
    }],
    teams: { freeSeats: 1, limitsFromPlanId: "plus", seatPrices: [] },
    supporter: null,
});

describe("account asks on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-asks-",
            env: { HAPPIER_FEATURE_SUPPORTER__ENABLED: "true", HAPPIER_PLANS__CONFIG: plansConfig },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("requires five completed user turns, separates the asks, and closes each permanently", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const addTurn = (status: string, initiator: "user" | "workflow" = "user") => db.sessionTurn.create({
            data: { sessionId: session.id, turnId: randomUUID(), status, initiator, startedAt: 0n, updatedAt: 1n },
        });
        await db.sessionTurn.createMany({
            data: Array.from({ length: 4 }, () => ({
                sessionId: session.id, turnId: randomUUID(), status: "completed", startedAt: 0n, updatedAt: 1n,
            })),
        });
        await addTurn("failed");
        await addTurn("completed", "workflow");

        await withAuthenticatedTestApp(billingRoutes, async (app) => {
            const headers = { "x-test-user-id": account.id };
            const expectDue = async (due: "star" | "supporter_prompt" | null) => {
                const response = await app.inject({ url: "/v1/account/asks", headers });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ due });
            };
            const close = (ask: string) => app.inject({ method: "POST", url: "/v1/account/asks/close", headers, payload: { ask } });

            await expectDue(null);
            await addTurn("completed");
            await expectDue("star");
            const starClose = await close("star");
            expect(starClose.statusCode).toBe(200);
            expect(starClose.json()).toEqual({ ok: true });
            await expectDue(null);
            await db.account.update({ where: { id: account.id }, data: { createdAt: new Date(Date.now() - 11 * dayMs) } });
            await expectDue("supporter_prompt");
            const record = await db.supporterRecord.create({
                data: { accountId: account.id, code: "a".repeat(32), number: 1, kind: "supporter_once" },
            });
            await expectDue(null);
            await db.supporterRecord.update({ where: { id: record.id }, data: { number: null, revokedAt: new Date() } });
            await expectDue(null);
            await db.supporterRecord.delete({ where: { id: record.id } });
            await db.account.update({ where: { id: account.id }, data: { plan: "plus", planSource: "manual" } });
            await expectDue(null);
            await db.account.update({ where: { id: account.id }, data: { plan: null, planSource: null } });
            const team = await db.team.create({ data: { name: "Paid Team", paidSeats: 2 } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: "member" } });
            await expectDue(null);
            await db.account.update({ where: { id: account.id }, data: { plan: "unrecognized-plan", planSource: "manual" } });
            await expectDue(null);
            await db.account.update({ where: { id: account.id }, data: { plan: null, planSource: null } });
            await db.team.update({ where: { id: team.id }, data: { planEndsAt: new Date(Date.now() - 31 * dayMs) } });
            await expectDue("supporter_prompt");
            expect((await close("supporter_prompt")).statusCode).toBe(200);
            expect((await close("supporter_prompt")).statusCode).toBe(200);
            await expectDue(null);
        });
        const rows = await db.userKVStore.findMany({ where: { accountId: account.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe("@happier/account/supporter/asks/v1");
        expect(isReservedAccountScopedKvKey(rows[0].key)).toBe(true);
        expect(rows[0].version).toBe(1);
    });

    it("refuses both operations while the Supporter feature is disabled", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const headers = { "x-test-user-id": account.id };
        await withAuthenticatedTestApp((app) => billingRoutes(app, { env: { HAPPIER_FEATURE_SUPPORTER__ENABLED: "false" } }), async (app) => {
            const read = await app.inject({ url: "/v1/account/asks", headers });
            expect(read.statusCode).toBe(404);
            const close = await app.inject({ method: "POST", url: "/v1/account/asks/close", headers, payload: { ask: "star" } });
            expect(close.statusCode).toBe(404);
        });
        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
    });
});
