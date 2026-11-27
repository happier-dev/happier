import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createTeamInvitationForActorInTx } from "@/app/teams/invitations/invitationService";
import { admitTeamMemberInTx } from "@/app/teams/memberships/membershipService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { billingRoutes } from "./registerBillingRoutes";

const productId = "34c6bbff-168b-45a7-a383-d9a54ea1cdad";
const signingKey = Buffer.from("team-polar-webhook-signing-key");

describe("Team seats and checkout (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-billing-", initAuth: false });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it("keeps Team billing closed when Plans is off or signed activation is unavailable", async () => {
        const team = await db.team.create({ data: { name: "Unavailable billing" } });
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const env = {
            POLAR_ACCESS_TOKEN: "polar_oat_team_fixture",
            HAPPIER_PLANS__CONFIG: JSON.stringify({
                v: 1, graceDays: 90, plans: [], supporter: null,
                teams: { freeSeats: 3, limitsFromPlanId: "plus", polarProductId: productId, seatPrices: [] },
            }),
        };
        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ url: "https://buy.polar.sh/team-fixture" }));
        for (const [overrides, expected] of [
            [{ HAPPIER_FEATURE_PLANS__ENABLED: "false" }, 503],
            [{ HAPPIER_FEATURE_PLANS__ENABLED: "true" }, 409],
        ] as const) {
            const app = createAuthenticatedTestApp();
            billingRoutes(app, { env: { ...env, ...overrides }, fetchImpl });
            try {
                const response = await app.inject({
                    method: "POST", url: `/v1/teams/${team.id}/billing/checkout`, headers: { "x-test-user-id": owner.id },
                });
                expect(response.statusCode).toBe(expected);
            } finally {
                await app.close();
            }
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reconciles the committed census once after a multi-member transaction", async () => {
        const periodEnd = new Date(Date.now() + 30 * 86_400_000);
        const team = await db.team.create({ data: { name: "Seat census", paidSeats: 4, planEndsAt: periodEnd } });
        const account = () => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const [owner, first, second] = await Promise.all([account(), account(), account()]);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const listOrPatch = vi.fn<typeof fetch>(async (_url, init) => {
            if (init?.method === "PATCH") {
                expect(JSON.parse(String(init.body))).toEqual({ units: 3 });
                return Response.json({ units: 3 });
            }
            return Response.json({
                items: [{ id: "team-subscription", product_id: productId, status: "active", units: 4,
                    current_period_end: periodEnd.toISOString(), metadata: { team_id: team.id },
                    product: { metadata: { happier_kind: "team" } } }],
                pagination: { total_count: 1, max_page: 1 },
            });
        });
        vi.stubEnv("POLAR_ACCESS_TOKEN", "polar_oat_team_fixture");
        vi.stubEnv("HAPPIER_PLANS__CONFIG", JSON.stringify({
            v: 1, graceDays: 90, plans: [], supporter: null,
            teams: { freeSeats: 3, limitsFromPlanId: "plus", polarProductId: productId, seatPrices: [] },
        }));
        vi.stubGlobal("fetch", listOrPatch);
        const admit = (tx: Parameters<typeof admitTeamMemberInTx>[0], accountId: string) =>
            admitTeamMemberInTx(tx, { teamId: team.id, accountId, role: "member", historyAccess: "from_membership" });
        try {
            await inTx(async tx => {
                expect(await admit(tx, first.id)).toMatchObject({ outcome: "added" });
                expect(await admit(tx, second.id)).toMatchObject({ outcome: "added" });
                expect(listOrPatch).not.toHaveBeenCalled();
            });
            await vi.waitFor(async () => {
                await expect(db.team.findUniqueOrThrow({ where: { id: team.id } })).resolves.toMatchObject({ paidSeats: 3 });
            });
            expect(listOrPatch).toHaveBeenCalledTimes(2);
        } finally {
            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        }
    });

    it("refuses a reserved seat until the owner buys it and a verified webhook reconciles the Team", async () => {
        const team = await db.team.create({ data: { name: "Team billing" } });
        const account = () => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const [owner, teammate] = await Promise.all([account(), account()]);
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: teammate.id, role: "member" },
        ] });

        const app = createAuthenticatedTestApp();
        const env = {
            POLAR_ACCESS_TOKEN: "polar_oat_team_fixture",
            POLAR_WEBHOOK_SECRET: `whsec_${signingKey.toString("base64")}`,
            HAPPIER_PLANS__CONFIG: JSON.stringify({
                v: 1, graceDays: 90, plans: [], supporter: null,
                teams: {
                    freeSeats: 3, limitsFromPlanId: "plus", polarProductId: productId,
                    seatPrices: [{ interval: "month", amountMinor: 1000, currency: "usd" }],
                },
            }),
        };
        const periodEnd = new Date(Date.now() + 30 * 86_400_000);
        let units = 0;
        const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            expect(new Headers(init?.headers).get("Polar-Version")).toBe("2026-10");
            if (url.pathname === "/v1/checkouts/" && init?.method === "POST") {
                expect(JSON.parse(String(init.body))).toMatchObject({
                    products: [productId], units: 4, metadata: { team_id: team.id },
                });
                return Response.json({ url: "https://buy.polar.sh/team-fixture" });
            }
            if (url.pathname === "/v1/subscriptions/" && url.searchParams.get("metadata[team_id]") === team.id) {
                const items = units === 0 ? [] : [{
                    id: "team-subscription", product_id: productId, status: "active", units,
                    current_period_end: periodEnd.toISOString(),
                    product: { metadata: { happier_kind: "team" } },
                    metadata: { team_id: team.id },
                }];
                return Response.json({ items, pagination: { total_count: items.length, max_page: 1 } });
            }
            if (url.pathname === "/v1/subscriptions/team-subscription" && init?.method === "PATCH") {
                units = JSON.parse(String(init.body)).units;
                return Response.json({ units });
            }
            return new Response(null, { status: 404 });
        });
        Object.entries(env).forEach(([key, value]) => vi.stubEnv(key, value));
        billingRoutes(app, { env: process.env, fetchImpl });
        try {
            const seats = (accountId: string) => app.inject({
                method: "POST", url: "/v1/teams/billing/seats",
                headers: { "x-test-user-id": accountId },
                payload: { v: 1, teamId: team.id },
            });
            expect((await seats(teammate.id)).statusCode).toBe(403);
            const initial = await seats(owner.id);
            expect(initial.statusCode).toBe(200);
            expect(initial.json()).toMatchObject({
                freeSeats: 3, paidSeats: 0, checkoutAvailable: true,
                members: expect.arrayContaining([{ accountId: owner.id, profile: expect.anything() }]),
            });
            const createInvite = (requestKey: string) => inTx(tx => createTeamInvitationForActorInTx(tx, {
                teamId: team.id, actorAccountId: owner.id, role: "member", historyAccess: "from_membership",
                recipientEmailNormalized: null, emailDeliveryAvailable: true, requestKey,
            }));
            await expect(createInvite(randomUUID())).resolves.toMatchObject({ ok: true });
            const requestKey = randomUUID();
            await expect(createInvite(requestKey)).resolves.toEqual({
                ok: false, error: "team_seats_required", details: { current: 3, free: 3 },
            });

            const url = `/v1/teams/${team.id}/billing/checkout`;
            const checkout = (accountId: string) => app.inject({ method: "POST", url, headers: { "x-test-user-id": accountId } });
            expect((await checkout(teammate.id)).statusCode).toBe(403);
            expect(fetchImpl).not.toHaveBeenCalled();
            const created = await checkout(owner.id);
            expect(created.statusCode).toBe(200);
            expect(created.json()).toEqual({ url: "https://buy.polar.sh/team-fixture" });

            units = 4;
            const body = JSON.stringify({ type: "subscription.updated", data: { metadata: { team_id: team.id } } });
            const webhookId = randomUUID();
            const stamp = String(Math.floor(Date.now() / 1000));
            const signature = createHmac("sha256", signingKey).update(`${webhookId}.${stamp}.${body}`).digest("base64");
            const deliver = () => app.inject({
                method: "POST", url: "/v1/billing/polar", payload: body,
                headers: { "content-type": "application/json", "webhook-id": webhookId, "webhook-timestamp": stamp, "webhook-signature": `v1,${signature}` },
            });
            expect((await deliver()).statusCode).toBe(200);
            await expect(db.team.findUniqueOrThrow({ where: { id: team.id } })).resolves.toMatchObject({ paidSeats: 2, planEndsAt: periodEnd });
            expect((await seats(owner.id)).json()).toMatchObject({ paidSeats: 2, checkoutAvailable: false });
            await expect(createInvite(requestKey)).resolves.toMatchObject({ ok: true });
            const patches = () => fetchImpl.mock.calls.filter(([, init]) => init?.method === "PATCH").length;
            expect(patches()).toBe(1);
            expect((await deliver()).statusCode).toBe(200);
            expect(patches()).toBe(1);
        } finally {
            await app.close();
            vi.unstubAllEnvs();
        }
    });
});
