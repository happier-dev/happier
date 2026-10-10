import type { TeamCapabilitiesV1 } from '@happier-dev/protocol/teams';

export type TeamOverviewDestinationId =
    | 'members'
    | 'groups'
    | 'invitations'
    | 'authentication'
    | 'settings';

/**
 * Pure presentation projection consumed by the Team overview.
 *
 * Members and Groups are reads, and the Home authorizes both on `viewRoster` — so
 * they are offered to every viewer the Home would actually answer, and the write
 * controls inside them stay gated on `manageMembers`/`manageGroups`. Gating the
 * destinations on the management capabilities instead would make the client
 * disagree with the server about who may read a roster, and would leave an
 * ordinary member looking at a Team with no contents at all. `viewTeam` alone is
 * not enough: a non-member Home administrator sees the Team but the roster and
 * Group reads refuse them unless they are recovering an ownerless Team (DR-20).
 *
 * Invitations, Authentication and Settings remain management destinations:
 * unlike the two rosters, their owners refuse a non-manager outright.
 */
export function resolveTeamOverviewDestinationIds(
    capabilities: TeamCapabilitiesV1,
): readonly TeamOverviewDestinationId[] {
    const rows: TeamOverviewDestinationId[] = [];
    if (capabilities.viewRoster) rows.push('members', 'groups');
    if (capabilities.manageInvitations) rows.push('invitations');
    if (capabilities.manageAuthentication) rows.push('authentication');
    if (
        capabilities.manageSettings
        || capabilities.managePolicy
        || capabilities.archiveTeam
        || capabilities.restoreTeam
    ) rows.push('settings');
    return Object.freeze(rows);
}
