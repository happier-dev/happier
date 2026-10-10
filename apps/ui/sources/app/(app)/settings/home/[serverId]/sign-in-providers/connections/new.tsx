import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { HomeWorkosSetupScreen } from '@/components/settings/home/identity/HomeIdentityConnectionScreens';

export function HomeWorkosSetupRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    return <HomeWorkosSetupScreen serverId={firstRouteParam(params.serverId)} />;
}
export { HomeWorkosSetupRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={HomeWorkosSetupRoute} />; }
