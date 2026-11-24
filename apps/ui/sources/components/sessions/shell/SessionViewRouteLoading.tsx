import * as React from 'react';

import { useLaunchCurtainHold } from '@/boot/launchCurtain';
import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

export function SessionViewRouteLoading({
    testID,
    initialLoading = true,
}: Readonly<{ testID?: string; initialLoading?: boolean }>) {
    const destinationFocused = useDestinationFocus();
    const sceneFocused = useOptionalScreenIsFocused();
    useLaunchCurtainHold(initialLoading && destinationFocused && sceneFocused);
    return <PaneLoadingFallback testID={testID} />;
}
