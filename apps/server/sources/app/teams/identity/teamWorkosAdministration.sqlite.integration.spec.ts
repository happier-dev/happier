import type { WorkOS } from "@workos-inc/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createIdentityConnectionTestResult } from "@/app/api/routes/connect/oauthExternal/identityConnectionTestResult";
import { oauthSecurityBindingSchema } from "@/app/api/routes/connect/oauthExternal/oauthExternalSchemas";
import { TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createTeamWorkosConnection,
    createTeamWorkosAdminPortalLink,
    reconcileTeamWorkosConnection,
    setTeamWorkosConnection,
} from "./teamWorkosAdministration";
import {
    startTeamIdentityConnectionTestForActor,
    consumeTeamIdentityConnectionTestForActor,
    setTeamIdentityConnectionEnabledForActor,
    removeTeamIdentityConnectionForActor,
    preflightTeamIdentityConnectionRemovalForActor,
} from "./teamIdentityConnectionAdministration";
import { listTeamIdentityConnectionsForActor } from "./teamIdentityConnectionAdministration";
import { setTeamIdentityConnectionEnabledInTx, updateTeamIdentityConnectionInTx } from "./teamIdentityConnectionLifecycle";
import { inTx } from "@/storage/inTx";
import { TEAM_CHANGE_ENTITY_ID } from "../teamChanges";

describe("Team WorkOS administration", () => {
    let harness: LightSqliteHarness;
    const interactiveAuthentication = { authenticationAuthority: "present_user" as const };

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-workos-administration-",
            initAuth: true,
        });
        // A fresh Home: no Team-provider narrowing is stored, so WorkOS is
        // allowed by the inherited deployment ceiling (teams-lane-01/02 :230).
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    async function createFixture(input: Readonly<{
        organizationId: string | null;
        connectionId: string | null;
        member?: boolean;
    }>) {
        const actor = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Acme Team" } });
        if (input.member !== false) {
            await db.teamMembership.create({
                data: {
                    teamId: team.id,
                    accountId: actor.id,
                    role: TeamRole.owner,
                    status: TeamMembershipStatus.active,
                },
            });
        }
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Acme SSO",
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
                    organizationId: input.organizationId,
                    connectionId: input.connectionId,
                },
                settings: { v: 1, kind: "workos_sso" },
                createdByAccountId: actor.id,
            },
        });
        return { actor, team, provider, connection };
    }

    function platform(client: WorkOS) {
        return {
            resolvePlatform: vi.fn(() => ({
                available: true as const,
                clientId: "client_exact",
                client,
                runtimeFingerprint: "workos-platform:v1:exact",
            })),
            resolveServerIdentityId: vi.fn(async () => "server_home"),
        };
    }

    it("creates Home company bindings without a Team and keeps administrator mutations closed", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const otherOwner = await db.account.create({ data: { homeRole: "owner" } });
        const admin = await db.account.create({ data: { homeRole: "admin" } });
        const dependencies = platform({} as WorkOS);
        const teamCount = await db.team.count();
        const [created, concurrent] = await Promise.all([owner, otherOwner].map((actor) => createTeamWorkosConnection({
            ...interactiveAuthentication, v: 1, teamId: null,
            actorAccountId: actor.id, displayName: "Company SSO", env: {},
        }, dependencies)));
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        expect(concurrent).toEqual(created);
        expect(created.value).toMatchObject({ teamId: null, provider: { kind: "workos_sso", displayName: "Company SSO" } });
        expect(await db.team.count()).toBe(teamCount);
        expect(await db.identityProviderInstance.findUnique({ where: { id: created.value.provider.id } }))
            .toMatchObject({ ownerTeamId: null });
        expect(await createTeamWorkosConnection({
            ...interactiveAuthentication, v: 1, teamId: null,
            actorAccountId: owner.id, displayName: "Company SSO", env: {},
        }, dependencies)).toEqual(created);
        expect(await listTeamIdentityConnectionsForActor({ teamId: null, actorAccountId: admin.id, env: {} }))
            .toMatchObject({ ok: true, value: { items: [{ id: created.value.id, allowedActions: [] }] } });
        dependencies.resolvePlatform.mockClear();
        expect(await createTeamWorkosAdminPortalLink({
            ...interactiveAuthentication, actorAccountId: admin.id, teamId: null,
            connectionId: created.value.id, intent: "sso", env: {},
        }, dependencies)).toEqual({ ok: false, error: "home_forbidden" });
        expect(dependencies.resolvePlatform).not.toHaveBeenCalled();
        expect(await db.homeAdministrationEvent.findFirst({ where: { targetId: created.value.provider.id } }))
            .toMatchObject({ action: "identity_provider.create" });
    });

    it("authorizes the Team actor before resolving the platform or calling WorkOS", async () => {
        const fixture = await createFixture({
            organizationId: "org_exact",
            connectionId: null,
            member: false,
        });
        const dependencies = platform({} as WorkOS);

        await expect(createTeamWorkosAdminPortalLink({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            intent: "sso",
            env: { HAPPIER_WEBAPP_URL: "https://app.example.test" },
        }, dependencies)).resolves.toEqual({ ok: false, error: "team_not_found" });

        expect(dependencies.resolvePlatform).not.toHaveBeenCalled();
        expect(dependencies.resolveServerIdentityId).not.toHaveBeenCalled();

        await expect(createTeamWorkosConnection({
            ...interactiveAuthentication,
            v: 1,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            env: {},
        }, dependencies)).resolves.toEqual({ ok: false, error: "team_not_found" });
        expect(dependencies.resolvePlatform).not.toHaveBeenCalled();
        await expect(db.identityProviderInstance.count({
            where: { ownerTeamId: fixture.team.id, kind: "workos_sso" },
        })).resolves.toBe(1);
    });

    it("starts and consumes a disabled Home test without admitting an identity, then refuses stale results", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: null, kind: "workos_sso", displayName: "Home test SSO", enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_home_test", connectionId: "conn_home_test" },
            settings: { v: 1, kind: "workos_sso" }, createdByAccountId: owner.id,
        } });
        const readAdmissionState = async () => await Promise.all([
            db.account.count(), db.accountIdentity.count(), db.team.count(), db.teamMembership.count(),
            db.accountApiToken.count(), db.teamProvisionedIdentity.count(), db.teamDirectorySource.count(),
        ]);
        const before = await readAdmissionState();
        const env = {
            WORKOS_API_KEY: "sk_test_exact", WORKOS_CLIENT_ID: "client_exact",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_WEBAPP_URL: "https://app.example.test",
        };
        const input = {
            ...interactiveAuthentication, v: 1 as const, actorAccountId: owner.id, teamId: null,
            connectionId: connection.id, env,
        };
        const result = await startTeamIdentityConnectionTestForActor({
            ...input, expectedRevision: 1,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        expect(new URL(result.value.authorizeUrl).searchParams.get("connection")).toBe("conn_home_test");
        const stored = await db.repeatKey.findUniqueOrThrow({ where: { key: `oauth_state_${result.value.attemptId}` } });
        expect(JSON.parse(stored.value)).toMatchObject({ securityBinding: {
            provider: { id: provider.id, context: { kind: "home" } },
            connection: { id: connection.id, revision: 1 }, purpose: "identity_connection_test",
        } });
        expect(await readAdmissionState()).toEqual(before);
        const securityBinding = oauthSecurityBindingSchema.parse(JSON.parse(stored.value).securityBinding);
        const testedAt = new Date();
        const createResult = async () => await createIdentityConnectionTestResult({
            initiatorAccountId: owner.id, securityBinding, providerUserId: "profile_home_test",
            testedAt, expiresAt: stored.expiresAt,
        });
        const successful = await createResult();
        expect(await consumeTeamIdentityConnectionTestForActor({ ...input, resultHandle: successful.resultHandle }))
            .toMatchObject({ ok: true, value: { connection: { id: connection.id, teamId: null, enabled: false } } });
        expect(await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connection.id } }))
            .toMatchObject({ enabled: false, firstEnabledAt: null, revision: 1, lastSuccessfulTestAt: testedAt });
        expect(await readAdmissionState()).toEqual(before);
        expect(await consumeTeamIdentityConnectionTestForActor({ ...input, resultHandle: successful.resultHandle }))
            .toEqual({ ok: false, error: "identity_connection_test_invalid" });

        const stale = await createResult();
        expect(await inTx((tx) => updateTeamIdentityConnectionInTx(tx, {
            id: connection.id, teamId: null, expectedRevision: 1,
            settings: { v: 1, kind: "workos_sso" },
        }))).toMatchObject({ status: "applied" });
        expect(await consumeTeamIdentityConnectionTestForActor({ ...input, resultHandle: stale.resultHandle }))
            .toEqual({ ok: false, error: "identity_connection_test_invalid" });
        expect(await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connection.id } }))
            .toMatchObject({ enabled: false, firstEnabledAt: null, revision: 2, lastSuccessfulTestAt: testedAt });
        expect(await readAdmissionState()).toEqual(before);
    });

    it("uses the shared Home Portal, selection and disable/removal lifecycle while rejecting Directory Sync", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: null, kind: "workos_sso", displayName: "Company lifecycle SSO", enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: null, connectionId: null },
            settings: { v: 1, kind: "workos_sso" }, createdByAccountId: owner.id,
        } });
        const env = {
            WORKOS_API_KEY: "sk_test_exact", WORKOS_CLIENT_ID: "client_exact",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_WEBAPP_URL: "https://app.example.test",
        };
        const generateLink = vi.fn(async () => ({ link: "https://setup.workos.test/portal" }));
        const getConnection = vi.fn(async () => ({
            id: "conn_home_lifecycle", organizationId: "org_home_lifecycle", name: "Company SSO", type: "SAML", state: "active",
        }));
        const deleteConnection = vi.fn(async () => undefined);
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(async () => ({ id: "org_home_lifecycle", name: "Company" })) },
            adminPortal: { generateLink }, sso: { getConnection, deleteConnection },
        } as unknown as WorkOS);
        const input = { ...interactiveAuthentication, teamId: null, actorAccountId: owner.id, connectionId: connection.id, env };
        expect(await createTeamWorkosAdminPortalLink({ ...input, intent: "dsync" }, dependencies))
            .toEqual({ ok: false, error: "identity_connection_invalid" });
        expect(generateLink).not.toHaveBeenCalled();
        expect(await createTeamWorkosAdminPortalLink({ ...input, intent: "sso" }, dependencies)).toMatchObject({ ok: true });
        expect(generateLink).toHaveBeenCalledWith({
            organization: "org_home_lifecycle", intent: "sso",
            returnUrl: `https://app.example.test/settings/home/server_home/sign-in-providers/connections/${connection.id}?purpose=workos_admin_portal`,
        });
        const selected = await setTeamWorkosConnection({ ...input, expectedRevision: 2, workosConnectionId: "conn_home_lifecycle" }, dependencies);
        expect(selected.ok).toBe(true);
        if (!selected.ok) throw new Error(selected.error);
        expect(selected.value.allowedActions).toContain("home.identity.connections.test.start");
        const enabled = await setTeamIdentityConnectionEnabledForActor({ ...input, v: 1, expectedRevision: selected.value.revision, enabled: true }, dependencies);
        expect(enabled.ok).toBe(true);
        if (!enabled.ok) throw new Error(enabled.error);
        const disabled = await setTeamIdentityConnectionEnabledForActor({ ...input, v: 1, expectedRevision: enabled.value.revision, enabled: false }, dependencies);
        expect(disabled.ok).toBe(true);
        if (!disabled.ok) throw new Error(disabled.error);
        expect(await removeTeamIdentityConnectionForActor({ ...input, v: 1, expectedRevision: disabled.value.revision }, dependencies))
            .toEqual({ ok: true, value: { outcome: "removed" } });
        expect(await db.teamIdentityConnection.findUnique({ where: { id: connection.id } })).toBeNull();
        expect(deleteConnection).toHaveBeenCalledWith("conn_home_lifecycle");
        expect(await db.homeAdministrationEvent.findMany({ where: { targetId: provider.id }, select: { action: true } }))
            .toEqual(expect.arrayContaining([{ action: "identity_provider.enable" }, { action: "identity_provider.disable" }, { action: "identity_provider.remove" }]));
    });

    it("protects shared provider bindings and Team Home-method choices before Home removal", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: null, kind: "workos_sso", displayName: "Shared Home SSO", enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const externalReference = { v: 1, kind: "workos_sso", organizationId: "org_shared", connectionId: "conn_shared" };
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id, externalReference,
            settings: { v: 1, kind: "workos_sso" }, createdByAccountId: owner.id,
        } });
        const team = await db.team.create({ data: { name: "Shared Home authentication", authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: provider.id }],
        } } });
        await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id, externalReference,
            settings: { v: 1, kind: "workos_sso" },
        } });
        const result = await preflightTeamIdentityConnectionRemovalForActor({
            ...interactiveAuthentication, v: 1, teamId: null, actorAccountId: owner.id,
            connectionId: connection.id, expectedRevision: 1, env: {},
        });
        expect(result).toMatchObject({ ok: true, value: { canRemove: false,
            blockers: expect.arrayContaining(["identity_connection_in_use", "team_authentication_policy_in_use"]),
        } });
        const dependencies = platform({} as WorkOS);
        expect(await removeTeamIdentityConnectionForActor({
            ...interactiveAuthentication, v: 1, teamId: null, actorAccountId: owner.id,
            connectionId: connection.id, expectedRevision: 1, env: {},
        }, dependencies)).toEqual({ ok: false, error: "identity_provider_in_use" });
        expect(dependencies.resolvePlatform).not.toHaveBeenCalled();
        expect(await db.teamIdentityConnection.count({ where: { providerInstanceId: provider.id } })).toBe(2);
    });

    it("binds directory-recovery portal links to the exact current WorkOS source", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: null });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: fixture.team.id,
                kind: "workos_directory",
                state: "needs_attention",
                displayName: "Primary directory",
                externalSourceKey: "workos:org_exact:directory_exact",
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_exact" },
                teamIdentityConnectionId: fixture.connection.id,
            },
        });
        const otherProvider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: fixture.team.id,
                kind: "workos_sso",
                displayName: "Other WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const otherConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: fixture.team.id,
                providerInstanceId: otherProvider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org_other",
                    connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
                createdByAccountId: fixture.actor.id,
            },
        });
        const portalDependencies = platform({} as WorkOS);
        // The provider call is intentionally irrelevant to these failures: the
        // current source binding must fail before any external work begins.
        await expect(createTeamWorkosAdminPortalLink({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: otherConnection.id,
            directorySourceId: source.id,
            intent: "dsync",
            env: {},
        }, portalDependencies)).resolves.toEqual({ ok: false, error: "identity_connection_invalid" });
        expect(portalDependencies.resolvePlatform).not.toHaveBeenCalled();

        const generateLink = vi.fn(async () => ({ link: "https://setup.workos.test/dsync" }));
        const exactDependencies = platform({
            adminPortal: { generateLink },
        } as unknown as WorkOS);
        await expect(createTeamWorkosAdminPortalLink({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            directorySourceId: source.id,
            intent: "dsync",
            env: { HAPPIER_WEBAPP_URL: "https://app.example.test" },
        }, exactDependencies)).resolves.toEqual({
            ok: true,
            value: { url: "https://setup.workos.test/dsync" },
        });
        expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({
            organization: "org_exact",
            intent: "dsync",
        }));
    });

    it("does not create a provider or draft when the Home WorkOS platform is unavailable", async () => {
        const actor = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Unavailable WorkOS" } });
        await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: actor.id,
            role: TeamRole.owner,
            status: TeamMembershipStatus.active,
        } });

        await expect(createTeamWorkosConnection({
            ...interactiveAuthentication,
            v: 1,
            actorAccountId: actor.id,
            teamId: team.id,
            env: {},
        }, {
            resolvePlatform: () => ({
                available: false,
                code: "workos_platform_unavailable",
                reason: "not_configured",
            }),
        })).resolves.toEqual({ ok: false, error: "workos_platform_unavailable" });
        await expect(db.identityProviderInstance.count({ where: { ownerTeamId: team.id } })).resolves.toBe(0);
        await expect(db.teamIdentityConnection.count({ where: { teamId: team.id } })).resolves.toBe(0);
    });

    it("reuses the one canonical WorkOS provider and Team connection on create replay", async () => {
        const actor = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Idempotent WorkOS" } });
        await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: actor.id,
            role: TeamRole.owner,
            status: TeamMembershipStatus.active,
        } });
        const dependencies = platform({} as WorkOS);
        const input = {
            v: 1 as const,
            actorAccountId: actor.id,
            teamId: team.id,
            env: {},
            authenticationAuthority: "present_user" as const,
        };

        const created = await createTeamWorkosConnection(input, dependencies);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const changeAfterCreate = await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: actor.id,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        });
        await expect(createTeamWorkosConnection(input, dependencies)).resolves.toEqual(created);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: actor.id,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.toMatchObject({ cursor: changeAfterCreate.cursor });
        await expect(db.identityProviderInstance.count({
            where: { ownerTeamId: team.id, kind: "workos_sso" },
        })).resolves.toBe(1);
        await expect(db.teamIdentityConnection.count({ where: { teamId: team.id } })).resolves.toBe(1);
    });

    it("recovers an activated namespace with a coexisting new provider connection and leaves the old one immutable", async () => {
        const actor = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: "Recovering WorkOS" } });
        await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: actor.id,
            role: TeamRole.owner,
            status: TeamMembershipStatus.active,
        } });
        let upstream = [
            { id: "conn_old", organizationId: "org_recover", name: "Acme Okta", type: "SAML", state: "active" },
        ];
        const dependencies = platform({
            organizations: {
                getOrganizationByExternalId: vi.fn(async () => ({ id: "org_recover", name: "Recovering WorkOS" })),
                createOrganization: vi.fn(),
            },
            adminPortal: { generateLink: vi.fn(async () => ({ link: "https://setup.workos.test/portal" })) },
            sso: {
                listConnections: vi.fn(async () => ({ data: upstream, listMetadata: { after: null } })),
                getConnection: vi.fn(async (id: string) => upstream.find((row) => row.id === id)),
            },
        } as unknown as WorkOS);
        const input = {
            ...interactiveAuthentication,
            v: 1 as const,
            actorAccountId: actor.id,
            teamId: team.id,
            env: { HAPPIER_WEBAPP_URL: "https://app.example.test" },
        };
        const setUp = async (connectionId: string) => {
            await expect(createTeamWorkosAdminPortalLink({ ...input, connectionId, intent: "sso" }, dependencies))
                .resolves.toMatchObject({ ok: true });
            const { revision } = await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connectionId } });
            return await reconcileTeamWorkosConnection({ ...input, connectionId, expectedRevision: revision }, dependencies);
        };

        const original = await createTeamWorkosConnection(input, dependencies);
        if (!original.ok) throw new Error(`create failed: ${original.error}`);
        await expect(setUp(original.value.id)).resolves.toMatchObject({ ok: true, value: { outcome: "connected" } });
        const configured = await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: original.value.id } });
        await expect(inTx((tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: original.value.id,
            teamId: team.id,
            expectedRevision: configured.revision,
            enabled: true,
        }))).resolves.toMatchObject({ status: "applied" });

        // The IdP connection is replaced upstream. The activated namespace is retained for diagnosis.
        upstream = [{ id: "conn_new", organizationId: "org_recover", name: "Acme Entra", type: "SAML", state: "active" }];
        const enabled = await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: original.value.id } });
        await expect(reconcileTeamWorkosConnection({
            ...input,
            connectionId: original.value.id,
            expectedRevision: enabled.revision,
        }, dependencies)).resolves.toMatchObject({ ok: true, value: { outcome: "needs_attention" } });

        // Recovery creates a new provider instance/Team connection beside the old one (child 03 §6.3.7).
        const replacement = await createTeamWorkosConnection(input, dependencies);
        if (!replacement.ok) throw new Error(`replacement failed: ${replacement.error}`);
        expect(replacement.value.id).not.toBe(original.value.id);
        expect(replacement.value.provider.id).not.toBe(original.value.provider.id);
        await expect(createTeamWorkosConnection(input, dependencies)).resolves.toMatchObject({
            ok: true,
            value: { id: replacement.value.id },
        });
        await expect(setUp(replacement.value.id)).resolves.toMatchObject({
            ok: true,
            value: {
                outcome: "connected",
                connection: { externalReference: { organizationId: "org_recover", connectionId: "conn_new" } },
            },
        });

        const old = await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: original.value.id } });
        expect(old.externalReference).toEqual({
            v: 1,
            kind: "workos_sso",
            organizationId: "org_recover",
            connectionId: "conn_old",
        });
        expect(old.enabled).toBe(true);
        expect(old.firstEnabledAt).not.toBeNull();
        await expect(db.teamIdentityConnection.count({ where: { teamId: team.id } })).resolves.toBe(2);
        await expect(db.identityProviderInstance.count({
            where: { ownerTeamId: team.id, kind: "workos_sso" },
        })).resolves.toBe(2);
    });

    it("resumes deterministic organization setup and returns an unpersisted exact-Team portal link", async () => {
        const fixture = await createFixture({ organizationId: null, connectionId: null });
        const getOrganizationByExternalId = vi.fn(async () => ({ id: "org_exact", name: "Acme Team" }));
        const generateLink = vi.fn(async () => ({ link: "https://setup.workos.test/portal" }));
        const dependencies = platform({
            organizations: { getOrganizationByExternalId, createOrganization: vi.fn() },
            adminPortal: { generateLink },
            sso: { listConnections: vi.fn(), getConnection: vi.fn() },
        } as unknown as WorkOS);

        await expect(createTeamWorkosAdminPortalLink({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            intent: "sso",
            env: { HAPPIER_WEBAPP_URL: "https://app.example.test" },
        }, dependencies)).resolves.toEqual({
            ok: true,
            value: { url: "https://setup.workos.test/portal" },
        });

        expect(dependencies.resolvePlatform).toHaveBeenCalledWith(
            expect.anything(),
            { timeoutMs: 30_000, maxRetries: 2 },
        );
        expect(getOrganizationByExternalId).toHaveBeenCalledWith(
            `happier:server_home:team:${fixture.team.id}`,
        );
        expect(generateLink).toHaveBeenCalledWith({
            organization: "org_exact",
            intent: "sso",
            returnUrl: `https://app.example.test/settings/teams/server_home/${fixture.team.id}/authentication/${fixture.connection.id}?purpose=workos_admin_portal`,
        });
        const stored = await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } });
        expect(stored.externalReference).toEqual({
            v: 1,
            kind: "workos_sso",
            organizationId: "org_exact",
            connectionId: null,
        });
        expect(stored.revision).toBe(2);
        expect(JSON.stringify(stored)).not.toContain("setup.workos.test");
    });

    it("requires explicit selection among multiple exact active connections and persists only the fetched choice", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: null });
        const rows = [
            { id: "conn_one", organizationId: "org_exact", name: "Acme Okta", type: "SAML", state: "active" },
            { id: "conn_two", organizationId: "org_exact", name: "Acme Entra", type: "SAML", state: "active" },
        ];
        const listConnections = vi.fn(async () => ({ data: rows, listMetadata: { after: null } }));
        const getConnection = vi.fn(async (id: string) => rows.find((row) => row.id === id));
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections, getConnection },
        } as unknown as WorkOS);

        const reconciled = await reconcileTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            env: {},
        }, dependencies);
        expect(reconciled).toMatchObject({
            ok: true,
            value: {
                outcome: "selection_required",
                connection: { revision: 1 },
                candidates: [
                    { connectionId: "conn_one", displayName: "Acme Okta", status: "active" },
                    { connectionId: "conn_two", displayName: "Acme Entra", status: "active" },
                ],
            },
        });
        expect(getConnection).not.toHaveBeenCalled();

        await expect(setTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            workosConnectionId: "conn_two",
            env: {},
        }, dependencies)).resolves.toMatchObject({
            ok: true,
            value: {
                revision: 2,
                externalReference: { organizationId: "org_exact", connectionId: "conn_two" },
                lastObservation: {
                    presentation: { displayName: "Acme Entra", status: "active" },
                },
            },
        });
    });

    it("maps a malformed WorkOS connection page to the canonical unavailable result without mutating the binding", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: null });
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: {
                listConnections: vi.fn(async () => ({ data: [] })),
                getConnection: vi.fn(),
            },
        } as unknown as WorkOS);

        await expect(reconcileTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            env: {},
        }, dependencies)).resolves.toEqual({
            ok: false,
            error: "identity_provider_unavailable",
        });
        await expect(db.teamIdentityConnection.findUniqueOrThrow({
            where: { id: fixture.connection.id },
        })).resolves.toMatchObject({
            revision: 1,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org_exact",
                connectionId: null,
            },
        });
    });

    it("lets an explicit selection correct a draft choice until the namespace is activated", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: "conn_wrong" });
        const rows = [
            { id: "conn_wrong", organizationId: "org_exact", name: "Acme Sandbox", type: "SAML", state: "active" },
            { id: "conn_right", organizationId: "org_exact", name: "Acme Okta", type: "SAML", state: "active" },
        ];
        const getConnection = vi.fn(async (id: string) => rows.find((row) => row.id === id));
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: { listConnections: vi.fn(), getConnection },
        } as unknown as WorkOS);

        // Never enabled and never linked: child 03 §6.3.7 lets the admin replace the
        // draft choice, and the connection lifecycle owner is what decides that.
        await expect(setTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            workosConnectionId: "conn_right",
            env: {},
        }, dependencies)).resolves.toMatchObject({
            ok: true,
            value: {
                revision: 2,
                externalReference: { organizationId: "org_exact", connectionId: "conn_right" },
                lastObservation: { presentation: { displayName: "Acme Okta", status: "active" } },
            },
        });

        // Once the exact connection has been enabled it defines the provider
        // namespace that existing AccountIdentity rows were issued under, so the
        // same explicit selection must now fail closed rather than rebind it.
        await db.teamIdentityConnection.update({
            where: { id: fixture.connection.id },
            data: { firstEnabledAt: new Date("2026-09-08T00:00:00.000Z") },
        });
        await expect(setTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 2,
            workosConnectionId: "conn_wrong",
            env: {},
        }, dependencies)).resolves.toEqual({
            ok: false,
            error: "workos_connection_mismatch",
        });
        const unchanged = await db.teamIdentityConnection.findUniqueOrThrow({
            where: { id: fixture.connection.id },
            select: { externalReference: true },
        });
        expect(unchanged.externalReference).toMatchObject({ connectionId: "conn_right" });
    });

    it("retains a missing exact connection as an immutable namespace needing attention", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: "conn_stale" });
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: {
                listConnections: vi.fn(async () => ({ data: [], listMetadata: { after: null } })),
                getConnection: vi.fn(),
            },
        } as unknown as WorkOS);

        const reconciled = await reconcileTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            // The projected state reads platform availability and the callback
            // origin from the environment, exactly as the list does; the
            // injected client only answers requests.
            env: {
                WORKOS_API_KEY: "sk_test_exact",
                WORKOS_CLIENT_ID: "client_exact",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            },
        }, dependencies);

        expect(reconciled).toMatchObject({
            ok: true,
            value: {
                outcome: "needs_attention",
                connection: {
                    externalReference: { organizationId: "org_exact", connectionId: "conn_stale" },
                    state: "needs_attention",
                },
            },
        });
        await expect(db.teamIdentityConnection.findUniqueOrThrow({
            where: { id: fixture.connection.id },
        })).resolves.toMatchObject({
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_exact", connectionId: "conn_stale" },
        });
    });

    it("observes the exact selected connection without reopening selection when other active connections exist", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: "conn_selected" });
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: {
                listConnections: vi.fn(async () => ({ data: [
                    { id: "conn_other", organizationId: "org_exact", name: "Other IdP", type: "SAML", state: "active" },
                    { id: "conn_selected", organizationId: "org_exact", name: "Selected IdP", type: "SAML", state: "active" },
                ], listMetadata: { after: null } })),
                getConnection: vi.fn(),
            },
        } as unknown as WorkOS);

        await expect(reconcileTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            env: {},
        }, dependencies)).resolves.toMatchObject({
            ok: true,
            value: {
                outcome: "connected",
                connection: {
                    externalReference: { connectionId: "conn_selected" },
                    lastObservation: { presentation: { displayName: "Selected IdP" } },
                },
            },
        });
    });

    it("does not rebind a missing exact selection to the only remaining active connection", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: "conn_missing" });
        const dependencies = platform({
            organizations: { getOrganizationByExternalId: vi.fn(), createOrganization: vi.fn() },
            adminPortal: { generateLink: vi.fn() },
            sso: {
                listConnections: vi.fn(async () => ({ data: [
                    { id: "conn_replacement", organizationId: "org_exact", name: "Replacement IdP", type: "SAML", state: "active" },
                ], listMetadata: { after: null } })),
                getConnection: vi.fn(),
            },
        } as unknown as WorkOS);

        await expect(reconcileTeamWorkosConnection({
            ...interactiveAuthentication,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            // The projected state reads platform availability and the callback
            // origin from the environment, exactly as the list does; the
            // injected client only answers requests.
            env: {
                WORKOS_API_KEY: "sk_test_exact",
                WORKOS_CLIENT_ID: "client_exact",
                HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            },
        }, dependencies)).resolves.toMatchObject({
            ok: true,
            value: {
                outcome: "needs_attention",
                connection: {
                    externalReference: { connectionId: "conn_missing" },
                    state: "needs_attention",
                },
            },
        });
    });

    it("starts one non-mutating test attempt bound to the exact connection revision", async () => {
        const fixture = await createFixture({ organizationId: "org_exact", connectionId: "conn_exact" });
        const env = {
            WORKOS_API_KEY: "sk_test_exact",
            WORKOS_CLIENT_ID: "client_exact",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            HAPPIER_WEBAPP_URL: "https://app.example.test",
        };

        const result = await startTeamIdentityConnectionTestForActor({
            ...interactiveAuthentication,
            v: 1,
            actorAccountId: fixture.actor.id,
            teamId: fixture.team.id,
            connectionId: fixture.connection.id,
            expectedRevision: 1,
            env,
        });
        expect(result).toMatchObject({ ok: true, value: { authorizeUrl: expect.any(String), attemptId: expect.any(String) } });
        if (!result.ok) throw new Error("test attempt was not created");
        expect(new URL(result.value.authorizeUrl).searchParams.get("connection"))
            .toBe("conn_exact");
        const stored = await db.repeatKey.findUniqueOrThrow({
            where: { key: `oauth_state_${result.value.attemptId}` },
        });
        expect(JSON.parse(stored.value)).toMatchObject({
            securityBinding: {
                provider: {
                    id: fixture.provider.id,
                    context: { kind: "team", teamId: fixture.team.id },
                },
                connection: { id: fixture.connection.id, revision: 1 },
                purpose: "identity_connection_test",
            },
        });
        expect(await db.accountIdentity.count()).toBe(0);
    });
});
