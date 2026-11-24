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

/**
 * Every lazy destination's Suspense fallback, beside a column too (a blank main area for the seconds a chunk
 * takes reads as broken). It draws the page's header room and rows in its column.
 */
export function DestinationBodyLoading({ routeServerId }: Readonly<{ routeServerId?: string | null }>) {
    const destinationHome = useDestinationInstance(selectDestinationHome);
    useRouteLaunchCurtainHold(true, routeServerId === undefined ? destinationHome : routeServerId);
    return <PageLoadingRows testID="workspace-destination-body-loading" header />;
}
