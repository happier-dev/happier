import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountPlanResponseV1Schema } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    // Socket delivery is the boundary; the payload builder stays real.
    return { ...actual, eventRouter: { ...actual.eventRouter, emitUpdate } };
});

import { accountTierWhere, resolveAccountPlan, resolveLimitTable } from "./accountLimits";
import { writeAccountPlanStateInTx } from "./accountPlanState";
import { registerAccountPlanRoute } from "./registerAccountPlanRoute";

const DAY_MS = 86_400_000;
const LITE = {
    id: "lite", name: "Happier Lite",
    limits: { sessionRetentionDays: 90, subagentRetentionDays: 14, toolOutputRetentionDays: null, pinnedSessions: 100, artifactStorageBytes: null },
    prices: [{ interval: "month", amountMinor: 299, currency: "usd", checkoutUrl: "https://buy.polar.sh/lite" }],
};
const PLUS = {
    id: "plus", name: "Happier Plus",
    limits: { sessionRetentionDays: 365, subagentRetentionDays: 30, toolOutputRetentionDays: null, pinnedSessions: 500, artifactStorageBytes: null },
    prices: [{ interval: "month", amountMinor: 699, currency: "usd", checkoutUrl: "https://buy.polar.sh/plus" }],
};
const CLOUD_ENV = {
    HAPPIER_PLANS__CONFIG: JSON.stringify({ v: 1, graceDays: 90, plans: [LITE, PLUS], teams: null, supporter: null }),
    HAPPIER_SESSION_PINS__MAX: "50",
    HAPPIER_SERVER_RETENTION__SESSIONS__MODE: "delete_inactive",
    HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: "60",
    HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: "delete_older_than",
    HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS: "7",
};

describe("Account plan state on a real database", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-plan-", initAuth: false, initEncrypt: false, initFiles: false });
    }, 120_000);

    beforeEach(() => {
        harness.resetEnv();
        Object.assign(process.env, CLOUD_ENV);
        emitUpdate.mockClear();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function getPlan(accountId: string): Promise<{ statusCode: number; body: string; json: () => unknown }> {
        let response: { statusCode: number; body: string; json: () => unknown } | undefined;
        await withAuthenticatedTestApp(
            (app) => registerAccountPlanRoute(app),
            async (app) => {
                response = await app.inject({ method: "GET", url: "/v1/account/plan", headers: { "x-test-user-id": accountId } });
            },
        );
        if (!response) throw new Error("no response");
        return response;
    }

    it("writes a real change once and a replay writes and publishes nothing", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const next = { plan: "plus", planSource: "polar" as const, planEndsAt: new Date(Date.now() + 30 * DAY_MS), planRenews: true };

        const first = await inTx(async (tx) => await writeAccountPlanStateInTx(tx, account.id, next));
        const changesAfterFirst = await db.accountChange.count({ where: { accountId: account.id } });
        const seqAfterFirst = (await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq;
        const replays = [];
        for (let index = 0; index < 5; index++) {
            replays.push(await inTx(async (tx) => await writeAccountPlanStateInTx(tx, account.id, { ...next, planEndsAt: new Date(next.planEndsAt) })));
        }

        expect(first).toEqual({ changed: true });
        expect(replays.every((result) => !result.changed)).toBe(true);
        expect(changesAfterFirst).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(1);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq).toBe(seqAfterFirst);
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate.mock.calls[0]?.[0]).toMatchObject({ userId: account.id, payload: { body: { t: "update-account", plan: true } } });
    });

    it("offers the public supporter checkout and portal without a plans config", async () => {
        delete process.env.HAPPIER_PLANS__CONFIG;
        process.env.HAPPIER_FEATURE_SUPPORTER__ENABLED = "1";
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const body = AccountPlanResponseV1Schema.parse((await getPlan(account.id)).json());
        expect(body.offers).toMatchObject({
            plans: [],
            billingReference: "supporter_code",
            supporter: {
                checkoutUrls: {
                    monthly: "https://buy.polar.sh/polar_cl_TOkujpwuMQtulowET1d9Qkg7IxKtghB3mArhW1JjzUJ",
                    once: "https://buy.polar.sh/polar_cl_b0CXA76oFRP5D9PGYKY840NDvq16RTIKG6Cji0UZRdx",
                },
            },
            portalUrl: "https://polar.sh/happier/portal",
        });
    });

    it("reports whether the active server reconciles purchases against its own accounts", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        delete process.env.POLAR_ACCESS_TOKEN;
        const selfHosted = AccountPlanResponseV1Schema.parse((await getPlan(account.id)).json());
        expect(selfHosted.offers).toMatchObject({ billingReference: "supporter_code" });

        process.env.POLAR_ACCESS_TOKEN = "test-sandbox-token";
        process.env.POLAR_SERVER = "sandbox";
        const sandbox = AccountPlanResponseV1Schema.parse((await getPlan(account.id)).json());
        expect(sandbox.offers).toMatchObject({ billingReference: "account" });
        expect(JSON.stringify(sandbox)).not.toContain("test-sandbox-token");
    });

    it("accountTierWhere selects exactly the rows resolveAccountPlan puts in each tier", async () => {
        const now = new Date();
        const table = resolveLimitTable(process.env);
        if (!table.ok) throw new Error(table.error);
        const fixtures = [
            { plan: null, planEndsAt: null },
            { plan: "plus", planEndsAt: new Date(now.getTime() + 20 * DAY_MS) },
            { plan: "plus", planEndsAt: null },
            { plan: "plus", planEndsAt: new Date(now.getTime() - 10 * DAY_MS) },
            { plan: "plus", planEndsAt: new Date(now.getTime() - 91 * DAY_MS) },
            { plan: "lite", planEndsAt: new Date(now.getTime() + 5 * DAY_MS) },
            { plan: "lite", planEndsAt: new Date(now.getTime() - 200 * DAY_MS) },
            { plan: "gold", planEndsAt: new Date(now.getTime() - 400 * DAY_MS) },
        ];
        const tag = randomUUID();
        const ids: string[] = [];
        for (const fixture of fixtures) {
            ids.push((await db.account.create({ data: { publicKey: `pk-${tag}-${ids.length}`, ...fixture }, select: { id: true } })).id);
        }
        for (const [index, fixture] of fixtures.entries()) {
            const resolved = resolveAccountPlan({ account: fixture, table, now });
            const selectingTiers: string[] = [];
            for (const tier of ["base", ...table.planOrder]) {
                const hit = await db.account.count({ where: { AND: [{ id: ids[index] }, accountTierWhere(tier, table, now)] } });
                if (hit > 0) selectingTiers.push(tier);
            }
            const expectedTier = fixture.plan === "gold" ? [] : [resolved.plan?.id ?? "base"];
            expect({ index, tiers: selectingTiers }).toEqual({ index, tiers: expectedTier });
        }
    });

    it("GET /v1/account/plan reports plan, limits, usage, supporter facts and offers, never the code", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, plan: "plus", planSource: "polar", planEndsAt: new Date(Date.now() - 2 * DAY_MS), planRenews: true },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: "{}", metadataVersion: 0, agentState: null, agentStateVersion: 0 },
            select: { id: true },
        });
        await db.sessionPin.create({ data: { accountId: account.id, sessionId: session.id } });
        const code = "0123456789abcdef0123456789abcdef";
        const grantedAt = new Date("2026-11-20T10:00:00.000Z");
        await db.supporterRecord.create({ data: { code, accountId: account.id, number: 7, kind: "plan", grantedAt } });

        const res = await getPlan(account.id);

        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(code);
        const body = AccountPlanResponseV1Schema.parse(res.json());
        expect(body.plan).toMatchObject({ id: "plus", via: "account", source: "polar", renews: true, overdue: true });
        expect(body.plan?.graceEndsAt).toBeGreaterThan(Date.now());
        expect(body.limits.pinnedSessions).toBe(500);
        expect(body.usage).toEqual({ pinnedSessions: 1, artifactStorageBytes: null });
        expect(body.supporter).toEqual({ active: true, since: grantedAt.getTime(), number: 7, recurringSince: null });
        expect(body.offers?.plans.map((plan) => plan.id)).toEqual(["lite", "plus"]);
        expect(body.offers?.baseLimits).toEqual({ sessionRetentionDays: 60, subagentRetentionDays: 7, toolOutputRetentionDays: null, pinnedSessions: 50, artifactStorageBytes: null });
        expect(body.offers?.supporter?.minimumMinor).toBe(300);
        expect(body.offers?.graceDays).toBe(90);
    });

    it("a revoked record reads as no supporter; plans off keeps Supporter offers only; both off is 404", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        await db.supporterRecord.create({
            data: { code: "fedcba9876543210fedcba9876543210", accountId: account.id, number: 8, kind: "supporter_once", grantedAt: new Date(), revokedAt: new Date() },
        });

        process.env.HAPPIER_FEATURE_PLANS__ENABLED = "0";
        const supporterOnly = AccountPlanResponseV1Schema.parse((await getPlan(account.id)).json());
        expect(supporterOnly.supporter).toEqual({ active: false, since: null, number: null, recurringSince: null });
        expect(supporterOnly.offers?.plans).toEqual([]);
        expect(supporterOnly.offers?.baseLimits).toBeNull();
        expect(supporterOnly.offers?.supporter).not.toBeNull();

        process.env.HAPPIER_FEATURE_SUPPORTER__ENABLED = "0";
        expect((await getPlan(account.id)).statusCode).toBe(404);
    });
});
