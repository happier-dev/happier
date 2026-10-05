import * as React from 'react';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { useDestinationInstanceKey } from './DestinationInstanceHost';

/** The Expo entry is only the URL sink when the workspace hosts its body. */
export function WorkspaceRouteEntry(props: Readonly<{ Body: React.ComponentType; mirror?: React.ReactNode }>) {
    const workspace = useOptionalWorkspaceNavigation();
    const hosted = useDestinationInstanceKey() !== null;
    return workspace?.active === true && !hosted ? <>{props.mirror}</> : <props.Body />;
}
