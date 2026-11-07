import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { movedSettingsRouteHref } from '@/components/settings/navigation/movedSettingsRouteHref';
import { homeAdministrationGitHubAppPath } from '@/components/settings/home/governance/homeAdministrationRoutes';

/** GitHub Apps moved to Sign-in providers; a link saved before the move still opens the same page. */
export function LegacyManagedGitHubAppDetailRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; registrationId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] ?? '' : params.serverId ?? '';
    const registrationId = Array.isArray(params.registrationId) ? params.registrationId[0] ?? '' : params.registrationId ?? '';
    return <Redirect href={movedSettingsRouteHref(homeAdministrationGitHubAppPath(serverId, registrationId), params, ['serverId', 'registrationId']) as never} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { LegacyManagedGitHubAppDetailRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={LegacyManagedGitHubAppDetailRoute} />; }
