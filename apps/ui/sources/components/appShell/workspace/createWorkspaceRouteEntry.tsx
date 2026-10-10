import * as React from 'react';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { useDestinationInstanceKey } from './DestinationInstanceHost';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';

/** The Expo entry is only the URL sink when the workspace hosts its body. */
export function WorkspaceRouteEntry(props: Readonly<{ Body: React.ComponentType; mirror?: React.ReactNode }>) {
    const workspace = useOptionalWorkspaceNavigation();
    const hosted = useDestinationInstanceKey() !== null;
    if (!hosted && workspace?.ownsRoute && !workspace.active) {
        // A temporary Expo body would lose edits when hydration admits the retained host.
        // Layout mirrors must stay mounted: Expo still owns their URL serialization.
        return <>{props.mirror ?? <PaneLoadingFallback testID="workspace-route-hydrating" />}</>;
    }
    return workspace?.active === true && !hosted ? <>{props.mirror}</> : <props.Body />;
}
