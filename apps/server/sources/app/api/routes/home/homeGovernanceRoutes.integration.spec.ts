import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HomeAccountListResultV1Schema } from "@happier-dev/protocol/home/governance";

import { auth } from "@/app/auth/auth";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { homeGovernanceRoutes } from "./homeGovernanceRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp(authenticatedAccountId?: string) {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    if (authenticatedAccountId === undefined) {
        enableAuthentication(typed);
    } else {
        // Credential verification is the transport boundary. Pin its principal
        // to exercise the route's own membership decision, including a principal
        // whose Account disappeared or was suspended after authentication.
        typed.decorate("authenticate", async (request: { userId: string }) => {
            request.userId = authenticatedAccountId;
        });
    }
    homeGovernanceRoutes(typed);
    return trackApp(typed);
}

let harness: LightSqliteHarness;
let sequence = 0;

/**
 * Accounts are always created active and minted a credential first, because an
 * inactive Account cannot mint one — that is the lifecycle contract itself. A
 * requested non-active status is then applied, exactly as an administrator or a
 * lifecycle transition would leave it.
 */
async function createAccount(
    homeRole: "owner" | "admin" | "member",
    status: "active" | "suspended" | "disabled" = "active",
): Promise<Readonly<{ accountId: string; token: string }>> {
    sequence += 1;
    const account = await db.account.create({
        data: { publicKey: `pk_home_governance_${sequence}`, encryptionMode: "plain", homeRole },
        select: { id: true },
    });
    const token = await auth.createToken(account.id, undefined, {
        kind: "account",
        authority: "present_user",
        authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
    });
    if (status !== "active") {
        await db.account.update({ where: { id: account.id }, data: { status } });
    }
    return { accountId: account.id, token };
}

async function post(
    app: ReturnType<typeof createTestApp>,
    url: string,
    token: string,
    payload?: unknown,
) {
    return await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload }),
    });
}

async function installPasswordOnlyLogin(accountId: string): Promise<void> {
    sequence += 1;
    await db.account.update({ where: { id: accountId }, data: { publicKey: null } });
    await db.accountIdentity.create({ data: {
        accountId,
        provider: "email",
        providerUserId: `password-only-${sequence}@example.test`,
        profile: {},
    } });
    await db.accountPasswordCredential.create({ data: {
        accountId,
        credential: { v: 1, kind: "plain_password_hash", hash: "test-only" },
    } });
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-governance-routes-",
        initAuth: true,
        initEncrypt: true,
        initFiles: true,
    });
}, 120_000);
afterAll(async () => await harness.close());
afterEach(async () => {
    await closeTrackedApps();
    await db.homeGovernancePolicy.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home governance routes", () => {
    it("returns the typed Machine-default refusal through the Home policy route", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        await createAccount("member");
        const machine = await db.machine.create({ data: {
            id: `home-default-${++sequence}`, accountId: owner.accountId, metadata: "{}",
        } });
        try {
            const response = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                sessionDefaults: { placement: { kind: "machine", target: { serverId: "home-a", machineId: machine.id } } },
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "managed_default_machine_not_member_usable" });
            expect(await db.homeGovernancePolicy.count()).toBe(0);
        } finally {
            await db.machine.delete({ where: { id: machine.id } });
        }
    });

    it("serves only Session defaults to an authenticated active Home member", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        const defaults = { permissionModeByAgentTargetKey: { "agent:example.agent/example": "read-only" } };
        const written = await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0, sessionDefaults: defaults,
        });
        expect(written.statusCode, written.body).toBe(200);
        for (const token of [member.token, owner.token]) {
            const response = await post(app, "/v1/home/governance/get", token, { projection: "session_defaults" });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ homeDefaults: defaults });
            expect(response.json()).not.toHaveProperty("policy");
            expect(response.json()).not.toHaveProperty("capabilities");
        }
        const adminRead = await post(app, "/v1/home/governance/get", member.token, {});
        expect(adminRead.statusCode).toBe(403);
        expect(adminRead.json()).toEqual({ error: "home_governance_forbidden" });
    });

    it("refuses the Session defaults projection when the authenticated principal is missing or suspended", async () => {
        const suspended = await createAccount("member", "suspended");
        for (const accountId of ["not-a-home-member", suspended.accountId]) {
            const app = createTestApp(accountId);
            const response = await post(app, "/v1/home/governance/get", "transport-principal", { projection: "session_defaults" });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "home_governance_forbidden" });
        }
    });

    it("returns the exact Home account total on every page, including inactive people", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        await createAccount("member");
        await createAccount("admin", "suspended");
        await createAccount("member", "disabled");

        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
            const response = await post(app, "/v1/home/accounts/list", owner.token, { limit: 1, cursor });
            expect(response.statusCode, response.body).toBe(200);
            const page = response.json();
            expect(page.total).toBe(4);
            expect(HomeAccountListResultV1Schema.safeParse(page).success).toBe(true);
            seen.add(page.items[0].accountId);
            cursor = page.nextCursor;
        } while (cursor);
        expect(seen.size).toBe(4);
    });

    it("answers whether an owner's Home has any sessions, other people or Teams", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const read = async () => await post(app, "/v1/home/emptiness/get", owner.token, {});

        expect((await read()).json()).toEqual({ isEmpty: true });

        const session = await db.session.create({ data: {
            accountId: owner.accountId,
            tag: crypto.randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
        } });
        expect((await read()).json()).toEqual({ isEmpty: false });
        await db.session.delete({ where: { id: session.id } });

        const member = await createAccount("member");
        expect((await read()).json()).toEqual({ isEmpty: false });
        const memberRead = await post(app, "/v1/home/emptiness/get", member.token, {});
        expect(memberRead.statusCode).toBe(403);
        await db.account.delete({ where: { id: member.accountId } });

        const team = await db.team.create({ data: { name: "Still here" } });
        expect((await read()).json()).toEqual({ isEmpty: false });
        await db.team.delete({ where: { id: team.id } });

        expect((await read()).json()).toEqual({ isEmpty: true });
    });

    it("reports owner setup without disclosing the administrative projection", async () => {
        const app = createTestApp();
        const first = await createAccount("member");
        await createAccount("member");

        const response = await post(app, "/v1/home/governance/get", first.token, {});

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "home_governance_setup_required" });
        expect(JSON.stringify(response.json())).not.toMatch(/policy|provider|network|ownerCount|authentication/i);
    });

    it("denies the administrative projection to a member and exposes only minimum eligibility", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        const memberView = await post(app, "/v1/home/governance/get", member.token, {});
        expect(memberView.statusCode).toBe(403);
        expect(memberView.json()).toEqual({ error: "home_governance_forbidden" });

        const eligibility = await post(app, "/v1/home/governance/eligibility/get", member.token, {});
        expect(eligibility.statusCode).toBe(200);
        expect(eligibility.json()).toMatchObject({ teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false });
        // Only the creation class, the administrators' names and this viewer's Teams visibility
        // join the three effective facts; no other policy, provider, network or roster fact does.
        expect(Object.keys(eligibility.json()).sort()).toEqual([
            "administratorNames",
            "createTeam",
            "createTeamForChosenAccount",
            "showTeams",
            "teamCreationPolicy",
            "teamsEnabled",
        ]);
        expect(JSON.stringify(eligibility.json())).not.toMatch(/provider|network|revision|role|authentication/i);
        const crossHomeBody = await post(app, "/v1/home/governance/eligibility/get", member.token, {
            serverId: "another-home",
        });
        expect(crossHomeBody.statusCode, crossHomeBody.body).toBe(400);

        const ownerView = await post(app, "/v1/home/governance/get", owner.token, {});
        expect(ownerView.json()).toMatchObject({
            capabilities: {
                viewAdministration: true,
                manageAccounts: true,
                manageHomeRoles: true,
                manageAuthentication: true,
                eraseAccounts: true,
            },
        });
        expect((await post(app, "/v1/home/governance/get", owner.token, {
            includePolicySecrets: true,
        })).statusCode).toBe(400);
    });

    it("does not let a terminal credential bypass Home erase authority by targeting itself", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        const terminalToken = await auth.createToken(member.accountId, undefined, {
            kind: "terminal",
            authority: "account_automation",
        });

        const response = await post(app, "/v1/home/accounts/delete", terminalToken, { accountId: member.accountId });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "home_governance_forbidden" });
        expect(await db.account.findUniqueOrThrow({ where: { id: member.accountId }, select: { status: true } }))
            .toEqual({ status: "active" });
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.accountId }, select: { status: true } }))
            .toEqual({ status: "active" });
    });

    it("answers malformed governance mutations with the one strict Home error envelope", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        const cases = [
            ["/v1/home/governance/get", { unexpected: true }],
            ["/v1/home/governance/eligibility/get", { unexpected: true }],
            ["/v1/home/accounts/list", { unexpected: true }],
            ["/v1/home/accounts/search", { query: member.accountId, scope: { kind: "home" }, unexpected: true }],
            ["/v1/home/accounts/role/set", { accountId: member.accountId, homeRole: "admin", unknown: true }],
            ["/v1/home/accounts/disable", { accountId: member.accountId, unexpected: true }],
            ["/v1/home/accounts/enable", { accountId: member.accountId, unexpected: true }],
            ["/v1/home/accounts/delete", { accountId: member.accountId, unexpected: true }],
            ["/v1/home/policy/set", { expectedRevision: 0, unexpected: true }],
        ] as const;

        for (const [url, payload] of cases) {
            const response = await post(app, url, owner.token, payload);
            expect(response.statusCode, `${url}: ${response.body}`).toBe(400);
            expect(response.json()).toEqual({ error: "invalid_home_input" });
        }
    });

    it("uses the resolved Teams gate in Home projections", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previousDeny = process.env.HAPPIER_BUILD_FEATURES_DENY;
        process.env.HAPPIER_BUILD_FEATURES_DENY = "teams";
        try {
            const response = await post(app, "/v1/home/governance/get", owner.token, {});
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                capabilities: { createTeam: false },
                teamsEnabled: false,
            });
        } finally {
            if (previousDeny === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
            else process.env.HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it("lists Accounts only for an administrator and pages by a stable keyset", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        await db.account.update({
            where: { id: owner.accountId },
            data: { encryptionMode: "e2ee" },
        });
        // This assertion exercises a real key-challenge-capable Account. The
        // generic governance fixture is Plain, where public-key presence must
        // not be reinterpreted as E2EE login capability.
        await db.account.update({ where: { id: owner.accountId }, data: { encryptionMode: "e2ee" } });

        expect((await post(app, "/v1/home/accounts/list", member.token, {})).statusCode).toBe(403);

        const first = await post(app, "/v1/home/accounts/list", owner.token, { limit: 1 });
        expect(first.statusCode).toBe(200);
        expect(first.json().items).toHaveLength(1);
        expect(first.json().nextCursor).toEqual(expect.any(String));

        const second = await post(app, "/v1/home/accounts/list", owner.token, {
            limit: 1,
            cursor: first.json().nextCursor,
        });
        const seen = [first.json().items[0].accountId, second.json().items[0].accountId];
        expect(new Set(seen)).toEqual(new Set([owner.accountId, member.accountId]));
        expect(second.json().nextCursor).toBeNull();
        expect(Object.keys(first.json()).sort()).toEqual(["items", "nextCursor", "total"]);
        const invalidCursor = await post(app, "/v1/home/accounts/list", owner.token, {
            limit: 1,
            cursor: "not-a-home-account-cursor",
        });
        expect(invalidCursor.statusCode).toBe(400);
        expect(invalidCursor.json()).toEqual({ error: "invalid_home_cursor" });
        const rows = [first.json().items[0], second.json().items[0]];
        expect(rows.find((row) => row.accountId === owner.accountId)?.authentication).toEqual({
            signInEmail: null,
            usableMethodIds: ["key_challenge"],
        });
        expect(rows.find((row) => row.accountId === owner.accountId)?.mutationCapabilities).toMatchObject({
            setRole: {
                member: { status: "unavailable", reason: "last_active_owner" },
                admin: { status: "unavailable", reason: "last_active_owner" },
            },
            disable: { status: "unavailable", reason: "last_active_owner" },
            delete: { status: "unavailable", reason: "last_active_owner" },
        });
        expect(rows.find((row) => row.accountId === member.accountId)?.mutationCapabilities).toMatchObject({
            setRole: {
                member: { status: "unavailable", reason: "unchanged" },
                admin: { status: "available" },
                owner: { status: "available" },
            },
            disable: { status: "available" },
            reenable: { status: "unavailable", reason: "target_not_suspended" },
            delete: { status: "available" },
        });
    });

    it("projects the native sign-in mailbox and effective usable methods only to Home administrators", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        const previous = {
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
        };
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        try {
            await installPasswordOnlyLogin(member.accountId);
            await db.accountEmail.create({ data: {
                accountId: member.accountId,
                address: "additional-mailbox@example.test",
                normalizedEmail: "additional-mailbox@example.test",
            } });

            const denied = await post(app, "/v1/home/accounts/list", member.token, {});
            expect(denied.statusCode).toBe(403);

            const response = await post(app, "/v1/home/accounts/list", owner.token, {});
            expect(response.statusCode, response.body).toBe(200);
            const row = response.json().items.find((item: { accountId: string }) =>
                item.accountId === member.accountId);
            expect(row.authentication).toEqual({
                signInEmail: expect.stringMatching(/^password-only-\d+@example\.test$/),
                usableMethodIds: ["email_password"],
            });

            const picker = await post(app, "/v1/home/accounts/search", owner.token, {
                query: member.accountId,
                scope: { kind: "home" },
            });
            expect(picker.statusCode).toBe(200);
            expect(picker.json().accounts[0]).not.toHaveProperty("authentication");
        } finally {
            if (previous.emailPassword === undefined) {
                delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            } else {
                process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            }
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
        }
    });

    it("refuses owner transitions to an admin and protects the last active owner", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");

        // An admin administers ordinary Accounts but may never touch ownership.
        const adminPromotes = await post(app, "/v1/home/accounts/role/set", admin.token, {
            accountId: member.accountId,
            homeRole: "owner",
        });
        expect(adminPromotes.statusCode).toBe(403);
        expect(adminPromotes.json()).toEqual({ error: "home_governance_forbidden" });

        // The Home's only active owner cannot demote themselves.
        const selfDemotion = await post(app, "/v1/home/accounts/role/set", owner.token, {
            accountId: owner.accountId,
            homeRole: "admin",
        });
        expect(selfDemotion.statusCode).toBe(409);
        expect(selfDemotion.json()).toEqual({ error: "home_owner_transfer_required" });

        // With a second owner in place a complete self-demotion is allowed,
        // and the committed row is still returned even though the actor no
        // longer has administrative projection authority afterward.
        expect((await post(app, "/v1/home/accounts/role/set", owner.token, {
            accountId: member.accountId,
            homeRole: "owner",
        })).json()).toMatchObject({ accountId: member.accountId, homeRole: "owner" });
        const completedSelfDemotion = await post(app, "/v1/home/accounts/role/set", owner.token, {
            accountId: owner.accountId,
            homeRole: "member",
        });
        expect(completedSelfDemotion.statusCode, completedSelfDemotion.body).toBe(200);
        expect(completedSelfDemotion.json()).toMatchObject({ accountId: owner.accountId, homeRole: "member" });
    });

    it("projects owner-target restrictions and Team erasure conflicts for the exact viewer", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const target = await createAccount("member");
        const worker = await createAccount("member");
        const team = await db.team.create({ data: { name: "Needs an owner" } });
        await db.teamMembership.createMany({
            data: [
                { teamId: team.id, accountId: target.accountId, role: "owner" },
                { teamId: team.id, accountId: worker.accountId, role: "member" },
            ],
        });

        const adminList = await post(app, "/v1/home/accounts/list", admin.token, { limit: 100 });
        expect(adminList.statusCode).toBe(200);
        const ownerForAdmin = adminList.json().items.find(
            (row: { accountId: string }) => row.accountId === owner.accountId,
        );
        expect(ownerForAdmin.mutationCapabilities).toMatchObject({
            setRole: {
                member: { status: "unavailable", reason: "not_authorized" },
                admin: { status: "unavailable", reason: "not_authorized" },
                owner: { status: "unavailable", reason: "not_authorized" },
            },
            disable: { status: "unavailable", reason: "not_authorized" },
            reenable: { status: "unavailable", reason: "not_authorized" },
            delete: { status: "unavailable", reason: "not_authorized" },
        });

        const ownerList = await post(app, "/v1/home/accounts/list", owner.token, { limit: 100 });
        expect(ownerList.statusCode).toBe(200);
        const targetForOwner = ownerList.json().items.find(
            (row: { accountId: string }) => row.accountId === target.accountId,
        );
        expect(targetForOwner.mutationCapabilities.delete).toEqual({
            status: "unavailable",
            reason: "team_owner_transfer_required",
        });
    });

    it("refuses to give Home authority to an Account that is not active", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const suspended = await createAccount("member", "suspended");

        const promotion = await post(app, "/v1/home/accounts/role/set", owner.token, {
            accountId: suspended.accountId,
            homeRole: "admin",
        });
        expect(promotion.statusCode).toBe(409);
        expect(promotion.json()).toEqual({ error: "home_account_inactive" });
    });

    it("disables and re-enables an ordinary Account and revokes its credentials", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");
        const memberPat = await auth.createApiToken({ accountId: member.accountId, tokenId: crypto.randomUUID(), label: "Before disable" });

        const disabled = await post(app, "/v1/home/accounts/disable", admin.token, {
            accountId: member.accountId,
        });
        expect(disabled.statusCode).toBe(200);
        expect(disabled.json()).toMatchObject({ accountId: member.accountId, status: "suspended" });
        await expect(auth.verifyPat(memberPat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });

        // Re-enable restores nothing but the ability to sign in again.
        expect((await post(app, "/v1/home/accounts/enable", admin.token, {
            accountId: member.accountId,
        })).json()).toMatchObject({ status: "active" });
        await expect(auth.verifyPat(memberPat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });

        // Administering an owner Account at all is owner authority.
        expect((await post(app, "/v1/home/accounts/disable", admin.token, {
            accountId: owner.accountId,
        })).statusCode).toBe(403);

        // A non-final administrator may disable themselves. The committed
        // result must not turn into a false not-found merely because this
        // transaction has just removed the actor's projection authority.
        const selfDisablingAdmin = await createAccount("admin");
        const disabledSelf = await post(app, "/v1/home/accounts/disable", selfDisablingAdmin.token, {
            accountId: selfDisablingAdmin.accountId,
        });
        expect(disabledSelf.statusCode, disabledSelf.body).toBe(200);
        expect(disabledSelf.json()).toMatchObject({
            accountId: selfDisablingAdmin.accountId,
            status: "suspended",
        });
        await expect(auth.verifyToken(selfDisablingAdmin.token)).resolves.toBeNull();
    });

    it("deletes an Account only for an owner and reports the target as gone on retry", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");

        expect((await post(app, "/v1/home/accounts/delete", admin.token, {
            accountId: member.accountId,
        })).statusCode).toBe(403);

        const deleted = await post(app, "/v1/home/accounts/delete", owner.token, {
            accountId: member.accountId,
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ status: "deleted" });
        expect(await db.account.findUnique({ where: { id: member.accountId } })).toBeNull();

        // A retry of a finished deletion is the outcome the owner asked for.
        expect((await post(app, "/v1/home/accounts/delete", owner.token, {
            accountId: member.accountId,
        })).json()).toEqual({ status: "deleted" });
    });

    it("reports the deployment's identity-service ceiling without disclosing its configuration", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");

        const withoutServices = (await post(app, "/v1/home/governance/get", owner.token, {})).json();
        expect(withoutServices.identityServices).toMatchObject({
            workos: "not_configured",
            privateIdentityNetworkAllowed: false,
        });
        // The Team-provider ceiling an inherited Home resolves to excludes what the
        // deployment cannot run.
        expect(withoutServices.identityServices.teamProviderKinds).not.toContain("workos_sso");
        expect(JSON.stringify(withoutServices)).not.toContain("wos_test_key");

        process.env.WORKOS_API_KEY = "wos_test_key";
        process.env.WORKOS_CLIENT_ID = "client_test";
        process.env.HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED = "true";
        try {
            const withServices = (await post(app, "/v1/home/governance/get", owner.token, {})).json();
            expect(withServices.identityServices).toMatchObject({
                workos: "configured",
                privateIdentityNetworkAllowed: true,
            });
            expect(withServices.identityServices.teamProviderKinds).toContain("workos_sso");
            expect(JSON.stringify(withServices)).not.toContain("wos_test_key");

            delete process.env.WORKOS_CLIENT_ID;
            expect((await post(app, "/v1/home/governance/get", owner.token, {})).json().identityServices)
                .toMatchObject({ workos: "partially_configured" });
        } finally {
            delete process.env.WORKOS_API_KEY;
            delete process.env.WORKOS_CLIENT_ID;
            delete process.env.HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED;
        }
    });

    it("lists the deployment's own OIDC providers by name only, as read-only facts", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        expect((await post(app, "/v1/home/governance/get", owner.token, {})).json().identityServices.deploymentOidcProviders)
            .toEqual([]);

        const previous = process.env.AUTH_PROVIDERS_CONFIG_JSON;
        process.env.AUTH_PROVIDERS_CONFIG_JSON = JSON.stringify([{
            id: "acme-sso",
            type: "oidc",
            displayName: "Acme SSO",
            issuer: "https://sso.acme.example",
            clientId: "acme-client",
            clientSecret: "acme-deployment-secret",
            redirectUrl: "https://home.example.test/v1/oauth/acme-sso/callback",
        }]);
        try {
            const projection = (await post(app, "/v1/home/governance/get", owner.token, {})).json();
            expect(projection.identityServices.deploymentOidcProviders).toEqual([
                { id: "acme-sso", displayName: "Acme SSO", sourceKey: "AUTH_PROVIDERS_CONFIG_JSON" },
            ]);
            expect(JSON.stringify(projection)).not.toContain("acme-deployment-secret");
            expect(JSON.stringify(projection)).not.toContain("sso.acme.example");
        } finally {
            if (previous === undefined) delete process.env.AUTH_PROVIDERS_CONFIG_JSON;
            else process.env.AUTH_PROVIDERS_CONFIG_JSON = previous;
        }
    });

    it("projects bounded deployment authentication options without service endpoints", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            mode: process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE,
            url: process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_URL,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE = "external";
        process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_URL = "https://sign-in.secret.example";
        try {
            const response = await post(app, "/v1/home/governance/get", owner.token, {});
            expect(response.statusCode).toBe(200);
            expect(response.json().authenticationOptions).toMatchObject({
                // Native email/password is on by default, so a deployment that
                // sets no `HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__*` key still
                // projects it; the endpoint-leak assertion below is the subject.
                methods: expect.arrayContaining([
                    expect.objectContaining({ id: "key_challenge" }),
                    expect.objectContaining({ id: "email_password" }),
                    // A method this deployment cannot run is listed with why (§3.4 bound 2), not hidden:
                    // mTLS needs trusted proxy headers the deployment does not set.
                    expect.objectContaining({ id: "mtls", unavailable: { requires: [] } }),
                ]),
                permittedAccountModes: ["e2ee"],
                recommendedProvisioningMode: "e2ee",
                signInService: { deploymentMode: "external", canDisable: true },
            });
            expect(JSON.stringify(response.json().authenticationOptions)).not.toContain("sign-in.secret.example");
        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.mode === undefined) delete process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE;
            else process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE = previous.mode;
            if (previous.url === undefined) delete process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_URL;
            else process.env.HAPPIER_AUTH_SIGN_IN_SERVICE_URL = previous.url;
        }
    });

    it("projects persisted Home method availability from the canonical effective decision", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        try {
            await db.homeGovernancePolicy.create({
                data: {
                    id: HOME_GOVERNANCE_POLICY_ID,
                    revision: 1,
                    teamCreationPolicy: "self_service",
                    authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
                },
            });

            const response = await post(app, "/v1/home/governance/get", owner.token, {});

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().authenticationOptions.methods).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: "key_challenge",
                    actions: expect.arrayContaining([
                        { id: "login", enabled: false, mode: "keyed", reason: "method_not_enabled" },
                    ]),
                }),
                expect.objectContaining({
                    id: "email_password",
                    actions: expect.arrayContaining([
                        expect.objectContaining({ id: "login", enabled: true }),
                    ]),
                }),
            ]));
        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.emailPassword === undefined) delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
        }
    });

    it("applies a policy patch under compare-and-set and refuses a stale editor", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");

        const applied = await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0,
            teamCreationPolicy: "self_service",
        });
        expect(applied.statusCode).toBe(200);
        expect(applied.json()).toMatchObject({ revision: 1, teamCreationPolicy: "self_service" });

        const stale = await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0,
            teamCreationPolicy: "disabled",
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "home_policy_revision_conflict" });

        // Team creation is admin authority; the authentication ceiling is not.
        expect((await post(app, "/v1/home/policy/set", admin.token, {
            expectedRevision: 1,
            teamCreationPolicy: "managed_only",
        })).statusCode).toBe(200);
        expect((await post(app, "/v1/home/policy/set", admin.token, {
            expectedRevision: 2,
            authenticationPolicy: { v: 1, admission: "invitation_only" },
        })).statusCode).toBe(403);
    });

    it("rejects prospectively unusable authentication policy without committing it", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
            smtpHost: process.env.HAPPIER_AUTH_EMAIL_SMTP_HOST,
            emailFromAddress: process.env.HAPPIER_AUTH_EMAIL_FROM_ADDRESS,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";
        delete process.env.HAPPIER_AUTH_EMAIL_SMTP_HOST;
        delete process.env.HAPPIER_AUTH_EMAIL_FROM_ADDRESS;
        try {
            const seqBeforeInvalidSaves = (await db.account.findUniqueOrThrow({
                where: { id: owner.accountId },
                select: { seq: true },
            })).seq;
            for (const authenticationPolicy of [
                { v: 1, enabledMethodIds: ["unknown-method"] },
                // Genuinely unusable: this deployment has no forwarded-mTLS
                // gate, so narrowing to `mtls` alone leaves no enabled login
                // action for any existing Account and no provision route at
                // all. Narrowing to `email_password` is deliberately *not*
                // here: its login stays usable for the Accounts that already
                // exist even when the deployment permits only E2EE
                // construction, which the case below commits.
                { v: 1, enabledMethodIds: ["mtls"] },
                { v: 1, permittedAccountModes: ["plain"] },
                {
                    v: 1,
                    permittedAccountModes: ["plain", "e2ee"],
                    recommendedProvisioningMode: "plain",
                },
            ]) {
                const response = await post(app, "/v1/home/policy/set", owner.token, {
                    expectedRevision: 0,
                    authenticationPolicy,
                });
                expect(response.statusCode, JSON.stringify(authenticationPolicy)).toBe(400);
                expect(response.json()).toEqual({ error: "home_policy_invalid" });
                await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
            }
            await expect(db.account.findUniqueOrThrow({
                where: { id: owner.accountId },
                select: { seq: true },
            })).resolves.toEqual({ seq: seqBeforeInvalidSaves });

            const validNarrowing = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            });
            expect(validNarrowing.statusCode).toBe(200);
            expect(validNarrowing.json()).toMatchObject({
                revision: 1,
                authentication: { status: "narrowed", enabledMethodIds: ["key_challenge"] },
            });

        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.emailPassword === undefined) delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
            if (previous.smtpHost === undefined) delete process.env.HAPPIER_AUTH_EMAIL_SMTP_HOST;
            else process.env.HAPPIER_AUTH_EMAIL_SMTP_HOST = previous.smtpHost;
            if (previous.emailFromAddress === undefined) delete process.env.HAPPIER_AUTH_EMAIL_FROM_ADDRESS;
            else process.env.HAPPIER_AUTH_EMAIL_FROM_ADDRESS = previous.emailFromAddress;
        }
    });

    it("rejects deployment-viable narrowing that strands the last active Home administrator", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        try {
            await installPasswordOnlyLogin(owner.accountId);

            const response = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "home_policy_invalid" });
            await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.emailPassword === undefined) delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
        }
    });

    it("rejects narrowing that strands a password-only member while the owner remains viable", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        try {
            await installPasswordOnlyLogin(member.accountId);

            const response = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "home_policy_invalid" });
            await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.emailPassword === undefined) delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
        }
    });

    it("keeps an existing Plain password login usable when the deployment permits only E2EE construction", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";
        try {
            await installPasswordOnlyLogin(owner.accountId);

            // Account-mode narrowing decides which Accounts may be
            // *constructed*; an Account that already exists keeps its stored
            // mode and its password login. So this Plain owner still holds a
            // current email/password route even though the deployment now
            // constructs E2EE Accounts only, and removing email/password
            // strands it.
            const stranding = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            });
            expect(stranding.statusCode, stranding.body).toBe(400);
            expect(stranding.json()).toEqual({ error: "home_policy_invalid" });
            await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);

            const retained = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
            });
            expect(retained.statusCode, retained.body).toBe(200);
            expect(retained.json()).toMatchObject({
                revision: 1,
                authentication: { status: "narrowed", enabledMethodIds: ["email_password"] },
            });
        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.emailPassword === undefined) delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
        }
    });

    it("allows a repair policy when the active owner is already stranded by the current policy", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const previous = {
            keyChallenge: process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED,
            emailPassword: process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED,
            keyless: process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED,
            storage: process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
        };
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = "1";
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = "1";
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        try {
            await installPasswordOnlyLogin(owner.accountId);
            await db.homeGovernancePolicy.create({
                data: {
                    id: HOME_GOVERNANCE_POLICY_ID,
                    revision: 1,
                    teamCreationPolicy: "managed_only",
                    authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
                },
            });

            const response = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 1,
                // Repairing restores a sign-in route, which widens: the owner confirms it (§3.4).
                confirmWidening: true,
                authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                revision: 2,
                authentication: { status: "narrowed", enabledMethodIds: ["email_password"] },
            });
        } finally {
            if (previous.keyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous.keyChallenge;
            if (previous.emailPassword === undefined) delete process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED = previous.emailPassword;
            if (previous.keyless === undefined) delete process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED;
            else process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = previous.keyless;
            if (previous.storage === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
            else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previous.storage;
        }
    });

    it("allows ordinary narrowing when every viable active Account retains key challenge", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        await db.account.updateMany({
            where: { id: { in: [owner.accountId, member.accountId] } },
            data: { encryptionMode: "e2ee" },
        });
        const previous = process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        try {
            const response = await post(app, "/v1/home/policy/set", owner.token, {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                revision: 1,
                authentication: { status: "narrowed", enabledMethodIds: ["key_challenge"] },
            });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previous;
        }
    });

    it("wakes every active Account when policy changes minimum eligibility", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");
        const before = await db.account.findMany({
            where: { id: { in: [owner.accountId, admin.accountId, member.accountId] } },
            select: { id: true, seq: true },
        });

        expect((await post(app, "/v1/home/policy/set", admin.token, {
            expectedRevision: 0,
            teamCreationPolicy: "self_service",
        })).statusCode).toBe(200);

        const after = await db.account.findMany({
            where: { id: { in: [owner.accountId, admin.accountId, member.accountId] } },
            select: { id: true, seq: true },
        });
        const beforeById = new Map(before.map((account) => [account.id, account.seq]));
        for (const account of after) {
            expect(account.seq).toBe(beforeById.get(account.id)! + 1);
        }
    });

    it("keeps another Account's administration-only Home role patch from advancing a member revision", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");
        const before = await db.account.findUniqueOrThrow({ where: { id: member.accountId }, select: { seq: true } });

        // Every current Home policy field affects Session admission. Home role
        // administration supplies the negative control without inventing a field.
        const response = await post(app, "/v1/home/accounts/role/set", owner.token, {
            accountId: admin.accountId, homeRole: "owner",
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ accountId: admin.accountId, homeRole: "owner" });
        expect(await db.account.findUniqueOrThrow({ where: { id: member.accountId }, select: { seq: true } }))
            .toEqual(before);
    });

    it("advances member revisions for network policy admission changes (c4df8d48698)", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");
        const before = await db.account.findMany({
            where: { id: { in: [owner.accountId, admin.accountId, member.accountId] } },
            select: { id: true, seq: true },
        });

        expect((await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0,
            identityNetworkPolicy: { v: 1, mode: "public_only" },
        })).statusCode).toBe(200);

        const after = await db.account.findMany({
            where: { id: { in: [owner.accountId, admin.accountId, member.accountId] } },
            select: { id: true, seq: true },
        });
        const beforeById = new Map(before.map((account) => [account.id, account.seq]));
        expect(after.find((account) => account.id === owner.accountId)?.seq)
            .toBe(beforeById.get(owner.accountId)! + 1);
        expect(after.find((account) => account.id === admin.accountId)?.seq)
            .toBe(beforeById.get(admin.accountId)! + 1);
        expect(after.find((account) => account.id === member.accountId)?.seq)
            .toBe(beforeById.get(member.accountId)! + 1);
    });

    it("tells an admitted member how Teams are created here and who administers them, by name only", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const unnamedAdmin = await createAccount("admin");
        const disabledAdmin = await createAccount("admin", "disabled");
        const member = await createAccount("member");
        await db.account.update({ where: { id: owner.accountId }, data: { name: "Ada Lovelace" } });
        await db.account.update({ where: { id: admin.accountId }, data: { username: "grace" } });
        await db.account.update({ where: { id: disabledAdmin.accountId }, data: { name: "Former" } });
        await db.account.update({ where: { id: member.accountId }, data: { name: "Mia" } });

        const response = await post(app, "/v1/home/governance/eligibility/get", member.token, {});

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            teamsEnabled: true,
            createTeam: false,
            createTeamForChosenAccount: false,
            teamCreationPolicy: "managed_only",
            // Active owners first, then administrators; an unnamed or inactive one is not named.
            administratorNames: ["Ada Lovelace", "grace"],
            showTeams: true,
        });
        const body = response.body;
        for (const accountId of [owner.accountId, admin.accountId, unnamedAdmin.accountId, disabledAdmin.accountId]) {
            expect(body).not.toContain(accountId);
        }
        expect(body).not.toContain("Former");
    });

    it("gives an Account that is not admitted to this Home neither the policy class nor any name", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        await db.account.update({ where: { id: owner.accountId }, data: { firstName: "Ada" } });
        const suspended = await createAccount("member", "suspended");
        const erased = await createAccount("member");
        await db.account.delete({ where: { id: erased.accountId } });

        for (const token of [suspended.token, erased.token]) {
            const response = await post(app, "/v1/home/governance/eligibility/get", token, {});
            expect(response.body).not.toMatch(/Ada|managed_only|teamCreationPolicy|administratorNames/);
        }
    });

    it("shows Teams to members by default and hides it only from members outside every Team once turned off", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");
        const teamMember = await createAccount("member");
        const team = await db.team.create({ data: { name: "Visible to its members" }, select: { id: true } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: teamMember.accountId, role: "member" } });
        const showTeams = async (token: string) =>
            (await post(app, "/v1/home/governance/eligibility/get", token, {})).json().showTeams;

        // A Home that never stored the policy shows Teams to everyone.
        expect(await showTeams(member.token)).toBe(true);
        expect((await post(app, "/v1/home/governance/get", owner.token, {})).json())
            .toMatchObject({ policy: { teamsVisibleToMembers: true } });

        // Only a Home administrator may turn it off.
        expect((await post(app, "/v1/home/policy/set", member.token, {
            expectedRevision: 0,
            teamsVisibleToMembers: false,
        })).statusCode).toBe(403);
        const turnedOff = await post(app, "/v1/home/policy/set", admin.token, {
            expectedRevision: 0,
            teamsVisibleToMembers: false,
        });
        expect(turnedOff.statusCode, turnedOff.body).toBe(200);
        expect(turnedOff.json()).toMatchObject({ revision: 1, teamsVisibleToMembers: false, teamCreationPolicy: "managed_only" });

        expect(await showTeams(member.token)).toBe(false);
        expect(await showTeams(teamMember.token)).toBe(true);
        expect(await showTeams(admin.token)).toBe(true);
        expect(await showTeams(owner.token)).toBe(true);

        // With creation disabled, only an Account that belongs to a Team keeps the destination.
        expect((await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 1,
            teamsVisibleToMembers: true,
            teamCreationPolicy: "disabled",
        })).statusCode).toBe(200);
        expect(await showTeams(member.token)).toBe(false);
        expect(await showTeams(admin.token)).toBe(false);
        expect(await showTeams(teamMember.token)).toBe(true);
    });

    it("wakes every active Account when Teams visibility changes", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");
        const before = await db.account.findMany({
            where: { id: { in: [owner.accountId, member.accountId] } },
            select: { id: true, seq: true },
        });

        expect((await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0,
            teamsVisibleToMembers: false,
        })).statusCode).toBe(200);

        const after = await db.account.findMany({
            where: { id: { in: [owner.accountId, member.accountId] } },
            select: { id: true, seq: true },
        });
        const beforeById = new Map(before.map((account) => [account.id, account.seq]));
        for (const account of after) {
            expect(account.seq).toBe(beforeById.get(account.id)! + 1);
        }
    });

    it("narrows Team creation through the effective capability the policy decides", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        expect((await post(app, "/v1/home/governance/eligibility/get", member.token, {})).json())
            .toMatchObject({ teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false });
        // Under the default managed creation an administrator creates Teams for a chosen
        // Account, so the plain self-service form would be refused.
        expect((await post(app, "/v1/home/governance/eligibility/get", owner.token, {})).json())
            .toMatchObject({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: true });

        await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 0,
            teamCreationPolicy: "self_service",
        });
        expect((await post(app, "/v1/home/governance/eligibility/get", member.token, {})).json())
            .toMatchObject({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false });
        expect((await post(app, "/v1/home/governance/eligibility/get", owner.token, {})).json())
            .toMatchObject({ teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false });

        await post(app, "/v1/home/policy/set", owner.token, {
            expectedRevision: 1,
            teamCreationPolicy: "disabled",
        });
        expect((await post(app, "/v1/home/governance/get", owner.token, {})).json())
            .toMatchObject({ capabilities: { createTeam: false, manageAllTeams: true } });
    });

    it("keeps Home-scoped Account lookup behind manageAccounts and answers an exact Account id", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        expect((await post(app, "/v1/home/accounts/search", member.token, {
            query: owner.accountId,
            scope: { kind: "home" },
        })).statusCode).toBe(403);

        const exact = await post(app, "/v1/home/accounts/search", owner.token, {
            query: member.accountId,
            scope: { kind: "home" },
        });
        expect(exact.statusCode).toBe(200);
        expect(exact.json()).toEqual({
            accounts: [{
                accountId: member.accountId,
                profile: { name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
                eligible: true,
            }],
        });

        // An Account id is only ever matched whole: a partial id is neither an
        // identifier nor a username prefix, so it finds nothing.
        expect((await post(app, "/v1/home/accounts/search", owner.token, {
            query: member.accountId.slice(0, 6),
            scope: { kind: "home" },
        })).json()).toEqual({ accounts: [] });
        expect((await post(app, "/v1/home/accounts/search", owner.token, {
            query: "nobody-here",
            scope: { kind: "home" },
        })).json()).toEqual({ accounts: [] });
    });

    it("finds every Account holding the exact verified mailbox, however the address is typed", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const ada = await createAccount("member");
        const adaAgain = await createAccount("member");
        const other = await createAccount("member");
        await db.accountEmail.create({ data: {
            accountId: ada.accountId, address: "Ada@example.test", normalizedEmail: "ada@example.test",
        } });
        await db.accountEmail.create({ data: {
            accountId: adaAgain.accountId, address: "ada@example.test", normalizedEmail: "ada@example.test",
        } });
        await db.accountEmail.create({ data: {
            accountId: other.accountId, address: "ada.other@example.test", normalizedEmail: "ada.other@example.test",
        } });

        const found = await post(app, "/v1/home/accounts/search", owner.token, {
            query: "  ADA@Example.TEST ",
            scope: { kind: "home" },
        });
        expect(found.statusCode).toBe(200);
        expect(found.json().accounts.map((row: { accountId: string }) => row.accountId).sort())
            .toEqual([ada.accountId, adaAgain.accountId].sort());

        // A mailbox is matched exactly: a prefix of one is not evidence of ownership.
        expect((await post(app, "/v1/home/accounts/search", owner.token, {
            query: "ada@example",
            scope: { kind: "home" },
        })).json()).toEqual({ accounts: [] });
    });

    it("finds Accounts by username prefix, case-insensitively, bounded to one page", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const graces: string[] = [];
        for (let index = 0; index < 51; index += 1) {
            sequence += 1;
            const created = await db.account.create({
                data: {
                    publicKey: `pk_home_governance_${sequence}`,
                    encryptionMode: "plain",
                    homeRole: "member",
                    username: `Grace${String(index).padStart(2, "0")}`,
                },
                select: { id: true },
            });
            graces.push(created.id);
        }
        sequence += 1;
        await db.account.create({ data: {
            publicKey: `pk_home_governance_${sequence}`, encryptionMode: "plain", homeRole: "member", username: "Gary",
        } });

        const page = await post(app, "/v1/home/accounts/search", owner.token, {
            query: "grace",
            scope: { kind: "home" },
        });
        expect(page.statusCode).toBe(200);
        const ids = page.json().accounts.map((row: { accountId: string }) => row.accountId);
        expect(ids).toHaveLength(50);
        expect(new Set(ids).size).toBe(50);
        expect(ids.every((id: string) => graces.includes(id))).toBe(true);

        expect((await post(app, "/v1/home/accounts/search", owner.token, {
            query: "GRACE0",
            scope: { kind: "home" },
        })).json().accounts).toHaveLength(10);
    });

    it("answers a username prefix in Home scope but never in Team scope", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const manager = await createAccount("member");
        const newcomer = await createAccount("member");
        await db.account.update({ where: { id: newcomer.accountId }, data: { username: "priya" } });
        await db.accountEmail.create({ data: {
            accountId: newcomer.accountId, address: "Priya@acme.test", normalizedEmail: "priya@acme.test",
        } });
        const team = await db.team.create({ data: { name: "Exact only" }, select: { id: true } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.accountId, role: "admin" } });

        // Home scope keeps the prefix arm: `manageAccounts` already pages the
        // entire roster through `home.accounts.list`, so exact-only there would
        // protect nothing and only degrade the administrator's picker.
        expect((await post(app, "/v1/home/accounts/search", owner.token, {
            query: "priy",
            scope: { kind: "home" },
        })).json().accounts).toEqual([expect.objectContaining({ accountId: newcomer.accountId })]);

        // Team scope resolves exact identifiers only, so the same prefix finds
        // nobody — and neither does a prefix of the verified mailbox.
        const teamScope = { kind: "team", teamId: team.id } as const;
        expect((await post(app, "/v1/home/accounts/search", manager.token, {
            query: "priy",
            scope: teamScope,
        })).json()).toEqual({ accounts: [] });
        expect((await post(app, "/v1/home/accounts/search", manager.token, {
            query: "priya@acme",
            scope: teamScope,
        })).json()).toEqual({ accounts: [] });

        // The two exact identifiers the Team picker is built on still answer.
        for (const query of [newcomer.accountId, " PRIYA@Acme.test "]) {
            const found = await post(app, "/v1/home/accounts/search", manager.token, { query, scope: teamScope });
            expect(found.statusCode, found.body).toBe(200);
            expect(found.json().accounts).toEqual([
                expect.objectContaining({ accountId: newcomer.accountId, eligible: true }),
            ]);
        }
    });

    it("shows a disabled Account as found but ineligible instead of hiding it", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const disabled = await createAccount("member", "disabled");
        await db.account.update({ where: { id: disabled.accountId }, data: { username: "dormant" } });

        const found = await post(app, "/v1/home/accounts/search", owner.token, {
            query: "dorm",
            scope: { kind: "home" },
        });
        expect(found.json()).toEqual({
            accounts: [{
                accountId: disabled.accountId,
                profile: { name: null, firstName: null, lastName: null, username: "dormant", avatarUrl: null },
                eligible: false,
            }],
        });
    });

    it("answers a Team-scoped search only to that Team's managers and marks existing members ineligible", async () => {
        const app = createTestApp();
        const manager = await createAccount("member");
        const existing = await createAccount("member");
        const newcomer = await createAccount("member");
        const team = await db.team.create({ data: { name: "Acme" }, select: { id: true } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.accountId, role: "admin" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: existing.accountId, role: "member" } });
        await db.accountEmail.create({ data: {
            accountId: existing.accountId, address: "grace@acme.test", normalizedEmail: "grace@acme.test",
        } });
        await db.accountEmail.create({ data: {
            accountId: newcomer.accountId, address: "grace@acme.test", normalizedEmail: "grace@acme.test",
        } });

        // An ordinary Team member manages nobody, so the Team scope is refused to them.
        expect((await post(app, "/v1/home/accounts/search", existing.token, {
            query: "grace@acme.test",
            scope: { kind: "team", teamId: team.id },
        })).statusCode).toBe(403);

        const found = await post(app, "/v1/home/accounts/search", manager.token, {
            query: "grace@acme.test",
            scope: { kind: "team", teamId: team.id },
        });
        expect(found.statusCode).toBe(200);
        expect(found.json().accounts).toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: existing.accountId, eligible: false }),
            expect.objectContaining({ accountId: newcomer.accountId, eligible: true }),
        ]));
        expect(found.json().accounts).toHaveLength(2);
    });

    it("qualifies the Team-scoped search against that Team's restricted policy", async () => {
        const app = createTestApp();
        const previousKeyChallenge = process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
        // The accepted method has to be one this Home currently offers,
        // otherwise every credential is unavailable rather than unqualified and
        // the two legs below would prove nothing about qualification.
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        try {
            const owner = await createAccount("owner");
            const manager = await createAccount("member");
            // `key_challenge` is a keyed login route, so only a key-bearing
            // Account can currently prove it — the same fixture fact the Team
            // directory suite relies on.
            await db.account.update({ where: { id: manager.accountId }, data: { encryptionMode: "e2ee" } });
            const newcomer = await createAccount("member");
            await db.account.update({ where: { id: newcomer.accountId }, data: { username: "priya" } });
            const team = await db.team.create({
                data: {
                    name: "Restricted picker",
                    authenticationPolicy: {
                        v: 1,
                        mode: "restricted",
                        accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                    },
                },
                select: { id: true },
            });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.accountId, role: "admin" } });
            // The same manager, on a credential that proves no accepted method.
            // Their Team-derived authority is unqualified, so the disclosure the
            // picker performs is refused exactly where the member mutation it
            // feeds is refused.
            const unqualified = await auth.createToken(manager.accountId, undefined, {
                kind: "account",
                authority: "present_user",
            });

            expect((await post(app, "/v1/home/accounts/search", unqualified, {
                query: "priy",
                scope: { kind: "team", teamId: team.id },
            })).statusCode).toBe(403);

            // Team scope is exact-only, so the qualified leg asks by exact
            // Account id; what it proves is qualification, not reach.
            const qualified = await post(app, "/v1/home/accounts/search", manager.token, {
                query: newcomer.accountId,
                scope: { kind: "team", teamId: team.id },
            });
            expect(qualified.statusCode, qualified.body).toBe(200);
            expect(qualified.json().accounts).toEqual([
                expect.objectContaining({ accountId: newcomer.accountId, eligible: true }),
            ]);

            // Home scope is independent Home authority and no Team's policy
            // narrows it, on either credential.
            const homeUnqualified = await auth.createToken(owner.accountId, undefined, {
                kind: "account",
                authority: "present_user",
            });
            const homeScoped = await post(app, "/v1/home/accounts/search", homeUnqualified, {
                query: "priy",
                scope: { kind: "home" },
            });
            expect(homeScoped.statusCode, homeScoped.body).toBe(200);
            expect(homeScoped.json().accounts).toEqual([
                expect.objectContaining({ accountId: newcomer.accountId }),
            ]);
        } finally {
            if (previousKeyChallenge === undefined) delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            else process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previousKeyChallenge;
        }
    });
});
