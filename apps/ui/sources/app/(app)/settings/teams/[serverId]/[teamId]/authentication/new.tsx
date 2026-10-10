import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { TeamIdentityProviderSetupScreen } from '@/components/settings/teams/identity/TeamIdentityProviderSetupScreen';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';

export function TeamIdentityProviderSetupRoute() {
    const params = useLocalSearchParams<{
        serverId?: string | string[];
        teamId?: string | string[];
        kind?: string | string[];
    }>();
    const kind = firstRouteParam(params.kind);
    return <TeamIdentityProviderSetupScreen
        serverId={firstRouteParam(params.serverId)}
        teamId={firstRouteParam(params.teamId)}
        providerKind={kind === 'github_app_identity' ? 'github_app_identity' : kind === 'workos_sso' ? 'workos_sso' : 'oidc'}
    />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { TeamIdentityProviderSetupRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={TeamIdentityProviderSetupRoute} />; }
