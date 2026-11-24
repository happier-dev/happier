import * as React from 'react';

import { useRouteLaunchCurtainHold } from '@/components/appShell/workspace/useRouteLaunchCurtainHold';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';

export function SessionViewRouteLoading({
    testID,
    initialLoading,
    serverId,
}: Readonly<{ testID?: string; initialLoading: boolean; serverId: string | null }>) {
    useRouteLaunchCurtainHold(initialLoading, serverId);
    return <PaneLoadingFallback testID={testID} />;
}
