import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { useWorkspaceRepositoryTreeWebDropState } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeWebDropState';

export function useRepositoryTreeWebDropState(params: Readonly<{
    sessionId: string;
    enabled: boolean;
    expandedPaths: readonly string[];
}>) {
    const handleExpandedPathsChange = React.useCallback((paths: string[]) => {
        storage.getState().setSessionRepositoryTreeExpandedPaths(params.sessionId, paths);
    }, [params.sessionId]);

    return useWorkspaceRepositoryTreeWebDropState({
        enabled: params.enabled,
        expandedPaths: params.expandedPaths,
        onExpandedPathsChange: handleExpandedPathsChange,
    });
}
