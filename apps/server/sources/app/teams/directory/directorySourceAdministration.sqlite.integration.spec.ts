import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkOS } from "@workos-inc/node";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { applyExternalTeamMembershipInTx } from "../memberships/externalFacts";
import {
    createDirectorySourceForActor,
    getDirectorySourceForActor,
    listDirectoryGroupsForActor,
    listDirectoryPeopleForActor,
    listDirectorySourceSetupOptionsForActor,
    listDirectorySourcesForActor,
    preflightDirectorySourceRemovalForActor,
    removeDirectorySourceForActor,
    setDirectorySourcePausedForActor,
    syncDirectorySourceForActor,
} from "./directorySourceAdministration";
import { deriveWorkosDirectoryExternalSourceKey } from "./directorySourceBinding";
import { registerEnterpriseIdentitySyncNudge } from "./runtime/directorySyncWake";
import {
    createGitHubAppRegistrationConfigV1,
    encryptGitHubAppRegistrationSecretsV1,
} from "@/app/integrations/github/githubManagedApp";

describe("directory source administration", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-directory-administration-",
            initAuth: false,
            initEncrypt: true,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso", "github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    }, 180_000);

    afterAll(async () => { if (harness) await harness.close(); });

    async function createFixture() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const managed = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const outsider = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: `Directory ${crypto.randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "active",
                displayName: "Primary directory",
                externalSourceKey: `workos:${crypto.randomUUID()}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_1" },
                teamIdentityConnectionId: connection.id,
                lastAttemptAt: new Date("2026-09-06T10:00:00.000Z"),
                lastSuccessAt: new Date("2026-09-06T10:00:00.000Z"),
                lastFullReconcileAt: new Date("2026-09-06T10:00:00.000Z"),
            },
        });
        const person = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: team.id,
                externalUserId: "person_1",
                normalizedEmail: "managed@example.test",
                displayName: "Managed Person",
                state: "active",
                boundAccountId: managed.id,
            },
        });
        const group = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "group_1",
                externalDisplayName: "Engineering",
                state: "active",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: group.externalGroupId,
                externalUserId: person.externalUserId,
            },
        });
        return { owner, member, managed, outsider, team, connection, source, person, group };
    }

    it("authorizes through manageAuthentication and returns bounded safe projections", async () => {
        const f = await createFixture();
        await db.teamProvisionedIdentity.createMany({ data: [
            {
                directorySourceId: f.source.id,
                teamId: f.team.id,
                externalUserId: "another-bound-person",
                state: "active",
                boundAccountId: f.managed.id,
            },
            {
                directorySourceId: f.source.id,
                teamId: f.team.id,
                externalUserId: "unbound-person",
                state: "active",
            },
        ] });
        await db.teamDirectoryGroupMember.createMany({ data: [
            { directorySourceId: f.source.id, externalGroupId: f.group.externalGroupId, externalUserId: "another-bound-person" },
            { directorySourceId: f.source.id, externalGroupId: f.group.externalGroupId, externalUserId: "unbound-person" },
        ] });
        await db.account.update({ where: { id: f.outsider.id }, data: { homeRole: "owner" } });
        await expect(listDirectorySourcesForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.outsider.id,
        })).resolves.toEqual({ ok: false, error: "team_not_found" });
        await expect(listDirectorySourcesForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.member.id,
        })).resolves.toEqual({ ok: false, error: "team_forbidden" });

        const listed = await listDirectorySourcesForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            now: new Date("2026-09-06T10:04:00.000Z"),
        });
        expect(listed).toMatchObject({
            ok: true,
            value: { items: [{ id: f.source.id, sync: { attempt: "succeeded", freshness: "fresh" } }] },
        });
        await expect(getDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({ ok: true, value: { id: f.source.id } });
        await expect(listDirectoryPeopleForActor({
            v: 1,
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({
            ok: true,
            value: { items: expect.arrayContaining([expect.objectContaining({
                id: f.person.id,
                accountBinding: { state: "bound", accountId: f.managed.id, teamMembershipId: null },
            })]) },
        });
        await expect(listDirectoryGroupsForActor({
            v: 1,
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({
            ok: true,
            value: { items: [{ id: f.group.id, memberCount: 3, boundAccountCount: 1, unboundPeopleCount: 1, mapping: { state: "unbound" } }] },
        });

        await db.teamDirectorySource.update({
            where: { id: f.source.id },
            data: {
                state: "initializing",
                activeReconcileRunId: "partial-roster-attempt",
                activeReconcileStartedAt: new Date("2026-09-06T10:05:00.000Z"),
            },
        });
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: f.source.id,
                teamId: f.team.id,
                externalUserId: "partial-person",
                state: "active",
                lastSeenReconcileRunId: "partial-roster-attempt",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: f.source.id,
                externalGroupId: f.group.externalGroupId,
                externalUserId: "partial-person",
                lastSeenReconcileRunId: "partial-roster-attempt",
            },
        });
        await expect(listDirectoryGroupsForActor({
            v: 1,
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({
            ok: true,
            value: { items: [{ id: f.group.id, memberCount: null, boundAccountCount: null, unboundPeopleCount: null }] },
        });
    });

    it("projects the bound Account's same-Team membership without claiming its management", async () => {
        const f = await createFixture();
        const nativeMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: f.member.id } },
        });
        const nativePerson = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: f.source.id,
                teamId: f.team.id,
                externalUserId: "native-person",
                state: "active",
                boundAccountId: f.member.id,
            },
        });
        const otherTeam = await db.team.create({ data: { name: "Other Team" } });
        await db.teamMembership.create({
            data: { teamId: otherTeam.id, accountId: f.managed.id, role: "member" },
        });

        await expect(listDirectoryPeopleForActor({
            v: 1, teamId: f.team.id, sourceId: f.source.id, actorAccountId: f.owner.id,
        })).resolves.toMatchObject({
            ok: true,
            value: { items: expect.arrayContaining([
                expect.objectContaining({
                    id: nativePerson.id,
                    accountBinding: { state: "bound", accountId: f.member.id, teamMembershipId: nativeMembership.id },
                }),
                expect.objectContaining({
                    id: f.person.id,
                    accountBinding: { state: "bound", accountId: f.managed.id, teamMembershipId: null },
                }),
            ]) },
        });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: nativePerson.id } }))
            .resolves.toMatchObject({ teamMembershipId: null, teamMembershipTeamId: null });
    });

    it("keeps public removal automation behind current Team authority and credential qualification", async () => {
        const f = await createFixture();
        await db.team.update({
            where: { id: f.team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        const enabledEnv = {
            ...process.env,
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        };
        const disabledEnv = {
            ...process.env,
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0",
        };
        const qualifyingEvidence = [{ kind: "home_method" as const, methodId: "key_challenge" }];

        await expect(removeDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            authenticationAuthority: "account_automation",
            env: enabledEnv,
        })).resolves.toEqual({ ok: false, error: "team_authentication_required" });

        await expect(removeDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            authenticationAuthority: "account_automation",
            authenticationEvidence: qualifyingEvidence,
            env: disabledEnv,
        })).resolves.toEqual({ ok: false, error: "team_authentication_unavailable" });

        await expect(removeDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.member.id,
            authenticationAuthority: "account_automation",
            authenticationEvidence: qualifyingEvidence,
            env: enabledEnv,
        })).resolves.toEqual({ ok: false, error: "team_forbidden" });

        await expect(db.teamDirectorySource.findUnique({ where: { id: f.source.id } }))
            .resolves.not.toBeNull();

        await expect(removeDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            authenticationAuthority: "account_automation",
            authenticationEvidence: qualifyingEvidence,
            env: enabledEnv,
        })).resolves.toMatchObject({ ok: true, value: { v: 1, status: "removed" } });

        await expect(db.teamDirectorySource.findUnique({ where: { id: f.source.id } }))
            .resolves.toBeNull();
    });

    it("lists only exact verified provider choices that are eligible and not already bound", async () => {
        const f = await createFixture();
        const otherTeam = await db.team.create({ data: { name: `Other ${crypto.randomUUID()}` } });
        const createRegistration = async (ownerTeamId: string | null, githubAppId: bigint) => {
            const id = crypto.randomUUID();
            const secrets = { v: 1 as const, privateKey: `private-key-${id}` };
            return await db.gitHubAppRegistration.create({ data: {
                id,
                ownerTeamId,
                githubHost: "https://github.com",
                githubAppId,
                githubClientId: crypto.randomUUID(),
                config: createGitHubAppRegistrationConfigV1(secrets),
                encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({ registrationId: id, secrets }),
                state: "verified",
            } });
        };
        const [homeRegistration, teamRegistration, otherRegistration] = await Promise.all([
            createRegistration(null, BigInt(Math.floor(Math.random() * 1_000_000) + 1)),
            createRegistration(f.team.id, BigInt(Math.floor(Math.random() * 1_000_000) + 1_000_001)),
            createRegistration(otherTeam.id, BigInt(Math.floor(Math.random() * 1_000_000) + 2_000_001)),
        ]);
        const createInstallation = async (
            registrationId: string,
            login: string,
            state = "verified",
            verifiedPermissions: Record<string, "read" | "write"> = { members: "read" },
        ) => (
            await db.gitHubAppInstallation.create({ data: {
                registrationId,
                githubInstallationId: BigInt(Math.floor(Math.random() * 1_000_000) + 1),
                githubOrganizationId: BigInt(Math.floor(Math.random() * 1_000_000) + 1),
                githubOrganizationLogin: login,
                repositorySelection: "all",
                verifiedPermissions,
                state,
            } })
        );
        const home = await createInstallation(homeRegistration.id, "home-org");
        const team = await createInstallation(teamRegistration.id, "team-org");
        await createInstallation(otherRegistration.id, "other-org");
        await createInstallation(homeRegistration.id, "unverified-org", "unverified");
        await createInstallation(homeRegistration.id, "missing-members-permission", "verified", {});
        const workosProvider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id,
            kind: "workos_sso",
            displayName: "WorkOS",
            enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const workosConnection = await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id,
            providerInstanceId: workosProvider.id,
            enabled: false,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org-exact",
                connectionId: null,
            },
            settings: { v: 1, kind: "workos_sso" },
        } });
        // An abandoned Portal draft is not a directory candidate and must not
        // prevent choosing the configured sibling or verified GitHub sources.
        const draftProvider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id, kind: "workos_sso", displayName: "Unfinished WorkOS",
            enabled: true, config: { v: 1, kind: "workos_sso" },
        } });
        await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id,
            providerInstanceId: draftProvider.id,
            enabled: false,
            externalReference: { v: 1, kind: "workos_sso", organizationId: null, connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        await db.teamDirectorySource.create({ data: {
            teamId: f.team.id,
            kind: "workos_directory",
            state: "active",
            displayName: "Already bound",
            externalSourceKey: deriveWorkosDirectoryExternalSourceKey({
                organizationId: "org-exact",
                directoryId: "directory-bound",
            }),
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory-bound" },
            teamIdentityConnectionId: workosConnection.id,
        } });
        let useLargeDirectory = false;
        const largeDirectories = Array.from({ length: 202 }, (_, index) => ({
            id: `directory-${String(index).padStart(3, "0")}`,
            name: `WorkOS ${String(index).padStart(3, "0")}`,
            organizationId: "org-exact",
            state: "active",
        }));
        const listDirectories = async ({ after, limit = 100 }: { after?: string; limit?: number } = {}) => {
            if (useLargeDirectory) {
                const start = after ? Number(after) : 0;
                const data = largeDirectories.slice(start, start + limit);
                const next = start + data.length;
                return { data, listMetadata: { after: next < largeDirectories.length ? String(next) : null } };
            }
            return {
            data: [
                { id: "directory-active", name: "Okta", organizationId: "org-exact", state: "active" },
                { id: "directory-bound", name: "Bound", organizationId: "org-exact", state: "active" },
                { id: "directory-foreign", name: "Foreign", organizationId: "org-other", state: "active" },
                { id: "directory-inactive", name: "Inactive", organizationId: "org-exact", state: "inactive" },
            ],
            listMetadata: { after: null },
        };
        };

        const result = await listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
        }, {
            resolveWorkosPlatform: () => ({
                available: true,
                clientId: "client-test",
                client: { directorySync: { listDirectories } } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            }),
        });

        expect(result).toEqual({
            ok: true,
            value: {
                v: 1,
                items: [
                    {
                        kind: "workos_directory",
                        displayName: "Okta",
                        teamIdentityConnectionId: workosConnection.id,
                        workosDirectoryId: "directory-active",
                    },
                ],
                nextCursor: expect.any(String),
                complete: false,
            },
        });
        if (!result.ok || result.value.nextCursor === null) throw new Error("expected GitHub continuation");
        await expect(listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            cursor: result.value.nextCursor,
        }, {
            resolveWorkosPlatform: () => ({
                available: true,
                clientId: "client-test",
                client: { directorySync: { listDirectories } } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            }),
        })).resolves.toEqual({
            ok: true,
            value: {
                v: 1,
                items: [
                    { kind: "github_organization", displayName: "home-org", githubAppInstallationId: home.id },
                    { kind: "github_organization", displayName: "team-org", githubAppInstallationId: team.id },
                ],
                nextCursor: null,
                complete: true,
            },
        });

        useLargeDirectory = true;
        const allOptionKeys = new Set<string>();
        let nextCursor: string | null = null;
        let complete = false;
        while (!complete) {
            const page = await listDirectorySourceSetupOptionsForActor({
                v: 1,
                teamId: f.team.id,
                actorAccountId: f.owner.id,
                env: {},
                limit: 37,
                ...(nextCursor ? { cursor: nextCursor } : {}),
            }, {
                resolveWorkosPlatform: () => ({
                    available: true,
                    clientId: "client-test",
                    client: { directorySync: { listDirectories } } as unknown as WorkOS,
                    runtimeFingerprint: "workos-platform:v1:test",
                }),
            });
            expect(page).toMatchObject({ ok: true, value: { v: 1 } });
            if (!page.ok) throw new Error(page.error);
            expect(page.value.items.length).toBeLessThanOrEqual(37);
            for (const option of page.value.items) {
                const key = option.kind === "workos_directory"
                    ? `${option.kind}:${option.teamIdentityConnectionId}:${option.workosDirectoryId}`
                    : `${option.kind}:${option.githubAppInstallationId}`;
                expect(allOptionKeys.has(key)).toBe(false);
                allOptionKeys.add(key);
            }
            complete = page.value.complete;
            nextCursor = page.value.nextCursor;
            expect(complete).toBe(nextCursor === null);
        }
        expect(allOptionKeys.size).toBe(204);
        expect(allOptionKeys.has(`github_organization:${home.id}`)).toBe(true);
        expect(allOptionKeys.has(`github_organization:${team.id}`)).toBe(true);

        await expect(listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            cursor: "not-a-directory-cursor",
        })).resolves.toEqual({ ok: false, error: "invalid_team_cursor" });
    });

    it("deduplicates WorkOS setup options by organization and directory across connections", async () => {
        const f = await createFixture();
        const [firstProvider, secondProvider] = await Promise.all([
            db.identityProviderInstance.create({ data: {
                ownerTeamId: f.team.id,
                kind: "workos_sso",
                displayName: "WorkOS 1",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            } }),
            db.identityProviderInstance.create({ data: {
                ownerTeamId: f.team.id,
                kind: "workos_sso",
                displayName: "WorkOS 2",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            } }),
        ]);
        const [firstConnection, secondConnection] = await Promise.all([
            db.teamIdentityConnection.create({ data: {
                teamId: f.team.id,
                providerInstanceId: firstProvider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org-shared",
                    connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
            } }),
            db.teamIdentityConnection.create({ data: {
                teamId: f.team.id,
                providerInstanceId: secondProvider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "org-shared",
                    connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
            } }),
        ]);
        const distinctProvider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id,
            kind: "workos_sso",
            displayName: "WorkOS 3",
            enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const distinctConnection = await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id,
            providerInstanceId: distinctProvider.id,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org-distinct",
                connectionId: null,
            },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const listDirectories = async ({ organizationId }: { organizationId: string }) => ({
            data: [{
                id: "directory-shared",
                name: organizationId === "org-distinct" ? "Distinct" : "Shared",
                organizationId,
                state: "active",
            }],
            listMetadata: { after: null },
        });

        const items: Array<{ teamIdentityConnectionId: string; workosDirectoryId: string }> = [];
        let cursor: string | null = null;
        let complete = false;
        while (!complete) {
            const result = await listDirectorySourceSetupOptionsForActor({
                v: 1,
                teamId: f.team.id,
                actorAccountId: f.owner.id,
                env: {},
                ...(cursor ? { cursor } : {}),
            }, {
                resolveWorkosPlatform: () => ({
                    available: true,
                    clientId: "client-test",
                    client: { directorySync: { listDirectories } } as unknown as WorkOS,
                    runtimeFingerprint: "workos-platform:v1:test",
                }),
            });
            expect(result).toMatchObject({ ok: true, value: { v: 1 } });
            if (!result.ok) throw new Error(result.error);
            items.push(...result.value.items.flatMap((item) => (
                item.kind === "workos_directory" ? [item] : []
            )));
            cursor = result.value.nextCursor;
            complete = result.value.complete;
        }
        expect(items).toHaveLength(2);
        const connectionIds = new Set(items.map((item) => item.teamIdentityConnectionId));
        expect(connectionIds).toContain(distinctConnection.id);
        expect([firstConnection.id, secondConnection.id].filter((id) => connectionIds.has(id))).toHaveLength(1);
        expect(items.every((item) => item.workosDirectoryId === "directory-shared")).toBe(true);
        expect(secondConnection.id).not.toBe(firstConnection.id);
    });

    it("pages setup discovery without exhausting upstream WorkOS pages in one request", async () => {
        const f = await createFixture();
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id,
            kind: "workos_sso",
            displayName: "WorkOS paged",
            enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org-paged",
                connectionId: null,
            },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const directories = Array.from({ length: 23 }, (_, index) => ({
            id: `directory-paged-${String(index).padStart(2, "0")}`,
            name: index % 2 === 0 ? `Needle ${index}` : `Other ${index}`,
            organizationId: "org-paged",
            state: "active",
        }));
        const listDirectories = vi.fn(async ({ after, limit }: { after?: string; limit: number }) => {
            const start = after ? Number(after) : 0;
            const data = directories.slice(start, start + limit);
            const next = start + data.length;
            return { data, listMetadata: { after: next < directories.length ? String(next) : null } };
        });
        const dependencies = {
            resolveWorkosPlatform: () => ({
                available: true as const,
                clientId: "client-test",
                client: { directorySync: { listDirectories } } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            }),
        };

        const first = await listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            limit: 5,
            query: "needle",
        }, dependencies);
        expect(first).toMatchObject({ ok: true, value: { v: 1, complete: false } });
        if (!first.ok) throw new Error(first.error);
        expect(first.value.items).toHaveLength(3);
        expect(listDirectories).toHaveBeenCalledTimes(1);
        expect(listDirectories).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 5 }));
        expect(first.value.nextCursor).not.toBeNull();

        await expect(listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            limit: 5,
            query: "different query",
            cursor: first.value.nextCursor,
        }, dependencies)).resolves.toEqual({ ok: false, error: "invalid_team_cursor" });

        const optionIds = new Set(first.value.items.map((item) => (
            item.kind === "workos_directory" ? item.workosDirectoryId : item.githubAppInstallationId
        )));
        let cursor = first.value.nextCursor;
        let complete = first.value.complete;
        let requestCount = 1;
        while (!complete) {
            const beforeCalls = listDirectories.mock.calls.length;
            const page = await listDirectorySourceSetupOptionsForActor({
                v: 1,
                teamId: f.team.id,
                actorAccountId: f.owner.id,
                env: {},
                limit: 5,
                query: "needle",
                ...(cursor ? { cursor } : {}),
            }, dependencies);
            expect(page).toMatchObject({ ok: true, value: { v: 1 } });
            if (!page.ok) throw new Error(page.error);
            expect(listDirectories.mock.calls.length - beforeCalls).toBeLessThanOrEqual(1);
            for (const item of page.value.items) {
                const id = item.kind === "workos_directory" ? item.workosDirectoryId : item.githubAppInstallationId;
                expect(optionIds.has(id)).toBe(false);
                optionIds.add(id);
            }
            cursor = page.value.nextCursor;
            complete = page.value.complete;
            requestCount += 1;
            expect(requestCount).toBeLessThan(20);
        }
        expect([...optionIds].filter((id) => id.startsWith("directory-paged-"))).toHaveLength(12);
    });

    it("advances through a bounded GitHub installation slice before later eligible options", async () => {
        const f = await createFixture();
        await db.identityProviderInstance.updateMany({
            where: { ownerTeamId: f.team.id, kind: "workos_sso" },
            data: { enabled: false },
        });
        const registrationId = crypto.randomUUID();
        const secrets = { v: 1 as const, privateKey: `private-key-${registrationId}` };
        const registration = await db.gitHubAppRegistration.create({ data: {
            id: registrationId,
            ownerTeamId: f.team.id,
            githubHost: "https://github.com",
            githubAppId: BigInt(Math.floor(Math.random() * 1_000_000_000) + 1),
            githubClientId: crypto.randomUUID(),
            config: createGitHubAppRegistrationConfigV1(secrets),
            encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({ registrationId, secrets }),
            state: "verified",
        } });
        for (let index = 0; index < 5; index += 1) {
            await db.gitHubAppInstallation.create({ data: {
                registrationId: registration.id,
                githubInstallationId: BigInt(10_000 + index),
                githubOrganizationId: BigInt(20_000 + index),
                githubOrganizationLogin: `000-bounded-blocked-${index}`,
                repositorySelection: "all",
                verifiedPermissions: {},
                state: "verified",
            } });
        }
        const eligible = await db.gitHubAppInstallation.create({ data: {
            registrationId: registration.id,
            githubInstallationId: BigInt(10_100),
            githubOrganizationId: BigInt(20_100),
            githubOrganizationLogin: "000-bounded-eligible-last",
            repositorySelection: "all",
            verifiedPermissions: { members: "read" },
            state: "verified",
        } });

        const first = await listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            limit: 5,
            query: "bounded",
        });
        expect(first).toMatchObject({
            ok: true,
            value: { v: 1, items: [], complete: false },
        });
        if (!first.ok || first.value.nextCursor === null) throw new Error("expected GitHub continuation");

        const second = await listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            limit: 5,
            query: "bounded",
            cursor: first.value.nextCursor,
        });
        expect(second).toMatchObject({
            ok: true,
            value: {
                v: 1,
                items: [{
                    kind: "github_organization",
                    displayName: "000-bounded-eligible-last",
                    githubAppInstallationId: eligible.id,
                }],
            },
        });
    });

    it("rejects a WorkOS setup page whose cursor does not advance", async () => {
        const f = await createFixture();
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id,
            kind: "workos_sso",
            displayName: "WorkOS",
            enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org-repeated-cursor",
                connectionId: null,
            },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const listDirectories = vi.fn(async ({ after }: { after?: string }) => {
            if (after === undefined) return { data: [], listMetadata: { after: "same-cursor" } };
            if (after === "same-cursor") return { data: [], listMetadata: { after: "same-cursor" } };
            throw new Error("setup pagination must stop at the repeated cursor");
        });

        const first = await listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
        }, {
            resolveWorkosPlatform: () => ({
                available: true,
                clientId: "client-test",
                client: { directorySync: { listDirectories } } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            }),
        });
        expect(first).toMatchObject({ ok: true, value: { items: [], complete: false } });
        if (!first.ok || first.value.nextCursor === null) throw new Error("expected WorkOS continuation");
        await expect(listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
            cursor: first.value.nextCursor,
        }, {
            resolveWorkosPlatform: () => ({
                available: true,
                clientId: "client-test",
                client: { directorySync: { listDirectories } } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            }),
        })).resolves.toEqual({ ok: false, error: "directory_sync_unavailable" });
        expect(listDirectories).toHaveBeenCalledTimes(2);
        expect(connection.id).toEqual(expect.any(String));
    });

    it("rejects a WorkOS setup page with a malformed provider cursor", async () => {
        const f = await createFixture();
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: f.team.id,
            kind: "workos_sso",
            displayName: "WorkOS",
            enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        await db.teamIdentityConnection.create({ data: {
            teamId: f.team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "workos_sso",
                organizationId: "org-malformed-cursor",
                connectionId: null,
            },
            settings: { v: 1, kind: "workos_sso" },
        } });

        await expect(listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            env: {},
        }, {
            resolveWorkosPlatform: () => ({
                available: true,
                clientId: "client-test",
                client: {
                    directorySync: {
                        listDirectories: vi.fn(async () => ({
                            data: [],
                            listMetadata: { after: 42 },
                        })),
                    },
                } as unknown as WorkOS,
                runtimeFingerprint: "workos-platform:v1:test",
            }),
        })).resolves.toEqual({ ok: false, error: "directory_sync_unavailable" });
    });

    it("coalesces sync, fences pause/resume, and removes the source-owned lifetime atomically", async () => {
        const f = await createFixture();
        const nudge = vi.fn();
        const unregisterNudge = registerEnterpriseIdentitySyncNudge(nudge);

        const setupProvider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: f.team.id,
                kind: "workos_sso",
                displayName: "WorkOS setup",
                config: { v: 1, kind: "workos_sso" },
                enabled: true,
            },
        });
        const setupConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: f.team.id,
                providerInstanceId: setupProvider.id,
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: "organization_setup",
                    connectionId: null,
                },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        await expect(createDirectorySourceForActor({
            v: 1,
            teamId: f.team.id,
            actorAccountId: f.owner.id,
            kind: "workos_directory",
            displayName: "Setup directory",
            teamIdentityConnectionId: setupConnection.id,
            workosDirectoryId: "directory_setup",
        })).resolves.toMatchObject({ ok: true, value: { state: "initializing" } });
        expect(nudge).toHaveBeenCalledTimes(1);

        const activation = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: f.team.id,
            accountId: f.managed.id,
            source: {
                kind: "directory_source",
                directorySourceId: f.source.id,
                externalUserId: f.person.externalUserId,
            },
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(activation.status).toBe("applied");
        if (activation.status !== "applied" || !activation.teamMembershipId) {
            throw new Error("expected managed membership");
        }
        const nativeGroup = await db.teamGroup.create({
            data: { teamId: f.team.id, name: "Operators", nameKey: "operators" },
        });
        await db.teamGroupMembership.create({
            data: {
                teamId: f.team.id,
                teamGroupId: nativeGroup.id,
                teamMembershipId: activation.teamMembershipId,
                nativeContribution: false,
            },
        });
        const sourceBinding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: f.team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: f.source.id,
                externalGroupId: "source-group",
                bindingMode: "native_target",
            },
        });
        const otherBinding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: f.team.id,
                teamGroupId: nativeGroup.id,
                teamIdentityConnectionId: f.connection.id,
                externalGroupId: "other-group",
                bindingMode: "native_target",
            },
        });
        const secondSourceBinding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: f.team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: f.source.id,
                externalGroupId: "source-group-2",
                bindingMode: "native_target",
            },
        });
        const nativeMember = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: f.member.id } },
        });
        await db.teamGroupMembership.create({
            data: {
                teamId: f.team.id,
                teamGroupId: nativeGroup.id,
                teamMembershipId: nativeMember.id,
                nativeContribution: true,
            },
        });
        await db.teamGroupMembershipExternalContribution.createMany({ data: [
            {
                teamGroupId: nativeGroup.id,
                teamMembershipId: activation.teamMembershipId,
                externalGroupBindingId: sourceBinding.id,
            },
            {
                teamGroupId: nativeGroup.id,
                teamMembershipId: activation.teamMembershipId,
                externalGroupBindingId: otherBinding.id,
            },
            {
                teamGroupId: nativeGroup.id,
                teamMembershipId: nativeMember.id,
                externalGroupBindingId: sourceBinding.id,
            },
            {
                teamGroupId: nativeGroup.id,
                teamMembershipId: nativeMember.id,
                externalGroupBindingId: secondSourceBinding.id,
            },
        ] });

        await expect(preflightDirectorySourceRemovalForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({
            ok: true,
            value: {
                impact: {
                    teamMembershipsRemoved: 1,
                    groupMembershipsRemoved: 1,
                    groupContributionsRemoved: 4,
                    nativeGroupContributionsPreserved: 1,
                },
            },
        });

        await expect(syncDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            now: new Date("2026-09-06T10:05:00.000Z"),
        })).resolves.toMatchObject({ ok: true, value: { status: "requested" } });
        await expect(syncDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            now: new Date("2026-09-06T10:05:01.000Z"),
        })).resolves.toMatchObject({ ok: true, value: { status: "coalesced" } });
        expect(nudge).toHaveBeenCalledTimes(3);

        await expect(setDirectorySourcePausedForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            paused: true,
        })).resolves.toMatchObject({ ok: true, value: { state: "paused", sync: { attempt: "paused" } } });
        expect(await db.teamMembership.count({ where: { id: activation.teamMembershipId ?? "missing" } })).toBe(1);
        await expect(setDirectorySourcePausedForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            paused: false,
        })).resolves.toMatchObject({ ok: true, value: { state: "initializing" } });
        expect(nudge).toHaveBeenCalledTimes(4);
        unregisterNudge();

        await expect(removeDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({
            ok: true,
            value: {
                status: "removed",
                impact: {
                    teamMembershipsRemoved: 1,
                    groupMembershipsRemoved: 1,
                    groupContributionsRemoved: 4,
                    nativeGroupContributionsPreserved: 1,
                },
            },
        });
        expect(await db.teamMembership.count({ where: { id: activation.teamMembershipId ?? "missing" } })).toBe(0);
        expect(await db.teamDirectorySource.count({ where: { id: f.source.id } })).toBe(0);
        await expect(removeDirectorySourceForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({ ok: true, value: { status: "already_absent" } });
    });

    it("refuses Resume without resetting the source when its full-scan request cannot be recorded", async () => {
        const f = await createFixture();
        await expect(setDirectorySourcePausedForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            paused: true,
        })).resolves.toMatchObject({ ok: true, value: { state: "paused" } });

        const allowedKinds = (kinds: string[]) => db.homeGovernancePolicy.update({
            where: { id: "home" },
            data: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: kinds,
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        // child 05 §10.1/:498: Resume atomically records the full-scan request.
        // A Home that no longer allows the provider kind refuses that request,
        // so Resume must refuse too rather than advertise a repair that never
        // starts.
        await allowedKinds(["github_app_identity"]);
        try {
            await expect(setDirectorySourcePausedForActor({
                teamId: f.team.id,
                sourceId: f.source.id,
                actorAccountId: f.owner.id,
                paused: false,
                now: new Date("2026-09-07T10:00:00.000Z"),
            })).resolves.toEqual({ ok: false, error: "team_identity_not_allowed" });
            await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: f.source.id } }))
                .resolves.toMatchObject({ state: "paused", manualSyncRequestedAt: null });
        } finally {
            await allowedKinds(["workos_sso", "github_app_identity"]);
        }

        await expect(setDirectorySourcePausedForActor({
            teamId: f.team.id,
            sourceId: f.source.id,
            actorAccountId: f.owner.id,
            paused: false,
            now: new Date("2026-09-07T10:05:00.000Z"),
        })).resolves.toMatchObject({ ok: true, value: { state: "initializing" } });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: f.source.id } }))
            .resolves.toMatchObject({
                state: "initializing",
                manualSyncRequestedAt: new Date("2026-09-07T10:05:00.000Z"),
            });
    });
});
