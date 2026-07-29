import * as React from 'react';

import {
    getWorkspaceRepositoryDirectoryRevision,
    subscribeWorkspaceRepositoryDirectoryRevision,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectoryRevision';

export function useWorkspaceRepositoryDirectoryRevision(workspaceCacheKey: string | null | undefined): number {
    const normalizedKey = typeof workspaceCacheKey === 'string' ? workspaceCacheKey.trim() : '';

    const subscribe = React.useCallback((listener: () => void) => (
        subscribeWorkspaceRepositoryDirectoryRevision(normalizedKey, listener)
    ), [normalizedKey]);
    const getSnapshot = React.useCallback(() => (
        getWorkspaceRepositoryDirectoryRevision(normalizedKey)
    ), [normalizedKey]);

    return React.useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
