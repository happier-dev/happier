import {
    NO_TEAM_CAPABILITIES_V1,
    NO_TEAM_MEMBERSHIP_CAPABILITIES_V1,
    resolveTeamAdmissionProjectionV1,
    TeamMembershipV1Schema,
    TeamSummaryV1Schema,
    type TeamMembershipV1,
} from '@happier-dev/protocol/teams';

import type { TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
import type { TeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';

import { DEMO_NOW_MS } from './constants';

const TEAM_ID = 'demo-team-northstar';
const VIEWER_ACCOUNT_ID = 'demo-account-maya';

function noop(): void {}
async function settledRead(): Promise<void> {}

/** Fictional display projections only; these identities never bind credentials or create Accounts. */
export function buildDemoTeam(serverId: string): Readonly<{ context: TeamSectionContext; roster: TeamMembersRoster }> {
    const team = TeamSummaryV1Schema.parse({
        id: TEAM_ID,
        name: 'Northstar Studio',
        description: 'Building thoughtful tools together.',
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'owner',
        capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true, viewRoster: true,
            manageMembers: true, manageInvitations: true },
        admission: resolveTeamAdmissionProjectionV1(),
        counts: { members: 4, suspendedMembers: 0, groups: 1, waitingInvitations: 0 },
    });
    const people: readonly Readonly<{ accountId: string; name: string; role: TeamMembershipV1['role'] }>[] = [
        { accountId: VIEWER_ACCOUNT_ID, name: 'Maya Park', role: 'owner' },
        { accountId: 'demo-account-alex', name: 'Alex Rivera', role: 'admin' },
        { accountId: 'demo-account-jules', name: 'Jules Chen', role: 'member' },
        { accountId: 'demo-account-sam', name: 'Sam Taylor', role: 'guest' },
    ];
    const members = people.map(person => TeamMembershipV1Schema.parse({
        v: 1,
        id: `demo-membership-${person.accountId}`,
        teamId: TEAM_ID,
        accountId: person.accountId,
        account: { name: person.name, firstName: person.name, lastName: null, username: null, avatarUrl: null },
        role: person.role,
        status: 'active',
        historyAccess: 'from_membership',
        management: { kind: 'native' },
        capabilities: NO_TEAM_MEMBERSHIP_CAPABILITIES_V1,
        joinedAt: DEMO_NOW_MS - 30 * 24 * 60 * 60 * 1000,
    }));
    return {
        context: {
            scope: { serverId, accountId: VIEWER_ACCOUNT_ID },
            address: { serverId, teamId: TEAM_ID },
            homeName: 'Personal Home',
            team,
            mutationsAvailable: true,
            archived: false,
            canMutate: true,
            approvalPending: false,
            refresh: noop,
            requestApproval: noop,
            settleLeave: noop,
        },
        roster: { rows: members, status: 'ready', error: null, hasMore: false, loadMore: settledRead, reload: settledRead },
    };
}
