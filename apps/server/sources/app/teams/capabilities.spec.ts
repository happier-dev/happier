import { describe, expect, it } from "vitest";

import { NO_TEAM_CAPABILITIES_V1, type TeamCapabilitiesV1 } from "@happier-dev/protocol";
import { AccountStatus, TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";

import { resolveHomeGovernanceAuthority } from "@/app/home/governance/homeCapabilities";
import { resolveTeamCapabilitiesV1, resolveTeamCredentialCapabilities, resolveTeamMembershipCapabilitiesV1, type TeamViewerFacts } from "./capabilities";
import { projectTeamSummaryV1, type TeamRecord } from "./projections";

const NO_HOME_AUTHORITY = resolveHomeGovernanceAuthority(null);

function viewer(
    overrides: Partial<TeamViewerFacts & { ownerRequired: boolean }> = {},
): TeamViewerFacts & { ownerRequired: boolean } {
    return {
        accountStatus: AccountStatus.active,
        homeAuthority: NO_HOME_AUTHORITY,
        membership: null,
        teamArchivedAt: null,
        ownerRequired: false,
        activeOwnerCount: 1,
        ...overrides,
    };
}

function membership(role: TeamRole, status: TeamMembershipStatus = TeamMembershipStatus.active) {
    return { role, status, managedExternally: false };
}

function granted(capabilities: TeamCapabilitiesV1): string[] {
    return Object.entries(capabilities).filter(([, value]) => value).map(([key]) => key).sort();
}

const homeAdminAuthority = resolveHomeGovernanceAuthority({
    accountId: "a_admin",
    homeRole: "admin",
    status: "active",
});
const homeOwnerAuthority = resolveHomeGovernanceAuthority({
    accountId: "a_owner",
    homeRole: "owner",
    status: "active",
});

describe("Team capability resolver", () => {
    it("admits credential offers by current non-guests and management only by Team managers", () => {
        for (const role of [TeamRole.owner, TeamRole.admin, TeamRole.member, TeamRole.guest]) {
            expect(resolveTeamCredentialCapabilities(viewer({ membership: membership(role) }))).toEqual({
                offerOwnCredential: role !== TeamRole.guest,
                manageCredentials: role === TeamRole.owner || role === TeamRole.admin,
            });
        }
    });

    it("never promotes Home authority or stale membership into credential authority", () => {
        const denied = { offerOwnCredential: false, manageCredentials: false };
        expect(resolveTeamCredentialCapabilities(viewer({ homeAuthority: homeOwnerAuthority }))).toEqual(denied);
        for (const overrides of [
            { accountStatus: AccountStatus.disabled },
            { accountStatus: AccountStatus.suspended },
            { teamArchivedAt: new Date() },
            { membership: membership(TeamRole.owner, TeamMembershipStatus.suspended) },
        ]) {
            expect(resolveTeamCredentialCapabilities(viewer({
                membership: membership(TeamRole.owner), homeAuthority: homeOwnerAuthority, ...overrides,
            }))).toEqual(denied);
        }
        expect(resolveTeamCredentialCapabilities(viewer({
            membership: membership(TeamRole.guest), homeAuthority: homeOwnerAuthority,
        }))).toEqual(denied);
    });
    it("denies everything to a viewer with neither membership nor Home authority", () => {
        expect(resolveTeamCapabilitiesV1(viewer())).toEqual(NO_TEAM_CAPABILITIES_V1);
    });

    it("gives an ordinary member visibility and no governance", () => {
        const capabilities = resolveTeamCapabilitiesV1(viewer({ membership: membership(TeamRole.member) }));
        expect(granted(capabilities)).toEqual(["leave", "viewRoster", "viewTeam"]);
    });

    it("gives a guest exactly what a member gets and never more", () => {
        // D2: a guest is rostered and visible but carries no governance capability.
        const guest = resolveTeamCapabilitiesV1(viewer({ membership: membership(TeamRole.guest) }));
        const member = resolveTeamCapabilitiesV1(viewer({ membership: membership(TeamRole.member) }));
        expect(granted(guest)).toEqual(["leave", "viewRoster", "viewTeam"]);
        expect(guest).toEqual(member);
    });

    it("gives a Team admin authentication governance but not ownership", () => {
        const capabilities = resolveTeamCapabilitiesV1(viewer({ membership: membership(TeamRole.admin) }));
        expect(capabilities.manageSettings).toBe(true);
        expect(capabilities.managePolicy).toBe(true);
        expect(capabilities.manageMembers).toBe(true);
        expect(capabilities.manageGroups).toBe(true);
        expect(capabilities.manageInvitations).toBe(true);
        expect(capabilities.archiveTeam).toBe(true);
        expect(capabilities.manageOwners).toBe(false);
        expect(capabilities.manageAuthentication).toBe(true);
    });

    it("gives a Team owner ownership and accepted-authentication authority", () => {
        const capabilities = resolveTeamCapabilitiesV1(viewer({ membership: membership(TeamRole.owner) }));
        expect(capabilities.manageOwners).toBe(true);
        expect(capabilities.manageAuthentication).toBe(true);
        expect(capabilities.archiveTeam).toBe(true);
    });

    it("withdraws Team authority from a suspended membership while permitting self-removal", () => {
        expect(resolveTeamCapabilitiesV1(viewer({
            membership: membership(TeamRole.owner, TeamMembershipStatus.suspended),
        }))).toEqual({ ...NO_TEAM_CAPABILITIES_V1, leave: true });
    });

    it("withdraws every capability from an inactive Account regardless of role", () => {
        for (const accountStatus of [AccountStatus.suspended, AccountStatus.disabled]) {
            expect(resolveTeamCapabilitiesV1(viewer({
                accountStatus,
                membership: membership(TeamRole.owner),
                homeAuthority: homeOwnerAuthority,
            }))).toEqual(NO_TEAM_CAPABILITIES_V1);
        }
    });

    it("limits Home-only administration to metadata and Team lifecycle", () => {
        const capabilities = resolveTeamCapabilitiesV1(viewer({ homeAuthority: homeAdminAuthority }));
        expect(granted(capabilities)).toEqual(["archiveTeam", "manageSettings", "viewTeam"]);
    });

    it("projects roster and Group reads exactly as the list reads admit them", () => {
        // A non-member Home administrator sees the Team (its summary) but not its roster:
        // the Members and Groups reads refuse them unless they are recovering an ownerless Team.
        expect(resolveTeamCapabilitiesV1(viewer({ homeAuthority: homeAdminAuthority })))
            .toMatchObject({ viewTeam: true, viewRoster: false });
        expect(resolveTeamCapabilitiesV1(viewer({ homeAuthority: homeOwnerAuthority, ownerRequired: true })).viewRoster)
            .toBe(true);
        // Ownerless alone confers nothing on a viewer without Home authority.
        expect(resolveTeamCapabilitiesV1(viewer({ ownerRequired: true })).viewRoster).toBe(false);
        // Any current membership reads the roster, Home authority or not.
        expect(resolveTeamCapabilitiesV1(viewer({
            membership: membership(TeamRole.guest), homeAuthority: homeAdminAuthority,
        })).viewRoster).toBe(true);
    });

    it("projects roster counts only under the composed roster capability, including ownerless recovery", () => {
        const team: TeamRecord = {
            id: "team",
            name: "Team",
            description: null,
            logo: null,
            sessionCreationPolicy: "private_default",
            externalSharingPolicy: "allowed",
            defaultSessionHistoryAccess: "from_membership",
            admissionMode: "invite_only",
            authenticationPolicy: null,
            archivedAt: null,
        };
        const counts = { members: 2, suspendedMembers: 1, groups: 3, waitingInvitations: 4 };
        for (const overrides of [
            { homeAuthority: homeAdminAuthority },
            { homeAuthority: homeAdminAuthority, ownerRequired: true },
            { accountStatus: AccountStatus.disabled, homeAuthority: homeAdminAuthority, ownerRequired: true },
        ]) {
            const facts = viewer(overrides);
            const capabilities = resolveTeamCapabilitiesV1(facts);
            const summary = projectTeamSummaryV1({
                team,
                counts,
                viewerRole: null,
                capabilities,
                ownerRequired: facts.ownerRequired,
                homeAuthority: facts.homeAuthority,
                teamCapabilities: resolveTeamMembershipCapabilitiesV1(facts),
            });
            expect(summary.counts).toEqual(capabilities.viewRoster
                ? { ...counts, waitingInvitations: null }
                : null);
        }
    });

    it("does not turn Home ownership into Team membership or authentication authority", () => {
        expect(granted(resolveTeamCapabilitiesV1(viewer({ homeAuthority: homeOwnerAuthority }))))
            .toEqual(["archiveTeam", "manageSettings", "viewTeam"]);
    });

    it("never lets Home authority imply membership or a viewer role", () => {
        // Governance only: the projection carries no Team role for an administrator.
        const capabilities = resolveTeamCapabilitiesV1(viewer({ homeAuthority: homeOwnerAuthority }));
        expect(capabilities.viewTeam).toBe(true);
        expect(granted(capabilities)).not.toContain("restoreTeam");
    });

    it("makes an archived Team read-only except restore", () => {
        const archived = { teamArchivedAt: new Date("2026-01-01T00:00:00.000Z") };
        const owner = resolveTeamCapabilitiesV1(viewer({ ...archived, membership: membership(TeamRole.owner) }));
        expect(granted(owner)).toEqual(["leave", "restoreTeam", "viewRoster", "viewTeam"]);

        const member = resolveTeamCapabilitiesV1(viewer({ ...archived, membership: membership(TeamRole.member) }));
        expect(granted(member)).toEqual(["leave", "viewRoster", "viewTeam"]);
    });

    it("never offers restore on an active Team or archive on an archived one", () => {
        const active = resolveTeamCapabilitiesV1(viewer({ membership: membership(TeamRole.owner) }));
        expect(active.restoreTeam).toBe(false);
        expect(active.archiveTeam).toBe(true);

        const archived = resolveTeamCapabilitiesV1(viewer({
            teamArchivedAt: new Date(),
            membership: membership(TeamRole.owner),
        }));
        expect(archived.archiveTeam).toBe(false);
        expect(archived.restoreTeam).toBe(true);
    });

    it("unions Team role and Home authority rather than letting one mask the other", () => {
        const capabilities = resolveTeamCapabilitiesV1(viewer({
            membership: membership(TeamRole.member),
            homeAuthority: homeAdminAuthority,
        }));
        expect(capabilities.manageSettings).toBe(true);
        expect(capabilities.manageMembers).toBe(false);
        expect(capabilities.viewTeam).toBe(true);

        const teamAdmin = resolveTeamCapabilitiesV1(viewer({
            membership: membership(TeamRole.admin),
            homeAuthority: homeAdminAuthority,
        }));
        expect(teamAdmin.manageAuthentication).toBe(true);
        expect(teamAdmin.manageMembers).toBe(true);
    });
});
