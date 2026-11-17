import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { TeamNewMembersScreen } from '@/components/settings/teams/newMembers/TeamNewMembersScreen';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';

export function TeamNewMembersRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; teamId?: string | string[] }>();
    return (
        <TeamNewMembersScreen
            serverId={firstRouteParam(params.serverId)}
            teamId={firstRouteParam(params.teamId)}
        />
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { TeamNewMembersRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TeamNewMembersRoute} />; }
