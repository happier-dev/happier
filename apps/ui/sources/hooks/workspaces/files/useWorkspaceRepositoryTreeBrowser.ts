import * as React from 'react';

import { useLazyDirectoryTree } from '@/hooks/ui/filesystem/useLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectory';
import {
    getCachedWorkspaceRepositoryDirectoryEntries,
    listWorkspaceRepositoryDirectoryEntries,
    warmWorkspaceRepositoryDirectoryCache,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
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

export function useWorkspaceRepositoryTreeBrowser(input: Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId?: string | null;
    enabled: boolean;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
    reloadToken?: number;
}>) {
    const directoryRevision = useWorkspaceRepositoryDirectoryRevision(input.workspaceCacheKey);
    const effectiveReloadToken = React.useMemo(() => (
        `${input.reloadToken ?? ''}:${directoryRevision}`
    ), [directoryRevision, input.reloadToken]);

    const getCachedEntries = React.useCallback((directoryPath: string) => {
        const cached = getCachedWorkspaceRepositoryDirectoryEntries({
            workspaceCacheKey: input.workspaceCacheKey,
            directoryPath,
        });
        return cached ? toLazyEntries(directoryPath, cached) : null;
    }, [input.workspaceCacheKey]);

    const loadDirectoryEntries = React.useCallback(async (directoryPath: string) => {
        const result = await listWorkspaceRepositoryDirectoryEntries({
            workspaceCacheKey: input.workspaceCacheKey,
            machineId: input.machineId,
            rootPath: input.rootPath,
            directoryPath,
            serverId: input.serverId,
        });
        return toLazyLoadResult(directoryPath, result);
    }, [input.machineId, input.rootPath, input.serverId, input.workspaceCacheKey]);

    const warmDirectoryEntries = React.useCallback(async (directoryPath: string) => {
        const result = await warmWorkspaceRepositoryDirectoryCache({
            workspaceCacheKey: input.workspaceCacheKey,
            machineId: input.machineId,
            rootPath: input.rootPath,
            directoryPath,
            serverId: input.serverId,
        });
        return toLazyLoadResult(directoryPath, result);
    }, [input.machineId, input.rootPath, input.serverId, input.workspaceCacheKey]);

    return useLazyDirectoryTree({
        scopeKey: input.workspaceCacheKey,
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
