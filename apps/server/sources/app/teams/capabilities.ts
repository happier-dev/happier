import { NO_TEAM_CAPABILITIES_V1, type TeamCapabilitiesV1 } from "@happier-dev/protocol";

import { AccountStatus, type TeamMembershipStatus, type TeamRole } from "@/storage/enums.generated";
import type { HomeGovernanceAuthority } from "@/app/home/governance/homeCapabilities";
import { resolveTeamLeaveDecision, resolveTeamMembershipCapabilities, resolveTeamMembershipCredentialCapabilities, type TeamCredentialCapabilities } from "./memberships/capabilities";

/**
 * The Team-membership half of the capability decision, as read inside the
 * deciding transaction. Only facts that change the answer are carried:
 * a capability resolver that also received names or timestamps would invite
 * callers to make policy out of presentation.
 */
export type TeamMembershipCapabilityFacts = Readonly<{
    role: TeamRole;
    status: TeamMembershipStatus;
    managedExternally?: boolean;
}>;

/**
 * Everything the Team capability decision depends on, always re-read inside the
 * transaction that decides. No token claim, cached projection, or client
 * assertion may stand in for any of it.
 */
export type TeamViewerFacts = Readonly<{
    accountStatus: AccountStatus;
    homeAuthority: HomeGovernanceAuthority;
    membership: TeamMembershipCapabilityFacts | null;
    teamArchivedAt: Date | null;
    activeOwnerCount?: number;
}>;

/** Team-role authority before the independent Home metadata/lifecycle arm is composed. */
export function resolveTeamMembershipCapabilitiesV1(
    facts: Omit<TeamViewerFacts, "homeAuthority">,
): TeamCapabilitiesV1 {
    if (!facts.membership) return NO_TEAM_CAPABILITIES_V1;
    return {
        ...resolveTeamMembershipCapabilities({
            role: facts.membership.role,
            membershipStatus: facts.membership.status,
            accountStatus: facts.accountStatus,
            teamArchivedAt: facts.teamArchivedAt,
        }),
        leave: resolveTeamLeaveDecision(facts).permitted,
    };
}

/** Home governance cannot confer source-offer or resource-management authority. */
export function resolveTeamCredentialCapabilities(facts: TeamViewerFacts): TeamCredentialCapabilities {
    if (!facts.membership) return { offerOwnCredential: false, manageCredentials: false };
    return resolveTeamMembershipCredentialCapabilities({
        role: facts.membership.role,
        membershipStatus: facts.membership.status,
        accountStatus: facts.accountStatus,
        teamArchivedAt: facts.teamArchivedAt,
    });
}

/**
 * Compose the canonical membership capabilities with Home metadata/lifecycle
 * administration. The membership owner alone maps Team roles to capabilities.
 *
 * Home authority does not grant Team membership, authentication policy, Group
 * mutation, invitation, or ordinary owner management. Safe Group/roster recovery
 * reads have their own ownerless-Team read branch; the membership mutation owner must check
 * its separate, bounded owner-required recovery operation; a broad projected
 * manageOwners capability cannot stand in for that target-specific decision.
 */
export function resolveTeamCapabilitiesV1(
    facts: TeamViewerFacts & Readonly<{
        /** The Team has no structurally active owner (the owner-required recovery condition). */
        ownerRequired: boolean;
    }>,
): TeamCapabilitiesV1 {
    if (facts.accountStatus !== AccountStatus.active) return NO_TEAM_CAPABILITIES_V1;

    const membership = resolveTeamMembershipCapabilitiesV1(facts);
    if (!facts.homeAuthority.manageAllTeams) return membership;

    const archived = facts.teamArchivedAt !== null;
    return Object.freeze({
        ...membership,
        viewTeam: true,
        // The one Home arm of the roster/Group read admission: recovering an ownerless Team.
        viewRoster: membership.viewRoster || facts.ownerRequired,
        manageSettings: !archived,
        archiveTeam: !archived,
        restoreTeam: archived,
    });
}
