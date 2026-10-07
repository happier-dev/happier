import * as React from 'react';
import { Platform } from 'react-native';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { ArtifactViewRead } from '@/sync/engine/artifacts/syncArtifacts';

export type ArtifactBodyState = 'ready' | 'loading' | 'failed';

/** A preview's opened row and content come from one finite authenticated operation, not the global store. */
export function useArtifactBody(artifactId: string, artifact: DecryptedArtifact | null): Readonly<{
    state: ArtifactBodyState; result: ArtifactViewRead | null; retry: () => void;
}> {
    const needsBody = artifact !== null && artifact.isDecrypted !== false && artifact.body === undefined;
    const requiresPreview = artifact !== null && artifact.isDecrypted !== false
        && (isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)
            || (artifact.body !== null && typeof artifact.body === 'object'
                && (artifact.body.mime.startsWith('image/') || (Platform.OS === 'web' && artifact.body.mime === 'application/pdf'))));
    const requiresRead = needsBody || requiresPreview;
    const [read, setRead] = React.useState<Readonly<{ state: ArtifactBodyState; result: ArtifactViewRead | null }>>({
        state: requiresRead ? 'loading' : 'ready', result: null,
    });
    const [attempt, setAttempt] = React.useState(0);
    const completed = React.useRef<Readonly<{ publishedArtifact: DecryptedArtifact; attempt: number }> | null>(null);
    React.useEffect(() => {
        if (completed.current?.publishedArtifact === artifact && completed.current.attempt === attempt) return;
        completed.current = null;
        if (!requiresRead) { setRead({ state: 'ready', result: null }); return; }
        const controller = new AbortController();
        setRead({ state: 'loading', result: null });
        void sync.fetchArtifactForView(artifactId, { includePdfPreview: Platform.OS === 'web', signal: controller.signal }).then((full) => {
            if (controller.signal.aborted) return;
            if (full) {
                storage.getState().updateArtifact(full.artifact);
                // Store reconciliation may retain an equal incumbent row. This acknowledges only
                // our just-completed publication; it never supplies a row to a new read authority.
                completed.current = { publishedArtifact: storage.getState().artifacts[artifactId] ?? full.artifact, attempt };
            }
            setRead({ state: full ? 'ready' : 'failed', result: full });
        }, () => { if (!controller.signal.aborted) setRead({ state: 'failed', result: null }); });
        return () => controller.abort();
    }, [artifactId, artifact, requiresRead, attempt]);
    const current = completed.current?.publishedArtifact === artifact && completed.current.attempt === attempt;
    return { state: requiresRead && !current && read.state === 'ready' ? 'loading' : read.state,
        result: current ? read.result : null, retry: React.useCallback(() => setAttempt((value) => value + 1), []) };
}
