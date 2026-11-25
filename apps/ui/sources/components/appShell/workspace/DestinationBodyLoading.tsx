import * as React from 'react';

import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';

import { useDestinationInstance, type DestinationInstanceContextValue } from './destinationInstanceContext';
import { useRouteLaunchCurtainHold } from './useRouteLaunchCurtainHold';
import { matchWorkspaceDestinationRoute } from './workspaceRoutes';

function selectDestinationHome(instance: DestinationInstanceContextValue | null): string | null {
    const serverId = instance?.ref.params.serverId;
    // A path parameter can name a Settings entity instead of qualifying the route's Home.
    return instance && serverId && !matchWorkspaceDestinationRoute(instance.pathname)?.params.serverId ? serverId : null;
}

/** A destination's page-shaped fallback while its route chunk or data is loading. */
export function DestinationBodyLoading({
    routeServerId,
    holdLaunchCurtain = true,
    testID = 'workspace-destination-body-loading',
}: Readonly<{ routeServerId?: string | null; holdLaunchCurtain?: boolean; testID?: string }>) {
    const destinationHome = useDestinationInstance(selectDestinationHome);
    useRouteLaunchCurtainHold(holdLaunchCurtain, routeServerId === undefined ? destinationHome : routeServerId);
    return <PageLoadingRows testID={testID} header />;
}
