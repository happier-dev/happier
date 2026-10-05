import * as React from 'react';

import { ArtifactEditor } from '@/components/artifacts/ArtifactEditor';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

/** A new document in the Account Artifact store. */
export function NewArtifactScreen(): React.ReactElement {
    return <ArtifactEditor artifact={null} mode="new" />;
}

export { NewArtifactScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewArtifactScreen} />; }
