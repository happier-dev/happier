import * as React from 'react';
import { Redirect, useLocalSearchParams, type Href } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';

import { resolveArtifactEditRedirect } from '@/components/artifacts/artifactBrowserModel';
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
    // A held row is delegated before any reader mounts; an unopened one once its header arrives.
    const redirect = props.artifact ? resolveArtifactEditRedirect(props.artifact) : null;
    if (redirect) return <Redirect href={redirect as Href} />;
    return <EditDocument id={props.id} artifact={props.artifact} />;
}

function EditDocument(props: Readonly<{ id: string; artifact: DecryptedArtifact | null }>): React.ReactElement {
    const body = useArtifactBody(props.id, props.artifact);
    const artifact = body.result?.artifact ?? props.artifact;
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
    if (artifact === null && body.state === 'loading') return <SurfaceStateCard testID="artifact-editor:loading" kind="loading" title={t('common.loading')} />;
    if (artifact === null || artifact.isDecrypted === false || body.state === 'missing') {
        return <SurfaceStateCard testID="artifact-editor:unavailable" kind="empty" title={t('artifacts.notFound')} />;
    }
    const redirect = resolveArtifactEditRedirect(artifact);
    if (redirect) return <Redirect href={redirect as Href} />;
    // The editor keeps its fields from the first body it sees, so it waits for the body rather than flashing empty.
    if (body.state === 'loading') return <SurfaceStateCard testID="artifact-editor:loading" kind="loading" title={t('common.loading')} />;
    return <ArtifactEditor key={props.id} artifact={artifact} mode="edit" />;
}
