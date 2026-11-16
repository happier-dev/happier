import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { HomeAdministrationMemberDefaultsScreen } from '@/components/settings/home/governance/HomeAdministrationMemberDefaultsScreen';

export function HomeAdministrationMemberDefaultsRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] ?? '' : params.serverId ?? '';
    return <HomeAdministrationMemberDefaultsScreen serverId={serverId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { HomeAdministrationMemberDefaultsRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={HomeAdministrationMemberDefaultsRoute} />; }
