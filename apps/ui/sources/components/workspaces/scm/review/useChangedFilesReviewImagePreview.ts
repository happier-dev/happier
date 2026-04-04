import * as React from 'react';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { useScmReviewImagePreview } from '@/components/workspaces/scm/review/useScmReviewImagePreview';

export function useChangedFilesReviewImagePreview(input: Readonly<{
    sessionId: string;
    snapshotSignature?: string | null;
    filePath: string;
    enabled: boolean;
    workspaceScope?: WorkspaceScopeBase | null;
}>) {
    const snapshotSignature =
        typeof input.snapshotSignature === 'string' && input.snapshotSignature.trim().length > 0
            ? input.snapshotSignature.trim()
            : null;
    const filePath = input.filePath;
    const enabled = input.enabled === true;
    const workspaceScope = input.workspaceScope ?? null;
    const source = React.useMemo(() => {
        return workspaceScope
            ? {
                kind: 'workspace' as const,
                scopeId: input.sessionId,
                scope: workspaceScope,
            }
            : {
                kind: 'session' as const,
                sessionId: input.sessionId,
            };
    }, [input.sessionId, workspaceScope]);

    return useScmReviewImagePreview({
        source,
        filePath,
        enabled,
        cacheKey: snapshotSignature,
        mimeType: getImageMimeTypeFromPath(filePath),
        sizeBytes: null,
    });
}
