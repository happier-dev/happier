import * as React from 'react';

import { useLazyDirectoryTree } from '@/hooks/ui/filesystem/useLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectory';
import {
    getCachedWorkspaceRepositoryDirectoryEntries,
    listWorkspaceRepositoryDirectoryEntries,
    warmWorkspaceRepositoryDirectoryCache,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceRepositoryDirectoryRevision } from './useWorkspaceRepositoryDirectoryRevision';

function joinPath(parent: string, name: string): string {
    const trimmedParent = parent.trim().replace(/\/+$/g, '');
    const trimmedName = name.trim().replace(/^\/+/g, '');
    if (!trimmedParent) return trimmedName;
    if (!trimmedName) return trimmedParent;
    return `${trimmedParent}/${trimmedName}`;
}

function toLazyEntries(directoryPath: string, entries: readonly RepositoryDirectoryEntry[]): LazyDirectoryTreeEntry[] {
    return entries.map((entry) => ({
        name: entry.name,
        path: joinPath(directoryPath, entry.name),
        type: entry.type,
        sizeBytes: entry.sizeBytes,
        modifiedMs: entry.modifiedMs,
    }));
}

function toLazyLoadResult(directoryPath: string, result: ListRepositoryDirectoryEntriesResult): LazyDirectoryTreeLoadResult {
    if (!result.ok) {
        return result;
    }
    return {
        ok: true,
        entries: toLazyEntries(directoryPath, result.entries),
    };
}

/**
 * Takes the workspace as ONE `scope`. The tree reads cached entries under a key and loads
 * missing ones over RPC, so a `workspaceCacheKey` prop next to a separate machine/root/server
 * address would let the cache it reads and the server it reads from name different
 * workspaces — silently, since the rows look identical either way.
 */
export function useWorkspaceRepositoryTreeBrowser(input: Readonly<{
    scope: WorkspaceScopeBase;
    enabled: boolean;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
    reloadToken?: number;
}>) {
    const scope = input.scope;
    const workspaceCacheKey = React.useMemo(() => tryBuildWorkspaceCacheKey(scope) ?? '', [scope]);
    const directoryRevision = useWorkspaceRepositoryDirectoryRevision(workspaceCacheKey);
    const effectiveReloadToken = React.useMemo(() => (
        `${input.reloadToken ?? ''}:${directoryRevision}`
    ), [directoryRevision, input.reloadToken]);

    const getCachedEntries = React.useCallback((directoryPath: string) => {
        const cached = getCachedWorkspaceRepositoryDirectoryEntries({
            workspaceCacheKey,
            directoryPath,
        });
        return cached ? toLazyEntries(directoryPath, cached) : null;
    }, [workspaceCacheKey]);

    const loadDirectoryEntries = React.useCallback(async (directoryPath: string) => {
        const result = await listWorkspaceRepositoryDirectoryEntries({ scope, directoryPath });
        return toLazyLoadResult(directoryPath, result);
    }, [scope]);

    const warmDirectoryEntries = React.useCallback(async (directoryPath: string) => {
        const result = await warmWorkspaceRepositoryDirectoryCache({ scope, directoryPath });
        return toLazyLoadResult(directoryPath, result);
    }, [scope]);

    return useLazyDirectoryTree({
        scopeKey: workspaceCacheKey,
        enabled: input.enabled,
        rootDirectoryPath: '',
        expandedPaths: input.expandedPaths,
        onExpandedPathsChange: input.onExpandedPathsChange,
        reloadToken: effectiveReloadToken,
        getCachedEntries,
        loadDirectoryEntries,
        warmDirectoryEntries,
        warmChildDirectoriesLimit: 2,
    });
}
