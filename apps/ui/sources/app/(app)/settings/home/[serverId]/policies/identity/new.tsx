import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { movedSettingsRouteHref } from '@/components/settings/navigation/movedSettingsRouteHref';
import { homeAdministrationIdentityProviderCreatePath } from '@/components/settings/home/governance/homeAdministrationRoutes';

/** Identity providers moved to Sign-in providers; a link saved before the move still opens the same page. */
export function LegacyManagedIdentityProviderCreateRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] ?? '' : params.serverId ?? '';
    return <Redirect href={movedSettingsRouteHref(homeAdministrationIdentityProviderCreatePath(serverId), params, ['serverId']) as never} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { LegacyManagedIdentityProviderCreateRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={LegacyManagedIdentityProviderCreateRoute} />; }
