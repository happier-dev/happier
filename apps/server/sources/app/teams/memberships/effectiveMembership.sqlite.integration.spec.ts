import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { resolveTeamMembershipContextInTx } from "./effectiveMembership";
import {
    resolveEffectiveTeamGroupIdsForAccountInTx,
    resolveTeamGroupMembershipContextInTx,
} from "../groups/effectiveGroupMembership";

describe("Team membership context resolution (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-membership-context-", initAuth: false });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account() {
        return db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
    }

    async function fixture() {
        const member = await account();
        const team = await db.team.create({ data: { name: "Acme" } });
        const teamHorizon = new Date("2026-03-01T00:00:00.000Z");
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: member.id, role: "member", sessionAccessStartsAt: teamHorizon },
        });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel("Developers") } });
        const groupHorizon = new Date("2026-05-01T00:00:00.000Z");
        await db.teamGroupMembership.create({
            data: {
                teamId: team.id,
                teamGroupId: group.id,
                teamMembershipId: membership.id,
                nativeContribution: true,
                sessionAccessStartsAt: groupHorizon,
            },
        });
        return { member, team, membership, group, teamHorizon, groupHorizon };
    }

    it("resolves the current lifetime with its persisted horizon and semantic history access", async () => {
        const f = await fixture();
        const resolved = await inTx(tx => resolveTeamMembershipContextInTx(tx, {
            teamId: f.team.id,
            teamMembershipId: f.membership.id,
            expectedAccountId: f.member.id,
        }));

        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.membership.teamMembershipId).toBe(f.membership.id);
        expect(resolved.membership.accountId).toBe(f.member.id);
        expect(resolved.membership.sessionAccessStartsAt?.getTime()).toBe(f.teamHorizon.getTime());
        expect(resolved.membership.historyAccess).toBe("from_membership");
        expect(resolved.membership.effective).toBe(true);
    });

    it("projects a null cutoff as all-existing history", async () => {
        const member = await account();
        const team = await db.team.create({ data: { name: "All existing" } });
        const membership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: member.id, role: "member", sessionAccessStartsAt: null },
        });

        const resolved = await inTx(tx => resolveTeamMembershipContextInTx(tx, {
            teamId: team.id,
            teamMembershipId: membership.id,
            expectedAccountId: member.id,
        }));

        expect(resolved).toMatchObject({ ok: true, membership: { historyAccess: "all_existing", sessionAccessStartsAt: null } });
    });

    it("rejects a lifetime whose Account was replaced instead of serving the new Account's data", async () => {
        const f = await fixture();
        const replacement = await account();
        // Provider Account replacement moves only `accountId` and preserves the lifetime.
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { accountId: replacement.id } });

        const resolved = await inTx(tx => resolveTeamMembershipContextInTx(tx, {
            teamId: f.team.id,
            teamMembershipId: f.membership.id,
            expectedAccountId: f.member.id,
        }));

        expect(resolved).toEqual({ ok: false, error: "team_membership_account_changed" });
    });

    it("does not resolve a real membership id through another Team", async () => {
        const f = await fixture();
        const other = await db.team.create({ data: { name: "Other" } });

        const resolved = await inTx(tx => resolveTeamMembershipContextInTx(tx, {
            teamId: other.id,
            teamMembershipId: f.membership.id,
            expectedAccountId: f.member.id,
        }));

        expect(resolved).toEqual({ ok: false, error: "team_membership_not_found" });
    });

    it("keeps the row resolvable but ineffective for each structural input", async () => {
        const suspendedMembership = await fixture();
        await db.teamMembership.update({ where: { id: suspendedMembership.membership.id }, data: { status: "suspended" } });

        const suspendedAccount = await fixture();
        await db.account.update({ where: { id: suspendedAccount.member.id }, data: { status: "suspended" } });

        const archivedTeam = await fixture();
        await db.team.update({ where: { id: archivedTeam.team.id }, data: { archivedAt: new Date() } });

        for (const f of [suspendedMembership, suspendedAccount, archivedTeam]) {
            const resolved = await inTx(tx => resolveTeamMembershipContextInTx(tx, {
                teamId: f.team.id,
                teamMembershipId: f.membership.id,
                expectedAccountId: f.member.id,
            }));
            expect(resolved.ok).toBe(true);
            if (!resolved.ok) continue;
            expect(resolved.membership.effective).toBe(false);
            // The retained horizon must survive so restoration is not a history rewrite.
            expect(resolved.membership.sessionAccessStartsAt?.getTime()).toBe(f.teamHorizon.getTime());
        }
    });

    it("resolves a Group membership from its public Account address with the Group's independent horizon", async () => {
        const f = await fixture();
        const resolved = await inTx(tx => resolveTeamGroupMembershipContextInTx(tx, {
            teamId: f.team.id,
            groupId: f.group.id,
            accountId: f.member.id,
        }));

        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.groupMembership.teamMembershipId).toBe(f.membership.id);
        expect(resolved.groupMembership.sessionAccessStartsAt?.getTime()).toBe(f.groupHorizon.getTime());
        expect(resolved.groupMembership.sessionAccessStartsAt?.getTime()).not.toBe(f.teamHorizon.getTime());
        expect(resolved.groupMembership.historyAccess).toBe("from_membership");
        expect(resolved.groupMembership.effective).toBe(true);
    });

    it("keeps an archived Group's retained rows resolvable but ineffective", async () => {
        const f = await fixture();
        await db.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: new Date() } });

        const resolved = await inTx(tx => resolveTeamGroupMembershipContextInTx(tx, {
            teamId: f.team.id,
            groupId: f.group.id,
            accountId: f.member.id,
        }));

        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.groupMembership.effective).toBe(false);
        expect(resolved.groupMembership.sessionAccessStartsAt?.getTime()).toBe(f.groupHorizon.getTime());
    });

    it("lists only structurally effective Groups across retained lifecycle rows", async () => {
        const f = await fixture();
        const resolve = () => inTx(tx => resolveEffectiveTeamGroupIdsForAccountInTx(tx, {
            teamId: f.team.id,
            accountId: f.member.id,
        }));

        await expect(resolve()).resolves.toEqual([f.group.id]);
        await db.account.update({ where: { id: f.member.id }, data: { status: "suspended" } });
        await expect(resolve()).resolves.toEqual([]);
        await db.account.update({ where: { id: f.member.id }, data: { status: "active" } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        await expect(resolve()).resolves.toEqual([]);
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "active" } });
        await db.team.update({ where: { id: f.team.id }, data: { archivedAt: new Date() } });
        await expect(resolve()).resolves.toEqual([]);
        await db.team.update({ where: { id: f.team.id }, data: { archivedAt: null } });
        await db.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: new Date() } });
        await expect(resolve()).resolves.toEqual([]);
        await db.teamGroup.update({ where: { id: f.group.id }, data: { archivedAt: null } });
        await expect(resolve()).resolves.toEqual([f.group.id]);
    });

    it("resolves the new lifetime after removal and rejoin without returning the old horizon", async () => {
        const f = await fixture();
        await db.teamMembership.delete({ where: { id: f.membership.id } });
        const rejoined = await db.teamMembership.create({
            data: { teamId: f.team.id, accountId: f.member.id, role: "member", sessionAccessStartsAt: new Date("2026-08-01T00:00:00.000Z") },
        });
        const rejoinedGroupHorizon = new Date("2026-08-02T00:00:00.000Z");
        await db.teamGroupMembership.create({
            data: {
                teamId: f.team.id,
                teamGroupId: f.group.id,
                teamMembershipId: rejoined.id,
                nativeContribution: true,
                sessionAccessStartsAt: rejoinedGroupHorizon,
            },
        });

        const resolved = await inTx(tx => resolveTeamGroupMembershipContextInTx(tx, {
            teamId: f.team.id,
            groupId: f.group.id,
            accountId: f.member.id,
        }));

        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.groupMembership.teamMembershipId).toBe(rejoined.id);
        expect(resolved.groupMembership.teamMembershipId).not.toBe(f.membership.id);
        expect(resolved.groupMembership.sessionAccessStartsAt?.getTime()).toBe(rejoinedGroupHorizon.getTime());
    });

    it("does not resolve a Group through a Team that does not own it", async () => {
        const f = await fixture();
        const other = await db.team.create({ data: { name: "Other owner" } });

        const resolved = await inTx(tx => resolveTeamGroupMembershipContextInTx(tx, {
            teamId: other.id,
            groupId: f.group.id,
            accountId: f.member.id,
        }));

        expect(resolved).toEqual({ ok: false, error: "team_group_not_found" });
    });

    it("reports a missing Group membership distinctly from a missing Team membership", async () => {
        const f = await fixture();
        const stranger = await account();
        await db.teamGroupMembership.delete({
            where: { teamGroupId_teamMembershipId: { teamGroupId: f.group.id, teamMembershipId: f.membership.id } },
        });

        const withoutGroupRow = await inTx(tx => resolveTeamGroupMembershipContextInTx(tx, {
            teamId: f.team.id, groupId: f.group.id, accountId: f.member.id,
        }));
        const withoutMembership = await inTx(tx => resolveTeamGroupMembershipContextInTx(tx, {
            teamId: f.team.id, groupId: f.group.id, accountId: stranger.id,
        }));

        expect(withoutGroupRow).toEqual({ ok: false, error: "team_group_membership_not_found" });
        expect(withoutMembership).toEqual({ ok: false, error: "team_membership_not_found" });
    });
});
