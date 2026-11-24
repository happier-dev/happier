import * as React from 'react';

import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

import { useSessionRouteLaunchCurtainHold } from './useSessionRouteLaunchCurtainHold';

export function SessionViewRouteLoading({
    testID,
    initialLoading,
    serverId,
}: Readonly<{ testID?: string; initialLoading: boolean; serverId: string | null }>) {
    const destinationFocused = useDestinationFocus();
    const sceneFocused = useOptionalScreenIsFocused();
    useSessionRouteLaunchCurtainHold(initialLoading && destinationFocused && sceneFocused, serverId);
    return <PaneLoadingFallback testID={testID} />;
}
