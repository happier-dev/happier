import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { movedSettingsRouteHref } from '@/components/settings/navigation/movedSettingsRouteHref';

/**
 * `/settings/delegation`: Work depth and Approval reviewer now live on Subagents (owner 11-06), so
 * older links and search results land there, keeping the setting they asked for.
 */
export const WorkspaceRouteBody = React.memo(function DelegationSettingsRoute() {
    const params = useLocalSearchParams();
    return <Redirect href={movedSettingsRouteHref(SETTINGS_ROUTES.subAgent, params, []) as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
