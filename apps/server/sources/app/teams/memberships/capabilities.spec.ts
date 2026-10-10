import { describe, expect, it } from "vitest";
import { AccountStatus, TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
import { resolveTeamMemberTargetCapabilities, resolveTeamMembershipCapabilities, type TeamMemberActorFacts, type TeamMemberTargetFacts } from "./capabilities";

const current = {
    accountStatus: AccountStatus.active,
    membershipStatus: TeamMembershipStatus.active,
    teamArchivedAt: null,
} as const;

const manager = {
    accountId: "account-manager",
    manageMembers: true,
    manageOwners: true,
    homeManagesAllTeams: false,
} as const;

const nativeMember = {
    accountId: "account-target",
    role: TeamRole.member,
    status: TeamMembershipStatus.active,
    accountStatus: AccountStatus.active,
    managedExternally: false,
    managementTransferTargetAvailable: false,
} as const;

describe("Team membership capability mapping", () => {
    it("gives an owner every management capability including owner administration", () => {
        const capabilities = resolveTeamMembershipCapabilities({ ...current, role: TeamRole.owner });

        expect(capabilities).toEqual({
            viewTeam: true,
            viewRoster: true,
            manageSettings: true,
            managePolicy: true,
            manageMembers: true,
            manageGroups: true,
            manageInvitations: true,
            manageAuthentication: true,
            manageOwners: true,
            archiveTeam: true,
            restoreTeam: false,
            leave: false,
        });
    });

    it("withholds owner administration from an admin who otherwise manages the Team", () => {
        const capabilities = resolveTeamMembershipCapabilities({ ...current, role: TeamRole.admin });

        expect(capabilities.manageMembers).toBe(true);
        expect(capabilities.manageGroups).toBe(true);
        expect(capabilities.archiveTeam).toBe(true);
        // An admin must not be able to promote, demote, or remove an owner even while
        // another active owner remains.
        expect(capabilities.manageOwners).toBe(false);
    });

    it("gives members and guests visibility without any management capability", () => {
        for (const role of [TeamRole.member, TeamRole.guest]) {
            const capabilities = resolveTeamMembershipCapabilities({ ...current, role });
            expect(capabilities.viewTeam).toBe(true);
            expect(capabilities.manageSettings).toBe(false);
            expect(capabilities.manageMembers).toBe(false);
            expect(capabilities.manageGroups).toBe(false);
            expect(capabilities.manageInvitations).toBe(false);
            expect(capabilities.manageAuthentication).toBe(false);
            expect(capabilities.managePolicy).toBe(false);
            expect(capabilities.manageOwners).toBe(false);
            expect(capabilities.archiveTeam).toBe(false);
            expect(capabilities.restoreTeam).toBe(false);
        }
    });

    it("keeps an archived Team viewable and restorable by its retained owner/admin while other mutations stop", () => {
        const archivedAt = new Date("2026-04-01T00:00:00.000Z");

        for (const role of [TeamRole.owner, TeamRole.admin]) {
            const capabilities = resolveTeamMembershipCapabilities({ ...current, role, teamArchivedAt: archivedAt });
            expect(capabilities.viewTeam).toBe(true);
            expect(capabilities.restoreTeam).toBe(true);
            expect(capabilities.archiveTeam).toBe(false);
            expect(capabilities.manageMembers).toBe(false);
            expect(capabilities.manageGroups).toBe(false);
            expect(capabilities.manageOwners).toBe(false);
        }

        const member = resolveTeamMembershipCapabilities({ ...current, role: TeamRole.member, teamArchivedAt: archivedAt });
        expect(member.viewTeam).toBe(true);
        expect(member.restoreTeam).toBe(false);
    });

    it("grants no membership-derived capability to an inactive Account or a suspended membership", () => {
        const suspendedMembership = resolveTeamMembershipCapabilities({
            ...current, role: TeamRole.owner, membershipStatus: TeamMembershipStatus.suspended,
        });
        const suspendedAccount = resolveTeamMembershipCapabilities({
            ...current, role: TeamRole.owner, accountStatus: AccountStatus.suspended,
        });
        const disabledAccount = resolveTeamMembershipCapabilities({
            ...current, role: TeamRole.owner, accountStatus: AccountStatus.disabled,
        });

        for (const capabilities of [suspendedMembership, suspendedAccount, disabledAccount]) {
            expect(Object.values(capabilities).every(value => value === false)).toBe(true);
        }
    });
});

describe("Team management-transfer capability", () => {
    it("projects exact role choices without removing inactive-member cleanup or narrow Home recovery", () => {
        const project = (actor: TeamMemberActorFacts, target: TeamMemberTargetFacts = nativeMember, activeOwnerCount = 1) =>
            resolveTeamMemberTargetCapabilities({ actor, target, teamArchivedAt: null, activeOwnerCount });
        expect(project(manager)).toMatchObject({ setRole: true, assignableRoles: ["owner", "admin", "member", "guest"] });
        expect(project({ ...manager, manageOwners: false })).toMatchObject({ assignableRoles: ["admin", "member", "guest"] });
        expect(project(manager, { ...nativeMember, accountStatus: AccountStatus.suspended }))
            .toMatchObject({ setRole: true, assignableRoles: ["admin", "member", "guest"], remove: true });
        expect(project(manager, { ...nativeMember, role: TeamRole.owner }))
            .toMatchObject({ setRole: false, assignableRoles: [] });
        const recovering = { ...manager, manageMembers: false, manageOwners: false, homeManagesAllTeams: true };
        expect(project(recovering, nativeMember, 0)).toMatchObject({ setRole: true, assignableRoles: ["owner"] });
        expect(project(recovering, nativeMember, 1)).toMatchObject({ setRole: false, assignableRoles: [] });
        expect(project({ ...recovering, manageMembers: true }, nativeMember, 0))
            .toMatchObject({ setRole: true, assignableRoles: ["owner", "admin", "member", "guest"] });
        expect(project(recovering, { ...nativeMember, accountStatus: AccountStatus.suspended }, 0))
            .toMatchObject({ setRole: false, assignableRoles: [] });
    });

    it("withholds the transfer from a native membership no source could take over", () => {
        // The conversion binds to an unbound provisioned identity. Without one
        // the mutation refuses by construction, so advertising it would be a
        // control that exists only to fail.
        const capabilities = resolveTeamMemberTargetCapabilities({
            actor: manager,
            target: nativeMember,
            teamArchivedAt: null,
            activeOwnerCount: 2,
        });

        expect(capabilities.setManagement).toBe(false);
        // The rest of the per-member decision is unaffected.
        expect(capabilities.setRole).toBe(true);
        expect(capabilities.remove).toBe(true);
    });

    it("offers the transfer once a source of this Team holds an identity for the Account", () => {
        const capabilities = resolveTeamMemberTargetCapabilities({
            actor: manager,
            target: { ...nativeMember, managementTransferTargetAvailable: true },
            teamArchivedAt: null,
            activeOwnerCount: 2,
        });

        expect(capabilities.setManagement).toBe(true);
    });

    it("always offers the return to native management for an externally owned lifetime", () => {
        const capabilities = resolveTeamMemberTargetCapabilities({
            actor: manager,
            target: {
                ...nativeMember,
                managedExternally: true,
                managementTransferTargetAvailable: false,
            },
            teamArchivedAt: null,
            activeOwnerCount: 2,
        });

        expect(capabilities.setManagement).toBe(true);
        // The lifecycle half stays at its source.
        expect(capabilities.suspend).toBe(false);
        expect(capabilities.remove).toBe(false);
    });

    it("withholds every membership control, transfer included, from an archived Team", () => {
        const capabilities = resolveTeamMemberTargetCapabilities({
            actor: manager,
            target: { ...nativeMember, managementTransferTargetAvailable: true },
            teamArchivedAt: new Date("2026-04-01T00:00:00.000Z"),
            activeOwnerCount: 2,
        });

        expect(capabilities.setManagement).toBe(false);
    });

    it("gives the Home owner-required recovery only the promotion, never a transfer", () => {
        const capabilities = resolveTeamMemberTargetCapabilities({
            actor: {
                accountId: "account-home-admin",
                manageMembers: false,
                manageOwners: false,
                homeManagesAllTeams: true,
            },
            target: { ...nativeMember, managementTransferTargetAvailable: true },
            teamArchivedAt: null,
            activeOwnerCount: 0,
        });

        expect(capabilities.setRole).toBe(true);
        expect(capabilities.setManagement).toBe(false);
        expect(capabilities.suspend).toBe(false);
        expect(capabilities.remove).toBe(false);
    });
});
