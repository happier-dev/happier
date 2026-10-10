import type { WorkOS } from "@workos-inc/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createIdentityConnectionTestResult } from "@/app/api/routes/connect/oauthExternal/identityConnectionTestResult";
import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { computeTeamWorkosConnectionRuntimeFingerprint } from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";
import { resolveWorkosPlatformRuntimeMetadata } from "@/app/integrations/workos/workosPlatform";
import { encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerTeamIdentityRoutes } from "./registerTeamIdentityRoutes";
import { TEAM_CHANGE_ENTITY_ID } from "../teamChanges";

describe("Team identity WorkOS routes", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    const getWorkosConnection = vi.fn();
    const deleteWorkosConnection = vi.fn();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-identity-routes-",
            initAuth: false,
            initEncrypt: true,
        });
        harness.resetEnv({
            HAPPIER_WEBAPP_URL: "https://app.example.test",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "managed_oidc_exact",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            WORKOS_API_KEY: "sk_test_exact",
            WORKOS_CLIENT_ID: "client_exact",
        });
        const generateLink = vi.fn(async () => ({ link: "https://setup.workos.test/portal" }));
        app = createAuthenticatedTestApp();
        registerTeamIdentityRoutes(app, {
            resolvePlatform: () => ({
                available: true,
                clientId: "client_exact",
                runtimeFingerprint: "workos-platform:v1:exact",
                client: {
                    organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
                    adminPortal: { generateLink },
                    sso: {
                        listConnections: vi.fn(),
                        getConnection: getWorkosConnection,
                        deleteConnection: deleteWorkosConnection,
                    },
                } as unknown as WorkOS,
            }),
            resolveServerIdentityId: async () => "server_home",
        });
        await app.ready();
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    }, 120_000);

    afterAll(async () => {
        if (app) await app.close();
        if (harness) await harness.close();
    });

    it("keeps Team identity administration membership-scoped and maps credential qualification distinctly", async () => {
        const owner = await db.account.create({ data: {} });
        const homeAdministrator = await db.account.create({ data: { homeRole: "owner" } });
        const team = await db.team.create({
            data: {
                name: "Restricted identity administration",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "email_password" }],
                },
            },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const list = async (actorAccountId: string) => await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/list",
            headers: { "x-test-user-id": actorAccountId },
            payload: { v: 1, teamId: team.id },
        });

        const required = await list(owner.id);
        expect(required.statusCode).toBe(403);
        expect(required.json()).toEqual({ error: "team_authentication_required" });

        const concealed = await list(homeAdministrator.id);
        expect(concealed.statusCode).toBe(404);
        expect(concealed.json()).toEqual({ error: "team_not_found" });

        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        const unavailable = await list(owner.id);
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json()).toEqual({ error: "team_authentication_unavailable" });
    });

    it("creates one Team-owned WorkOS provider and draft connection idempotently", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Setup WorkOS" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const create = async () => await app.inject({
            method: "POST",
            url: "/v1/teams/identity/workos/connection/create",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id },
        });

        const first = await create();
        expect(first.statusCode).toBe(200);
        expect(first.json().connection).toMatchObject({
            teamId: team.id,
            provider: { kind: "workos_sso", displayName: "Setup WorkOS SSO" },
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: null,
                connectionId: null,
            },
            settings: { v: 1, kind: "workos_sso" },
            enabled: false,
            revision: 1,
            state: "setting_up",
        });
        const second = await create();
        expect(second.statusCode).toBe(200);
        expect(second.json().connection.id).toBe(first.json().connection.id);
        await expect(db.identityProviderInstance.findMany({ where: { ownerTeamId: team.id } }))
            .resolves.toHaveLength(1);
        await expect(db.teamIdentityConnection.findMany({ where: { teamId: team.id } }))
            .resolves.toHaveLength(1);
    });

    it("disables before upstream removal and retains the shared Directory carrier and native memberships", async () => {
        getWorkosConnection.mockReset()
            .mockResolvedValueOnce({
                id: "conn_shared",
                organizationId: "org_shared",
                name: "Shared SSO",
                type: "SAML",
                state: "active",
            })
            .mockRejectedValueOnce({ status: 404 });
        deleteWorkosConnection.mockReset()
            .mockRejectedValueOnce({ status: 503 });

        const owner = await db.account.create({ data: {} });
        const linkedAccount = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Shared WorkOS" } });
        const otherTeam = await db.team.create({ data: { name: "Unrelated Team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: linkedAccount.id, role: "member" },
            { teamId: otherTeam.id, accountId: linkedAccount.id, role: "member" },
        ] });
        await db.accountIdentity.create({ data: {
            accountId: linkedAccount.id,
            provider: "email",
            providerUserId: `linked-${linkedAccount.id}@example.test`,
            providerLogin: `linked-${linkedAccount.id}@example.test`,
            profile: {},
        } });
        await db.accountPasswordCredential.create({ data: {
            accountId: linkedAccount.id,
            credential: { v: 1, kind: "plain_password_hash", hash: "test-only-hash" },
        } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id,
            kind: "workos_sso",
            displayName: "Shared WorkOS SSO",
            enabled: true,
            firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org_shared",
                connectionId: "conn_shared",
            },
            settings: { v: 1, kind: "workos_sso" },
            enabled: true,
            firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
        } });
        await db.accountIdentity.create({ data: {
            accountId: linkedAccount.id,
            provider: provider.id,
            providerUserId: "workos_subject",
            profile: {},
            eligibilityStatus: "eligible",
        } });
        const directory = await db.teamDirectorySource.create({ data: {
            teamId: team.id,
            kind: "workos_directory",
            state: "active",
            displayName: "Shared Directory",
            externalSourceKey: `workos:${team.id}:directory`,
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_shared" },
            teamIdentityConnectionId: connection.id,
        } });

        const preflight = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove/preflight",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id, connectionId: connection.id, expectedRevision: 1 },
        });
        expect(preflight.statusCode).toBe(200);
        expect(preflight.json()).toMatchObject({
            canRemove: true,
            impact: { linkedAccounts: 1, directorySources: 1 },
            blockers: [],
        });

        const failed = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id, connectionId: connection.id, expectedRevision: 1 },
        });
        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toEqual({ error: "identity_provider_unavailable" });
        await expect(db.teamIdentityConnection.findUnique({ where: { id: connection.id } }))
            .resolves.toMatchObject({ enabled: false, revision: 2 });
        await expect(db.accountIdentity.findUnique({
            where: { accountId_provider: { accountId: linkedAccount.id, provider: provider.id } },
        })).resolves.not.toBeNull();

        const removed = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id, connectionId: connection.id, expectedRevision: 2 },
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({ outcome: "removed" });
        await expect(db.teamIdentityConnection.findUnique({ where: { id: connection.id } }))
            .resolves.toMatchObject({
                enabled: false,
                revision: 3,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_shared",
                    connectionId: null,
                },
            });
        await expect(db.accountIdentity.findUnique({
            where: { accountId_provider: { accountId: linkedAccount.id, provider: provider.id } },
        })).resolves.toBeNull();
        await expect(db.teamDirectorySource.findUnique({ where: { id: directory.id } }))
            .resolves.toMatchObject({ teamIdentityConnectionId: connection.id, state: "active" });
        await expect(db.teamMembership.count({ where: { accountId: linkedAccount.id } })).resolves.toBe(2);
        await expect(db.identityProviderInstance.findUnique({ where: { id: provider.id } })).resolves.not.toBeNull();

        const replay = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id, connectionId: connection.id, expectedRevision: 2 },
        });
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual({ outcome: "already_absent" });
        await expect(db.teamIdentityConnection.findUnique({ where: { id: connection.id } }))
            .resolves.toMatchObject({ revision: 3 });
    });

    it("returns a successful portal bearer link with no-store after current Team authorization", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Acme" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Acme SSO",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_exact",
                    connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        const response = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/workos/admin-portal-link/create",
            headers: { "x-test-user-id": owner.id, "x-test-auth-token-kind": "terminal" },
            payload: { v: 1, teamId: team.id, connectionId: connection.id, intent: "sso" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({ url: "https://setup.workos.test/portal" });

        const preflight = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove/preflight",
            headers: { "x-test-user-id": owner.id },
            payload: {
                v: 1,
                teamId: team.id,
                connectionId: connection.id,
                expectedRevision: 1,
            },
        });
        expect(preflight.statusCode).toBe(200);
        expect(preflight.json()).toMatchObject({
            v: 1,
            canRemove: true,
            connection: { id: connection.id },
            impact: {
                linkedAccounts: 0,
                accountsRequiringAlternateLogin: 0,
                directorySources: 0,
                externalGroupBindings: 0,
                managedMemberships: 0,
            },
            blockers: [],
        });
    });

    it("blocks removal in the mutation transaction when a linked Account would lose its only login route", async () => {
        const owner = await db.account.create({ data: {} });
        const linkedAccount = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Sole login Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                id: "managed_oidc_exact",
                kind: "oidc",
                displayName: "Managed OIDC",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                encryptedSecrets: encryptString(
                    ["storage", "identity_provider_instance", "managed_oidc_exact", "oidc", "secrets", "v1"],
                    JSON.stringify({ v: 1, kind: "oidc", clientSecret: "managed-oidc-secret" }),
                ),
                config: {
                    v: 1,
                    kind: "oidc",
                    issuer: "https://id.example.test",
                    clientId: "happier",
                    clientAuthenticationMethod: "client_secret_post",
                    scopes: "openid profile email",
                    httpTimeoutSeconds: 30,
                    claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: true,
                    storeRefreshToken: false,
                    ui: { buttonColor: null, iconHint: "oidc" },
                },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        await db.accountIdentity.create({
            data: {
                accountId: linkedAccount.id,
                provider: provider.id,
                providerUserId: "subject_exact",
                eligibilityStatus: "eligible",
            },
        });
        expect(await inTx(async (tx) => await resolveEffectiveHomeAuthMethodsInTx(tx, { env: process.env })))
            .toMatchObject({
                status: "ready",
                decisions: expect.arrayContaining([
                    expect.objectContaining({
                        id: provider.id,
                        actions: expect.arrayContaining([
                            expect.objectContaining({ id: "login", enabled: true }),
                        ]),
                    }),
                ]),
            });

        const payload = {
            v: 1,
            teamId: team.id,
            connectionId: connection.id,
            expectedRevision: 1,
        } as const;
        const preflight = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove/preflight",
            headers: { "x-test-user-id": owner.id },
            payload,
        });
        expect(preflight.statusCode).toBe(200);
        expect(preflight.json()).toMatchObject({
            canRemove: false,
            impact: { linkedAccounts: 1, accountsRequiringAlternateLogin: 1 },
            blockers: ["account_would_lose_login"],
        });

        const removed = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/remove",
            headers: { "x-test-user-id": owner.id },
            payload,
        });
        expect(removed.statusCode).toBe(409);
        expect(removed.json()).toEqual({ error: "identity_provider_in_use" });
        await expect(db.teamIdentityConnection.findUnique({ where: { id: connection.id } }))
            .resolves.not.toBeNull();
        await db.accountIdentity.deleteMany({ where: { provider: provider.id } });
        await db.teamIdentityConnection.delete({ where: { id: connection.id } });
        await db.identityProviderInstance.delete({ where: { id: provider.id } });
    });

    it("keeps a connection disabled when its exact provider runtime cannot be validated", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Invalid runtime Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                id: "enable_oidc_exact",
                ownerTeamId: team.id,
                kind: "oidc",
                displayName: "Missing secrets OIDC",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: {
                    v: 1,
                    kind: "oidc",
                    issuer: "https://id.example.test",
                    clientId: "happier",
                    clientAuthenticationMethod: "client_secret_post",
                    scopes: "openid profile email",
                    httpTimeoutSeconds: 30,
                    claims: { login: "preferred_username", email: "email", groups: "groups" },
                    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                    fetchUserInfo: true,
                    storeRefreshToken: false,
                    ui: { buttonColor: null, iconHint: "oidc" },
                },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
            },
        });

        const enabled = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/enable",
            headers: { "x-test-user-id": owner.id },
            payload: {
                v: 1,
                teamId: team.id,
                connectionId: connection.id,
                expectedRevision: 1,
            },
        });
        expect(enabled.statusCode).toBe(503);
        expect(enabled.json()).toEqual({ error: "identity_provider_unavailable" });
        await expect(db.teamIdentityConnection.findUnique({ where: { id: connection.id } }))
            .resolves.toMatchObject({ enabled: false, revision: 1 });
    });

    it("projects runtime-aware actions and exact current test evidence from the live runtime", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Current test Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Current WorkOS",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const platform = resolveWorkosPlatformRuntimeMetadata(process.env);
        expect(platform.available).toBe(true);
        if (!platform.available) return;
        const connectionId = "connection_current_test";
        const runtimeFingerprint = computeTeamWorkosConnectionRuntimeFingerprint({
            teamId: team.id,
            connectionId,
            providerInstanceId: provider.id,
            providerSecurityRevision: 1,
            connectionRevision: 1,
            platformRuntimeFingerprint: platform.runtimeFingerprint,
            externalReference: { organizationId: "org_exact", connectionId: "workos_connection_exact" },
        });
        await db.teamIdentityConnection.create({
            data: {
                id: connectionId,
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_exact",
                    connectionId: "workos_connection_exact",
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                lastObservation: {
                    v: 1,
                    kind: "workos_sso",
                    presentation: null,
                    successfulTest: { runtimeFingerprint },
                },
                lastSuccessfulTestAt: new Date("2026-09-06T00:01:00.000Z"),
            },
        });
        const list = async () => await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/list",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id },
        });
        const current = await list();
        expect(current.statusCode).toBe(200);
        expect(current.json().items[0]).toMatchObject({
            id: connectionId,
            allowedActions: [
                "teams.identity.connections.disable",
                "teams.identity.connections.remove",
                "teams.identity.connections.test.start",
                "teams.identity.workos.adminPortalLink.create",
                "teams.identity.workos.reconcile",
                "teams.identity.workos.connection.set",
            ],
            lastSuccessfulTest: { current: true, runtimeFingerprint },
        });
        expect(current.json().items[0].lastSuccessfulTest).not.toHaveProperty("connectionRevision");

        const workosApiKey = process.env.WORKOS_API_KEY;
        delete process.env.WORKOS_API_KEY;
        try {
            const unavailable = await list();
            expect(unavailable.statusCode).toBe(200);
            expect(unavailable.json().items[0]).toMatchObject({
                id: connectionId,
                state: "unavailable",
                lastSuccessfulTest: { current: false },
            });
        } finally {
            process.env.WORKOS_API_KEY = workosApiKey;
        }

        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: { securityRevision: { increment: 1 } },
        });
        const stale = await list();
        expect(stale.statusCode).toBe(200);
        expect(stale.json().items[0].lastSuccessfulTest).toMatchObject({ current: false });
    });

    it("projects a mutation result from the same currentness owner as the list", async () => {
        // A CLI, Agent or plugin caller reads the Action result, not the list.
        // With the WorkOS platform gone, the row is still disabled but the
        // connection is unavailable and none of the WorkOS actions can succeed.
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Mutation result Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Mutation WorkOS",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_exact",
                    connectionId: "workos_connection_exact",
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const workosApiKey = process.env.WORKOS_API_KEY;
        delete process.env.WORKOS_API_KEY;
        try {
            const disabled = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/disable",
                headers: { "x-test-user-id": owner.id },
                payload: { v: 1, teamId: team.id, connectionId: connection.id, expectedRevision: 1 },
            });
            expect(disabled.statusCode).toBe(200);
            expect(disabled.json().connection).toMatchObject({
                id: connection.id,
                enabled: false,
                state: "unavailable",
            });
            expect(disabled.json().connection.allowedActions).toEqual([
                "teams.identity.connections.remove",
            ]);
        } finally {
            process.env.WORKOS_API_KEY = workosApiKey;
        }
    });

    it("re-enables a WorkOS connection only after revalidating the exact upstream connection", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Re-enable Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Re-enable WorkOS",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_exact",
                    connectionId: "workos_connection_exact",
                },
                settings: { v: 1, kind: "workos_sso" },
                enabled: false,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const enable = async (expectedRevision: number) => await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/enable",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id, connectionId: connection.id, expectedRevision },
        });

        getWorkosConnection.mockReset();
        getWorkosConnection.mockResolvedValueOnce({
            id: "workos_connection_exact",
            organizationId: "org_exact",
            name: "Acme Okta",
            type: "SAML",
            state: "inactive",
        });
        const refused = await enable(1);
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toEqual({ error: "workos_connection_mismatch" });
        expect(getWorkosConnection).toHaveBeenCalledWith("workos_connection_exact");
        const observed = await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connection.id } });
        expect(observed.enabled).toBe(false);
        expect(observed.lastObservation).toMatchObject({
            kind: "workos_sso",
            presentation: { displayName: "Acme Okta", status: "inactive" },
        });

        getWorkosConnection.mockResolvedValueOnce({
            id: "workos_connection_exact",
            organizationId: "org_exact",
            name: "Acme Okta",
            type: "SAML",
            state: "active",
        });
        const enabled = await enable(observed.revision);
        expect(enabled.statusCode).toBe(200);
        expect(enabled.json().connection).toMatchObject({ enabled: true, state: "connected" });
    });

    it("renders the member sign-in link from the Home's own origin and carrier, or nothing", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Link Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });

        // A second app instance so the link resolver is the only difference from
        // the shared app above, which deliberately publishes no link at all.
        const linkApp = createAuthenticatedTestApp();
        registerTeamIdentityRoutes(linkApp, {
            resolveServerIdentityId: async () => "server_home",
            resolveMemberSignInLinkTarget: async () => ({
                applicationOrigin: "https://app.example.test",
                homeTarget: '{"kind":"descriptor"}',
            }),
        });
        await linkApp.ready();
        try {
            const withLink = await linkApp.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/list",
                headers: { "x-test-user-id": owner.id },
                payload: { v: 1, teamId: team.id },
            });
            expect(withLink.statusCode).toBe(200);
            // The immutable Team id addresses the page and the portable carrier
            // rides in the query, exactly as the invitation link is composed.
            expect(withLink.json().memberSignInUrl).toBe(
                `https://app.example.test/teams/${encodeURIComponent(team.id)}/sign-in`
                + "?target=%7B%22kind%22%3A%22descriptor%22%7D",
            );
        } finally {
            await linkApp.close();
        }

        // A Home that publishes no origin says so rather than returning a link
        // that would only work on devices which already know this Home.
        const withoutLink = await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/list",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id },
        });
        expect(withoutLink.statusCode).toBe(200);
        expect(withoutLink.json().memberSignInUrl).toBeNull();
    });

    it("projects current admission applicability on the Team Authentication list result", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Admission projection Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const list = async () => await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/list",
            headers: { "x-test-user-id": owner.id },
            payload: { v: 1, teamId: team.id },
        });

        const baseline = await list();
        expect(baseline.statusCode).toBe(200);
        expect(baseline.json().admissionModeApplicability).toEqual({
            v: 1,
            modes: {
                invite_only: { status: "available" },
                provisioned: { status: "unavailable", reason: "directory_source_required" },
                jit: { status: "unavailable", reason: "home_policy_prohibited" },
            },
        });

        await db.homeGovernancePolicy.update({
            where: { id: "home" },
            data: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        try {
            const provider = await db.identityProviderInstance.create({
                data: {
                    ownerTeamId: team.id,
                    kind: "workos_sso",
                    displayName: "Admission WorkOS",
                    enabled: true,
                    firstEnabledAt: new Date("2026-09-12T00:00:00.000Z"),
                    config: { v: 1, kind: "workos_sso" },
                },
            });
            const connection = await db.teamIdentityConnection.create({
                data: {
                    teamId: team.id,
                    providerInstanceId: provider.id,
                    externalReference: {
                        v: 1,
                        kind: "workos_sso",
                        organizationId: "org_admission_projection",
                        connectionId: "conn_admission_projection",
                    },
                    settings: { v: 1, kind: "workos_sso" },
                    enabled: true,
                    firstEnabledAt: new Date("2026-09-12T00:00:00.000Z"),
                },
            });
            await db.teamDirectorySource.create({
                data: {
                    teamId: team.id,
                    kind: "workos_directory",
                    state: "active",
                    displayName: "Admission directory",
                    externalSourceKey: `directory_admission_${team.id}`,
                    bindingConfig: {
                        v: 1,
                        kind: "workos_directory",
                        workosDirectoryId: "directory_admission_projection",
                    },
                    teamIdentityConnectionId: connection.id,
                },
            });

            const available = await list();
            expect(available.statusCode).toBe(200);
            expect(available.json().admissionModeApplicability.modes).toEqual({
                invite_only: { status: "available" },
                provisioned: { status: "available" },
                jit: { status: "available" },
            });

            await db.teamIdentityConnection.update({
                where: { id: connection.id },
                data: { enabled: false, revision: { increment: 1 } },
            });
            const disabled = await list();
            expect(disabled.statusCode).toBe(200);
            expect(disabled.json().admissionModeApplicability.modes.jit).toEqual({
                status: "unavailable",
                reason: "team_connection_unavailable",
            });
        } finally {
            await db.homeGovernancePolicy.update({
                where: { id: "home" },
                data: {
                    teamProviderPolicy: {
                        v: 1,
                        allowedTeamProviderKinds: ["workos_sso"],
                        teamJitAllowed: false,
                        approvedGitHubEnterpriseOrigins: [],
                    },
                },
            });
        }
    });

    it("lists only authorization-scoped eligible providers and keeps Home policy decisions on the server", async () => {
        const owner = await db.account.create({ data: {} });
        const outsider = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Picker Team" } });
        const otherTeam = await db.team.create({ data: { name: "Foreign Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const oidcConfig = {
            v: 1 as const,
            kind: "oidc" as const,
            issuer: "https://identity.example.test",
            clientId: "happier",
            clientAuthenticationMethod: "client_secret_post",
            scopes: "openid profile email",
            httpTimeoutSeconds: 30,
            claims: { login: "preferred_username", email: "email", groups: "groups" },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: false,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: "oidc" },
        };
        const [homeProvider, teamProvider, boundProvider, foreignProvider, disabledProvider] = await Promise.all([
            db.identityProviderInstance.create({ data: {
                id: "picker_home_oidc", kind: "oidc", displayName: "Shared OIDC", enabled: true, config: oidcConfig,
            } }),
            db.identityProviderInstance.create({ data: {
                id: "picker_team_oidc", ownerTeamId: team.id, kind: "oidc", displayName: "Team OIDC", enabled: true, config: oidcConfig,
            } }),
            db.identityProviderInstance.create({ data: {
                id: "picker_bound_oidc", ownerTeamId: team.id, kind: "oidc", displayName: "Already connected", enabled: true, config: oidcConfig,
            } }),
            db.identityProviderInstance.create({ data: {
                id: "picker_foreign_oidc", ownerTeamId: otherTeam.id, kind: "oidc", displayName: "Foreign secret name", enabled: true, config: oidcConfig,
            } }),
            db.identityProviderInstance.create({ data: {
                id: "picker_disabled_oidc", kind: "oidc", displayName: "Disabled shared OIDC", enabled: false, config: oidcConfig,
            } }),
        ]);
        const boundConnection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id,
            providerInstanceId: boundProvider.id,
            externalReference: { v: 1, kind: "oidc" },
            settings: { v: 1, kind: "oidc", allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
        } });
        await db.homeGovernancePolicy.update({ where: { id: "home" }, data: {
            teamProviderPolicy: {
                v: 1,
                allowedTeamProviderKinds: ["oidc", "github_app_identity"],
                teamJitAllowed: false,
                approvedGitHubEnterpriseOrigins: [],
            },
        } });
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/list",
                headers: { "x-test-user-id": owner.id },
                payload: { v: 1, teamId: team.id },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().eligibleProviders).toEqual([
                {
                    v: 1,
                    providerId: homeProvider.id,
                    providerKind: "oidc",
                    owner: "home",
                    displayName: "Shared OIDC",
                    availability: {
                        status: "available",
                        setupChoice: {
                            kind: "use_existing",
                            providerInstanceId: homeProvider.id,
                            connectionDraft: {
                                externalReference: { v: 1, kind: "oidc" },
                                settings: {
                                    v: 1,
                                    kind: "oidc",
                                    allowedUsers: [],
                                    allowedEmailDomains: [],
                                    groupsAny: [],
                                    groupsAll: [],
                                },
                            },
                        },
                    },
                },
                {
                    v: 1,
                    providerId: teamProvider.id,
                    providerKind: "oidc",
                    owner: "team",
                    displayName: "Team OIDC",
                    availability: {
                        status: "available",
                        setupChoice: {
                            kind: "use_existing",
                            providerInstanceId: teamProvider.id,
                            connectionDraft: {
                                externalReference: { v: 1, kind: "oidc" },
                                settings: {
                                    v: 1,
                                    kind: "oidc",
                                    allowedUsers: [],
                                    allowedEmailDomains: [],
                                    groupsAny: [],
                                    groupsAll: [],
                                },
                            },
                        },
                    },
                },
                {
                    v: 1,
                    providerId: disabledProvider.id,
                    providerKind: "oidc",
                    owner: "home",
                    displayName: "Disabled shared OIDC",
                    availability: { status: "unavailable", code: "provider_disabled" },
                },
                {
                    v: 1,
                    providerId: null,
                    providerKind: "oidc",
                    owner: "team",
                    displayName: null,
                    availability: {
                        status: "available",
                        setupChoice: { kind: "create_managed", actionId: "identity.providers.create" },
                    },
                },
                {
                    v: 1,
                    providerId: null,
                    providerKind: "workos_sso",
                    owner: "team",
                    displayName: null,
                    availability: { status: "unavailable", code: "home_policy_prohibited" },
                },
                {
                    v: 1,
                    providerId: null,
                    providerKind: "github_app_identity",
                    owner: "team",
                    displayName: null,
                    availability: {
                        status: "available",
                        setupChoice: {
                            kind: "create_managed",
                            actionId: "identity.githubApps.manifestSetup.start",
                        },
                    },
                },
            ]);
            expect(response.json().eligibleProviders).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ providerId: foreignProvider.id }),
                expect.objectContaining({ providerId: boundProvider.id }),
            ]));

            const settingsUpdated = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/settings/update",
                headers: { "x-test-user-id": owner.id },
                payload: {
                    v: 1,
                    teamId: team.id,
                    connectionId: boundConnection.id,
                    expectedRevision: 1,
                    settings: {
                        v: 1,
                        kind: "oidc",
                        allowedUsers: ["alice"],
                        allowedEmailDomains: ["example.test"],
                        groupsAny: ["engineering"],
                        groupsAll: [],
                    },
                },
            });
            expect(settingsUpdated.statusCode, settingsUpdated.body).toBe(200);
            expect(settingsUpdated.json().connection).toMatchObject({
                id: boundConnection.id,
                revision: 2,
                settings: { allowedUsers: ["alice"], groupsAny: ["engineering"] },
            });
            await expect(db.accountChange.findUnique({
                where: {
                    accountId_kind_entityId: {
                        accountId: owner.id,
                        kind: "account",
                        entityId: TEAM_CHANGE_ENTITY_ID,
                    },
                },
            })).resolves.not.toBeNull();

            const prohibitedWorkos = await db.identityProviderInstance.create({
                data: {
                    ownerTeamId: team.id,
                    kind: "workos_sso",
                    displayName: "Policy bypass attempt",
                    enabled: true,
                    config: { v: 1, kind: "workos_sso" },
                },
            });
            const prohibitedCreate = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/create",
                headers: { "x-test-user-id": owner.id },
                payload: {
                    v: 1,
                    teamId: team.id,
                    providerInstanceId: prohibitedWorkos.id,
                    externalReference: {
                        v: 1,
                        kind: "workos_sso",
                        organizationId: null,
                        connectionId: null,
                    },
                    settings: { v: 1, kind: "workos_sso" },
                },
            });
            expect(prohibitedCreate.statusCode).toBe(503);
            expect(prohibitedCreate.json()).toEqual({ error: "identity_provider_unavailable" });

            const denied = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/list",
                headers: { "x-test-user-id": outsider.id },
                payload: { v: 1, teamId: team.id },
            });
            expect(denied.statusCode).toBe(404);
            expect(JSON.stringify(denied.json())).not.toContain(homeProvider.id);
        } finally {
            await db.homeGovernancePolicy.update({
                where: { id: "home" },
                data: {
                    teamProviderPolicy: {
                        v: 1,
                        allowedTeamProviderKinds: ["workos_sso"],
                        teamJitAllowed: false,
                        approvedGitHubEnterpriseOrigins: [],
                    },
                },
            });
        }
    });

    it("projects a current successful test and rejects later evidence after its runtime changes", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Rotated test Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Rotating WorkOS",
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_rotated",
                    connectionId: "workos_connection_rotated",
                },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        const runtime = await resolveOAuthRuntimeById(
            process.env,
            provider.id,
            { kind: "team", teamId: team.id },
            "identity_connection_test",
        );
        expect(runtime).not.toBeNull();
        if (!runtime) return;
        const testedAt = new Date("2026-09-06T00:02:00.000Z");
        const diagnostics = {
            subjectPresent: true,
            loginAvailable: true,
            emailAvailable: true,
            emailVerified: false,
            groups: { state: "complete" as const, count: 3 },
            eligibility: {
                status: "ineligible" as const,
                rules: [{ kind: "email_domains" as const, matched: false }],
            },
            mappedGroups: [],
        };
        const createResult = async () => await createIdentityConnectionTestResult({
            initiatorAccountId: owner.id,
            securityBinding: {
                provider: runtime.reference,
                connection: { id: connection.id, revision: 1 },
                admission: null,
                purpose: "identity_connection_test",
            },
            providerUserId: "subject-do-not-return",
            diagnostics,
            testedAt,
            expiresAt: new Date(Date.now() + 60_000),
        });
        const consume = async (resultHandle: string) => await app.inject({
            method: "POST",
            url: "/v1/teams/identity/connections/test/consume",
            headers: { "x-test-user-id": owner.id, "x-test-auth-token-kind": "terminal" },
            payload: {
                v: 1,
                teamId: team.id,
                connectionId: connection.id,
                resultHandle,
            },
        });
        const currentResult = await createResult();
        const current = await consume(currentResult.resultHandle);
        expect(current.statusCode).toBe(200);
        expect(current.headers["cache-control"]).toBe("no-store");
        expect(current.json().connection.lastSuccessfulTest).toEqual({
            at: testedAt.getTime(),
            runtimeFingerprint: runtime.reference.runtimeFingerprint,
            current: true,
        });
        expect(current.json().diagnostics).toEqual(diagnostics);
        expect(JSON.stringify(current.json())).not.toContain("subject-do-not-return");
        // A one-time result cannot be replayed for a second diagnostic read.
        const replayed = await consume(currentResult.resultHandle);
        expect(replayed.statusCode).toBe(409);
        expect(replayed.json()).toEqual({ error: "identity_connection_test_invalid" });

        const staleResult = await createResult();
        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: { securityRevision: { increment: 1 } },
        });
        const consumed = await consume(staleResult.resultHandle);
        expect(consumed.statusCode).toBe(409);
        expect(consumed.json()).toEqual({ error: "identity_connection_test_invalid" });
        await expect(db.teamIdentityConnection.findUnique({ where: { id: connection.id } }))
            .resolves.toMatchObject({ lastSuccessfulTestAt: testedAt });
    });

    it("binds a registered Team GitHub App from the exact draft the picker offered and enables it", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "GitHub Binding Team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const registration = await db.gitHubAppRegistration.create({
            data: {
                ownerTeamId: team.id,
                githubHost: "https://github.com",
                githubAppId: 981n,
                githubClientId: "Iv1.binding",
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: true,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
                encryptedSecrets: Uint8Array.from([7]),
                state: "verified",
                lastVerifiedAt: new Date("2026-09-01T10:00:00.000Z"),
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 9101n,
                githubOrganizationId: 9201n,
                githubOrganizationLogin: "BindingOrg",
                repositorySelection: "all",
                state: "verified",
                verifiedPermissions: { members: "read" },
                lastVerifiedAt: new Date("2026-09-01T10:00:00.000Z"),
            },
        });
        // A registered App's identity provider is created disabled: it becomes a
        // real sign-in method only when the Team deliberately binds it.
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "github_app_identity",
                displayName: "Binding GitHub",
                enabled: false,
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });
        const previousPolicy = await db.homeGovernancePolicy.findUnique({ where: { id: "home" } });
        await db.homeGovernancePolicy.update({
            where: { id: "home" },
            data: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        try {
            const listed = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/list",
                headers: { "x-test-user-id": owner.id },
                payload: { v: 1, teamId: team.id },
            });
            expect(listed.statusCode, listed.body).toBe(200);
            const offered = listed.json().eligibleProviders
                .find((entry: { providerId: string | null }) => entry.providerId === provider.id);
            expect(offered?.availability).toMatchObject({
                status: "available",
                setupChoice: { kind: "use_existing", providerInstanceId: provider.id },
            });

            // The administrator sends back exactly what they were offered. If
            // the picker and the create path built that draft separately, this
            // verbatim round trip is what breaks.
            const created = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/create",
                headers: { "x-test-user-id": owner.id },
                payload: {
                    v: 1,
                    teamId: team.id,
                    providerInstanceId: provider.id,
                    ...offered.availability.setupChoice.connectionDraft,
                },
            });
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json().connection).toMatchObject({
                teamId: team.id,
                provider: { id: provider.id, kind: "github_app_identity" },
                externalReference: { kind: "github_app_identity", installationId: installation.id },
                settings: { kind: "github_app_identity", organizationLogin: "BindingOrg" },
            });
            // Binding is what makes the provider usable; no GitHub-specific
            // lifecycle owner is involved.
            await expect(db.identityProviderInstance.findUnique({ where: { id: provider.id } }))
                .resolves.toMatchObject({ enabled: true });
        } finally {
            if (previousPolicy) {
                await db.homeGovernancePolicy.update({
                    where: { id: "home" },
                    data: { teamProviderPolicy: previousPolicy.teamProviderPolicy ?? undefined },
                });
            }
        }
    });

    it("returns complete stable connection and eligible-provider projections beyond 100 rows", async () => {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Large identity catalog" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });

        const connectedProviderIds = Array.from(
            { length: 101 },
            (_, index) => `large_connected_provider_${String(index).padStart(3, "0")}`,
        );
        const eligibleProviderIds = Array.from(
            { length: 101 },
            (_, index) => `large_eligible_provider_${String(index).padStart(3, "0")}`,
        );
        const baseCreatedAt = new Date("2030-01-01T00:00:00.000Z").getTime();

        try {
            await db.identityProviderInstance.createMany({
                data: [
                    ...connectedProviderIds.map((id, index) => ({
                        id,
                        ownerTeamId: team.id,
                        kind: "workos_sso" as const,
                        displayName: `Connected provider ${String(index).padStart(3, "0")}`,
                        enabled: false,
                        config: { v: 1, kind: "workos_sso" },
                        createdAt: new Date(baseCreatedAt + index),
                    })),
                    ...eligibleProviderIds.map((id, index) => ({
                        id,
                        ownerTeamId: null,
                        kind: "workos_sso" as const,
                        displayName: `Eligible provider ${String(index).padStart(3, "0")}`,
                        enabled: false,
                        config: { v: 1, kind: "workos_sso" },
                        createdAt: new Date(baseCreatedAt + 1_000 + index),
                    })),
                ],
            });
            await db.teamIdentityConnection.createMany({
                data: connectedProviderIds.map((providerInstanceId, index) => ({
                    id: `large_identity_connection_${String(index).padStart(3, "0")}`,
                    teamId: team.id,
                    providerInstanceId,
                    externalReference: {
                        v: 1,
                        kind: "workos_sso",
                        organizationId: null,
                        connectionId: null,
                    },
                    settings: { v: 1, kind: "workos_sso" },
                    createdAt: new Date(baseCreatedAt + index),
                })),
            });

            const response = await app.inject({
                method: "POST",
                url: "/v1/teams/identity/connections/list",
                headers: { "x-test-user-id": owner.id },
                payload: { v: 1, teamId: team.id },
            });
            expect(response.statusCode, response.body).toBe(200);

            const body = response.json();
            const returnedConnectionIds = body.items
                .map((item: { id: string }) => item.id)
                .filter((id: string) => id.startsWith("large_identity_connection_"));
            const returnedEligibleProviderIds = body.eligibleProviders
                .map((provider: { providerId: string | null }) => provider.providerId)
                .filter((id: string | null): id is string => id?.startsWith("large_eligible_provider_") === true);
            expect(returnedConnectionIds).toEqual(connectedProviderIds.map((_, index) =>
                `large_identity_connection_${String(index).padStart(3, "0")}`));
            expect(returnedEligibleProviderIds).toEqual(eligibleProviderIds);
            expect(returnedConnectionIds.at(-1)).toBe("large_identity_connection_100");
            expect(returnedEligibleProviderIds.at(-1)).toBe("large_eligible_provider_100");
        } finally {
            await db.teamIdentityConnection.deleteMany({ where: { teamId: team.id } });
            await db.identityProviderInstance.deleteMany({
                where: { id: { in: [...connectedProviderIds, ...eligibleProviderIds] } },
            });
            await db.teamMembership.deleteMany({ where: { teamId: team.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
