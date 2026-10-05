import * as React from 'react';
import { Redirect, useLocalSearchParams, type Href } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

import { opensInArtifactView, resolveArtifactOpenRoute } from '@/components/artifacts/artifactBrowserModel';
import { ArtifactView } from '@/components/artifacts/ArtifactView';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifact } from '@/sync/domains/state/storage';

export function ArtifactDetailScreen(): React.ReactElement {
    const { id } = useLocalSearchParams<{ id: string }>();
    const artifact = useArtifact(id);
    return <ArtifactDetailContent id={id} artifact={artifact} />;
}

export { ArtifactDetailScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ArtifactDetailScreen} />; }

/** A kind with its own destination (a board, a workflow, a prompt…) opens there; a document opens here. */
export function ArtifactDetailContent(props: Readonly<{ id: string; artifact: DecryptedArtifact | null }>): React.ReactElement {
    if (props.artifact && !opensInArtifactView(props.artifact)) return <Redirect href={resolveArtifactOpenRoute(props.artifact) as Href} />;
    return <ArtifactView artifactId={props.id} artifact={props.artifact} presentation="page" />;
}
