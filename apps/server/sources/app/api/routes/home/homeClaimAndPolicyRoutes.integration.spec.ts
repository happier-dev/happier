import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AUTHORITY_CEILING_HEADER_V1 } from "@happier-dev/protocol/actions/invocationAuthority";

import { auth } from "@/app/auth/auth";
import { mintHomeClaimCode } from "@/app/home/governance/homeClaimCode";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { homeGovernanceRoutes } from "./homeGovernanceRoutes";

/**
 * The HTTP seams of U4/U5 (plan `2026-09-26-home-owner-console`): a claim refusal is one status and
 * body whatever the cause, and a widening policy patch without confirmation is a typed 409.
 */
const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    homeGovernanceRoutes(typed);
    return trackApp(typed);
}

let harness: LightSqliteHarness;
let sequence = 0;

async function createAccount(
    homeRole: "owner" | "admin" | "member",
    status: "active" | "suspended" = "active",
): Promise<Readonly<{ accountId: string; token: string }>> {
    sequence += 1;
    const account = await db.account.create({
        data: { publicKey: `pk_home_claim_routes_${sequence}`, encryptionMode: "plain", homeRole, status: "active" },
        select: { id: true },
    });
    const token = await auth.createToken(account.id, undefined, {
        kind: "account",
        authority: "present_user",
        authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
    });
    if (status !== "active") await db.account.update({ where: { id: account.id }, data: { status } });
    return { accountId: account.id, token };
}

async function post(app: ReturnType<typeof createTestApp>, url: string, token: string, payload: unknown) {
    return await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-claim-routes-",
        initAuth: true,
        initEncrypt: true,
        initFiles: false,
    });
}, 120_000);
afterAll(async () => await harness.close());
afterEach(async () => {
    await closeTrackedApps();
    await db.simpleCache.deleteMany({});
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
    await db.accountChange.deleteMany({});
    await db.account.deleteMany({});
});

describe("home.governance.claim", () => {
    it("answers every refusal with the same status and body, and claims with a valid code", async () => {
        const app = createTestApp();
        const claimant = await createAccount("member");

        const noCode = await post(app, "/v1/home/governance/claim", claimant.token, { code: "A".repeat(52) });
        const invalidBody = await post(app, "/v1/home/governance/claim", claimant.token, { code: "" });
        const minted = await mintHomeClaimCode();
        if (minted.status !== "minted") throw new Error("expected a code");
        const wrong = await post(app, "/v1/home/governance/claim", claimant.token, { code: "B".repeat(52) });

        for (const response of [noCode, invalidBody, wrong]) {
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "home_claim_refused" });
        }

        const claimed = await post(app, "/v1/home/governance/claim", claimant.token, { code: minted.code });
        expect(claimed.statusCode).toBe(200);
        expect(claimed.json()).toEqual({ status: "claimed" });
        await expect(db.account.findUniqueOrThrow({ where: { id: claimant.accountId }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "owner" });

        const replay = await post(app, "/v1/home/governance/claim", claimant.token, { code: minted.code });
        expect(replay.statusCode).toBe(403);
        expect(replay.json()).toEqual({ error: "home_claim_refused" });
    });

    it("refuses a valid code once the Home has an owner, identically", async () => {
        const app = createTestApp();
        const minted = await mintHomeClaimCode();
        if (minted.status !== "minted") throw new Error("expected a code");
        await createAccount("owner");
        const other = await createAccount("member");

        const response = await post(app, "/v1/home/governance/claim", other.token, { code: minted.code });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "home_claim_refused" });
        await expect(db.account.count({ where: { homeRole: "owner" } })).resolves.toBe(1);
    });
});

describe("home.policy.set widening", () => {
    it("refuses an unconfirmed widening with a typed 409 and applies it once confirmed", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");

        const narrowed = await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0,
            authenticationPolicy: { v: 1, admission: "invitation_only" },
        });
        expect(narrowed.statusCode).toBe(200);

        const unconfirmed = await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 1,
            authenticationPolicy: { v: 1, admission: "self_service" },
        });
        expect(unconfirmed.statusCode).toBe(409);
        expect(unconfirmed.json()).toEqual({ error: "home_policy_widening_unconfirmed" });

        // An Agent or other automation caller cannot author the person's confirmation:
        // the operand counts only under present-user authority (approved replays run as the person).
        const automation = await app.inject({
            method: "POST",
            url: "/v1/home/policy/set",
            headers: { authorization: `Bearer ${owner.token}`, [AUTHORITY_CEILING_HEADER_V1]: "account_automation" },
            payload: {
                expectedRevision: 1,
                confirmWidening: true,
                authenticationPolicy: { v: 1, admission: "self_service" },
            },
        });
        expect(automation.statusCode).toBe(409);
        expect(automation.json()).toEqual({ error: "home_policy_widening_unconfirmed" });
        // Nothing was written: the person's confirmation below still applies at revision 1.

        const confirmed = await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 1,
            confirmWidening: true,
            authenticationPolicy: { v: 1, admission: "self_service" },
        });
        expect(confirmed.statusCode).toBe(200);
        expect(confirmed.json()).toMatchObject({ revision: 2 });

        // Narrowing needs no confirmation and keeps working for automation callers.
        const automationNarrowed = await app.inject({
            method: "POST",
            url: "/v1/home/policy/set",
            headers: { authorization: `Bearer ${owner.token}`, [AUTHORITY_CEILING_HEADER_V1]: "account_automation" },
            payload: { expectedRevision: 2, authenticationPolicy: { v: 1, admission: "invitation_only" } },
        });
        expect(automationNarrowed.statusCode).toBe(200);
        expect(automationNarrowed.json()).toMatchObject({ revision: 3 });
    });
});
