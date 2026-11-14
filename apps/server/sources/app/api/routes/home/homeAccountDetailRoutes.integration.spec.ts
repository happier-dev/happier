import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { db } from "@/storage/db";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { homeGovernanceRoutes } from "./homeGovernanceRoutes";

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
        data: { publicKey: `pk_home_account_detail_${sequence}`, encryptionMode: "plain", homeRole, username: `person${sequence}` },
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
        tempDirPrefix: "happier-home-account-detail-",
        initAuth: true,
        initEncrypt: true,
        initFiles: true,
    });
}, 120_000);
afterAll(async () => await harness.close());
afterEach(async () => {
    await closeTrackedApps();
    await db.homeAdministrationEvent.deleteMany({});
    await db.teamMembership.deleteMany({});
    await db.team.deleteMany({});
    await db.machine.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home account detail (home.accounts.get)", () => {
    it("projects the canonical profile management authority and restriction independently of Account lifecycle", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const person = await createAccount("member", "suspended");
        await db.accountPublicProfile.create({ data: {
            accountId: person.accountId, removedAt: new Date(), removalReason: "Reviewed report",
        } });

        const allowed = await post(app, "/v1/home/accounts/get", admin.token, { accountId: person.accountId });
        expect(allowed.statusCode, allowed.body).toBe(200);
        expect(allowed.json().publicProfile).toEqual({
            managementCapability: { status: "available" }, restricted: true,
        });
        const denied = await post(app, "/v1/home/accounts/get", admin.token, { accountId: owner.accountId });
        expect(denied.json().publicProfile).toEqual({
            managementCapability: { status: "unavailable", reason: "not_authorized" }, restricted: false,
        });
        const ownerView = await post(app, "/v1/home/accounts/get", owner.token, { accountId: owner.accountId });
        expect(ownerView.json().publicProfile).toEqual({
            managementCapability: { status: "available" }, restricted: false,
        });
    });

    it("answers an administrator with Teams, counts, linked providers and events about the person, and refuses a member", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const person = await createAccount("member");
        const other = await createAccount("member");

        const platform = await db.team.create({ data: { name: "Platform" } });
        const design = await db.team.create({ data: { name: "Design", archivedAt: new Date() } });
        const unrelated = await db.team.create({ data: { name: "Unrelated" } });
        await db.teamMembership.create({ data: { teamId: platform.id, accountId: person.accountId, role: "member" } });
        await db.teamMembership.create({ data: { teamId: design.id, accountId: person.accountId, role: "admin", status: "suspended" } });
        await db.teamMembership.create({ data: { teamId: unrelated.id, accountId: other.accountId, role: "owner" } });

        await db.machine.create({ data: { id: `m-${sequence}-a`, accountId: person.accountId, metadata: "sealed" } });
        await db.machine.create({ data: { id: `m-${sequence}-b`, accountId: person.accountId, metadata: "sealed" } });
        await db.machine.create({ data: { id: `m-${sequence}-c`, accountId: other.accountId, metadata: "sealed" } });
        const lastUsedAt = new Date("2026-09-20T10:00:00.000Z");
        await db.accountApiToken.create({ data: {
            id: `tok-${sequence}`, accountId: person.accountId, displayPrefix: "hpat_secretprefix", secretDigest: "digest",
            label: storedPlainPrivateLabel("private label"), lastUsedAt,
        } });
        await db.accountIdentity.create({ data: {
            accountId: person.accountId, provider: "github", providerUserId: "gh-private-user-id-42", providerLogin: "chloe", profile: {},
        } });
        await db.accountIdentity.create({ data: {
            accountId: person.accountId, provider: "email", providerUserId: "chloe@example.test", profile: {},
        } });

        // One event about this person and one about somebody else.
        expect((await post(app, "/v1/home/accounts/role/set", owner.token, { accountId: person.accountId, homeRole: "admin" })).statusCode).toBe(200);
        expect((await post(app, "/v1/home/accounts/role/set", owner.token, { accountId: person.accountId, homeRole: "member" })).statusCode).toBe(200);
        expect((await post(app, "/v1/home/accounts/role/set", owner.token, { accountId: other.accountId, homeRole: "admin" })).statusCode).toBe(200);

        const response = await post(app, "/v1/home/accounts/get", admin.token, { accountId: person.accountId });
        expect(response.statusCode, response.body).toBe(200);
        const detail = response.json();
        expect(detail.accountId).toBe(person.accountId);
        expect(detail.homeRole).toBe("member");
        expect(detail.authentication.linkedProviderIds).toEqual(["github"]);
        expect(detail.authentication.signInEmail).toBe("chloe@example.test");
        expect(detail.teams).toEqual(expect.arrayContaining([
            { teamId: platform.id, name: "Platform", role: "member", status: "active", archived: false },
            { teamId: design.id, name: "Design", role: "admin", status: "suspended", archived: true },
        ]));
        expect(detail.teams).toHaveLength(2);
        // Team administration authorizes names and roles only: no Groups, no Session facts.
        for (const team of detail.teams) expect(Object.keys(team).sort()).toEqual(["archived", "name", "role", "status", "teamId"]);
        expect(detail.machines).toEqual({ count: 2 });
        expect(detail.apiTokens).toEqual({ count: 1, lastUsedAt: lastUsedAt.getTime() });
        expect(detail.recentEvents.map((event: { action: string; target: { id: string } }) => [event.action, event.target.id])).toEqual([
            ["account.role.set", person.accountId],
            ["account.role.set", person.accountId],
        ]);
        expect(detail.recentEvents[0].summary).toEqual({ from: "admin", to: "member" });
        // Never a token label or prefix, never the provider's user id.
        expect(response.body).not.toMatch(/private label|hpat_secretprefix|gh-private-user-id-42|digest/);

        // `other` was made an admin above; a plain member is refused.
        const bystander = await createAccount("member");
        const memberView = await post(app, "/v1/home/accounts/get", bystander.token, { accountId: person.accountId });
        expect(memberView.statusCode).toBe(403);
        expect(memberView.json()).toEqual({ error: "home_governance_forbidden" });

        const missing = await post(app, "/v1/home/accounts/get", admin.token, { accountId: "no-such-account" });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: "home_account_not_found" });
    });

    it("keeps last-owner protection on every ownership-reducing action while sign-out stays available", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");

        const response = await post(app, "/v1/home/accounts/get", owner.token, { accountId: owner.accountId });
        expect(response.statusCode, response.body).toBe(200);
        const capabilities = response.json().mutationCapabilities;
        expect(capabilities.setRole.member).toEqual({ status: "unavailable", reason: "last_active_owner" });
        expect(capabilities.setRole.admin).toEqual({ status: "unavailable", reason: "last_active_owner" });
        expect(capabilities.disable).toEqual({ status: "unavailable", reason: "last_active_owner" });
        expect(capabilities.delete).toEqual({ status: "unavailable", reason: "last_active_owner" });
        expect(capabilities.signOutEverywhere).toEqual({ status: "available" });

        // The server refuses the demotion itself, not only the projection.
        const demote = await post(app, "/v1/home/accounts/role/set", owner.token, { accountId: owner.accountId, homeRole: "member" });
        expect(demote.statusCode).toBe(409);
        expect(demote.json()).toEqual({ error: "home_owner_transfer_required" });

        const second = await createAccount("owner");
        const withTwo = await post(app, "/v1/home/accounts/get", owner.token, { accountId: second.accountId });
        expect(withTwo.json().mutationCapabilities.setRole.member).toEqual({ status: "available" });
        expect(withTwo.json().mutationCapabilities.disable).toEqual({ status: "available" });
    });
});

describe("Admin sign out everywhere (home.accounts.signOutEverywhere)", () => {
    it("ends the person's signed sessions, keeps their API tokens and records who did it", async () => {
        const app = createTestApp();
        await createAccount("owner");
        const admin = await createAccount("admin");
        const person = await createAccount("member");
        await db.accountApiToken.create({ data: {
            id: `tok-signout-${sequence}`, accountId: person.accountId, displayPrefix: "hpat_x", secretDigest: "digest", label: storedPlainPrivateLabel("ci"),
        } });
        const before = await db.account.findUniqueOrThrow({ where: { id: person.accountId }, select: { tokenEpoch: true } });
        expect((await post(app, "/v1/home/accounts/get", person.token, { accountId: person.accountId })).statusCode).toBe(403);

        const response = await post(app, "/v1/home/accounts/sign-out-everywhere", admin.token, { accountId: person.accountId });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().accountId).toBe(person.accountId);
        expect(response.json().status).toBe("active");

        const after = await db.account.findUniqueOrThrow({ where: { id: person.accountId }, select: { tokenEpoch: true } });
        expect(after.tokenEpoch).toBe(before.tokenEpoch + 1);
        expect(await db.accountApiToken.count({ where: { accountId: person.accountId } })).toBe(1);
        // The person's previous signed session is refused on its next request.
        const stale = await post(app, "/v1/home/accounts/get", person.token, { accountId: person.accountId });
        expect(stale.statusCode).toBe(401);

        const events = await db.homeAdministrationEvent.findMany({ where: { targetId: person.accountId } });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ action: "account.sign_out_everywhere", actorKind: "account", actorAccountId: admin.accountId });
    });

    it("refuses an inactive person, a member actor, and an administrator acting on an owner", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");
        const suspended = await createAccount("member", "suspended");

        const inactive = await post(app, "/v1/home/accounts/sign-out-everywhere", admin.token, { accountId: suspended.accountId });
        expect(inactive.statusCode).toBe(409);
        expect(inactive.json()).toEqual({ error: "home_account_inactive" });
        const detail = await post(app, "/v1/home/accounts/get", admin.token, { accountId: suspended.accountId });
        expect(detail.json().mutationCapabilities.signOutEverywhere).toEqual({ status: "unavailable", reason: "target_not_active" });

        const byMember = await post(app, "/v1/home/accounts/sign-out-everywhere", member.token, { accountId: admin.accountId });
        expect(byMember.statusCode).toBe(403);

        const adminOnOwner = await post(app, "/v1/home/accounts/sign-out-everywhere", admin.token, { accountId: owner.accountId });
        expect(adminOnOwner.statusCode).toBe(403);
        const ownerDetail = await post(app, "/v1/home/accounts/get", admin.token, { accountId: owner.accountId });
        expect(ownerDetail.json().mutationCapabilities.signOutEverywhere).toEqual({ status: "unavailable", reason: "not_authorized" });

        expect(await db.homeAdministrationEvent.count({ where: { action: "account.sign_out_everywhere" } })).toBe(0);
    });
});
