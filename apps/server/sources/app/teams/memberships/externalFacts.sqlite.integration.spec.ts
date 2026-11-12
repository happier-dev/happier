import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { applyTeamGroupContributionInTx } from "../groups/groupContributions";
import { admitTeamMemberInTx } from "./membershipService";
import {
    applyExternalGroupContributionInTx,
    applyExternalManagedGroupInTx,
    applyExternalTeamMembershipInTx,
    removeExternalGroupBindingInTx,
    revokeExternalSourceFactsInTx,
    withdrawIneligibleDirectoryGroupContributionsInTx,
} from "./externalFacts";

describe("Team external-fact seam (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-external-facts-",
            initAuth: false,
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account() {
        return db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
    }

    async function team(name: string) {
        return db.team.create({ data: { name } });
    }

    async function source(teamId: string, displayName: string) {
        const provider = await db.identityProviderInstance.create({
            data: { ownerTeamId: teamId, kind: "workos_sso", displayName, config: { v: 1 } },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        const directorySource = await db.teamDirectorySource.create({
            data: {
                teamId,
                kind: "workos_directory",
                displayName,
                externalSourceKey: `workos:${teamId}:${crypto.randomUUID()}`,
                bindingConfig: { v: 1, kind: "workos_directory" },
                teamIdentityConnectionId: connection.id,
            },
        });
        return { connection, directorySource };
    }

    async function identity(input: Readonly<{
        directorySourceId: string;
        accountId: string;
        externalUserId: string;
    }>) {
        return db.teamProvisionedIdentity.create({
            data: {
                source: { connect: { id: input.directorySourceId } },
                boundAccount: { connect: { id: input.accountId } },
                externalUserId: input.externalUserId,
                state: "active",
            },
        });
    }

    async function group(teamId: string, name: string) {
        return db.teamGroup.create({
            data: { teamId, name, nameKey: name.toLowerCase() },
        });
    }

    async function binding(input: Readonly<{
        teamId: string;
        teamGroupId: string;
        directorySourceId?: string;
        teamIdentityConnectionId?: string;
        bindingMode?: "native_target" | "directory_created";
    }>) {
        return db.teamExternalGroupBinding.create({
            data: {
                teamId: input.teamId,
                teamGroupId: input.teamGroupId,
                ...(input.directorySourceId ? { directorySourceId: input.directorySourceId } : {}),
                ...(input.teamIdentityConnectionId
                    ? { teamIdentityConnectionId: input.teamIdentityConnectionId }
                    : {}),
                externalGroupId: `ext-${crypto.randomUUID()}`,
                bindingMode: input.bindingMode ?? "native_target",
            },
        });
    }

    it("activates, replays, suspends, reactivates, and removes one source-owned lifetime", async () => {
        const person = await account();
        const acme = await team("Directory lifecycle");
        const { directorySource } = await source(acme.id, "Okta");
        await identity({
            directorySourceId: directorySource.id,
            accountId: person.id,
            externalUserId: "ext-1",
        });
        const memberSource = {
            kind: "directory_source" as const,
            directorySourceId: directorySource.id,
            externalUserId: "ext-1",
        };

        const activated = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: memberSource,
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(activated.status).toBe("applied");
        if (activated.status !== "applied") return;
        const lifetimeId = activated.teamMembershipId;
        const minted = await db.teamMembership.findUniqueOrThrow({ where: { id: lifetimeId! } });
        expect(minted.role).toBe("member");
        expect(minted.sessionAccessStartsAt).not.toBeNull();

        // Replay is idempotent and changes neither the lifetime nor the horizon.
        const replay = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: memberSource,
            desired: "active",
            historyAccess: "all_existing",
        }));
        expect(replay).toMatchObject({ status: "unchanged", teamMembershipId: lifetimeId });
        const afterReplay = await db.teamMembership.findUniqueOrThrow({ where: { id: lifetimeId! } });
        expect(afterReplay.sessionAccessStartsAt?.getTime())
            .toBe(minted.sessionAccessStartsAt?.getTime());

        const suspended = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: memberSource,
            desired: "suspended",
            historyAccess: "from_membership",
        }));
        expect(suspended).toMatchObject({ status: "applied", teamMembershipId: lifetimeId });
        expect((await db.teamMembership.findUniqueOrThrow({ where: { id: lifetimeId! } })).status)
            .toBe("suspended");

        const reactivated = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: memberSource,
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(reactivated).toMatchObject({ status: "applied", teamMembershipId: lifetimeId });
        const preserved = await db.teamMembership.findUniqueOrThrow({ where: { id: lifetimeId! } });
        expect(preserved.sessionAccessStartsAt?.getTime())
            .toBe(minted.sessionAccessStartsAt?.getTime());

        const resource = await db.teamCredentialResource.create({ data: {
            teamId: acme.id,
            custodianAccountId: person.id,
            displayName: "Directory-managed provider",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "directory-managed-provider",
                connectionSecurityFingerprint: "connection-security:v1:directory-managed-provider",
                credentialSlotId: "apiKey",
            }),
            memberGrants: { create: { teamMembershipId: lifetimeId!, deliveryMode: "direct" } },
        } });
        const externalKey = await db.teamCredentialExternalApiKey.create({ data: {
            resourceId: resource.id,
            teamMembershipId: lifetimeId!,
            label: "Directory runner",
            displayPrefix: "hapek_v1_directory",
            secretDigest: `directory-secret-${crypto.randomUUID()}`,
        } });
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: resource.id,
            recipientAccountId: person.id,
            sourceMemberKey: "provider:directory-managed-provider",
            sourceVersion: "directory-source-version-1",
            recipientMode: "plain",
            storedMaterial: new Uint8Array([1, 2, 3]),
        } });

        const removed = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: memberSource,
            desired: "absent",
            historyAccess: "from_membership",
        }));
        expect(removed).toMatchObject({ status: "applied", teamMembershipId: null });
        expect(await db.teamMembership.count({ where: { id: lifetimeId! } })).toBe(0);
        expect(await db.teamCredentialExternalApiKey.count({ where: { id: externalKey.id } })).toBe(0);
        expect(await db.teamCredentialMemberGrant.count({
            where: { resourceId: resource.id, teamMembershipId: lifetimeId! },
        })).toBe(0);
        expect(await db.teamCredentialRecipientMaterial.count({
            where: { resourceId: resource.id, recipientAccountId: person.id },
        })).toBe(0);
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: resource.id } }))
            .resolves.toMatchObject({ revision: 1 });
        await expect(db.teamCredentialActivityEvent.findMany({
            where: { resourceId: resource.id, kind: { in: ["external_key_revoked", "audience_changed"] } },
            orderBy: { kind: "asc" },
            select: { kind: true, actorAccountId: true, subjectDisplayName: true },
        })).resolves.toEqual([
            { kind: "audience_changed", actorAccountId: null, subjectDisplayName: resource.displayName },
            { kind: "external_key_revoked", actorAccountId: null, subjectDisplayName: externalKey.label },
        ]);
    });

    it("mints a provisioned membership from the current Team history default", async () => {
        const person = await account();
        const acme = await db.team.create({
            data: { name: "Current membership default", defaultSessionHistoryAccess: "all_existing" },
        });
        const { directorySource } = await source(acme.id, "Okta");
        await identity({
            directorySourceId: directorySource.id,
            accountId: person.id,
            externalUserId: "ext-current-default",
        });

        const activated = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: {
                kind: "directory_source",
                directorySourceId: directorySource.id,
                externalUserId: "ext-current-default",
            },
            desired: "active",
            // Prepared source state is deliberately stale; final transaction
            // policy is authoritative.
            historyAccess: "from_membership",
        }));
        expect(activated.status).toBe("applied");
        if (activated.status !== "applied" || activated.teamMembershipId === null) return;
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: activated.teamMembershipId },
            select: { sessionAccessStartsAt: true },
        })).resolves.toEqual({ sessionAccessStartsAt: null });
    });

    it("never seizes a native membership and never touches another Team", async () => {
        const person = await account();
        const acme = await team("Collision");
        const { directorySource } = await source(acme.id, "Okta");
        await identity({
            directorySourceId: directorySource.id,
            accountId: person.id,
            externalUserId: "ext-2",
        });
        const native = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id, accountId: person.id, role: "admin", historyAccess: "all_existing",
        }));
        expect(native.ok).toBe(true);

        const seized = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: {
                kind: "directory_source",
                directorySourceId: directorySource.id,
                externalUserId: "ext-2",
            },
            desired: "active",
            historyAccess: "from_membership",
        }));
        const untouched = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: acme.id, accountId: person.id } },
        });
        // Reported as somebody else's lifetime, not as a conflict: the source
        // still has valid Group evidence against this exact membership.
        expect(seized).toEqual({ status: "managed_elsewhere", teamMembershipId: untouched.id });
        expect(untouched.role).toBe("admin");
        expect(untouched.sessionAccessStartsAt).toBeNull();

        // A source cannot end a lifetime it never admitted, so an offboarding
        // observation for that person is a no-op rather than a conflict that
        // would park the whole source.
        const notOffboarded = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: {
                kind: "directory_source",
                directorySourceId: directorySource.id,
                externalUserId: "ext-2",
            },
            desired: "absent",
            historyAccess: "from_membership",
        }));
        expect(notOffboarded).toEqual({
            status: "unchanged",
            teamMembershipId: untouched.id,
            accountId: person.id,
        });
        await expect(db.teamMembership.count({ where: { id: untouched.id } })).resolves.toBe(1);

        // A source belonging to another Team cannot reach this one.
        const other = await team("Other Home Team");
        const crossed = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: other.id,
            accountId: person.id,
            source: {
                kind: "directory_source",
                directorySourceId: directorySource.id,
                externalUserId: "ext-2",
            },
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(crossed).toEqual({ status: "source_not_found" });
    });

    it("binds one JIT connection to the membership lifetime without seizing another owner", async () => {
        const person = await account();
        const acme = await team("JIT lifetime");
        const first = await source(acme.id, "First SSO");
        const second = await source(acme.id, "Second SSO");

        const activated = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: {
                kind: "identity_connection",
                teamIdentityConnectionId: first.connection.id,
            },
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(activated.status).toBe("applied");
        if (activated.status !== "applied" || activated.teamMembershipId === null) return;
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: activated.teamMembershipId },
            select: { identityConnectionManagement: { select: { teamIdentityConnectionId: true } } },
        })).resolves.toEqual({ identityConnectionManagement: { teamIdentityConnectionId: first.connection.id } });

        await expect(inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: {
                kind: "identity_connection",
                teamIdentityConnectionId: second.connection.id,
            },
            desired: "active",
            historyAccess: "from_membership",
        }))).resolves.toEqual({
            status: "managed_elsewhere",
            teamMembershipId: activated.teamMembershipId,
        });
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: activated.teamMembershipId },
            select: { identityConnectionManagement: { select: { teamIdentityConnectionId: true } } },
        })).resolves.toEqual({ identityConnectionManagement: { teamIdentityConnectionId: first.connection.id } });
    });

    it("revokes the exact JIT connection-owned membership lifetime atomically", async () => {
        const person = await account();
        const acme = await team("JIT revocation");
        const { connection } = await source(acme.id, "Admission SSO");
        const activated = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            source: {
                kind: "identity_connection",
                teamIdentityConnectionId: connection.id,
            },
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(activated.status).toBe("applied");
        if (activated.status !== "applied" || activated.teamMembershipId === null) return;

        const revoked = await inTx((tx) => revokeExternalSourceFactsInTx(tx, {
            teamId: acme.id,
            owner: { kind: "identity_connection", teamIdentityConnectionId: connection.id },
        }));

        expect(revoked).toMatchObject({ membershipsRemoved: 1, affectedAccountIds: [person.id] });
        await expect(db.teamMembership.count({
            where: { id: activated.teamMembershipId },
        })).resolves.toBe(0);
    });

    it("rejects a provisioned identity bound to a different Account", async () => {
        const bound = await account();
        const claimed = await account();
        const acme = await team("Binding integrity");
        const { directorySource } = await source(acme.id, "Okta");
        await identity({
            directorySourceId: directorySource.id,
            accountId: bound.id,
            externalUserId: "ext-bound-account",
        });

        const result = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: claimed.id,
            source: {
                kind: "directory_source",
                directorySourceId: directorySource.id,
                externalUserId: "ext-bound-account",
            },
            desired: "active",
            historyAccess: "from_membership",
        }));

        expect(result).toEqual({ status: "management_conflict" });
        expect(await db.teamMembership.count({ where: { teamId: acme.id } })).toBe(0);
    });

    it("rejects a binding that targets a different Group or Team", async () => {
        const person = await account();
        const acme = await team("Binding validation");
        const { directorySource } = await source(acme.id, "Okta");
        const developers = await group(acme.id, "Developers");
        const design = await group(acme.id, "Design");
        const developersBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: directorySource.id,
        });
        await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id, accountId: person.id, role: "member", historyAccess: "from_membership",
        }));

        const wrongGroup = await inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: design.id,
            accountId: person.id,
            externalGroupBindingId: developersBinding.id,
            desired: "present",
            historyAccess: "from_membership",
        }));
        expect(wrongGroup).toEqual({ status: "binding_not_found" });
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: design.id } })).toBe(0);
    });

    it("contributes to a directory Group only for an exactly bound projected member", async () => {
        const person = await account();
        const acme = await team("Contribution order");
        const { directorySource } = await source(acme.id, "Okta");
        const developers = await group(acme.id, "Developers");
        const developersBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: directorySource.id,
        });

        const early = await inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: developers.id,
            accountId: person.id,
            externalGroupBindingId: developersBinding.id,
            desired: "present",
            historyAccess: "from_membership",
        }));
        expect(early).toEqual({ status: "not_team_member" });

        await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id, accountId: person.id, role: "member", historyAccess: "from_membership",
        }));

        // Structural Team membership is not source evidence. The Lane 01
        // adapter must not let a caller attach this directory binding to an
        // arbitrary member before Lane 03's exact person/Group projection says
        // that the source contributes this Account.
        const withoutSourceEvidence = await inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: developers.id,
            accountId: person.id,
            externalGroupBindingId: developersBinding.id,
            desired: "present",
            historyAccess: "from_membership",
        }));
        expect(withoutSourceEvidence).toEqual({ status: "binding_not_found" });
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: developers.id } })).toBe(0);

        const projectedIdentity = await identity({
            directorySourceId: directorySource.id,
            accountId: person.id,
            externalUserId: "ext-group-member",
        });
        const teamMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: acme.id, accountId: person.id } },
            select: { id: true },
        });
        await db.teamProvisionedIdentity.update({
            where: { id: projectedIdentity.id },
            data: { teamMembershipId: teamMembership.id, teamMembershipTeamId: acme.id },
        });
        await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: directorySource.id,
                externalGroupId: developersBinding.externalGroupId,
                externalDisplayName: "Developers",
                state: "active",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: directorySource.id,
                externalGroupId: developersBinding.externalGroupId,
                externalUserId: "ext-group-member",
            },
        });
        const contributed = await inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: developers.id,
            accountId: person.id,
            externalGroupBindingId: developersBinding.id,
            desired: "present",
            historyAccess: "from_membership",
        }));
        expect(contributed).toEqual({ status: "ok", outcome: "added" });
    });

    it("does not stockpile an external contribution on an archived Group", async () => {
        const person = await account();
        const acme = await team("Archived contribution");
        const { directorySource } = await source(acme.id, "Okta");
        const developers = await db.teamGroup.create({
            data: { teamId: acme.id, name: "Developers", nameKey: "developers", archivedAt: new Date() },
        });
        const developersBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: directorySource.id,
        });
        await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id, accountId: person.id, role: "member", historyAccess: "from_membership",
        }));

        await expect(inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: developers.id,
            accountId: person.id,
            externalGroupBindingId: developersBinding.id,
            desired: "present",
            historyAccess: "from_membership",
        }))).resolves.toEqual({ status: "group_archived" });
        await expect(db.teamGroupMembership.count({ where: { teamGroupId: developers.id } })).resolves.toBe(0);
    });

    it("mints the first external Group horizon from the current Team default", async () => {
        const person = await account();
        const acme = await db.team.create({
            data: { name: "Current Group default", defaultSessionHistoryAccess: "all_existing" },
        });
        const { directorySource } = await source(acme.id, "Okta");
        const developers = await group(acme.id, "Developers");
        const developersBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: directorySource.id,
        });
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            role: "member",
            historyAccess: "from_membership",
        }));
        if (!admitted.ok) throw new Error("expected admission");
        const projectedIdentity = await identity({
            directorySourceId: directorySource.id,
            accountId: person.id,
            externalUserId: "ext-current-default",
        });
        await db.teamProvisionedIdentity.update({
            where: { id: projectedIdentity.id },
            data: { teamMembershipId: admitted.membership.teamMembershipId, teamMembershipTeamId: acme.id },
        });
        await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: directorySource.id,
                externalGroupId: developersBinding.externalGroupId,
                externalDisplayName: "Developers",
                state: "active",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: directorySource.id,
                externalGroupId: developersBinding.externalGroupId,
                externalUserId: "ext-current-default",
            },
        });

        await inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: developers.id,
            accountId: person.id,
            externalGroupBindingId: developersBinding.id,
            desired: "present",
            // A prepared stale value must not override the Team policy reread by
            // the final transaction.
            historyAccess: "from_membership",
        }));

        await expect(db.teamGroupMembership.findUniqueOrThrow({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: developers.id,
                    teamMembershipId: admitted.membership.teamMembershipId,
                },
            },
            select: { sessionAccessStartsAt: true },
        })).resolves.toEqual({ sessionAccessStartsAt: null });
    });

    it.each(["active", "suspended"] as const)("withdraws only newly ineligible contributions when a %s identity loses management", async (releasedIdentityState) => {
        const person = await account();
        const acme = await team(`Directory handoff ${releasedIdentityState}`);
        const okta = await source(acme.id, "Okta");
        const entra = await source(acme.id, "Entra");
        const developers = await group(acme.id, "Developers");
        const oldBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: okta.directorySource.id,
        });
        const independentBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: entra.directorySource.id,
        });
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            role: "member",
            historyAccess: "from_membership",
        }));
        if (!admitted.ok) throw new Error("expected admission");
        const teamMembershipId = admitted.membership.teamMembershipId;
        for (const externalGroupBindingId of [oldBinding.id, independentBinding.id]) {
            await inTx((tx) => applyTeamGroupContributionInTx(tx, {
                teamId: acme.id,
                teamGroupId: developers.id,
                teamMembershipId,
                contribution: { kind: "external", externalGroupBindingId },
                desired: "present",
                historyAccess: "from_membership",
            }));
        }
        const where = { teamGroupId_teamMembershipId: { teamGroupId: developers.id, teamMembershipId } };
        const before = await db.teamGroupMembership.findUniqueOrThrow({ where });

        await inTx((tx) => withdrawIneligibleDirectoryGroupContributionsInTx(tx, {
            teamId: acme.id,
            teamMembershipId,
            accountId: person.id,
            directorySourceId: okta.directorySource.id,
            releasedIdentityState,
            sessionAccessImpacts: new Map(),
        }));

        const retained = await db.teamGroupMembership.findUniqueOrThrow({
            where,
            include: { externalContributions: true },
        });
        expect(retained.externalContributions.map(({ externalGroupBindingId }) => externalGroupBindingId).sort())
            .toEqual((releasedIdentityState === "active"
                ? [oldBinding.id, independentBinding.id]
                : [independentBinding.id]).sort());
        expect(retained.sessionAccessStartsAt).toEqual(before.sessionAccessStartsAt);
    });

    it("removes one exact binding while native and other-source contributions survive", async () => {
        const person = await account();
        const acme = await team("Exact binding removal");
        const okta = await source(acme.id, "Okta");
        const entra = await source(acme.id, "Entra");
        const developers = await group(acme.id, "Developers");
        const oktaBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: okta.directorySource.id,
        });
        const entraBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: entra.directorySource.id,
        });
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id,
            accountId: person.id,
            role: "member",
            historyAccess: "from_membership",
        }));
        if (!admitted.ok) throw new Error("expected admission");
        await inTx(async (tx) => {
            for (const externalGroupBindingId of [oktaBinding.id, entraBinding.id]) {
                await applyTeamGroupContributionInTx(tx, {
                    teamId: acme.id,
                    teamGroupId: developers.id,
                    teamMembershipId: admitted.membership.teamMembershipId,
                    contribution: { kind: "external", externalGroupBindingId },
                    desired: "present",
                    historyAccess: "from_membership",
                });
            }
            await applyTeamGroupContributionInTx(tx, {
                teamId: acme.id,
                teamGroupId: developers.id,
                teamMembershipId: admitted.membership.teamMembershipId,
                contribution: { kind: "native" },
                desired: "present",
                historyAccess: "from_membership",
            });
        });

        await expect(inTx((tx) => removeExternalGroupBindingInTx(tx, {
            teamId: acme.id,
            bindingId: oktaBinding.id,
        }))).resolves.toEqual({
            status: "removed",
            contributionsRemoved: 1,
            affectedAccountIds: [person.id],
        });
        await expect(db.teamGroupMembership.findUniqueOrThrow({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: developers.id,
                    teamMembershipId: admitted.membership.teamMembershipId,
                },
            },
            include: { externalContributions: true },
        })).resolves.toMatchObject({
            nativeContribution: true,
            externalContributions: [{ externalGroupBindingId: entraBinding.id }],
        });
    });

    it("archives and restores only a Group its own directory_created binding owns", async () => {
        const acme = await team("Managed group");
        const { directorySource } = await source(acme.id, "Okta");
        const sourced = await group(acme.id, "Sourced");
        const nativeTarget = await group(acme.id, "Native target");
        const owning = await binding({
            teamId: acme.id,
            teamGroupId: sourced.id,
            directorySourceId: directorySource.id,
            bindingMode: "directory_created",
        });
        const contributing = await binding({
            teamId: acme.id,
            teamGroupId: nativeTarget.id,
            directorySourceId: directorySource.id,
        });

        const retired = await inTx((tx) => applyExternalManagedGroupInTx(tx, {
            teamId: acme.id, externalGroupBindingId: owning.id, desired: "retired",
        }));
        expect(retired).toMatchObject({ status: "applied" });
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: sourced.id } })).archivedAt)
            .not.toBeNull();

        const renamed = await inTx((tx) => applyExternalManagedGroupInTx(tx, {
            teamId: acme.id,
            externalGroupBindingId: owning.id,
            desired: "active",
            sourceDisplayName: "Platform",
        }));
        expect(renamed).toMatchObject({ status: "applied" });
        const restored = await db.teamGroup.findUniqueOrThrow({ where: { id: sourced.id } });
        expect(restored.archivedAt).toBeNull();
        expect(restored.name).toBe("Platform");

        await group(acme.id, "Eng Team");
        const canonicalCollision = await inTx((tx) => applyExternalManagedGroupInTx(tx, {
            teamId: acme.id,
            externalGroupBindingId: owning.id,
            desired: "active",
            sourceDisplayName: "  Eng \t Team  ",
        }));
        expect(canonicalCollision).toEqual({ status: "unchanged", teamGroupId: sourced.id });
        await expect(db.teamGroup.findUniqueOrThrow({ where: { id: sourced.id } }))
            .resolves.toMatchObject({ name: "Platform", nameKey: "platform" });

        // A contributing binding is not the metadata owner and cannot archive a
        // Group it merely feeds members into.
        const refused = await inTx((tx) => applyExternalManagedGroupInTx(tx, {
            teamId: acme.id, externalGroupBindingId: contributing.id, desired: "retired",
        }));
        expect(refused).toEqual({ status: "not_metadata_owner" });
        expect((await db.teamGroup.findUniqueOrThrow({ where: { id: nativeTarget.id } })).archivedAt)
            .toBeNull();
    });

    it("revokes one source atomically while another source and native rows survive", async () => {
        const kept = await account();
        const owned = await account();
        const acme = await team("Revocation");
        const okta = await source(acme.id, "Okta");
        const entra = await source(acme.id, "Entra");
        const developers = await group(acme.id, "Developers");
        const oktaBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: okta.directorySource.id,
        });
        const entraBinding = await binding({
            teamId: acme.id,
            teamGroupId: developers.id,
            directorySourceId: entra.directorySource.id,
        });

        // `kept` is a native Team member contributed by both sources plus a
        // native Group contribution; `owned` is a lifetime Okta itself owns.
        const keptMembership = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id, accountId: kept.id, role: "member", historyAccess: "from_membership",
        }));
        expect(keptMembership.ok).toBe(true);
        if (!keptMembership.ok) return;
        for (const contribution of [
            { kind: "native" as const },
            { kind: "external" as const, externalGroupBindingId: oktaBinding.id },
            { kind: "external" as const, externalGroupBindingId: entraBinding.id },
        ]) {
            await inTx((tx) => applyTeamGroupContributionInTx(tx, {
                teamId: acme.id,
                teamGroupId: developers.id,
                teamMembershipId: keptMembership.membership.teamMembershipId,
                contribution,
                desired: "present",
                historyAccess: "from_membership",
            }));
        }
        const keptHorizon = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamMembershipId: keptMembership.membership.teamMembershipId },
        });

        await identity({
            directorySourceId: okta.directorySource.id,
            accountId: owned.id,
            externalUserId: "ext-owned",
        });
        const ownedActivation = await inTx((tx) => applyExternalTeamMembershipInTx(tx, {
            teamId: acme.id,
            accountId: owned.id,
            source: {
                kind: "directory_source",
                directorySourceId: okta.directorySource.id,
                externalUserId: "ext-owned",
            },
            desired: "active",
            historyAccess: "from_membership",
        }));
        expect(ownedActivation.status).toBe("applied");
        if (ownedActivation.status !== "applied") return;
        await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: okta.directorySource.id,
                externalGroupId: oktaBinding.externalGroupId,
                externalDisplayName: "Developers",
                state: "active",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: okta.directorySource.id,
                externalGroupId: oktaBinding.externalGroupId,
                externalUserId: "ext-owned",
            },
        });
        await inTx((tx) => applyExternalGroupContributionInTx(tx, {
            teamId: acme.id,
            groupId: developers.id,
            accountId: owned.id,
            externalGroupBindingId: oktaBinding.id,
            desired: "present",
            historyAccess: "from_membership",
        }));
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: developers.id } })).toBe(2);

        const credentialResource = await db.teamCredentialResource.create({ data: {
            teamId: acme.id,
            custodianAccountId: kept.id,
            displayName: "Bulk directory provider",
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "bulk-directory-provider",
                connectionSecurityFingerprint: "connection-security:v1:bulk-directory-provider",
                credentialSlotId: "apiKey",
            }),
            memberGrants: { create: {
                teamMembershipId: ownedActivation.teamMembershipId!,
                deliveryMode: "direct",
            } },
        } });
        const externalKey = await db.teamCredentialExternalApiKey.create({ data: {
            resourceId: credentialResource.id,
            teamMembershipId: ownedActivation.teamMembershipId!,
            label: "Bulk directory runner",
            displayPrefix: "hapek_v1_bulk_directory",
            secretDigest: `bulk-directory-secret-${crypto.randomUUID()}`,
        } });
        await db.teamCredentialRecipientMaterial.create({ data: {
            resourceId: credentialResource.id,
            recipientAccountId: owned.id,
            sourceMemberKey: "provider:bulk-directory-provider",
            sourceVersion: "bulk-directory-source-version-1",
            recipientMode: "plain",
            storedMaterial: new Uint8Array([4, 5, 6]),
        } });

        const rollbackMarker = new Error("rollback external source revocation");
        await expect(inTx(async (tx) => {
            await revokeExternalSourceFactsInTx(tx, {
                teamId: acme.id,
                owner: { kind: "directory_source", directorySourceId: okta.directorySource.id },
            });
            throw rollbackMarker;
        })).rejects.toBe(rollbackMarker);
        expect(await db.teamMembership.count({
            where: { id: ownedActivation.teamMembershipId! },
        })).toBe(1);
        expect(await db.teamCredentialExternalApiKey.count({ where: { id: externalKey.id } })).toBe(1);
        expect(await db.teamCredentialMemberGrant.count({
            where: { resourceId: credentialResource.id, teamMembershipId: ownedActivation.teamMembershipId! },
        })).toBe(1);
        expect(await db.teamCredentialRecipientMaterial.count({
            where: { resourceId: credentialResource.id, recipientAccountId: owned.id },
        })).toBe(1);
        expect(await db.teamCredentialActivityEvent.count({
            where: { resourceId: credentialResource.id },
        })).toBe(0);

        const revoked = await inTx((tx) => revokeExternalSourceFactsInTx(tx, {
            teamId: acme.id,
            owner: { kind: "directory_source", directorySourceId: okta.directorySource.id },
        }));
        expect(revoked.contributionsRemoved).toBe(2);
        expect(revoked.membershipsRemoved).toBe(1);
        expect(await db.teamCredentialExternalApiKey.count({ where: { id: externalKey.id } })).toBe(0);
        expect(await db.teamCredentialMemberGrant.count({
            where: { resourceId: credentialResource.id, teamMembershipId: ownedActivation.teamMembershipId! },
        })).toBe(0);
        expect(await db.teamCredentialRecipientMaterial.count({
            where: { resourceId: credentialResource.id, recipientAccountId: owned.id },
        })).toBe(0);
        await expect(db.teamCredentialResource.findUniqueOrThrow({ where: { id: credentialResource.id } }))
            .resolves.toMatchObject({ revision: 1 });
        await expect(db.teamCredentialActivityEvent.findMany({
            where: { resourceId: credentialResource.id, kind: { in: ["external_key_revoked", "audience_changed"] } },
            orderBy: { kind: "asc" },
            select: { kind: true, actorAccountId: true, subjectDisplayName: true },
        })).resolves.toEqual([
            { kind: "audience_changed", actorAccountId: null, subjectDisplayName: credentialResource.displayName },
            { kind: "external_key_revoked", actorAccountId: null, subjectDisplayName: externalKey.label },
        ]);

        // Okta's own lifetime ended and its Group row went with it; the shared
        // member survived on the native and Entra contributions, horizon intact.
        expect(await db.teamMembership.count({
            where: { id: ownedActivation.teamMembershipId! },
        })).toBe(0);
        const survivor = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamMembershipId: keptMembership.membership.teamMembershipId },
        });
        expect(survivor.nativeContribution).toBe(true);
        expect(survivor.sessionAccessStartsAt?.getTime())
            .toBe(keptHorizon.sessionAccessStartsAt?.getTime());
        const remainingContributions = await db.teamGroupMembershipExternalContribution.findMany({
            where: { teamMembershipId: keptMembership.membership.teamMembershipId },
        });
        expect(remainingContributions.map((c) => c.externalGroupBindingId)).toEqual([entraBinding.id]);

        // The revoked source's bindings are gone and no empty effective row
        // survived to grant access on nothing.
        expect(await db.teamExternalGroupBinding.count({
            where: { directorySourceId: okta.directorySource.id },
        })).toBe(0);
        const empty = await db.teamGroupMembership.findMany({
            where: { teamGroupId: developers.id, nativeContribution: false },
            select: { externalContributions: { select: { externalGroupBindingId: true } } },
        });
        expect(empty.every((row) => row.externalContributions.length > 0)).toBe(true);

        // The source row itself remains deletable by its own owner: the
        // restricting foreign keys no longer hold anything.
        await db.teamDirectorySource.delete({ where: { id: okta.directorySource.id } });
    });

    it("fails source revocation closed when identity ownership disagrees with its membership", async () => {
        const boundAccount = await account();
        const membershipAccount = await account();
        const acme = await team("Revocation ownership");
        const { directorySource } = await source(acme.id, "Okta");
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: acme.id,
            accountId: membershipAccount.id,
            role: "member",
            historyAccess: "from_membership",
        }));
        if (!admitted.ok) throw new Error("expected admission");
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: directorySource.id,
                teamId: acme.id,
                externalUserId: "mismatched-account",
                state: "active",
                boundAccountId: boundAccount.id,
                teamMembershipId: admitted.membership.teamMembershipId,
                teamMembershipTeamId: acme.id,
            },
        });

        await expect(inTx((tx) => revokeExternalSourceFactsInTx(tx, {
            teamId: acme.id,
            owner: { kind: "directory_source", directorySourceId: directorySource.id },
        }))).rejects.toThrow("ownership binding is inconsistent");
        await expect(db.teamMembership.count({ where: { id: admitted.membership.teamMembershipId } })).resolves.toBe(1);
    });
});
