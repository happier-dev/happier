import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createTeamIdentityConnectionInTx,
    deleteTeamIdentityConnectionInTx,
    listTeamIdentityConnectionsInTx,
    readTeamIdentityConnectionInTx,
    recordTeamIdentityConnectionTestInTx,
    setTeamIdentityConnectionEnabledInTx,
    updateTeamIdentityConnectionInTx,
} from "./teamIdentityConnectionLifecycle";

describe("TeamIdentityConnection lifecycle", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-identity-connection-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    async function createProvider(input: Readonly<{
        ownerTeamId: string | null;
        kind?: "workos_sso" | "oidc" | "github_app_identity";
        githubAppInstallationId?: string;
        enabled?: boolean;
    }>) {
        return await db.identityProviderInstance.create({
            data: {
                ownerTeamId: input.ownerTeamId,
                kind: input.kind ?? "workos_sso",
                displayName: "Company identity",
                enabled: input.enabled ?? true,
                firstEnabledAt: input.enabled === false ? null : new Date("2026-09-06T00:00:00.000Z"),
                config: input.kind === "oidc"
                    ? {
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
                    }
                    : input.kind === "github_app_identity"
                        ? { v: 1, kind: "github_app_identity" }
                        : { v: 1, kind: "workos_sso" },
                ...(input.githubAppInstallationId
                    ? { githubAppInstallationId: input.githubAppInstallationId }
                    : {}),
            },
        });
    }

    const workosDocuments = {
        externalReference: {
            v: 1 as const,
            kind: "workos_sso" as const,
            organizationId: "org_Exact",
            connectionId: "conn_Exact",
        },
        settings: { v: 1 as const, kind: "workos_sso" as const },
    };

    it("persists Home bindings in the shared lifecycle without allowing Team-provider or directory attachment", async () => {
        const homeProvider = await createProvider({ ownerTeamId: null });
        const team = await db.team.create({ data: { name: "Separate company" } });
        const teamProvider = await createProvider({ ownerTeamId: team.id });
        const created = await inTx((tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: null,
            providerInstanceId: homeProvider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(created.status).toBe("created");
        if (created.status !== "created") throw new Error("Home binding missing");
        expect(created.connection.teamId).toBeNull();
        expect(await inTx((tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: null,
            providerInstanceId: teamProvider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }))).toEqual({ status: "provider_not_available" });
        const enabled = await inTx((tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: created.connection.id, teamId: null, expectedRevision: 1, enabled: true,
        }));
        expect(enabled.status).toBe("applied");
        expect(await inTx((tx) => updateTeamIdentityConnectionInTx(tx, {
            id: created.connection.id, teamId: null, expectedRevision: 2,
            externalReference: { ...workosDocuments.externalReference, connectionId: "different" },
        }))).toMatchObject({ status: "immutable_external_identity" });
        await expect(db.teamDirectorySource.create({ data: {
            teamId: team.id,
            teamIdentityConnectionId: created.connection.id,
            kind: "workos_directory",
            displayName: "Rejected Home directory",
            externalSourceKey: `workos:org_Exact:${created.connection.id}`,
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_home" },
        } })).rejects.toMatchObject({ code: "P2003" });
        expect(await inTx((tx) => listTeamIdentityConnectionsInTx(tx, { teamId: team.id }))).toEqual([]);
        expect((await inTx((tx) => listTeamIdentityConnectionsInTx(tx, { teamId: null }))).map((row) => row.id))
            .toContain(created.connection.id);
    });

    it("keeps one exact WorkOS namespace when a Home provider is shared across scopes", async () => {
        const provider = await createProvider({ ownerTeamId: null });
        const team = await db.team.create({ data: { name: "Home provider consumer" } });
        const otherTeam = await db.team.create({ data: { name: "Rejected namespace" } });
        const home = await inTx((tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: null, providerInstanceId: provider.id, ...workosDocuments, createdByAccountId: null,
        }));
        expect(home.status).toBe("created");
        if (home.status !== "created") throw new Error("Home namespace missing");
        const shared = await inTx((tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id, providerInstanceId: provider.id, ...workosDocuments, createdByAccountId: null,
        }));
        expect(shared.status).toBe("created");
        expect(await inTx((tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: otherTeam.id, providerInstanceId: provider.id, createdByAccountId: null,
            settings: workosDocuments.settings,
            externalReference: { ...workosDocuments.externalReference, connectionId: "conn_Different" },
        }))).toEqual({ status: "invalid_document" });
        expect(await inTx((tx) => updateTeamIdentityConnectionInTx(tx, {
            id: home.connection.id, teamId: null, expectedRevision: 1,
            externalReference: { ...workosDocuments.externalReference, organizationId: "org_Different" },
        }))).toEqual({ status: "invalid_document" });
        await db.teamIdentityConnection.update({ where: { id: home.connection.id }, data: {
            externalReference: { ...workosDocuments.externalReference, connectionId: "conn_LegacyDivergent" },
        } });
        expect(await inTx((tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: home.connection.id, teamId: null, expectedRevision: 1, enabled: true,
        }))).toEqual({ status: "invalid_document" });
    });

    it("withdraws already-enabled divergent WorkOS namespaces from exact reads and scope lists", async () => {
        const provider = await createProvider({ ownerTeamId: null });
        const team = await db.team.create({ data: { name: "Legacy namespace consumer" } });
        const home = await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id, ...workosDocuments,
            enabled: true, firstEnabledAt: new Date(),
        } });
        const shared = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id, settings: workosDocuments.settings,
            externalReference: { ...workosDocuments.externalReference, connectionId: "conn_LegacyDivergent" },
            enabled: true, firstEnabledAt: new Date(),
        } });
        expect.soft(await inTx((tx) => readTeamIdentityConnectionInTx(tx, { id: home.id, teamId: null })))
            .toEqual({ status: "unreadable" });
        expect.soft(await inTx((tx) => readTeamIdentityConnectionInTx(tx, { id: shared.id, teamId: team.id })))
            .toEqual({ status: "unreadable" });
        expect.soft((await inTx((tx) => listTeamIdentityConnectionsInTx(tx, { teamId: null }))).map((row) => row.id))
            .not.toContain(home.id);
        expect.soft((await inTx((tx) => listTeamIdentityConnectionsInTx(tx, { teamId: team.id }))).map((row) => row.id))
            .not.toContain(shared.id);
    });

    it("creates only exact same-Team or Home-provider bindings and returns a redacted projection", async () => {
        const teamA = await db.team.create({ data: { name: "Team A" } });
        const teamB = await db.team.create({ data: { name: "Team B" } });
        const teamProvider = await createProvider({ ownerTeamId: teamA.id });
        const homeProvider = await createProvider({ ownerTeamId: null });

        const wrongOwner = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: teamB.id,
            providerInstanceId: teamProvider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(wrongOwner).toEqual({ status: "provider_not_available" });

        const malformed = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: teamA.id,
            providerInstanceId: teamProvider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_Exact", connectionId: "" },
            settings: workosDocuments.settings,
            createdByAccountId: null,
        }));
        expect(malformed).toEqual({ status: "invalid_document" });

        const created = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: teamA.id,
            providerInstanceId: homeProvider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(created.status).toBe("created");
        if (created.status !== "created") return;
        expect(created.connection).toMatchObject({
            teamId: teamA.id,
            providerInstanceId: homeProvider.id,
            providerKind: "workos_sso",
            enabled: false,
            firstEnabledAt: null,
            revision: 1,
            state: "setting_up",
            externalReference: workosDocuments.externalReference,
            settings: workosDocuments.settings,
            lastSuccessfulTest: null,
        });
        expect(JSON.stringify(created.connection)).not.toContain("encryptedSecrets");

        const replayed = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: teamA.id,
            providerInstanceId: homeProvider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(replayed).toEqual({ status: "already_exists", connection: created.connection });

        await expect(inTx(async (tx) => listTeamIdentityConnectionsInTx(tx, { teamId: teamA.id })))
            .resolves.toEqual([created.connection]);
    });

    it("binds a GitHub identity connection only to its provider's exact installation", async () => {
        const team = await db.team.create({ data: { name: "GitHub identity Team" } });
        const registration = await db.gitHubAppRegistration.create({
            data: {
                ownerTeamId: team.id,
                githubHost: "https://github.com",
                githubAppId: 910n,
                githubClientId: "Iv1.identity",
                config: { v: 1 },
                encryptedSecrets: Uint8Array.from([1]),
            },
        });
        const installations = await Promise.all([911n, 912n].map(async (githubInstallationId) =>
            await db.gitHubAppInstallation.create({
                data: {
                    registrationId: registration.id,
                    githubInstallationId,
                    githubOrganizationId: githubInstallationId + 100n,
                    githubOrganizationLogin: `organization-${githubInstallationId}`,
                    repositorySelection: "all",
                    state: "verified",
                },
            })));
        const provider = await createProvider({
            ownerTeamId: team.id,
            kind: "github_app_identity",
            githubAppInstallationId: installations[0]!.id,
        });
        const documents = {
            settings: {
                v: 1 as const,
                kind: "github_app_identity" as const,
                organizationLogin: installations[0]!.githubOrganizationLogin,
            },
        };

        await expect(inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "github_app_identity",
                installationId: installations[1]!.id,
            },
            ...documents,
            createdByAccountId: null,
        }))).resolves.toEqual({ status: "invalid_document" });
        await expect(inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "github_app_identity",
                installationId: installations[0]!.id,
            },
            ...documents,
            createdByAccountId: null,
        }))).resolves.toMatchObject({ status: "created" });
    });

    it("fences revisions, preserves the first-enable boundary, and keeps namespace identity immutable", async () => {
        const team = await db.team.create({ data: { name: "Lifecycle Team" } });
        const provider = await createProvider({ ownerTeamId: team.id });
        const created = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id,
            providerInstanceId: provider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(created.status).toBe("created");
        if (created.status !== "created") return;

        expect(await inTx(async (tx) => updateTeamIdentityConnectionInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 9,
            settings: workosDocuments.settings,
        }))).toMatchObject({ status: "revision_conflict", connection: { revision: 1 } });

        const enabledAt = new Date("2026-09-06T01:00:00.000Z");
        const enabled = await inTx(async (tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 1,
            enabled: true,
            now: enabledAt,
        }));
        expect(enabled).toMatchObject({
            status: "applied",
            connection: { enabled: true, firstEnabledAt: enabledAt, revision: 2, state: "connected" },
        });

        expect(await inTx(async (tx) => updateTeamIdentityConnectionInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 2,
            externalReference: {
                ...workosDocuments.externalReference,
                connectionId: "conn_rebound",
            },
        }))).toMatchObject({ status: "immutable_external_identity", connection: { revision: 2 } });

        const disabled = await inTx(async (tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 2,
            enabled: false,
        }));
        expect(disabled).toMatchObject({
            status: "applied",
            connection: { enabled: false, firstEnabledAt: enabledAt, revision: 3, state: "disabled" },
        });
    });

    it("records test evidence only for the exact current revision and blocks unsafe deletion", async () => {
        const team = await db.team.create({ data: { name: "Test Evidence Team" } });
        const provider = await createProvider({ ownerTeamId: team.id });
        const created = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id,
            providerInstanceId: provider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(created.status).toBe("created");
        if (created.status !== "created") return;

        const testedAt = new Date("2026-09-06T02:00:00.000Z");
        expect(await inTx(async (tx) => recordTeamIdentityConnectionTestInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 7,
            runtimeFingerprint: "workos:v1:exact",
            testedAt,
        }))).toMatchObject({ status: "revision_conflict", connection: { revision: 1 } });

        const tested = await inTx(async (tx) => recordTeamIdentityConnectionTestInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 1,
            runtimeFingerprint: "workos:v1:exact",
            testedAt,
        }));
        expect(tested).toMatchObject({
            status: "applied",
            connection: {
                revision: 1,
                lastSuccessfulTest: {
                    at: testedAt,
                    runtimeFingerprint: "workos:v1:exact",
                },
            },
        });

        await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "initializing",
                displayName: "Directory",
                externalSourceKey: `workos:${team.id}:directory`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory" },
                teamIdentityConnectionId: created.connection.id,
            },
        });

        expect(await inTx(async (tx) => deleteTeamIdentityConnectionInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 1,
        }))).toEqual({
            status: "blocked",
            blockers: { directorySources: 1, externalGroupBindings: 0, managedMemberships: 0 },
        });

        await db.teamDirectorySource.deleteMany({ where: { teamIdentityConnectionId: created.connection.id } });
        expect(await inTx(async (tx) => deleteTeamIdentityConnectionInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 1,
        }))).toEqual({ status: "deleted" });
        expect(await db.teamIdentityConnection.findUnique({ where: { id: created.connection.id } })).toBeNull();
    });

    it("fails closed when disable or remove would invalidate the canonical Team authentication policy", async () => {
        const team = await db.team.create({ data: { name: "Required SSO Team" } });
        const provider = await createProvider({ ownerTeamId: team.id });
        const created = await inTx(async (tx) => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id,
            providerInstanceId: provider.id,
            ...workosDocuments,
            createdByAccountId: null,
        }));
        expect(created.status).toBe("created");
        if (created.status !== "created") return;
        const enabled = await inTx(async (tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 1,
            enabled: true,
        }));
        expect(enabled).toMatchObject({ status: "applied", connection: { revision: 2 } });

        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "team_connection", connectionId: created.connection.id }],
                },
            },
        });
        await expect(inTx(async (tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 2,
            enabled: false,
        }))).resolves.toEqual({ status: "policy_in_use" });
        await expect(inTx(async (tx) => deleteTeamIdentityConnectionInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 2,
        }))).resolves.toEqual({ status: "policy_in_use" });

        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 99 } } });
        await expect(inTx(async (tx) => setTeamIdentityConnectionEnabledInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 2,
            enabled: false,
        }))).resolves.toEqual({ status: "authentication_policy_unavailable" });
        await expect(inTx(async (tx) => deleteTeamIdentityConnectionInTx(tx, {
            id: created.connection.id,
            teamId: team.id,
            expectedRevision: 2,
        }))).resolves.toEqual({ status: "authentication_policy_unavailable" });
    });
});
