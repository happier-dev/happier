import type { TeamGroupV1, TeamMembershipV1, TeamRoleV1, TeamSummaryV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

/**
 * The one place a Team role becomes user-visible text.
 *
 * Role copy is a projection of the fixed enum, never a capability statement: a
 * row labelled Owner may still have every management control withdrawn by an
 * archived Team, a suspended membership or an inactive Account, and only the
 * server-projected capabilities decide that.
 */
export function teamRoleLabel(role: TeamRoleV1): string {
    switch (role) {
        case 'owner':
            return t('teams.role.owner');
        case 'admin':
            return t('teams.role.admin');
        case 'member':
            return t('teams.role.member');
        case 'guest':
            return t('teams.role.guest');
    }
}

/**
 * Whether the viewer's own membership is suspended, as the Team projection makes it knowable.
 *
 * The summary carries no membership status, but the Home withdraws `viewTeam` from exactly one kind
 * of current member: one whose membership is suspended (an inactive Account projects no capabilities
 * at all, and a Home administrator who is not a member has no role). Such a viewer keeps only Leave.
 * This is presentation of that state, never an authority: every control still follows `capabilities`.
 */
export function isTeamViewerSuspended(team: Pick<TeamSummaryV1, 'viewerRole' | 'capabilities'>): boolean {
    return team.viewerRole !== null && !team.capabilities.viewTeam && team.capabilities.leave;
}

/** The viewer's standing in the Team for a row or header: Suspended, else their role, else nothing. */
export function teamViewerStandingLabel(team: Pick<TeamSummaryV1, 'viewerRole' | 'capabilities'>): string | null {
    if (isTeamViewerSuspended(team)) return t('teams.status.suspended');
    return team.viewerRole ? teamRoleLabel(team.viewerRole) : null;
}

/**
 * A Team row's line 2 wherever Teams are listed (the Teams directory, a share sheet's Teams): the
 * viewer's standing, then its active members when the Home shares the count.
 */
export function teamStandingSummary(team: Pick<TeamSummaryV1, 'viewerRole' | 'capabilities' | 'counts'>,
    options?: Readonly<{ count?: boolean }>): string {
    const counts = team.counts;
    return [
        teamViewerStandingLabel(team) ?? '',
        options?.count !== false && counts ? t('teams.groups.memberCount', { count: counts.members - counts.suspendedMembers }) : '',
    ].filter((part) => part.length > 0).join(' · ');
}

/**
 * The one sentence of consequence that accompanies a role wherever it can be
 * chosen or read.
 *
 * The plan requires the role picker to always state what the role actually
 * means, and add, invitation and member detail each ask the same question — so
 * the answer lives here once. Like the label it is a projection of the enum and
 * never a capability statement: what this viewer may do to a member stays with
 * the server-projected per-membership capabilities.
 */
export function teamRoleDescription(role: TeamRoleV1): string {
    switch (role) {
        case 'owner':
            return t('teams.roleHelp.owner');
        case 'admin':
            return t('teams.roleHelp.admin');
        case 'member':
            return t('teams.roleHelp.member');
        case 'guest':
            return t('teams.roleHelp.guest');
    }
}

/** The externally owned lifetime of one membership, when applicable. */
export function membershipManagementLabel(membership: TeamMembershipV1): string | null {
    return membership.management.kind === 'native'
        ? null
        : t('teams.members.managedBy', { source: membership.management.label });
}

/** The externally owned metadata lifecycle of one Group, when applicable. */
export function groupManagementLabel(group: TeamGroupV1): string | null {
    return group.management.kind === 'native'
        ? null
        : t('teams.groups.managedBy', { source: group.management.label });
}
