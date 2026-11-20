import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { TeamSetupScreen } from '@/components/teams/setup/TeamSetupScreen';

/** Set up for a Team (plan D, L2). The Home travels in the query, as on the Team's Sessions route. */
export function TeamSetupRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; teamId?: string | string[]; preview?: string | string[] }>();
    return <TeamSetupScreen serverId={firstRouteParam(params.serverId)} teamId={firstRouteParam(params.teamId)}
        preview={firstRouteParam(params.preview) === '1'} />;
}

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { TeamSetupRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TeamSetupRoute} />; }
