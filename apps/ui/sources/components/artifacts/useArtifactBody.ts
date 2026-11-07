import * as React from 'react';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { ArtifactViewRead } from '@/sync/engine/artifacts/syncArtifacts';

export type ArtifactBodyState = 'ready' | 'loading' | 'missing' | 'failed';

/** A preview's opened row and content come from one finite authenticated operation, not the global store. */
export function useArtifactBody(artifactId: string, artifact: DecryptedArtifact | null, options?: Readonly<{ readMissing?: boolean }>): Readonly<{
    state: ArtifactBodyState; result: ArtifactViewRead | null; retry: () => void;
}> {
    const lifetime = useActiveServerAccountScopeLifetime();
    // Opening an exact reference must not depend on Account inventory hydration.
    // Inactive consumers (for example an unmounted widget scope) explicitly opt out.
    const needsBody = artifact === null ? options?.readMissing !== false : artifact.isDecrypted !== false && artifact.body === undefined;
    // A content-only socket row has no HTTP owner/grant authority. Complete bytes
    // still need that exact authenticated projection before a consumer admits them.
    const needsAuthority = artifact !== null && artifact.isDecrypted !== false
        && (!artifact.ownerAccountId || artifact.access === undefined);
    const requiresPreview = artifact !== null && artifact.isDecrypted !== false
        && (isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)
            || (artifact.body !== null && typeof artifact.body === 'object'
                && resolveFileViewerKind({ path: artifact.title ?? '', mimeType: artifact.body.mime }).previewable));
    const requiresRead = needsBody || needsAuthority || requiresPreview;
    const [read, setRead] = React.useState<Readonly<{ state: ArtifactBodyState; result: ArtifactViewRead | null }>>({
        state: requiresRead ? 'loading' : 'ready', result: null,
    });
    const [attempt, setAttempt] = React.useState(0);
    // The first inventory head fills in an unknown opening revision; it is not
    // a second open. A deletion or a genuinely superseding revision is.
    const sourceRef = React.useRef({ artifactId, artifact });
    const previous = sourceRef.current;
    if (previous.artifactId !== artifactId || (previous.artifact !== null && (artifact === null
        || previous.artifact.headerVersion !== artifact.headerVersion
        || previous.artifact.bodyVersion !== artifact.bodyVersion
        || previous.artifact.isDecrypted !== artifact.isDecrypted))) {
        sourceRef.current = { artifactId, artifact };
    } else {
        previous.artifact = artifact;
    }
    const source = sourceRef.current;
    const completed = React.useRef<Readonly<{ source: typeof source; attempt: number; lifetime: typeof lifetime }> | null>(null);
    React.useEffect(() => {
        if (completed.current?.source === source && completed.current.attempt === attempt && completed.current.lifetime === lifetime) return;
        completed.current = null;
        if (!requiresRead) { setRead({ state: 'ready', result: null }); return; }
        const controller = new AbortController();
        setRead({ state: 'loading', result: null });
        void sync.fetchArtifactForView(artifactId, { signal: controller.signal }).then((full) => {
            if (controller.signal.aborted) return;
            if (full) {
                // Acknowledge this operation before publishing its own row, so
                // synchronous store consumers cannot turn that result into a read.
                source.artifact = full.artifact;
                completed.current = { source, attempt, lifetime };
                storage.getState().updateArtifact(full.artifact);
            }
            setRead({ state: full ? 'ready' : 'missing', result: full });
        }, () => { if (!controller.signal.aborted) setRead({ state: 'failed', result: null }); });
        return () => controller.abort();
    }, [artifactId, source, requiresRead, attempt, lifetime]);
    const current = completed.current?.source === source && completed.current.attempt === attempt && completed.current.lifetime === lifetime;
    return { state: requiresRead && !current && read.state === 'ready' ? 'loading' : read.state,
        result: current ? read.result : null, retry: React.useCallback(() => setAttempt((value) => value + 1), []) };
}
