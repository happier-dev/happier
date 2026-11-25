import * as React from 'react';

import { DestinationBodyLoading } from '@/components/appShell/workspace/DestinationBodyLoading';

export function SessionViewRouteLoading({
    testID,
    initialLoading,
    serverId,
}: Readonly<{ testID?: string; initialLoading: boolean; serverId: string | null }>) {
    return <DestinationBodyLoading testID={testID} holdLaunchCurtain={initialLoading} routeServerId={serverId} />;
}
