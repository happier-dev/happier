import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccountStatusV1, HomeRoleV1 } from "@happier-dev/protocol";
import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from "@happier-dev/protocol/changes";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { resolveStructuralSessionAccessForAccountsInTx } from "@/app/session/access/sessionAccess";
import {
    commitDirectoryProjectionPage,
    completeDirectoryProjection,
} from "@/app/teams/directory/directoryProjectionRepository";

import { replaceAccountForProviderResetInTx } from "./accountReplacement";
import { setAccountStatusInTx } from "./accountLifecycle";
import { TEAM_CHANGE_ENTITY_ID } from "@/app/teams/teamChanges";

let sequence = 0;

function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
}

async function createAccount(input: Readonly<{
    homeRole?: HomeRoleV1;
    username?: string | null;
    feedSeq?: bigint;
    status?: AccountStatusV1;
}> = {}): Promise<string> {
    const created = await db.account.create({
        data: {
            publicKey: nextId("replacement-key"),
            homeRole: input.homeRole ?? "member",
            username: input.username ?? null,
            ...(input.feedSeq === undefined ? {} : { feedSeq: input.feedSeq }),
            ...(input.status === undefined ? {} : { status: input.status }),
        },
        select: { id: true },
    });
    return created.id;
}

async function createTeamWithMember(input: Readonly<{
    accountId: string;
    sessionAccessStartsAt?: Date | null;
}>): Promise<Readonly<{ teamId: string; membershipId: string }>> {
    const team = await db.team.create({ data: { name: nextId("Team") }, select: { id: true } });
    const membership = await db.teamMembership.create({
        data: {
            teamId: team.id,
            accountId: input.accountId,
            role: "owner",
            ...(input.sessionAccessStartsAt === undefined
                ? {}
                : { sessionAccessStartsAt: input.sessionAccessStartsAt }),
        },
        select: { id: true },
    });
    return { teamId: team.id, membershipId: membership.id };
}

describe("Provider-reset Account replacement", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-home-governance-replacement-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            },
        });
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
    afterAll(async () => await harness?.close());
    afterEach(async () => {
        await db.session.deleteMany({});
        await db.teamGroupMembershipExternalContribution.deleteMany({});
        await db.teamExternalGroupBinding.deleteMany({});
        await db.teamGroupMembership.deleteMany({});
        await db.teamMembershipIdentityConnectionManagement.deleteMany({});
        await db.teamCredentialExternalApiKey.deleteMany({});
        await db.teamCredentialMemberGrant.deleteMany({});
        await db.teamCredentialResource.deleteMany({});
        await db.teamGroup.deleteMany({});
        await db.teamDirectoryGroupMember.deleteMany({});
        await db.teamDirectoryGroup.deleteMany({});
        await db.teamProvisionedIdentity.deleteMany({});
        await db.teamDirectorySource.deleteMany({});
        await db.teamIdentityConnection.deleteMany({});
        await db.identityProviderInstance.deleteMany({});
        await db.teamMembership.deleteMany({});
        await db.team.deleteMany({});
        await db.account.deleteMany({});
    });

    async function createDirectorySource(teamId: string, suffix: string) {
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: teamId,
                kind: "workos_sso",
                displayName: "WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        return await db.teamDirectorySource.create({
            data: {
                teamId,
                kind: "workos_directory",
                state: "active",
                displayName: "WorkOS directory",
                externalSourceKey: `workos-replacement:${suffix}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: suffix },
                teamIdentityConnectionId: connection.id,
            },
        });
    }

    it("reconciles Session access and private drafts when membership transfers to the replacement", async () => {
        const ownerAccountId = await createAccount();
        const oldAccountId = await createAccount({ homeRole: "owner" });
        const membership = await createTeamWithMember({ accountId: oldAccountId });
        const session = await db.session.create({ data: {
            accountId: ownerAccountId, tag: nextId("session"), metadata: "{}",
            encryptionMode: "plain", currentStorageState: "hosted", responsibleAccountId: oldAccountId,
            teamGrants: { create: { teamId: membership.teamId, accessLevel: "edit", effectiveAt: new Date() } },
        } });
        const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
        if (!key) throw new Error("expected Session draft key");
        await db.userKVStore.create({ data: { accountId: oldAccountId, key, value: new Uint8Array([1]), version: 1 } });
        const replacementAccountId = nextId("acc-replacement");

        expect(await inTx(async (tx) => (await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: session.id,
            accountIds: [oldAccountId],
        })).get(oldAccountId)?.capabilities.readTranscript)).toBe(true);

        const result = await inTx(tx => replaceAccountForProviderResetInTx(tx, {
            oldAccountId, replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: null,
            retireReplacedAccountInTx: async (retireTx) => {
                expect(await setAccountStatusInTx(retireTx, {
                    actorAccountId: replacementAccountId,
                    targetAccountId: oldAccountId,
                    status: "disabled",
                    authority: "provider_account_replacement",
                })).toEqual({ status: "applied" });
            },
        }));

        expect(result.status).toBe("replaced");
        expect(await db.session.findUnique({ where: { id: session.id }, select: { responsibleAccountId: true } }))
            .toEqual({ responsibleAccountId: null });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: oldAccountId, key } }, select: { value: true } }))
            .toEqual({ value: null });
        const changes = await db.accountChange.findMany({ where: { entityId: session.id, kind: "session" }, select: { accountId: true } });
        expect(changes.map(change => change.accountId)).toEqual(expect.arrayContaining([oldAccountId, replacementAccountId]));
        expect(await db.accountChange.count({ where: { entityId: session.id, kind: "share" } })).toBe(0);
    });

    it("transfers Home role and membership lifetimes into one committed transaction", async () => {
        const oldAccountId = await createAccount({ homeRole: "owner", username: "ada", feedSeq: 42n });
        const horizon = new Date("2026-01-02T03:04:05.000Z");
        const membership = await createTeamWithMember({ accountId: oldAccountId, sessionAccessStartsAt: horizon });
        const viewerAccountId = await createAccount({ homeRole: "admin" });
        await db.teamMembership.create({ data: { teamId: membership.teamId, accountId: viewerAccountId, role: "member" } });
        const viewerSeqBefore = (await db.account.findUniqueOrThrow({
            where: { id: viewerAccountId },
            select: { seq: true },
        })).seq;
        const replacementAccountId = nextId("acc-replacement");
        let retired = false;

        const result = await inTx(async (tx) => await replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: "ada",
            retireReplacedAccountInTx: async (tx) => {
                retired = true;
                const result = await setAccountStatusInTx(tx, {
                    actorAccountId: replacementAccountId,
                    targetAccountId: oldAccountId,
                    status: "disabled",
                    authority: "provider_account_replacement",
                });
                if (result.status === "rejected") throw new Error(result.code);
            },
        }), { isolationLevel: "Serializable" });

        expect(result).toEqual({
            status: "replaced",
            replacementAccountId,
            transferredTeamMembershipCount: 1,
        });
        expect(retired).toBe(true);
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: viewerAccountId, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID,
        } } })).toMatchObject({ hint: null, cursor: viewerSeqBefore + 1 });
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: viewerAccountId,
            kind: "account",
            entityId: HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1,
        } } })).toMatchObject({ hint: null, cursor: viewerSeqBefore + 2 });
        expect((await db.account.findUniqueOrThrow({
            where: { id: viewerAccountId },
            select: { seq: true },
        })).seq).toBe(viewerSeqBefore + 2);

        await expect(db.account.findUniqueOrThrow({
            where: { id: replacementAccountId },
            select: { homeRole: true, status: true, username: true, feedSeq: true },
        })).resolves.toEqual({ homeRole: "owner", status: "active", username: "ada", feedSeq: 42n });

        await expect(db.account.findUniqueOrThrow({
            where: { id: oldAccountId },
            select: { homeRole: true, status: true, username: true },
        })).resolves.toEqual({ homeRole: "owner", status: "disabled", username: null });

        // The Home never loses its active owner across the replacement.
        await expect(db.account.count({ where: { homeRole: "owner", status: "active" } })).resolves.toBe(1);

        // The membership lifetime identity and its history horizon do not move.
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: membership.membershipId },
            select: { accountId: true, teamId: true, role: true, status: true, sessionAccessStartsAt: true },
        })).resolves.toEqual({
            accountId: replacementAccountId,
            teamId: membership.teamId,
            role: "owner",
            status: "active",
            sessionAccessStartsAt: horizon,
        });
    });

    it("rebinds admitted and unadmitted provisioned identities to the replacement Account", async () => {
        const oldAccountId = await createAccount({ homeRole: "owner" });
        const membership = await createTeamWithMember({ accountId: oldAccountId });
        const source = await createDirectorySource(membership.teamId, nextId("replacement-source"));
        const unadmittedSource = await createDirectorySource(membership.teamId, nextId("replacement-unadmitted-source"));
        const admittedExternalUserId = nextId("admitted-user");
        const admitted = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: membership.teamId,
                externalUserId: admittedExternalUserId,
                state: "active",
                boundAccountId: oldAccountId,
                teamMembershipId: membership.membershipId,
                teamMembershipTeamId: membership.teamId,
            },
        });
        const unadmitted = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: unadmittedSource.id,
                teamId: membership.teamId,
                externalUserId: nextId("unadmitted-user"),
                state: "active",
                boundAccountId: oldAccountId,
            },
        });
        const projectedGroup = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: nextId("external-group"),
                externalDisplayName: "Replacement continuity",
                state: "active",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: projectedGroup.externalGroupId,
                externalUserId: admittedExternalUserId,
            },
        });
        const nativeGroup = await db.teamGroup.create({
            data: {
                teamId: membership.teamId,
                name: "Replacement continuity",
                nameKey: nextId("replacement-continuity"),
            },
        });
        const groupBinding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: membership.teamId,
                teamGroupId: nativeGroup.id,
                directorySourceId: source.id,
                externalGroupId: projectedGroup.externalGroupId,
                bindingMode: "directory_created",
            },
        });
        await db.teamGroupMembership.create({
            data: {
                teamId: membership.teamId,
                teamGroupId: nativeGroup.id,
                teamMembershipId: membership.membershipId,
            },
        });
        await db.teamGroupMembershipExternalContribution.create({
            data: {
                teamGroupId: nativeGroup.id,
                teamMembershipId: membership.membershipId,
                externalGroupBindingId: groupBinding.id,
            },
        });
        const custodianAccountId = await createAccount();
        const credentialResource = await db.teamCredentialResource.create({
            data: {
                teamId: membership.teamId,
                custodianAccountId,
                displayName: "Replacement continuity credential",
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: "{}",
            },
        });
        await db.teamCredentialMemberGrant.create({
            data: {
                resourceId: credentialResource.id,
                teamMembershipId: membership.membershipId,
                deliveryMode: "brokered",
            },
        });
        const externalApiKey = await db.teamCredentialExternalApiKey.create({
            data: {
                resourceId: credentialResource.id,
                teamMembershipId: membership.membershipId,
                label: "Replacement continuity API key",
                displayPrefix: "hpk_replacement",
                secretDigest: nextId("replacement-secret-digest"),
            },
        });
        const replacementAccountId = nextId("acc-replacement");

        await expect(inTx((tx) => replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: null,
            retireReplacedAccountInTx: async (retireTx) => {
                const result = await setAccountStatusInTx(retireTx, {
                    actorAccountId: replacementAccountId,
                    targetAccountId: oldAccountId,
                    status: "disabled",
                    authority: "provider_account_replacement",
                });
                if (result.status === "rejected") throw new Error(result.code);
            },
        }))).resolves.toMatchObject({ status: "replaced" });

        await expect(db.teamProvisionedIdentity.findMany({
            where: { id: { in: [admitted.id, unadmitted.id] } },
            orderBy: { id: "asc" },
            select: { id: true, boundAccountId: true, teamMembershipId: true },
        })).resolves.toEqual([
            { id: admitted.id, boundAccountId: replacementAccountId, teamMembershipId: membership.membershipId },
            { id: unadmitted.id, boundAccountId: replacementAccountId, teamMembershipId: null },
        ].sort((left, right) => left.id.localeCompare(right.id)));

        const reconcileRunId = nextId("replacement-reconcile");
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: {
                state: "initializing",
                activeReconcileRunId: reconcileRunId,
                activeReconcileStartedAt: new Date("2026-09-08T08:00:00.000Z"),
            },
        });
        await expect(commitDirectoryProjectionPage({
            sourceId: source.id,
            reconcileRunId,
            people: [{ externalUserId: admittedExternalUserId, active: true }],
            groups: [{ externalGroupId: projectedGroup.externalGroupId, displayName: "Replacement continuity" }],
            groupMembers: [{ externalGroupId: projectedGroup.externalGroupId, externalUserId: admittedExternalUserId }],
        })).resolves.toEqual({ applied: true });
        await expect(completeDirectoryProjection({
            sourceId: source.id,
            reconcileRunId,
            observedManualSyncRequestedAt: null,
        })).resolves.toEqual({ applied: true });

        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: membership.membershipId },
            select: { accountId: true },
        })).resolves.toEqual({ accountId: replacementAccountId });
        await expect(db.teamGroupMembershipExternalContribution.findUnique({
            where: {
                teamGroupId_teamMembershipId_externalGroupBindingId: {
                    teamGroupId: nativeGroup.id,
                    teamMembershipId: membership.membershipId,
                    externalGroupBindingId: groupBinding.id,
                },
            },
        })).resolves.not.toBeNull();
        await expect(db.teamCredentialMemberGrant.findUnique({
            where: {
                resourceId_teamMembershipId: {
                    resourceId: credentialResource.id,
                    teamMembershipId: membership.membershipId,
                },
            },
        })).resolves.not.toBeNull();
        await expect(db.teamCredentialExternalApiKey.findUnique({
            where: { id: externalApiKey.id },
            select: { resourceId: true, teamMembershipId: true },
        })).resolves.toEqual({
            resourceId: credentialResource.id,
            teamMembershipId: membership.membershipId,
        });
    });

    it("refuses an ambiguous duplicate membership before mutating anything", async () => {
        const oldAccountId = await createAccount({ homeRole: "admin", username: "grace" });
        const membership = await createTeamWithMember({ accountId: oldAccountId });
        const replacementAccountId = await createAccount();
        await db.teamMembership.create({
            data: { teamId: membership.teamId, accountId: replacementAccountId, role: "member" },
        });
        let retired = false;

        const result = await inTx(async (tx) => await replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: "grace",
            retireReplacedAccountInTx: async () => { retired = true; },
        }), { isolationLevel: "Serializable" });

        expect(result).toEqual({
            status: "rejected",
            code: "team_membership_transfer_conflict",
            details: { teamIds: [membership.teamId] },
        });
        expect(retired).toBe(false);
        await expect(db.account.findUniqueOrThrow({
            where: { id: oldAccountId },
            select: { username: true, status: true, homeRole: true },
        })).resolves.toEqual({ username: "grace", status: "active", homeRole: "admin" });
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: membership.membershipId },
            select: { accountId: true },
        })).resolves.toEqual({ accountId: oldAccountId });
    });

    it("refuses an inconsistent provisioned-identity binding before creating the replacement", async () => {
        const oldAccountId = await createAccount({ homeRole: "owner", username: "lin" });
        const incorrectlyBoundAccountId = await createAccount();
        const membership = await createTeamWithMember({ accountId: oldAccountId });
        const source = await createDirectorySource(membership.teamId, nextId("conflict-source"));
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: membership.teamId,
                externalUserId: nextId("conflict-user"),
                state: "active",
                boundAccountId: incorrectlyBoundAccountId,
                teamMembershipId: membership.membershipId,
                teamMembershipTeamId: membership.teamId,
            },
        });
        const replacementAccountId = nextId("acc-replacement");

        await expect(inTx((tx) => replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: "lin",
            retireReplacedAccountInTx: async () => {
                throw new Error("must not retire");
            },
        }))).resolves.toEqual({
            status: "rejected",
            code: "team_membership_transfer_conflict",
            details: { teamIds: [membership.teamId] },
        });
        await expect(db.account.findUnique({ where: { id: replacementAccountId } })).resolves.toBeNull();
        await expect(db.teamMembership.findUniqueOrThrow({ where: { id: membership.membershipId } }))
            .resolves.toMatchObject({ accountId: oldAccountId });
    });

    it("reports every colliding Team across membership and provisioned-identity preflights", async () => {
        const oldAccountId = await createAccount({ homeRole: "owner", username: "complete-collision" });
        const replacementAccountId = await createAccount();
        const incorrectlyBoundAccountId = await createAccount();
        const duplicateMembership = await createTeamWithMember({ accountId: oldAccountId });
        const inconsistentIdentityMembership = await createTeamWithMember({ accountId: oldAccountId });
        await db.teamMembership.create({
            data: { teamId: duplicateMembership.teamId, accountId: replacementAccountId, role: "member" },
        });
        const source = await createDirectorySource(
            inconsistentIdentityMembership.teamId,
            nextId("complete-conflict-source"),
        );
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: inconsistentIdentityMembership.teamId,
                externalUserId: nextId("complete-conflict-user"),
                state: "active",
                boundAccountId: incorrectlyBoundAccountId,
                teamMembershipId: inconsistentIdentityMembership.membershipId,
                teamMembershipTeamId: inconsistentIdentityMembership.teamId,
            },
        });

        await expect(inTx((tx) => replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: "complete-collision",
            retireReplacedAccountInTx: async () => {
                throw new Error("must not retire");
            },
        }))).resolves.toEqual({
            status: "rejected",
            code: "team_membership_transfer_conflict",
            details: {
                teamIds: [duplicateMembership.teamId, inconsistentIdentityMembership.teamId].sort(),
            },
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: oldAccountId },
            select: { status: true, username: true },
        })).resolves.toEqual({ status: "active", username: "complete-collision" });
        await expect(db.teamMembership.findMany({
            where: { id: { in: [duplicateMembership.membershipId, inconsistentIdentityMembership.membershipId] } },
            orderBy: { id: "asc" },
            select: { id: true, accountId: true },
        })).resolves.toEqual([
            { id: duplicateMembership.membershipId, accountId: oldAccountId },
            { id: inconsistentIdentityMembership.membershipId, accountId: oldAccountId },
        ].sort((left, right) => left.id.localeCompare(right.id)));
    });

    it("refuses a provisioned identity bound to the replaced Account but attached to another Account's lifetime", async () => {
        const oldAccountId = await createAccount({ homeRole: "owner", username: "margaret" });
        const membership = await createTeamWithMember({ accountId: oldAccountId });
        const otherAccountId = await createAccount();
        const otherMembership = await db.teamMembership.create({
            data: { teamId: membership.teamId, accountId: otherAccountId, role: "member" },
        });
        const source = await createDirectorySource(membership.teamId, nextId("inverse-conflict-source"));
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: membership.teamId,
                externalUserId: nextId("inverse-conflict-user"),
                state: "active",
                boundAccountId: oldAccountId,
                teamMembershipId: otherMembership.id,
                teamMembershipTeamId: membership.teamId,
            },
        });
        const replacementAccountId = nextId("acc-replacement");

        await expect(inTx((tx) => replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: "margaret",
            retireReplacedAccountInTx: async () => {
                throw new Error("must not retire");
            },
        }))).resolves.toEqual({
            status: "rejected",
            code: "team_membership_transfer_conflict",
            details: { teamIds: [membership.teamId] },
        });
        await expect(db.account.findUnique({ where: { id: replacementAccountId } })).resolves.toBeNull();
        await expect(db.teamProvisionedIdentity.findFirstOrThrow({
            where: { boundAccountId: oldAccountId },
            select: { teamMembershipId: true },
        })).resolves.toEqual({ teamMembershipId: otherMembership.id });
    });

    it("leaves the replaced Account authoritative when a later step fails, with no compensating delete", async () => {
        const oldAccountId = await createAccount({ homeRole: "owner", username: "hopper", feedSeq: 7n });
        const membership = await createTeamWithMember({ accountId: oldAccountId });
        const source = await createDirectorySource(membership.teamId, nextId("rollback-source"));
        const identity = await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: membership.teamId,
                externalUserId: nextId("rollback-user"),
                state: "active",
                boundAccountId: oldAccountId,
                teamMembershipId: membership.membershipId,
                teamMembershipTeamId: membership.teamId,
            },
        });
        const viewerAccountId = await createAccount();
        await db.teamMembership.create({
            data: { teamId: membership.teamId, accountId: viewerAccountId, role: "member" },
        });
        const viewerSeqBefore = (await db.account.findUniqueOrThrow({
            where: { id: viewerAccountId },
            select: { seq: true },
        })).seq;
        const replacementAccountId = nextId("acc-replacement");

        await expect(inTx(async (tx) => await replaceAccountForProviderResetInTx(tx, {
            oldAccountId,
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: "hopper",
            retireReplacedAccountInTx: async () => {
                throw new Error("retirement failed");
            },
        }), { isolationLevel: "Serializable" })).rejects.toThrow("retirement failed");

        await expect(db.account.findUnique({ where: { id: replacementAccountId }, select: { id: true } }))
            .resolves.toBeNull();
        await expect(db.account.findUniqueOrThrow({
            where: { id: oldAccountId },
            select: { homeRole: true, status: true, username: true, feedSeq: true },
        })).resolves.toEqual({ homeRole: "owner", status: "active", username: "hopper", feedSeq: 7n });
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: membership.membershipId },
            select: { accountId: true },
        })).resolves.toEqual({ accountId: oldAccountId });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({
            where: { id: identity.id },
            select: { boundAccountId: true, teamMembershipId: true },
        })).resolves.toEqual({ boundAccountId: oldAccountId, teamMembershipId: membership.membershipId });
        await expect(db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: viewerAccountId, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID,
        } } })).resolves.toBeNull();
        await expect(db.account.findUniqueOrThrow({
            where: { id: viewerAccountId }, select: { seq: true },
        })).resolves.toEqual({ seq: viewerSeqBefore });
        await expect(db.account.count({ where: { homeRole: "owner", status: "active" } })).resolves.toBe(1);
    });

    it("rejects an absent replaced Account without creating a replacement", async () => {
        const replacementAccountId = nextId("acc-replacement");

        const result = await inTx(async (tx) => await replaceAccountForProviderResetInTx(tx, {
            oldAccountId: "missing-account",
            replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
            desiredUsername: null,
            retireReplacedAccountInTx: async () => {
                throw new Error("must not retire");
            },
        }), { isolationLevel: "Serializable" });

        expect(result).toEqual({ status: "rejected", code: "home_account_not_found" });
        await expect(db.account.findUnique({ where: { id: replacementAccountId }, select: { id: true } }))
            .resolves.toBeNull();
    });

    // A provider reset is a credential recovery, never a lifecycle recovery: a
    // Home hold or a terminal retirement must survive it. Both inactive states
    // are asserted because they fail differently today — a suspended source
    // would be retired straight through, and a disabled one short-circuits the
    // lifecycle owner as `unchanged`.
    it.each<AccountStatusV1>(["suspended", "disabled"])(
        "refuses to replace a %s Account before any mutation",
        async (status) => {
            const oldAccountId = await createAccount({ homeRole: "owner", username: "mal", status });
            const membership = await createTeamWithMember({ accountId: oldAccountId });
            const replacementAccountId = nextId("acc-replacement");
            let retired = false;

            const result = await inTx(async (tx) => await replaceAccountForProviderResetInTx(tx, {
                oldAccountId,
                replacement: { accountId: replacementAccountId, publicKey: nextId("replacement-key") },
                desiredUsername: "mal",
                retireReplacedAccountInTx: async () => { retired = true; },
            }), { isolationLevel: "Serializable" });

            expect(result).toEqual({ status: "rejected", code: "home_account_inactive" });
            expect(retired).toBe(false);
            await expect(db.account.findUnique({ where: { id: replacementAccountId }, select: { id: true } }))
                .resolves.toBeNull();
            await expect(db.account.findUniqueOrThrow({
                where: { id: oldAccountId },
                select: { username: true, status: true, homeRole: true },
            })).resolves.toEqual({ username: "mal", status, homeRole: "owner" });
            await expect(db.teamMembership.findUniqueOrThrow({
                where: { id: membership.membershipId },
                select: { accountId: true },
            })).resolves.toEqual({ accountId: oldAccountId });
        },
    );
});
