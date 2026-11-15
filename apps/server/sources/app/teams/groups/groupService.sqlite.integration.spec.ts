import { plainPrivateLabel, storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { admitTeamMemberInTx } from "../memberships/membershipService";
import { applyTeamGroupContributionInTx } from "./groupContributions";
import {
    addTeamGroupMemberForActorInTx,
    archiveTeamGroupForActorInTx,
    createTeamGroupForActorInTx,
    getTeamGroupForActorInTx,
    listTeamGroupMembersForActorInTx,
    listTeamMemberGroupsForActorInTx,
    listTeamGroupsForActorInTx,
    removeTeamGroupMemberForActorInTx,
    resolveGrantableTeamGroupForActorInTx,
    restoreTeamGroupForActorInTx,
    updateTeamGroupForActorInTx,
} from "./groupService";

describe("Team Groups (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-team-groups-",
            initAuth: false,
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account(
        homeRole: "owner" | "admin" | "member" = "member",
        encryptionMode: "plain" | "e2ee" = "plain",
    ) {
        return db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode, homeRole },
        });
    }

    async function teamWithOwner(name: string) {
        const owner = await account();
        const team = await db.team.create({ data: { name } });
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: team.id, accountId: owner.id, role: "owner", historyAccess: "all_existing",
        }));
        if (!admitted.ok) throw new Error("owner admission failed");
        return { team, ownerAccountId: owner.id };
    }

    async function memberOf(teamId: string, role: "member" | "guest" = "member") {
        const person = await account();
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId, accountId: person.id, role, historyAccess: "from_membership",
        }));
        if (!admitted.ok) throw new Error("admission failed");
        return { accountId: person.id, membershipId: admitted.membership.teamMembershipId };
    }

    async function createGroup(teamId: string, actorAccountId: string, name: string) {
        const result = await inTx((tx) => createTeamGroupForActorInTx(tx, {
            teamId,
            actorAccountId,
            groupId: crypto.randomUUID(),
            name: plainPrivateLabel(name),
            requestKey: crypto.randomUUID(),
        }));
        if (!result.ok) throw new Error(`group create failed: ${result.error}`);
        return result.value;
    }

    it("does not turn Home Team-detail administration into Group authority", async () => {
        const { team } = await teamWithOwner("Home detail is not Group access");
        const homeAdmin = await account("admin");

        const result = await inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: homeAdmin.id,
            archived: "active",
        }));

        expect(result).toEqual({ ok: false, error: "team_not_found" });
    });

    it("lets a non-member Home administrator read the Groups of an ownerless Team during recovery", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Ownerless Groups");
        const homeAdmin = await account("admin");
        await db.account.update({ where: { id: ownerAccountId }, data: { status: "suspended" } });

        const result = await inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: homeAdmin.id,
            archived: "active",
        }));

        expect(result.ok).toBe(true);
    });

    it("keeps ownerless Group recovery read-only when the Team has a restricted policy", async () => {
        const owner = await account();
        const team = await db.team.create({
            data: {
                name: "Restricted ownerless Groups",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Recovery") } });
        const homeAdmin = await account("admin");
        await db.account.update({ where: { id: owner.id }, data: { status: "suspended" } });

        const result = await inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: homeAdmin.id,
            archived: "active",
        }));

        expect(result).toMatchObject({ ok: true, value: { items: [{ id: group.id, capabilities: {
            updateMetadata: false,
            archive: false,
            restore: false,
            manageNativeMembers: false,
        } }] } });
    });

    /** A real WorkOS source and a binding that targets an existing native Group. */
    async function externalBinding(input: Readonly<{
        teamId: string;
        teamGroupId: string;
        displayName: string;
        bindingMode?: "native_target" | "directory_created";
        ownerKind?: "directory_source" | "identity_connection";
    }>) {
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: input.teamId,
                kind: "workos_sso",
                displayName: input.displayName,
                config: { v: 1 },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: input.teamId,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: input.teamId,
                kind: "workos_directory",
                displayName: input.displayName,
                externalSourceKey: `workos:${input.teamId}:${crypto.randomUUID()}`,
                bindingConfig: { v: 1, kind: "workos_directory" },
                teamIdentityConnectionId: connection.id,
            },
        });
        const binding = await db.teamExternalGroupBinding.create({
            data: {
                teamId: input.teamId,
                teamGroupId: input.teamGroupId,
                ...(input.ownerKind === "identity_connection"
                    ? { teamIdentityConnectionId: connection.id }
                    : { directorySourceId: source.id }),
                externalGroupId: `ext-${crypto.randomUUID()}`,
                bindingMode: input.bindingMode ?? "native_target",
            },
        });
        return {
            ...binding,
            directorySourceId: source.id,
            teamIdentityConnectionId: connection.id,
        };
    }

    it("creates a Group and replays one retry", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Groups create");
        const requestKey = crypto.randomUUID();
        const groupId = crypto.randomUUID();
        const name = plainPrivateLabel("Platform Design");

        const created = await inTx((tx) => createTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId, name, requestKey,
        }));
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.value.name).toEqual({
            kind: "available",
            label: { content: { t: "plain", v: "Platform Design" }, recipientEnvelope: null },
        });
        expect(created.value.management).toEqual({ kind: "native" });
        expect(created.value.memberCount).toBe(0);

        // The same intent replayed returns the same Group rather than a second one.
        const replay = await inTx((tx) => createTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId, name, requestKey,
        }));
        expect(replay.ok).toBe(true);
        if (!replay.ok) return;
        expect(replay.value.id).toBe(created.value.id);
    });

    it("keeps Group-create replay live when the process clock is behind the database clock", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Group clock consistency");
        const requestKey = crypto.randomUUID();
        const groupId = crypto.randomUUID();
        const name = plainPrivateLabel("Operators");
        const processClock = vi.spyOn(Date, "now").mockReturnValue(0);
        try {
            const first = await inTx((tx) => createTeamGroupForActorInTx(tx, {
                teamId: team.id, actorAccountId: ownerAccountId, groupId, name, requestKey,
            }));
            const replay = await inTx((tx) => createTeamGroupForActorInTx(tx, {
                teamId: team.id, actorAccountId: ownerAccountId, groupId, name, requestKey,
            }));
            expect(first.ok && replay.ok).toBe(true);
            if (!first.ok || !replay.ok) return;
            expect(replay.value.id).toBe(first.value.id);
            expect(await db.teamGroup.count({ where: { teamId: team.id } })).toBe(1);
            expect(await inTx((tx) => createTeamGroupForActorInTx(tx, {
                teamId: team.id, actorAccountId: ownerAccountId, groupId, name: plainPrivateLabel("Altered"), requestKey,
            }))).toEqual({ ok: false, error: "team_conflict" });
        } finally {
            processClock.mockRestore();
        }
    });

    it("refuses an ordinary member every Group mutation and hides nothing it may see", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Group authority");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const plain = await memberOf(team.id);

        const listed = await inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: team.id, actorAccountId: plain.accountId, archived: "active",
        }));
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        expect(listed.value.items.map((item) => item.id)).toEqual([group.id]);
        expect(listed.value.items[0]?.capabilities).toEqual({
            updateMetadata: false, archive: false, restore: false, manageNativeMembers: false,
        });

        const rename = await inTx((tx) => updateTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: plain.accountId, groupId: group.id, name: plainPrivateLabel("Renamed"),
        }));
        expect(rename).toEqual({ ok: false, error: "team_forbidden" });
    });

    it("requires the acting credential to satisfy a restricted Team on Group reads and mutations", async () => {
        const owner = await account("member", "e2ee");
        const acme = await db.team.create({
            data: {
                name: "Restricted Groups",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.teamMembership.create({ data: { teamId: acme.id, accountId: owner.id, role: "owner" } });
        const group = await db.teamGroup.create({
            data: { teamId: acme.id, name: storedPlainPrivateLabel("Private") },
        });

        await expect(inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: acme.id,
            actorAccountId: owner.id,
            archived: "active",
        }))).resolves.toEqual({ ok: false, error: "team_authentication_required" });
        await expect(inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: acme.id,
            actorAccountId: owner.id,
            groupId: group.id,
        }))).resolves.toEqual({ ok: false, error: "team_authentication_required" });

        const authentication = {
            authenticationEvidence: [{ kind: "home_method" as const, methodId: "key_challenge" }],
            authenticationAuthority: "present_user" as const,
        };
        await expect(inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: acme.id, actorAccountId: owner.id, archived: "active", authentication,
        }))).resolves.toMatchObject({ ok: true });
        await expect(inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: acme.id, actorAccountId: owner.id, groupId: group.id, authentication,
        }))).resolves.toMatchObject({ ok: true });
        await expect(inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: acme.id, actorAccountId: owner.id, groupId: group.id,
        }))).resolves.toEqual({ ok: false, error: "team_authentication_required" });

        const readOnly = await memberOf(acme.id);
        await expect(inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: acme.id, actorAccountId: readOnly.accountId, groupId: group.id,
        }))).resolves.toEqual({ ok: false, error: "team_forbidden" });
    });

    it("archives and restores a Group while retaining its rows and horizons", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Archive group");
        const group = await createGroup(team.id, ownerAccountId, "Infrastructure");
        const person = await memberOf(team.id);
        const added = await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "from_membership",
        }));
        expect(added.ok).toBe(true);
        const horizon = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        });

        const archived = await inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(archived.ok).toBe(true);
        if (!archived.ok) return;
        expect(archived.value.archivedAt).not.toBeNull();
        expect(archived.value.capabilities).toMatchObject({
            manageNativeMembers: false, restore: true, archive: false,
        });
        const archiveReplay = await inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(archiveReplay.ok).toBe(true);
        if (!archiveReplay.ok) return;
        expect(archiveReplay.value.archivedAt).toBe(archived.value.archivedAt);

        // Rows and horizons survive archive; only mutation and effectiveness stop.
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: group.id } })).toBe(1);
        const another = await memberOf(team.id);
        const blocked = await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: another.accountId,
            historyAccess: "from_membership",
        }));
        expect(blocked).toEqual({ ok: false, error: "group_archived" });

        // The archived Group is absent from the default list and reachable in
        // its own section.
        const activeList = await inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, archived: "active",
        }));
        const archivedList = await inTx((tx) => listTeamGroupsForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, archived: "archived",
        }));
        expect(activeList.ok && activeList.value.items).toEqual([]);
        expect(archivedList.ok && archivedList.value.items.map((item) => item.id)).toEqual([group.id]);

        const restored = await inTx((tx) => restoreTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(restored.ok).toBe(true);
        const restoreReplay = await inTx((tx) => restoreTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(restoreReplay.ok).toBe(true);
        if (!restoreReplay.ok) return;
        expect(restoreReplay.value.archivedAt).toBeNull();
        const retained = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        });
        expect(retained.sessionAccessStartsAt?.getTime())
            .toBe(horizon.sessionAccessStartsAt?.getTime());
    });

    it("rechecks the canonical metadata authority before a same-state lifecycle reply", async () => {
        const { team, ownerAccountId } = await teamWithOwner("No-op authority");
        const group = await createGroup(team.id, ownerAccountId, "Platform");
        const archived = await inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(archived.ok).toBe(true);
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });

        await expect(inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }))).resolves.toEqual({ ok: false, error: "team_archived" });
    });

    it("refuses to add somebody who is not a Team member", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Flat invariant");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const outsider = await account();

        const result = await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: outsider.id,
            historyAccess: "all_existing",
        }));
        expect(result).toEqual({ ok: false, error: "not_team_member" });
    });

    it("unions native and two directory contributions into one row, count, and horizon", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Union");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const person = await memberOf(team.id);
        const okta = await externalBinding({
            teamId: team.id, teamGroupId: group.id, displayName: "Okta",
        });
        const entra = await externalBinding({
            teamId: team.id,
            teamGroupId: group.id,
            displayName: "Entra",
            ownerKind: "identity_connection",
        });

        // The first contribution mints the horizon; nothing later may widen it.
        const first = await inTx((tx) => applyTeamGroupContributionInTx(tx, {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: person.membershipId,
            contribution: { kind: "external", externalGroupBindingId: okta.id },
            desired: "present",
            historyAccess: "from_membership",
        }));
        expect(first.outcome).toBe("added");
        const minted = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        });
        expect(minted.sessionAccessStartsAt).not.toBeNull();

        const second = await inTx((tx) => applyTeamGroupContributionInTx(tx, {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: person.membershipId,
            contribution: { kind: "external", externalGroupBindingId: entra.id },
            desired: "present",
            // A second source asking for all-existing must not widen a retained
            // horizon: history is granted once, by the first contribution.
            historyAccess: "all_existing",
        }));
        expect(second.outcome).toBe("contribution_added");

        const nativeAdd = await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "all_existing",
        }));
        expect(nativeAdd.ok).toBe(true);
        if (!nativeAdd.ok) return;
        expect(nativeAdd.value.status).toBe("contribution_added");

        const retained = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        });
        expect(retained.sessionAccessStartsAt?.getTime())
            .toBe(minted.sessionAccessStartsAt?.getTime());

        // One row, one count, one page entry, with truthful provenance.
        const detail = await inTx((tx) => getTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(detail.ok && detail.value.memberCount).toBe(1);
        const page = await inTx((tx) => listTeamGroupMembersForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        expect(page.value.items).toHaveLength(1);
        expect(page.value.items[0]?.contributions.native).toBe(true);
        expect(page.value.items[0]?.contributions.external
            .map((contribution) => ({ label: contribution.label, owner: contribution.owner }))
            .sort((left, right) => left.label.localeCompare(right.label)))
            .toEqual([
                {
                    label: "Entra",
                    owner: {
                        kind: "identity_connection",
                        teamIdentityConnectionId: entra.teamIdentityConnectionId,
                    },
                },
                {
                    label: "Okta",
                    owner: { kind: "directory_source", directorySourceId: okta.directorySourceId },
                },
            ]);
    });

    it("excludes retained memberships from Group count and roster while structurally inactive", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Effective Group roster");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const person = await memberOf(team.id);
        await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "from_membership",
        }));

        const expectEffectiveMember = async (expected: boolean) => {
            const detail = await inTx((tx) => getTeamGroupForActorInTx(tx, {
                teamId: team.id,
                actorAccountId: ownerAccountId,
                groupId: group.id,
            }));
            expect(detail.ok).toBe(true);
            if (!detail.ok) return;
            expect(detail.value.memberCount).toBe(expected ? 1 : 0);

            const roster = await inTx((tx) => listTeamGroupMembersForActorInTx(tx, {
                teamId: team.id,
                actorAccountId: ownerAccountId,
                groupId: group.id,
            }));
            expect(roster.ok).toBe(true);
            if (!roster.ok) return;
            expect(roster.value.items).toHaveLength(expected ? 1 : 0);
        };

        await expectEffectiveMember(true);
        await db.account.update({ where: { id: person.accountId }, data: { status: "suspended" } });
        await expectEffectiveMember(false);
        await db.account.update({ where: { id: person.accountId }, data: { status: "active" } });
        await db.teamMembership.update({ where: { id: person.membershipId }, data: { status: "suspended" } });
        await expectEffectiveMember(false);
        await db.teamMembership.update({ where: { id: person.membershipId }, data: { status: "active" } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        await expectEffectiveMember(false);
        await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        await expectEffectiveMember(false);
    });

    it("treats removal of a contribution from an absent Group row as unchanged", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Absent contribution");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const person = await memberOf(team.id);

        const result = await inTx((tx) => applyTeamGroupContributionInTx(tx, {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: person.membershipId,
            contribution: { kind: "native" },
            desired: "absent",
            historyAccess: "from_membership",
        }));

        expect(result).toEqual({ outcome: "unchanged", membershipRetained: false });

        const serviceResult = await inTx((tx) => removeTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
        }));
        expect(serviceResult).toEqual({ ok: true, value: { status: "unchanged" } });
        expect(await db.teamGroupMembership.count({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        })).toBe(0);
    });

    it("ends membership only when the last contribution disappears, in any order", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Last contribution");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const person = await memberOf(team.id);
        const okta = await externalBinding({
            teamId: team.id, teamGroupId: group.id, displayName: "Okta",
        });

        await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "from_membership",
        }));
        await inTx((tx) => applyTeamGroupContributionInTx(tx, {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: person.membershipId,
            contribution: { kind: "external", externalGroupBindingId: okta.id },
            desired: "present",
            historyAccess: "from_membership",
        }));
        const minted = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        });

        // Clearing the native contribution does not end access, and the result
        // says exactly that instead of claiming a removal.
        const nativeCleared = await inTx((tx) => removeTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
        }));
        expect(nativeCleared.ok).toBe(true);
        if (!nativeCleared.ok) return;
        expect(nativeCleared.value.status).toBe("contribution_removed");
        if (nativeCleared.value.status !== "contribution_removed") return;
        expect(nativeCleared.value.member.contributions).toEqual({
            native: false,
            external: [{
                bindingId: okta.id,
                label: "Okta",
                owner: { kind: "directory_source", directorySourceId: okta.directorySourceId },
            }],
        });
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: group.id } })).toBe(1);

        // A repeated native removal is a normal no-op, not a removal.
        const again = await inTx((tx) => removeTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
        }));
        expect(again.ok && again.value.status).toBe("unchanged");

        // The last contribution ends the membership and deletes the row; an
        // empty effective row must never survive to grant access.
        const last = await inTx((tx) => applyTeamGroupContributionInTx(tx, {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: person.membershipId,
            contribution: { kind: "external", externalGroupBindingId: okta.id },
            desired: "absent",
            historyAccess: "from_membership",
        }));
        expect(last).toEqual({ outcome: "removed", membershipRetained: false });
        expect(await db.teamGroupMembership.count({ where: { teamGroupId: group.id } })).toBe(0);

        // Rejoining mints a genuinely new horizon rather than resurrecting one.
        const rejoined = await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "from_membership",
        }));
        expect(rejoined.ok && rejoined.value.status).toBe("added");
        const fresh = await db.teamGroupMembership.findFirstOrThrow({
            where: { teamGroupId: group.id, teamMembershipId: person.membershipId },
        });
        expect(fresh.sessionAccessStartsAt?.getTime())
            .toBeGreaterThanOrEqual(minted.sessionAccessStartsAt?.getTime() ?? 0);
        expect(fresh.createdAt.getTime()).toBeGreaterThanOrEqual(minted.createdAt.getTime());
    });

    it("keeps a directory-created Group natively editable as a roster but not as metadata", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Directory created");
        const group = await createGroup(team.id, ownerAccountId, "Sourced");
        await externalBinding({
            teamId: team.id,
            teamGroupId: group.id,
            displayName: "Okta",
            bindingMode: "directory_created",
        });
        const person = await memberOf(team.id);

        const detail = await inTx((tx) => getTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(detail.ok).toBe(true);
        if (!detail.ok) return;
        expect(detail.value.management).toMatchObject({
            kind: "directory_created",
            label: "Okta",
            owner: { kind: "directory_source", directorySourceId: expect.any(String) },
        });
        expect(detail.value.capabilities).toEqual({
            updateMetadata: false, archive: false, restore: false, manageNativeMembers: true,
        });

        const rename = await inTx((tx) => updateTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id, name: plainPrivateLabel("Renamed"),
        }));
        expect(rename).toEqual({ ok: false, error: "managed_by_directory" });

        const sameStateRestore = await inTx((tx) => restoreTeamGroupForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id,
        }));
        expect(sameStateRestore).toEqual({ ok: false, error: "managed_by_directory" });

        const rosterEdit = await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "from_membership",
        }));
        expect(rosterEdit.ok && rosterEdit.value.status).toBe("added");
    });

    it("cascades Group membership when the Team membership lifetime ends", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Cascade");
        const group = await createGroup(team.id, ownerAccountId, "Developers");
        const person = await memberOf(team.id);
        await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            accountId: person.accountId,
            historyAccess: "from_membership",
        }));

        await db.teamMembership.delete({ where: { id: person.membershipId } });
        expect(await db.teamGroupMembership.count({
            where: { teamMembershipId: person.membershipId },
        })).toBe(0);
    });

    it("pages the effective Groups for one membership lifetime, leaving out archived Groups", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Member detail groups");
        const alpha = await createGroup(team.id, ownerAccountId, "Alpha");
        const beta = await createGroup(team.id, ownerAccountId, "Beta");
        const gamma = await createGroup(team.id, ownerAccountId, "Gamma");
        await createGroup(team.id, ownerAccountId, "Not assigned");
        const person = await memberOf(team.id);
        for (const group of [alpha, beta, gamma]) {
            await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
                teamId: team.id,
                actorAccountId: ownerAccountId,
                groupId: group.id,
                accountId: person.accountId,
                historyAccess: "from_membership",
            }));
        }
        // An archived Group keeps its rows for restore, but its roster and count are empty
        // (structural membership), so member detail must not list it either.
        await inTx((tx) => archiveTeamGroupForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: beta.id,
        }));

        const first = await inTx((tx) => listTeamMemberGroupsForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            membershipId: person.membershipId,
            limit: 1,
        }));
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const expectedById = [alpha, gamma].sort((left, right) => left.id.localeCompare(right.id));
        expect(first.value.items.map((group) => group.id)).toEqual([expectedById[0]!.id]);

        const second = await inTx((tx) => listTeamMemberGroupsForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            membershipId: person.membershipId,
            cursor: first.value.nextCursor,
            limit: 1,
        }));
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.value.items.map((group) => group.id)).toEqual([expectedById[1]!.id]);
        expect(second.value.nextCursor).toBeNull();

        const other = await memberOf(team.id);
        const crossed = await inTx((tx) => listTeamMemberGroupsForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            membershipId: other.membershipId,
            cursor: first.value.nextCursor,
        }));
        expect(crossed).toEqual({ ok: false, error: "invalid_team_cursor" });
    });

    it("pages Group members in creation order and rejects another Group's cursor", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Group paging");
        const group = await createGroup(team.id, ownerAccountId, "Wide");
        const other = await createGroup(team.id, ownerAccountId, "Narrow");
        const people: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const person = await memberOf(team.id);
            people.push(person.accountId);
            await inTx((tx) => addTeamGroupMemberForActorInTx(tx, {
                teamId: team.id,
                actorAccountId: ownerAccountId,
                groupId: group.id,
                accountId: person.accountId,
                historyAccess: "from_membership",
            }));
        }

        const first = await inTx((tx) => listTeamGroupMembersForActorInTx(tx, {
            teamId: team.id, actorAccountId: ownerAccountId, groupId: group.id, limit: 2,
        }));
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.value.items.map((item) => item.accountId)).toEqual(people.slice(0, 2));

        const second = await inTx((tx) => listTeamGroupMembersForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: group.id,
            limit: 2,
            cursor: first.value.nextCursor,
        }));
        expect(second.ok && second.value.items.map((item) => item.accountId)).toEqual(people.slice(2));

        const crossed = await inTx((tx) => listTeamGroupMembersForActorInTx(tx, {
            teamId: team.id,
            actorAccountId: ownerAccountId,
            groupId: other.id,
            cursor: first.value.nextCursor,
        }));
        expect(crossed).toEqual({ ok: false, error: "invalid_team_cursor" });
    });

    it("resolves a grantable Group only through current parent-Team membership", async () => {
        const { team, ownerAccountId } = await teamWithOwner("Grantable Group");
        const group = await createGroup(team.id, ownerAccountId, `Grantable ${crypto.randomUUID()}`);
        await expect(inTx((tx) => resolveGrantableTeamGroupForActorInTx(tx, {
            actorAccountId: ownerAccountId,
            teamId: team.id,
            groupId: group.id,
        }))).resolves.toEqual({ teamId: team.id, groupId: group.id });
        const stranger = await account();
        await expect(inTx((tx) => resolveGrantableTeamGroupForActorInTx(tx, {
            actorAccountId: stranger.id,
            teamId: team.id,
            groupId: group.id,
        }))).resolves.toBeNull();
    });
});
