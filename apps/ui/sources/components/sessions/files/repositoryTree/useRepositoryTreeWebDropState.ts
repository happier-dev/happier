import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { useWorkspaceRepositoryTreeWebDropState } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeWebDropState';

export function useRepositoryTreeWebDropState(params: Readonly<{
    sessionId: string;
    enabled: boolean;
    expandedPaths: readonly string[];
}>) {
    return useWorkspaceRepositoryTreeWebDropState({
        enabled: params.enabled,
        expandedPaths: params.expandedPaths,
        onExpandedPathsChange: (paths) => storage.getState().setSessionRepositoryTreeExpandedPaths(params.sessionId, paths),
    });
}
