import * as React from 'react';
import { Redirect, useLocalSearchParams, type Href } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

import { opensInArtifactView, resolveArtifactOpenRoute } from '@/components/artifacts/artifactBrowserModel';
import { ArtifactEditor } from '@/components/artifacts/ArtifactEditor';
import { useArtifactBody } from '@/components/artifacts/useArtifactBody';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifact } from '@/sync/domains/state/storage';
import { t } from '@/text';

export function EditArtifactScreen(): React.ReactElement {
    const { id } = useLocalSearchParams<{ id: string }>();
    const artifact = useArtifact(id);
    return <EditArtifactContent id={id} artifact={artifact} />;
}

export { EditArtifactScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={EditArtifactScreen} />; }

/** A kind with its own editor (a board, a workflow, a prompt…) edits there; a document edits here. */
export function EditArtifactContent(props: Readonly<{ id: string; artifact: DecryptedArtifact | null }>): React.ReactElement {
    if (props.artifact && !opensInArtifactView(props.artifact)) return <Redirect href={resolveArtifactOpenRoute(props.artifact) as Href} />;
    return <EditDocument id={props.id} artifact={props.artifact} />;
}

function EditDocument(props: Readonly<{ id: string; artifact: DecryptedArtifact | null }>): React.ReactElement {
    const body = useArtifactBody(props.id, props.artifact);
    if (props.artifact === null || props.artifact.isDecrypted === false) {
        return <SurfaceStateCard testID="artifact-editor:unavailable" kind="empty" title={t('artifacts.notFound')} />;
    }
    if (body.state === 'failed') {
        return (
            <SurfaceStateCard
                testID="artifact-editor:failed"
                kind="error"
                title={t('artifacts.error')}
                action={{ label: t('common.retry'), onPress: body.retry }}
                accessibilitySemantics="alert"
            />
        );
    }
    // The editor keeps its fields from the first body it sees, so it waits for the body rather than flashing empty.
    if (body.state === 'loading') return <SurfaceStateCard testID="artifact-editor:loading" kind="loading" title={t('common.loading')} />;
    return <ArtifactEditor key={props.id} artifact={props.artifact} mode="edit" />;
}
