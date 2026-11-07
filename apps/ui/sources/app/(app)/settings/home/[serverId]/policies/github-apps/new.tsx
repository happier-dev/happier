import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { movedSettingsRouteHref } from '@/components/settings/navigation/movedSettingsRouteHref';
import { homeAdministrationGitHubAppCreatePath } from '@/components/settings/home/governance/homeAdministrationRoutes';

/** GitHub Apps moved to Sign-in providers; a link saved before the move still opens the same page. */
export function LegacyManagedGitHubAppCreateRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] ?? '' : params.serverId ?? '';
    return <Redirect href={movedSettingsRouteHref(homeAdministrationGitHubAppCreatePath(serverId), params, ['serverId']) as never} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { LegacyManagedGitHubAppCreateRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={LegacyManagedGitHubAppCreateRoute} />; }
