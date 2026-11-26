import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openid-client", async () => {
    const actual = await vi.importActual<typeof import("openid-client")>("openid-client");
    return {
        ...actual,
        discovery: vi.fn(async (issuer: URL) => ({
            serverMetadata: () => ({
                issuer: issuer.href.replace(/\/$/u, ""),
                authorization_endpoint: `${issuer.origin}/authorize`,
                response_types_supported: ["code"],
                code_challenge_methods_supported: ["S256"],
            }),
        })),
    };
});

import { resolveOAuthRuntimeById, resolveRuntime } from "@/app/auth/providers/identityProviderCatalog";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { inTx } from "@/storage/inTx";

import { listHomeAdministrationEventsInTx } from "@/app/home/audit/homeAdministrationEvents";
import {
    createHomeManagedOidcProvider,
    deleteHomeManagedIdentityProvider,
    listHomeManagedIdentityProviders,
    replaceHomeManagedIdentityProviderSecret,
    setHomeManagedIdentityProviderEnabled,
    updateHomeManagedIdentityProvider,
} from "./homeManagedIdentityProviders";
import { setHomeGovernancePolicyInTx } from "./governancePolicy";
import { resolveEffectiveHomeAuthMethods } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { TEAM_CHANGE_ENTITY_ID } from "@/app/teams/teamChanges";
import { createTeamIdentityConnectionInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import { setTeamIdentityConnectionEnabledForActor } from "@/app/teams/identity/teamIdentityConnectionAdministration";

let harness: LightSqliteHarness;
let sequence = 0;
const originalPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;

const oidcConfig = {
    issuer: "https://id.example.test",
    clientId: "happier",
    clientAuthenticationMethod: "client_secret_post" as const,
    scopes: "openid profile email",
    httpTimeoutSeconds: 30,
    claims: { login: "preferred_username", email: "email", groups: "groups" },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
    fetchUserInfo: true,
    storeRefreshToken: false,
    ui: { buttonColor: null, iconHint: "oidc" },
};

async function account(homeRole: "owner" | "member"): Promise<string> {
    sequence += 1;
    return (await db.account.create({
        data: { publicKey: `managed-home-${sequence}`, homeRole, status: "active" },
        select: { id: true },
    })).id;
}

beforeAll(async () => {
    process.env.HAPPIER_PUBLIC_SERVER_URL = "https://home.example.test";
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-managed-identity-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
afterAll(async () => {
    if (originalPublicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = originalPublicServerUrl;
    await harness.close();
});
afterEach(async () => {
    await db.homeAdministrationEvent.deleteMany({});
    await db.teamIdentityConnection.deleteMany({});
    await db.identityProviderInstance.deleteMany({});
    await db.teamMembership.deleteMany({});
    await db.team.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
    await db.account.deleteMany({});
});

/**
 * Taking a Home identity method out of service (disabling the provider or its
 * Home connection, or removing the provider) must not strand an Account's last
 * login route or a Team authentication policy that accepts that Home method.
 */
describe("Home identity method withdrawal", () => {
    async function enabledProvider(owner: string) {
        const created = await createHomeManagedOidcProvider({
            actorAccountId: owner,
            displayName: `Login ${++sequence}`,
            config: oidcConfig,
            clientSecret: "withdrawal-secret",
        });
        if (created.status !== "created") throw new Error(created.status);
        const enabled = await setHomeManagedIdentityProviderEnabled({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: created.instance.revision,
            expectedSecurityRevision: created.instance.securityRevision,
            enabled: true,
        });
        if (enabled.status !== "applied") throw new Error(enabled.status);
        return enabled.instance;
    }
    const disable = (
        owner: string,
        instance: Readonly<{ id: string; revision: number; securityRevision: number }>,
        env?: NodeJS.ProcessEnv,
    ) =>
        setHomeManagedIdentityProviderEnabled({
            actorAccountId: owner,
            id: instance.id,
            expectedRevision: instance.revision,
            expectedSecurityRevision: instance.securityRevision,
            enabled: false,
            ...(env ? { env } : {}),
        });
    const restrictTeamTo = async (methodId: string) => await db.team.create({ data: {
        name: `Restricted ${++sequence}`,
        authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId }] },
    } });
    const storedEnabled = async (id: string) =>
        (await db.identityProviderInstance.findUniqueOrThrow({ where: { id }, select: { enabled: true } })).enabled;

    it("refuses disabling a Home provider that a Team authentication policy accepts", async () => {
        const owner = await account("owner");
        const instance = await enabledProvider(owner);
        await restrictTeamTo(instance.id);

        await expect(disable(owner, instance)).resolves.toMatchObject({ status: "in_use" });
        expect(await storedEnabled(instance.id)).toBe(true);
    });

    it("refuses disabling the last login route of an Account that signs in only through it", async () => {
        const owner = await account("owner");
        const instance = await enabledProvider(owner);
        const linked = await db.account.create({ data: { encryptionMode: "plain", status: "active" } });
        await db.accountIdentity.create({ data: {
            accountId: linked.id, provider: instance.id, providerUserId: `subject-${linked.id}`, eligibilityStatus: "eligible",
        } });
        // The provider is a keyless login route for this Plain Account, not only a connect target.
        const keylessLogin = {
            ...process.env,
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: instance.id,
        };

        await expect(disable(owner, instance, keylessLogin)).resolves.toMatchObject({ status: "in_use" });
        expect(await storedEnabled(instance.id)).toBe(true);
    });

    it("still disables a Home provider no Account or Team depends on", async () => {
        const owner = await account("owner");
        const instance = await enabledProvider(owner);

        await expect(disable(owner, instance)).resolves.toMatchObject({ status: "applied", instance: { enabled: false } });
    });

    it("refuses removing a Home provider that a Team authentication policy accepts", async () => {
        const owner = await account("owner");
        const instance = await enabledProvider(owner);
        await restrictTeamTo(instance.id);

        await expect(deleteHomeManagedIdentityProvider({
            actorAccountId: owner,
            id: instance.id,
            expectedRevision: instance.revision,
        })).resolves.toMatchObject({ status: "in_use" });
        expect(await db.identityProviderInstance.count({ where: { id: instance.id } })).toBe(1);
    });

    it("refuses disabling a Home identity connection that a Team authentication policy accepts", async () => {
        const owner = await account("owner");
        const instance = await enabledProvider(owner);
        await restrictTeamTo(instance.id);
        const connection = await inTx(async (tx) => await createTeamIdentityConnectionInTx(tx, {
            teamId: null,
            providerInstanceId: instance.id,
            externalReference: { v: 1, kind: "oidc" },
            settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            createdByAccountId: owner,
        }));
        if (connection.status !== "created") throw new Error(connection.status);
        const enabledRow = await db.teamIdentityConnection.update({
            where: { id: connection.connection.id },
            data: { enabled: true, revision: { increment: 1 } },
        });

        await expect(setTeamIdentityConnectionEnabledForActor({
            actorAccountId: owner,
            teamId: null,
            connectionId: connection.connection.id,
            expectedRevision: enabledRow.revision,
            enabled: false,
            env: process.env,
        })).resolves.toEqual({ ok: false, error: "identity_connection_policy_in_use" });
        expect((await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connection.connection.id } })).enabled)
            .toBe(true);
    });
});

describe("Home managed OIDC consumed lifecycle", () => {
    it("records who added, re-keyed and removed a Home provider in Activity, never the secret", async () => {
        const owner = await account("owner");
        const created = await createHomeManagedOidcProvider({
            actorAccountId: owner,
            displayName: "Okta",
            config: oidcConfig,
            clientSecret: "first-secret-value",
        });
        expect(created.status).toBe("created");
        if (created.status !== "created") return;
        const replaced = await replaceHomeManagedIdentityProviderSecret({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: created.instance.revision,
            clientSecret: "second-secret-value",
        });
        expect(replaced.status).toBe("applied");
        const current = await db.identityProviderInstance.findUniqueOrThrow({
            where: { id: created.instance.id },
            select: { revision: true },
        });
        const removed = await deleteHomeManagedIdentityProvider({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: current.revision,
        });
        expect(removed.status).toBe("deleted");

        const listed = await inTx((tx) => listHomeAdministrationEventsInTx(tx, { targetId: created.instance.id }));
        expect(listed.status).toBe("ok");
        if (listed.status !== "ok") return;
        expect(listed.result.items.map((event) => [event.action, event.summary, event.actor.accountId, event.target?.kind]))
            .toEqual([
                ["identity_provider.remove", { displayName: "Okta" }, owner, "identity_provider"],
                ["identity_provider.secret.replace", { displayName: "Okta" }, owner, "identity_provider"],
                ["identity_provider.create", { displayName: "Okta" }, owner, "identity_provider"],
            ]);
        const stored = JSON.stringify(await db.homeAdministrationEvent.findMany({}));
        expect(stored).not.toContain("first-secret-value");
        expect(stored).not.toContain("second-secret-value");
    });

    it("does not record Team-owned provider changes as Home administration", async () => {
        const owner = await account("owner");
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: { v: 1, allowedTeamProviderKinds: ["oidc"], teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [] },
            },
        });
        const team = await db.team.create({ data: { name: "Team-owned audit" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner, role: "owner", status: "active" } });
        const created = await createHomeManagedOidcProvider({
            actorAccountId: owner,
            owner: { kind: "team", teamId: team.id },
            displayName: "Team login",
            config: oidcConfig,
            clientSecret: "team-secret",
        });
        expect(created.status).toBe("created");
        expect(await db.homeAdministrationEvent.count()).toBe(0);
    });

    it("publishes Team currentness when a Team-owned provider changes", async () => {
        const owner = await account("owner");
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const team = await db.team.create({ data: { name: "Team provider currentness" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner, role: "owner", status: "active" },
        });

        const created = await createHomeManagedOidcProvider({
            actorAccountId: owner,
            owner: { kind: "team", teamId: team.id },
            displayName: "Team login",
            config: oidcConfig,
            clientSecret: "team-secret",
        });
        expect(created.status).toBe("created");
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: owner,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.not.toBeNull();
    });

    it("publishes one Team invalidation when a Home-owned provider used by that Team changes", async () => {
        const owner = await account("owner");
        const team = await db.team.create({ data: { name: "Home provider consumer" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner, role: "owner", status: "active" },
        });
        const created = await createHomeManagedOidcProvider({
            actorAccountId: owner,
            displayName: "Shared login",
            config: oidcConfig,
            clientSecret: "shared-secret",
        });
        expect(created.status).toBe("created");
        if (created.status !== "created") return;
        await inTx(async (tx) => {
            const connection = await createTeamIdentityConnectionInTx(tx, {
                teamId: team.id,
                providerInstanceId: created.instance.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                createdByAccountId: owner,
            });
            expect(connection.status).toBe("created");
        });
        const before = await db.account.findUniqueOrThrow({
            where: { id: owner },
            select: { seq: true },
        });

        await expect(updateHomeManagedIdentityProvider({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: created.instance.revision,
            displayName: "Shared login renamed",
        })).resolves.toMatchObject({ status: "applied" });

        const change = await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: owner,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        });
        expect(change.cursor).toBeGreaterThan(before.seq);
        await expect(db.account.findUniqueOrThrow({ where: { id: owner }, select: { seq: true } }))
            .resolves.toMatchObject({ seq: change.cursor });
    });

    it("authorizes the Home owner, keeps secrets redacted, and invalidates a bound runtime on rotation", async () => {
        const owner = await account("owner");
        const member = await account("member");

        await expect(createHomeManagedOidcProvider({
            actorAccountId: member,
            displayName: "Company login",
            config: oidcConfig,
            clientSecret: "member-secret",
        })).resolves.toEqual({ status: "forbidden" });
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: member,
                    kind: "account",
                    entityId: "home-governance",
                },
            },
        })).resolves.toBeNull();

        const created = await createHomeManagedOidcProvider({
            actorAccountId: owner,
            displayName: "Company login",
            config: oidcConfig,
            clientSecret: "owner-secret",
        });
        expect(created.status).toBe("created");
        if (created.status !== "created") return;
        expect(JSON.stringify(created.instance)).not.toContain("owner-secret");
        const enabled = await setHomeManagedIdentityProviderEnabled({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: 1,
            expectedSecurityRevision: 1,
            enabled: true,
        });
        expect(enabled).toMatchObject({
            status: "applied",
            instance: { enabled: true, revision: 2, securityRevision: 2 },
        });
        if (enabled.status !== "applied") return;

        const env = { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };
        const effective = await resolveEffectiveHomeAuthMethods({ env });
        expect(effective.status).toBe("ready");
        if (effective.status !== "ready") return;
        expect(effective.decisions.find((decision) => decision.id === created.instance.id)?.actions)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ id: "connect", enabled: true, mode: "either" }),
                expect.objectContaining({ id: "provision", enabled: true, mode: "keyed" }),
            ]));
        const runtime = await resolveOAuthRuntimeById(env, created.instance.id);
        expect(runtime?.provider.resolveRedirectUrl(env)).toBe(
            `https://home.example.test/v1/oauth/${created.instance.id}/callback`,
        );

        const renamed = await updateHomeManagedIdentityProvider({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: 2,
            displayName: "Company SSO",
            config: { v: 1, kind: "oidc", ...oidcConfig },
        });
        expect(renamed).toMatchObject({
            status: "applied",
            instance: { revision: 3, securityRevision: 2, displayName: "Company SSO" },
        });
        if (renamed.status !== "applied") return;
        await expect(resolveRuntime({
            env,
            reference: runtime!.reference,
            purpose: "oauth_callback",
        })).resolves.toMatchObject({ ok: true });

        // The save-time validator fails closed unless this deployment ceiling
        // explicitly permits private identity networks.
        const privateNetworkEnv = {
            ...env,
            HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED: "true",
        };
        await expect(inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: privateNetworkEnv,
            patch: {
                expectedRevision: 0,
                identityNetworkPolicy: {
                    v: 1,
                    mode: "private_allowlist",
                    hostnames: ["id.example.test"],
                    cidrs: ["10.20.0.0/16"],
                    ports: [443],
                },
            },
        }))).resolves.toMatchObject({ status: "applied" });
        const cloudRuntime = await resolveOAuthRuntimeById(env, created.instance.id);
        expect(cloudRuntime?.reference.runtimeFingerprint).toBe(runtime?.reference.runtimeFingerprint);
        const privateRuntime = await resolveOAuthRuntimeById(privateNetworkEnv, created.instance.id);
        expect(privateRuntime?.reference.runtimeFingerprint).not.toBe(runtime?.reference.runtimeFingerprint);

        const rotated = await replaceHomeManagedIdentityProviderSecret({
            actorAccountId: owner,
            id: created.instance.id,
            expectedRevision: 3,
            clientSecret: "rotated-secret",
        });
        expect(rotated).toMatchObject({
            status: "applied",
            instance: { revision: 4, securityRevision: 3 },
        });
        expect(JSON.stringify(await listHomeManagedIdentityProviders({ actorAccountId: owner })))
            .not.toContain("rotated-secret");
        await expect(resolveRuntime({
            env,
            reference: runtime!.reference,
            purpose: "oauth_callback",
        })).resolves.toEqual({ ok: false, code: "auth_provider_configuration_changed" });
    });
});
