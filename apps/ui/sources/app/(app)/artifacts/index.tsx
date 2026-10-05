import * as React from 'react';

import { ArtifactsBrowserScreen } from '@/components/artifacts/ArtifactsBrowserScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

/** The Artifacts destination: the browser over every ordinary Account Artifact. */
export function ArtifactsScreen(): React.ReactElement {
    return <ArtifactsBrowserScreen />;
}

export { ArtifactsScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ArtifactsScreen} />; }
