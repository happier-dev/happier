import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";

import { AccountPlanResponseV1Schema, AccountSupporterResponseV1Schema } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    // Socket delivery is the boundary; payload builders stay real.
    return { ...actual, eventRouter: { ...actual.eventRouter, emitUpdate } };
});

import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { setSessionPin } from "@/app/session/organization/organizationMutations";
import { registerAccountPlanRoute } from "@/app/plans/registerAccountPlanRoute";
import { billingRoutes } from "./registerBillingRoutes";
import { reconcileBillingForRef } from "./reconcileBilling";
import type { PolarClient } from "./polarClient";

const DAY_MS = 86_400_000;
const WEBHOOK_KEY = Buffer.from("polar-webhook-test-key-0123456789");
const WEBHOOK_SECRET = `whsec_${privacyKit.encodeBase64(WEBHOOK_KEY)}`;

const LITE = {
    id: "lite", name: "Happier Lite",
    limits: { sessionRetentionDays: 90, subagentRetentionDays: 14, toolOutputRetentionDays: null, pinnedSessions: 3, artifactStorageBytes: null },
    prices: [{ interval: "month", amountMinor: 299, currency: "usd" }],
};
const PLUS = {
    id: "plus", name: "Happier Plus",
    limits: { sessionRetentionDays: 365, subagentRetentionDays: 30, toolOutputRetentionDays: null, pinnedSessions: 4, artifactStorageBytes: null },
    prices: [{ interval: "month", amountMinor: 699, currency: "usd" }],
};
const PUBLIC_PORTAL_URL = "https://polar.sh/happier/portal";
const BASE_ENV = {
    HAPPIER_PLANS__CONFIG: JSON.stringify({ v: 1, graceDays: 90, plans: [LITE, PLUS], teams: null, supporter: null, portalUrl: PUBLIC_PORTAL_URL }),
    HAPPIER_SESSION_PINS__MAX: "2",
};
const CLOUD_ENV = { ...BASE_ENV, POLAR_ACCESS_TOKEN: "polar_oat_test", POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET };

type FakeItem = Record<string, unknown> & { metadata: { reference_id: string } };

/** Polar's REST API at the HTTP boundary: list filters by `metadata[reference_id]`, one page. */
function createFakePolar() {
    const state = { subscriptions: [] as FakeItem[], orders: [] as FakeItem[], failing: false, calls: 0 };
    const fetchImpl: typeof fetch = async (input) => {
        state.calls += 1;
        const url = new URL(String(input));
        if (state.failing) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        const ref = url.searchParams.get("metadata[reference_id]");
        const source = url.pathname === "/v1/subscriptions/" ? state.subscriptions : url.pathname === "/v1/orders/" ? state.orders : null;
        if (!source) return new Response("{}", { status: 404 });
        const items = source.filter((item) => item.metadata.reference_id === ref);
        return new Response(JSON.stringify({ items, pagination: { total_count: items.length, max_page: 1 } }), { status: 200 });
    };
    return { state, fetchImpl };
}

function subscription(ref: string, kind: string, overrides: Record<string, unknown> = {}): FakeItem {
    return {
        id: `sub_${randomUUID()}`, status: "active", customer_id: `cus_${ref.slice(0, 6)}`,
        current_period_end: new Date(Date.now() + 30 * DAY_MS).toISOString(), cancel_at_period_end: false,
        started_at: new Date(Date.now() - DAY_MS).toISOString(), ended_at: null,
        metadata: { reference_id: ref }, product: { metadata: { happier_kind: kind } },
        ...overrides,
    };
}

function order(ref: string, kind: string, status: string): FakeItem {
    return {
        id: `ord_${randomUUID()}`, status, customer_id: `cus_${ref.slice(0, 6)}`, created_at: new Date(Date.now() - DAY_MS).toISOString(),
        subscription_id: null, billing_reason: "purchase", metadata: { reference_id: ref }, product: { metadata: { happier_kind: kind } },
    };
}

function signedWebhookHeaders(body: string, id = `msg_${randomUUID()}`) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", WEBHOOK_KEY).update(`${id}.${timestamp}.${body}`).digest("base64");
    return { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

describe("Polar billing end to end on a real database", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-billing-", initAuth: false, initEncrypt: false, initFiles: false });
    }, 120_000);

    beforeEach(() => {
        harness.resetEnv();
        emitUpdate.mockClear();
    });

    afterAll(async () => {
        await harness.close();
    });

    async function buildApp(env: Record<string, string>, fetchImpl: typeof fetch) {
        Object.assign(process.env, env);
        const app = createAuthenticatedTestApp();
        registerAccountPlanRoute(app);
        billingRoutes(app, { env: process.env, fetchImpl });
        await app.ready();
        return app;
    }

    async function createAccountWithSessions(count: number) {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const sessionIds: string[] = [];
        for (let index = 0; index < count; index++) {
            sessionIds.push((await db.session.create({
                data: { accountId: account.id, tag: `s-${randomUUID()}`, metadata: "{}", metadataVersion: 0, agentState: null, agentStateVersion: 0 },
                select: { id: true },
            })).id);
        }
        return { accountId: account.id, sessionIds };
    }

    it("a paid Plus subscription lifts the pin limit through the webhook, and replays write nothing", async () => {
        const polar = createFakePolar();
        const app = await buildApp(CLOUD_ENV, polar.fetchImpl);
        const { accountId, sessionIds } = await createAccountWithSessions(4);
        const pin = (sessionId: string) => setSessionPin({ accountId, sessionId, authentication: createPresentUserSessionAccessAuthentication(), request: { pinned: true } });
        const readPlan = async () => AccountPlanResponseV1Schema.parse((await app.inject({ method: "GET", url: "/v1/account/plan", headers: { "x-test-user-id": accountId } })).json());

        await pin(sessionIds[0]!);
        await pin(sessionIds[1]!);
        expect(await pin(sessionIds[2]!)).toEqual({ error: "session-pin-limit-exceeded", limit: 2 });
        expect((await readPlan()).plan).toBeNull();

        polar.state.subscriptions.push(subscription(accountId, "plus"));
        polar.state.orders.push(order(accountId, "plus", "paid"));
        const body = JSON.stringify({ type: "subscription.updated", timestamp: new Date().toISOString(), data: { id: "sub", metadata: { reference_id: accountId } } });
        const delivered = await app.inject({ method: "POST", url: "/v1/billing/polar", headers: signedWebhookHeaders(body), payload: body });
        expect(delivered.statusCode).toBe(200);

        const plan = await readPlan();
        expect(plan.plan).toMatchObject({ id: "plus", source: "polar", renews: true, graceEndsAt: null, overdue: false });
        expect(plan.supporter).toMatchObject({ active: true, number: 1 });
        expect(plan.supporterRing).toBe(false);
        expect(await pin(sessionIds[2]!)).toHaveProperty("pin");

        const changes = await db.accountChange.count({ where: { accountId } });
        const seq = (await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq;
        const pushes = emitUpdate.mock.calls.length;
        for (let replay = 0; replay < 3; replay++) {
            const again = await app.inject({ method: "POST", url: "/v1/billing/polar", headers: signedWebhookHeaders(body), payload: body });
            expect(again.statusCode).toBe(200);
        }
        expect(await db.accountChange.count({ where: { accountId } })).toBe(changes);
        expect((await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq).toBe(seq);
        expect(emitUpdate.mock.calls.length).toBe(pushes);
        await app.close();
    });

    it("reads a fresh provider snapshot after the previous reconciliation for the same ref finishes", async () => {
        const { accountId } = await createAccountWithSessions(0);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const listSubscriptionsForRef = vi.fn<PolarClient["listSubscriptionsForRef"]>()
            .mockImplementationOnce(async () => {
                await held;
                return [{ id: "old", status: "active", product: { metadata: { happier_kind: "lite" } } }];
            })
            .mockResolvedValue([{ id: "new", status: "active", product: { metadata: { happier_kind: "plus" } } }]);
        const polar: PolarClient = { listSubscriptionsForRef, listOrdersForRef: async () => [] };
        const deps = { polar, env: CLOUD_ENV };
        const first = reconcileBillingForRef(accountId, deps);
        const second = reconcileBillingForRef(accountId, deps);
        await new Promise<void>(resolve => setImmediate(resolve));
        const readsWhileHeld = listSubscriptionsForRef.mock.calls.length;
        release();
        await Promise.all([first, second]);
        expect(readsWhileHeld).toBe(1);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { plan: true } })).toEqual({ plan: "plus" });
    });

    it("rejects an unsigned delivery before any provider read, and an outage writes nothing", async () => {
        const polar = createFakePolar();
        const app = await buildApp(CLOUD_ENV, polar.fetchImpl);
        const { accountId } = await createAccountWithSessions(0);
        await db.account.update({ where: { id: accountId }, data: { plan: "plus", planSource: "polar", planEndsAt: new Date(Date.now() + 10 * DAY_MS), planRenews: true } });
        const body = JSON.stringify({ type: "order.paid", data: { metadata: { reference_id: accountId } } });

        const forged = await app.inject({ method: "POST", url: "/v1/billing/polar", headers: { ...signedWebhookHeaders(body), "webhook-signature": "v1,AAAA" }, payload: body });
        expect(forged.statusCode).toBe(403);
        expect(polar.state.calls).toBe(0);

        polar.state.failing = true;
        const outage = await app.inject({ method: "POST", url: "/v1/billing/polar", headers: signedWebhookHeaders(body), payload: body });
        expect(outage.statusCode).toBe(502);
        const refresh = await app.inject({ method: "POST", url: "/v1/billing/refresh", headers: { "x-test-user-id": accountId } });
        expect(refresh.statusCode).toBe(502);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { plan: true, planRenews: true } })).toEqual({ plan: "plus", planRenews: true });
        await app.close();
    });

    it("a refund ends Plus into grace and revokes Supporter until a paid purchase restores the same number", async () => {
        const polar = createFakePolar();
        const app = await buildApp(CLOUD_ENV, polar.fetchImpl);
        const { accountId } = await createAccountWithSessions(0);
        const sub = subscription(accountId, "plus");
        const paid = order(accountId, "plus", "paid");
        polar.state.subscriptions.push(sub);
        polar.state.orders.push(paid);
        const refresh = async () => (await app.inject({ method: "POST", url: "/v1/billing/refresh", headers: { "x-test-user-id": accountId } })).statusCode;
        const readPlan = async () => AccountPlanResponseV1Schema.parse((await app.inject({ method: "GET", url: "/v1/account/plan", headers: { "x-test-user-id": accountId } })).json());

        expect(await refresh()).toBe(200);
        const ring = await app.inject({ method: "PUT", url: "/v1/account/supporter/ring", headers: { "x-test-user-id": accountId }, payload: { visible: true } });
        expect(ring.statusCode).toBe(200);
        const number = (await readPlan()).supporter.number;

        Object.assign(sub, { status: "canceled", ended_at: new Date().toISOString() });
        Object.assign(paid, { status: "refunded" });
        expect(await refresh()).toBe(200);
        const refunded = await readPlan();
        expect(refunded.plan).toMatchObject({ id: "plus", renews: false });
        expect(refunded.plan?.graceEndsAt).toBeGreaterThan(Date.now());
        expect(refunded.supporter).toEqual({ active: false, since: null, number: null, recurringSince: null });
        expect(refunded.supporterRing).toBe(false);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { plan: true } })).toEqual({ plan: "plus" });

        polar.state.subscriptions.length = 0;
        polar.state.orders.length = 0;
        expect(await refresh()).toBe(200);
        expect((await readPlan()).supporter).toEqual(refunded.supporter);

        polar.state.orders.push(order(accountId, "supporter", "paid"));
        expect(await refresh()).toBe(200);
        expect((await readPlan()).supporter).toMatchObject({ active: true, number });
        await app.close();
    });

    it("the highest live plan wins, and a lapse without a live source keeps a manual grant untouched", async () => {
        const polar = createFakePolar();
        const app = await buildApp(CLOUD_ENV, polar.fetchImpl);
        const { accountId } = await createAccountWithSessions(0);
        polar.state.subscriptions.push(subscription(accountId, "lite"), subscription(accountId, "plus", { cancel_at_period_end: true }));
        await app.inject({ method: "POST", url: "/v1/billing/refresh", headers: { "x-test-user-id": accountId } });
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { plan: true, planRenews: true } })).toEqual({ plan: "plus", planRenews: false });

        const manual = await createAccountWithSessions(0);
        await db.account.update({ where: { id: manual.accountId }, data: { plan: "plus", planSource: "manual", planEndsAt: null } });
        await app.inject({ method: "POST", url: "/v1/billing/refresh", headers: { "x-test-user-id": manual.accountId } });
        expect(await db.account.findUniqueOrThrow({ where: { id: manual.accountId }, select: { plan: true, planSource: true, planEndsAt: true } }))
            .toEqual({ plan: "plus", planSource: "manual", planEndsAt: null });
        await app.close();
    });

    it("a cross-server Supporter gets a number, and a gift grants neither a ring nor billing access", async () => {
        const polar = createFakePolar();
        const app = await buildApp(CLOUD_ENV, polar.fetchImpl);
        const code = "abcdefabcdefabcdefabcdefabcdef01";
        polar.state.orders.push(order(code, "supporter", "paid"));
        const body = JSON.stringify({ type: "order.paid", data: { metadata: { reference_id: code } } });
        expect((await app.inject({ method: "POST", url: "/v1/billing/polar", headers: signedWebhookHeaders(body), payload: body })).statusCode).toBe(200);

        const lookup = await app.inject({ method: "POST", url: "/v1/supporter/lookup", payload: { code } });
        expect(lookup.statusCode).toBe(200);
        expect(lookup.json()).toMatchObject({ kind: "supporter_once", recurringActive: false, revokedAt: null });
        expect(typeof lookup.json().number).toBe("number");
        expect((await app.inject({ method: "POST", url: "/v1/supporter/lookup", payload: { code: "00000000000000000000000000000000" } })).statusCode).toBe(404);

        const victim = await createAccountWithSessions(0);
        polar.state.orders.push(order(victim.accountId, "supporter", "paid"));
        const gift = JSON.stringify({ type: "order.paid", data: { metadata: { reference_id: victim.accountId } } });
        await app.inject({ method: "POST", url: "/v1/billing/polar", headers: signedWebhookHeaders(gift), payload: gift });
        expect(await db.account.findUniqueOrThrow({ where: { id: victim.accountId }, select: { supporterRing: true } })).toEqual({ supporterRing: false });
        const headers = { "x-test-user-id": victim.accountId };
        expect((await app.inject({ method: "PUT", url: "/v1/account/supporter", headers, payload: { code } })).statusCode).toBe(403);

        const providerCalls = polar.state.calls;
        expect((await app.inject({ method: "POST", url: "/v1/billing/portal", headers })).statusCode).toBe(404);
        const plan = AccountPlanResponseV1Schema.parse((await app.inject({ method: "GET", url: "/v1/account/plan", headers })).json());
        expect(plan.offers?.portalUrl).toBe(PUBLIC_PORTAL_URL);
        expect(polar.state.calls).toBe(providerCalls);
        await app.close();
    });

    it("a self-hosted server registers no billing route, calls out to nobody and stores its own supporter record", async () => {
        const polar = createFakePolar();
        const app = await buildApp(BASE_ENV, polar.fetchImpl);
        const { accountId } = await createAccountWithSessions(0);
        const headers = { "x-test-user-id": accountId };
        expect((await app.inject({ method: "POST", url: "/v1/billing/refresh", headers })).statusCode).toBe(404);
        expect((await app.inject({ method: "POST", url: "/v1/supporter/lookup", payload: { code: "abcdefabcdefabcdefabcdefabcdef02" } })).statusCode).toBe(404);

        const code = "abcdefabcdefabcdefabcdefabcdef02";
        const pending = await app.inject({ method: "PUT", url: "/v1/account/supporter", headers, payload: { code } });
        expect(AccountSupporterResponseV1Schema.parse(pending.json()).record).toMatchObject({ code, number: null });
        const settled = await app.inject({
            method: "PUT", url: "/v1/account/supporter", headers,
            payload: { code, facts: { number: 42, kind: "supporter_once", grantedAt: Date.now(), recurringActive: false, revokedAt: null } },
        });
        expect(settled.statusCode).toBe(200);
        const plan = AccountPlanResponseV1Schema.parse((await app.inject({ method: "GET", url: "/v1/account/plan", headers })).json());
        expect(plan.supporter).toMatchObject({ active: true, number: 42 });
        expect(JSON.stringify(plan)).not.toContain(code);
        expect(polar.state.calls).toBe(0);
        await app.close();
    });
});
