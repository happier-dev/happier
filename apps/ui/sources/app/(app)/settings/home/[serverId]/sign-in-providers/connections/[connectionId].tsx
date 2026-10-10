import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';
import { HomeIdentityConnectionDetailScreen } from '@/components/settings/home/identity/HomeIdentityConnectionScreens';

export function HomeIdentityConnectionDetailRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; connectionId?: string | string[]; purpose?: string | string[]; resultHandle?: string | string[]; error?: string | string[] }>();
    return <HomeIdentityConnectionDetailScreen
        serverId={firstRouteParam(params.serverId)} connectionId={firstRouteParam(params.connectionId)}
        workosPortalReturn={firstRouteParam(params.purpose) === 'workos_admin_portal'}
        testReturn={{ purpose: firstRouteParam(params.purpose) || null, resultHandle: firstRouteParam(params.resultHandle) || null, error: firstRouteParam(params.error) || null }}
    />;
}
export { HomeIdentityConnectionDetailRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={HomeIdentityConnectionDetailRoute} />; }
