import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { bindDirectoryProvisionedIdentitiesInTx } from "./provisionedIdentityBinding";
import { createGitHubAppRegistrationConfigV1, encryptGitHubAppRegistrationSecretsV1 } from "@/app/integrations/github/githubManagedApp";

describe("directory provisioned identity binding", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-directory-binding-",
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
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    async function createWorkosSource(params: Readonly<{
        teamId: string;
        suffix: string;
        state: "active" | "initializing";
        activeReconcileRunId?: string;
    }>) {
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: params.teamId,
                kind: "workos_sso",
                displayName: "WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: params.teamId,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: "workos_sso", organizationId: `org_${params.suffix}`, connectionId: null },
                settings: { v: 1, kind: "workos_sso" },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: params.teamId,
                kind: "workos_directory",
                state: params.state,
                displayName: "WorkOS directory",
                externalSourceKey: `workos-binding:${params.suffix}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: params.suffix },
                teamIdentityConnectionId: connection.id,
                ...(params.activeReconcileRunId
                    ? {
                        activeReconcileRunId: params.activeReconcileRunId,
                        activeReconcileStartedAt: new Date("2026-09-06T10:00:00.000Z"),
                    }
                    : {}),
            },
        });
        return { connection, source };
    }

    it("binds the exact signed-in subject and grants native access only from a complete directory", async () => {
        const team = await db.team.create({ data: { name: "Provisioned Binding Team" } });
        const ready = await createWorkosSource({ teamId: team.id, suffix: "ready", state: "active" });
        const importing = await createWorkosSource({
            teamId: team.id,
            suffix: "importing",
            state: "initializing",
            activeReconcileRunId: "import-run",
        });
        const account = await db.account.create({ data: { publicKey: `provisioned-${team.id}` } });

        const readyIdentity = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: ready.source.id,
                teamId: team.id,
                externalUserId: "directory_user_1",
                externalSubjectId: "idp-subject-1",
                state: "active",
                lastSeenReconcileRunId: "complete-run",
            },
        });
        const directoryGroup = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: ready.source.id,
                externalGroupId: "engineering",
                externalDisplayName: "Engineering",
                state: "active",
                lastSeenReconcileRunId: "complete-run",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: ready.source.id,
                externalGroupId: directoryGroup.externalGroupId,
                externalUserId: readyIdentity.externalUserId,
                lastSeenReconcileRunId: "complete-run",
            },
        });
        const nativeGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering")},
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: team.id,
                teamGroupId: nativeGroup.id,
                directorySourceId: ready.source.id,
                externalGroupId: directoryGroup.externalGroupId,
                bindingMode: "directory_created",
            },
        });

        // The same person is staged in a directory whose first import has not
        // finished. That observation must never become access.
        const stagedIdentity = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: importing.source.id,
                teamId: team.id,
                externalUserId: "directory_user_2",
                externalSubjectId: "idp-subject-2",
                state: "active",
                lastSeenReconcileRunId: "import-run",
            },
        });

        await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
            accountId: account.id,
            teamId: team.id,
            match: {
                kind: "workos_directory",
                teamIdentityConnectionId: importing.connection.id,
                externalSubjectId: "idp-subject-2",
            },
        }))).resolves.toEqual({
            boundIdentityIds: [],
            nativeFactsApplied: false,
        });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: stagedIdentity.id } }))
            .resolves.toMatchObject({ boundAccountId: null, teamMembershipId: null });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toBeNull();

        await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
            accountId: account.id,
            teamId: team.id,
            match: {
                kind: "workos_directory",
                teamIdentityConnectionId: ready.connection.id,
                externalSubjectId: "idp-subject-1",
            },
        }))).resolves.toEqual({
            boundIdentityIds: [readyIdentity.id],
            nativeFactsApplied: true,
        });

        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        });
        expect(membership).toMatchObject({ status: "active", role: "member" });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: readyIdentity.id } }))
            .resolves.toMatchObject({ boundAccountId: account.id, teamMembershipId: membership.id });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: membership.id,
                    externalGroupBindingId: binding.id,
                },
            },
        })).resolves.not.toBeNull();
    });

    it("never binds a missing, ambiguous, or already-owned identity", async () => {
        const team = await db.team.create({ data: { name: "Ambiguous Binding Team" } });
        const ready = await createWorkosSource({ teamId: team.id, suffix: "ambiguous", state: "active" });
        const account = await db.account.create({ data: { publicKey: `ambiguous-${team.id}` } });
        const otherAccount = await db.account.create({ data: { publicKey: `ambiguous-other-${team.id}` } });

        await db.teamProvisionedIdentity.createMany({
            data: [
                {
                    directorySourceId: ready.source.id,
                    teamId: team.id,
                    externalUserId: "twin_a",
                    externalSubjectId: "shared-subject",
                    state: "active",
                },
                {
                    directorySourceId: ready.source.id,
                    teamId: team.id,
                    externalUserId: "twin_b",
                    externalSubjectId: "shared-subject",
                    state: "active",
                },
                {
                    directorySourceId: ready.source.id,
                    teamId: team.id,
                    externalUserId: "owned",
                    externalSubjectId: "owned-subject",
                    state: "active",
                    boundAccountId: otherAccount.id,
                },
                {
                    directorySourceId: ready.source.id,
                    teamId: team.id,
                    externalUserId: "exact",
                    externalSubjectId: "  exact-subject  ",
                    state: "active",
                },
            ],
        });

        const empty = { boundIdentityIds: [], nativeFactsApplied: false };
        for (const externalSubjectId of ["shared-subject", "owned-subject", "exact-subject", "unknown-subject", "", null]) {
            await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
                accountId: account.id,
                teamId: team.id,
                match: {
                    kind: "workos_directory",
                    teamIdentityConnectionId: ready.connection.id,
                    externalSubjectId,
                },
            }))).resolves.toEqual(empty);
        }
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toBeNull();

        // A different Team's connection can never reach this Team's projections.
        const otherTeam = await db.team.create({ data: { name: "Other Binding Team" } });
        await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
            accountId: account.id,
            teamId: otherTeam.id,
            match: {
                kind: "workos_directory",
                teamIdentityConnectionId: ready.connection.id,
                externalSubjectId: "owned-subject",
            },
        }))).resolves.toEqual(empty);
    });

    it("binds a GitHub organization person by immutable numeric id", async () => {
        const team = await db.team.create({ data: { name: "GitHub Binding Team" } });
        const creator = await db.account.create({ data: { publicKey: `github-binding-creator-${Date.now()}` } });
        const registrationId = `github-binding-registration-${team.id}`;
        const registration = await db.gitHubAppRegistration.create({
            data: {
                id: registrationId,
                ownerTeamId: team.id,
                githubHost: "https://github.com",
                githubAppId: 4242n,
                githubClientId: `client-${team.id}`,
                config: createGitHubAppRegistrationConfigV1({ v: 1, privateKey: "test-directory-key" }),
                encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({ registrationId,
                    secrets: { v: 1, privateKey: "test-directory-key" } }),
                state: "verified",
                createdByAccountId: creator.id,
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 909n,
                githubOrganizationId: 808n,
                githubOrganizationLogin: "acme",
                verifiedPermissions: { members: "read" },
                repositorySelection: "all",
                state: "verified",
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "github_organization",
                state: "active",
                displayName: "acme",
                externalSourceKey: `github-binding:${team.id}`,
                bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "acme" },
                githubAppInstallationId: installation.id,
            },
        });
        const identity = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: team.id,
                externalUserId: "5150",
                externalLogin: "octocat",
                state: "active",
                lastSeenReconcileRunId: "complete-run",
            },
        });
        const otherInstallation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 910n,
                githubOrganizationId: 809n,
                githubOrganizationLogin: "other",
                verifiedPermissions: { members: "read" },
                repositorySelection: "all",
                state: "verified",
            },
        });
        const otherSource = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "github_organization",
                state: "active",
                displayName: "other",
                externalSourceKey: `github-binding-other:${team.id}`,
                bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "other" },
                githubAppInstallationId: otherInstallation.id,
            },
        });
        const otherIdentity = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: otherSource.id,
                teamId: team.id,
                externalUserId: "5150",
                externalLogin: "octocat",
                state: "active",
                lastSeenReconcileRunId: "complete-run",
            },
        });
        const account = await db.account.create({ data: { publicKey: `github-binding-${team.id}` } });

        await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
            accountId: account.id,
            teamId: team.id,
            match: {
                kind: "github_organization",
                githubAppInstallationId: installation.id,
                externalUserId: "5150",
            },
        }))).resolves.toEqual({
            boundIdentityIds: [identity.id],
            nativeFactsApplied: true,
        });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toMatchObject({ status: "active", role: "member" });
        await expect(db.teamProvisionedIdentity.findUnique({
            where: { id: otherIdentity.id },
            select: { boundAccountId: true, teamMembershipId: true },
        })).resolves.toEqual({ boundAccountId: null, teamMembershipId: null });
    });

    it("withholds native access from an active source with an outstanding reconcile run", async () => {
        const team = await db.team.create({ data: { name: "Fenced Run Team" } });
        const fenced = await createWorkosSource({
            teamId: team.id,
            suffix: "fenced-active",
            state: "active",
            activeReconcileRunId: "repair-run",
        });
        const account = await db.account.create({ data: { publicKey: `fenced-${team.id}` } });
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: fenced.source.id,
                teamId: team.id,
                externalUserId: "directory_fenced",
                externalSubjectId: "fenced-subject",
                state: "active",
                lastSeenReconcileRunId: "repair-run",
            },
        });

        await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
            accountId: account.id,
            teamId: team.id,
            match: {
                kind: "workos_directory",
                teamIdentityConnectionId: fenced.connection.id,
                externalSubjectId: "fenced-subject",
            },
        }))).resolves.toEqual({ boundIdentityIds: [], nativeFactsApplied: false });
        await expect(db.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).resolves.toBeNull();
    });

    it("withholds identity binding when current Home policy disables the source kind", async () => {
        const team = await db.team.create({ data: { name: "Policy Disabled Binding Team" } });
        const ready = await createWorkosSource({ teamId: team.id, suffix: "policy-disabled", state: "active" });
        const account = await db.account.create({ data: { publicKey: `policy-disabled-${team.id}` } });
        const identity = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: ready.source.id,
                teamId: team.id,
                externalUserId: "directory_policy_disabled",
                externalSubjectId: "policy-disabled-subject",
                state: "active",
                lastSeenReconcileRunId: "complete-run",
            },
        });
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
            await expect(inTx((tx) => bindDirectoryProvisionedIdentitiesInTx(tx, {
                accountId: account.id,
                teamId: team.id,
                match: {
                    kind: "workos_directory",
                    teamIdentityConnectionId: ready.connection.id,
                    externalSubjectId: "policy-disabled-subject",
                },
            }))).resolves.toEqual({ boundIdentityIds: [], nativeFactsApplied: false });
            await expect(db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: identity.id } }))
                .resolves.toMatchObject({ boundAccountId: null, teamMembershipId: null });
            await expect(db.teamMembership.findUnique({
                where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
            })).resolves.toBeNull();
        } finally {
            await db.homeGovernancePolicy.update({
                where: { id: "home" },
                data: {
                    teamProviderPolicy: {
                        v: 1,
                        allowedTeamProviderKinds: ["workos_sso", "github_app_identity"],
                        teamJitAllowed: false,
                        approvedGitHubEnterpriseOrigins: [],
                    },
                },
            });
        }
    });
});
