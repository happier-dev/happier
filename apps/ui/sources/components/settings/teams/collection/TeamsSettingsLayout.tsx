import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useHappierCollectionVisit } from '@happier-dev/plugin-ui/presentation';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { teamAddressKey } from '@/sync/domains/teams/teamAddress';

import { TeamMembersCollectionRail } from '../members/TeamMembersCollectionRail';
import { TeamsCollectionRail } from './TeamsCollectionRail';
import { recordTeamsCollectionVisit, resolveSelectedTeamAddress, resolveSelectedTeamMember } from './teamsCollection';

/** Rail width at normal text scale: a Team mark, a name and one role · Home line. */
const TEAMS_RAIL_WIDTH_PX = 264;
/** The narrowest Team page that still fits a field or segmented row beside its label. */
const TEAMS_DETAIL_MIN_WIDTH_PX = 480;

function resolveTeamsChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('teams', pathname) ?? 'index';
}

/**
 * Teams as a collection beside the open Team. Wide: the Teams rail beside the Team's pages. Narrow:
 * the Team pages alone, whose index lists the Teams and pushes each one. While a member is open, the
 * Team's Members rail stands beside them instead (lab `tsMembers-A`, the Home People pattern): the
 * person is one of a collection of people, and the back control leads to the Team again.
 */
export const TeamsSettingsLayout = React.memo(function TeamsSettingsLayout() {
    const pathname = usePathname().replace(/\/+$/, '');
    // Beside the rail and in the pushed list alike, the opened Team is what a wide collection lands on.
    useHappierCollectionVisit(recordTeamsCollectionVisit, resolveSelectedTeamAddress(pathname), teamAddressKey);
    const member = React.useMemo(() => resolveSelectedTeamMember(pathname), [pathname]);
    return (
        <SettingsCollectionLayout
            navigator="teams"
            rootPathname="/settings/teams"
            resolveChildRoute={resolveTeamsChildRoute}
            rail={member
                ? <TeamMembersCollectionRail address={member.address} selectedMembershipId={member.membershipId} />
                : <TeamsCollectionRail />}
            railWidthPx={TEAMS_RAIL_WIDTH_PX}
            detailMinWidthPx={TEAMS_DETAIL_MIN_WIDTH_PX}
            testID="settings-teams"
        />
    );
});
