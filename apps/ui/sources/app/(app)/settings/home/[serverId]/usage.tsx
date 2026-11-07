import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { TeamCredentialUsageScreen } from '@/components/settings/teams/credentials/TeamCredentialUsageScreen';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';

export function WorkspaceRouteBody() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    return <TeamCredentialUsageScreen serverId={firstRouteParam(params.serverId)} subject={{ kind: 'home' }} />;
}

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
