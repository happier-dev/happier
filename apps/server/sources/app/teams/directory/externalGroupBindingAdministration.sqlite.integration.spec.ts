import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { parsePrivateLabelStoredV1 } from "@happier-dev/protocol/crypto/privateLabelV1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { applyTeamGroupContributionInTx } from "../groups/groupContributions";
import { inTx } from "@/storage/inTx";
import {
    listExternalGroupBindingsForActor,
    removeExternalGroupBindingForActor,
    setExternalGroupBindingForActor,
} from "./externalGroupBindingAdministration";

describe("external Group binding administration", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-external-group-binding-administration-",
            initAuth: false,
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

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const managed = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const outsider = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: `Mappings ${crypto.randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: member.id, role: "member" },
            { teamId: team.id, accountId: managed.id, role: "member" },
        ] });
        const managedMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: managed.id } },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
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
            },
        });
        await db.teamProvisionedIdentity.create({
            data: {
                directorySourceId: source.id,
                teamId: team.id,
                externalUserId: "person_1",
                displayName: "Managed Person",
                state: "active",
                boundAccountId: managed.id,
                teamMembershipId: managedMembership.id,
                teamMembershipTeamId: team.id,
            },
        });
        const projectedGroup = await db.teamDirectoryGroup.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: "group_1",
                externalDisplayName: "  Engineering \t Team  ",
                state: "active",
            },
        });
        await db.teamDirectoryGroupMember.create({
            data: {
                directorySourceId: source.id,
                externalGroupId: projectedGroup.externalGroupId,
                externalUserId: "person_1",
            },
        });
        const nativeGroup = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Operators")},
        });
        await inTx((tx) => applyTeamGroupContributionInTx(tx, {
            teamId: team.id,
            teamGroupId: nativeGroup.id,
            teamMembershipId: managedMembership.id,
            contribution: { kind: "native" },
            desired: "present",
            historyAccess: "from_membership",
        }));
        return { owner, member, managed, outsider, team, connection, source, projectedGroup, nativeGroup, managedMembership };
    }

    it("requires both administration powers and maps an active directory Group through the canonical union", async () => {
        const f = await fixture();
        await db.account.update({ where: { id: f.outsider.id }, data: { homeRole: "owner" } });
        const setInput = {
            v: 1 as const,
            teamId: f.team.id,
            owner: { kind: "directory_source" as const, directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "native_target" as const, teamGroupId: f.nativeGroup.id },
        };
        await expect(setExternalGroupBindingForActor({
            ...setInput,
            actorAccountId: f.outsider.id,
        })).resolves.toEqual({ ok: false, error: "team_not_found" });
        await expect(setExternalGroupBindingForActor({
            ...setInput,
            actorAccountId: f.member.id,
        })).resolves.toEqual({ ok: false, error: "team_forbidden" });

        const set = await setExternalGroupBindingForActor({ ...setInput, actorAccountId: f.owner.id });
        expect(set).toMatchObject({
            ok: true,
            value: {
                teamId: f.team.id,
                owner: { kind: "directory_source", directorySourceId: f.source.id },
                externalGroupId: "group_1",
                mode: "native_target",
                target: {
                    teamGroupId: f.nativeGroup.id,
                    name: {
                        kind: "available",
                        label: { content: { t: "plain", v: "Operators" }, recipientEnvelope: null },
                    },
                    archivedAt: null,
                },
            },
        });
        expect(await db.teamGroupMembershipExternalContribution.count({
            where: { binding: { directorySourceId: f.source.id }, teamMembershipId: f.managedMembership.id },
        })).toBe(1);

        await db.teamDirectorySource.update({ where: { id: f.source.id }, data: { state: "paused" } });

        await expect(listExternalGroupBindingsForActor({
            v: 1,
            teamId: f.team.id,
            ownerKind: "directory_source",
            directorySourceId: f.source.id,
            actorAccountId: f.owner.id,
        })).resolves.toMatchObject({ ok: true, value: { items: [{ id: set.ok ? set.value.id : "" }], nextCursor: null } });

        const removed = await removeExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            bindingId: set.ok ? set.value.id : "missing",
            actorAccountId: f.owner.id,
        });
        expect(removed).toEqual({ ok: true, value: { v: 1, outcome: "removed" } });
        await expect(db.teamGroupMembership.findUniqueOrThrow({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: f.nativeGroup.id,
                    teamMembershipId: f.managedMembership.id,
                },
            },
        })).resolves.toMatchObject({ nativeContribution: true });

        const connectionBinding = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: {
                kind: "identity_connection",
                teamIdentityConnectionId: f.connection.id,
            },
            externalGroupId: "claim-engineering",
            target: { kind: "native_target", teamGroupId: f.nativeGroup.id },
            actorAccountId: f.owner.id,
        });
        expect(connectionBinding).toMatchObject({
            ok: true,
            value: {
                owner: { kind: "identity_connection", teamIdentityConnectionId: f.connection.id },
                mode: "native_target",
            },
        });
    });

    it("creates a normalized directory-owned Group and rejects inactive or cross-Team targets", async () => {
        const f = await fixture();
        const created = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "directory_created" },
            actorAccountId: f.owner.id,
        });
        expect(created).toMatchObject({
            ok: true,
            value: {
                mode: "directory_created",
                target: {
                    name: {
                        kind: "available",
                        label: { content: { t: "plain", v: "Engineering Team" }, recipientEnvelope: null },
                    },
                    archivedAt: null,
                },
            },
        });
        if (!created.ok) throw new Error("expected mapping");
        const persisted = await db.teamGroup.findUniqueOrThrow({ where: { id: created.value.target.teamGroupId } });
        expect(parsePrivateLabelStoredV1(persisted.name)).toMatchObject({
            kind: "current",
            stored: { content: { t: "plain", v: "Engineering Team" } },
        });

        await db.teamDirectoryGroup.update({
            where: {
                directorySourceId_externalGroupId: {
                    directorySourceId: f.source.id,
                    externalGroupId: f.projectedGroup.externalGroupId,
                },
            },
            data: { state: "deleted" },
        });
        await expect(setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "native_target", teamGroupId: f.nativeGroup.id },
            actorAccountId: f.owner.id,
        })).resolves.toEqual({ ok: false, error: "directory_group_mapping_invalid" });
    });

    it("does not materialize a directory mapping from a source disabled by current Home policy", async () => {
        const f = await fixture();
        await db.homeGovernancePolicy.upsert({
            where: { id: "home" },
            create: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
            update: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        try {
            await expect(setExternalGroupBindingForActor({
                v: 1,
                teamId: f.team.id,
                owner: { kind: "directory_source", directorySourceId: f.source.id },
                externalGroupId: f.projectedGroup.externalGroupId,
                target: { kind: "native_target", teamGroupId: f.nativeGroup.id },
                actorAccountId: f.owner.id,
            })).resolves.toEqual({ ok: false, error: "directory_group_mapping_invalid" });
            await expect(db.teamGroupMembershipExternalContribution.count({
                where: { binding: { directorySourceId: f.source.id } },
            })).resolves.toBe(0);
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

    it("adds a native-target roster source without competing for directory metadata ownership", async () => {
        const f = await fixture();
        const metadataOwner = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "directory_created" },
            actorAccountId: f.owner.id,
        });
        if (!metadataOwner.ok) throw new Error("expected metadata-owner binding");

        const rosterSource = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "identity_connection", teamIdentityConnectionId: f.connection.id },
            externalGroupId: "claim-engineering",
            target: { kind: "native_target", teamGroupId: metadataOwner.value.target.teamGroupId },
            actorAccountId: f.owner.id,
        });

        expect(rosterSource).toMatchObject({ ok: true, value: { mode: "native_target" } });
        await expect(db.teamExternalGroupBinding.count({
            where: { teamGroupId: metadataOwner.value.target.teamGroupId },
        })).resolves.toBe(2);
    });

    it("cleans the old contribution and rematerializes the roster when a mapping is retargeted", async () => {
        const f = await fixture();
        const first = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "native_target", teamGroupId: f.nativeGroup.id },
            actorAccountId: f.owner.id,
        });
        if (!first.ok) throw new Error("expected initial mapping");
        const replacementTarget = await db.teamGroup.create({
            data: { teamId: f.team.id, name: storedPlainPrivateLabel("Responders")},
        });

        const retargeted = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "native_target", teamGroupId: replacementTarget.id },
            actorAccountId: f.owner.id,
        });

        expect(retargeted).toMatchObject({
            ok: true,
            value: { target: { teamGroupId: replacementTarget.id } },
        });
        await expect(db.teamExternalGroupBinding.findUnique({ where: { id: first.value.id } }))
            .resolves.toBeNull();
        await expect(db.teamGroupMembership.findUniqueOrThrow({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: f.nativeGroup.id,
                    teamMembershipId: f.managedMembership.id,
                },
            },
            select: { nativeContribution: true, externalContributions: true },
        })).resolves.toEqual({ nativeContribution: true, externalContributions: [] });
        await expect(db.teamGroupMembership.findUniqueOrThrow({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: replacementTarget.id,
                    teamMembershipId: f.managedMembership.id,
                },
            },
            select: { nativeContribution: true, externalContributions: { select: { externalGroupBindingId: true } } },
        })).resolves.toEqual({
            nativeContribution: false,
            externalContributions: [{ externalGroupBindingId: retargeted.ok ? retargeted.value.id : "" }],
        });
    });

    it("rejects inconsistent directory identity membership before materializing a mapping", async () => {
        const f = await fixture();
        const otherMembership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: f.team.id, accountId: f.member.id } },
            select: { id: true },
        });
        await db.teamProvisionedIdentity.updateMany({
            where: { directorySourceId: f.source.id, externalUserId: "person_1" },
            data: {
                teamMembershipId: otherMembership.id,
                teamMembershipTeamId: f.team.id,
            },
        });

        await expect(setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "native_target", teamGroupId: f.nativeGroup.id },
            actorAccountId: f.owner.id,
        })).resolves.toEqual({ ok: false, error: "directory_group_mapping_invalid" });
        await expect(db.teamExternalGroupBinding.count({
            where: { directorySourceId: f.source.id },
        })).resolves.toBe(0);
        await expect(db.teamGroupMembershipExternalContribution.count({
            where: { binding: { directorySourceId: f.source.id } },
        })).resolves.toBe(0);
    });
    it("unions two directories' Group contributions onto a natively managed member without taking the Team lifetime", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const person = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const team = await db.team.create({ data: { name: `Union ${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        // Invited by hand first, the way an administrator seeds a Team before
        // wiring SCIM. No source owns this lifetime.
        const nativeMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: person.id, role: "member" },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: storedPlainPrivateLabel("Engineering")},
        });
        const bindingIds: string[] = [];
        for (const index of [1, 2]) {
            const provider = await db.identityProviderInstance.create({
                data: {
                    ownerTeamId: team.id,
                    kind: "workos_sso",
                    displayName: `WorkOS ${index}`,
                    enabled: true,
                    config: { v: 1, kind: "workos_sso" },
                },
            });
            const connection = await db.teamIdentityConnection.create({
                data: {
                    teamId: team.id,
                    providerInstanceId: provider.id,
                    enabled: true,
                    externalReference: { v: 1 },
                    settings: { v: 1 },
                },
            });
            const source = await db.teamDirectorySource.create({
                data: {
                    teamId: team.id,
                    kind: "workos_directory",
                    state: "active",
                    displayName: `Directory ${index}`,
                    externalSourceKey: `workos:${crypto.randomUUID()}`,
                    bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: `directory_${index}` },
                    teamIdentityConnectionId: connection.id,
                },
            });
            await db.teamProvisionedIdentity.create({
                data: {
                    directorySourceId: source.id,
                    teamId: team.id,
                    externalUserId: "same_person",
                    state: "active",
                    boundAccountId: person.id,
                },
            });
            await db.teamDirectoryGroup.create({
                data: {
                    directorySourceId: source.id,
                    externalGroupId: "engineering",
                    externalDisplayName: "Engineering",
                    state: "active",
                },
            });
            await db.teamDirectoryGroupMember.create({
                data: {
                    directorySourceId: source.id,
                    externalGroupId: "engineering",
                    externalUserId: "same_person",
                },
            });
            const mapped = await setExternalGroupBindingForActor({
                v: 1,
                teamId: team.id,
                owner: { kind: "directory_source", directorySourceId: source.id },
                externalGroupId: "engineering",
                target: { kind: "native_target", teamGroupId: group.id },
                actorAccountId: owner.id,
            });
            expect(mapped).toMatchObject({ ok: true });
            bindingIds.push(mapped.ok ? mapped.value.id : "missing");
        }

        // One Group row, one contribution per source, and the hand-made
        // membership is still exactly the row the administrator created.
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: group.id } })).toBe(1);
        expect(await db.teamGroupMembershipExternalContribution.count({
            where: { teamGroupId: group.id, teamMembershipId: nativeMembership.id },
        })).toBe(2);
        await expect(db.teamMembership.findUniqueOrThrow({
            where: { id: nativeMembership.id },
            select: { provisionedIdentity: { select: { id: true } }, status: true },
        })).resolves.toEqual({ provisionedIdentity: null, status: "active" });

        const removed = await removeExternalGroupBindingForActor({
            v: 1,
            teamId: team.id,
            bindingId: bindingIds[0]!,
            actorAccountId: owner.id,
        });
        expect(removed).toEqual({ ok: true, value: { v: 1, outcome: "removed" } });
        expect(await db.teamGroupMembershipExternalContribution.count({
            where: { teamGroupId: group.id, teamMembershipId: nativeMembership.id },
        })).toBe(1);
        await expect(db.teamGroupMembership.findUniqueOrThrow({
            where: {
                teamGroupId_teamMembershipId: {
                    teamGroupId: group.id,
                    teamMembershipId: nativeMembership.id,
                },
            },
            select: { externalContributions: { select: { externalGroupBindingId: true } } },
        })).resolves.toEqual({ externalContributions: [{ externalGroupBindingId: bindingIds[1]! }] });
        await expect(db.teamMembership.count({ where: { id: nativeMembership.id } })).resolves.toBe(1);
    });

    it("maps a roster in one Team publication and never grants a person the source reports inactive", async () => {
        const f = await fixture();
        // Two more natively invited people the directory also lists: one active,
        // one the provider has deactivated. Native keeps both lifetimes.
        const activePerson = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const inactivePerson = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        for (const [account, externalUserId, state] of [
            [activePerson, "person_active", "active"],
            [inactivePerson, "person_inactive", "suspended"],
        ] as const) {
            await db.teamMembership.create({ data: { teamId: f.team.id, accountId: account.id, role: "member" } });
            await db.teamProvisionedIdentity.create({
                data: {
                    directorySourceId: f.source.id,
                    teamId: f.team.id,
                    externalUserId,
                    state,
                    boundAccountId: account.id,
                },
            });
            await db.teamDirectoryGroupMember.create({
                data: {
                    directorySourceId: f.source.id,
                    externalGroupId: f.projectedGroup.externalGroupId,
                    externalUserId,
                },
            });
        }
        const target = await db.teamGroup.create({
            data: { teamId: f.team.id, name: storedPlainPrivateLabel("Mapped roster")},
        });
        const readSeq = async () => (await db.account.findUniqueOrThrow({
            where: { id: f.member.id },
            select: { seq: true },
        })).seq;
        const before = await readSeq();

        const mapped = await setExternalGroupBindingForActor({
            v: 1,
            teamId: f.team.id,
            owner: { kind: "directory_source", directorySourceId: f.source.id },
            externalGroupId: f.projectedGroup.externalGroupId,
            target: { kind: "native_target", teamGroupId: target.id },
            actorAccountId: f.owner.id,
        });
        expect(mapped).toMatchObject({ ok: true });

        // child 05 §5: compute the audience once and publish once for the
        // whole mapping — not once per materialized member plus once more.
        expect(await readSeq()).toBe(before + 1);
        const rosterAccountIds = (await db.teamGroupMembership.findMany({
            where: { teamGroupId: target.id },
            select: { teamMembership: { select: { accountId: true } } },
        })).map((row) => row.teamMembership.accountId).sort();
        expect(rosterAccountIds).toEqual([f.managed.id, activePerson.id].sort());
    });
});
