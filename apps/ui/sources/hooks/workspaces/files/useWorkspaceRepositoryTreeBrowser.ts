import * as React from 'react';

import { useLazyDirectoryTree } from '@/hooks/ui/filesystem/useLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectory';
import {
    getCachedWorkspaceRepositoryDirectoryEntries,
    getCachedWorkspaceRepositoryGitIgnoreAvailable,
    listWorkspaceRepositoryDirectoryEntries,
    warmWorkspaceRepositoryDirectoryCache,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceRepositoryDirectoryRevision } from './useWorkspaceRepositoryDirectoryRevision';

import { readRepositoryTreeClassification } from '@/hooks/workspaces/files/repositoryTreeClassification';
import { projectRepositoryTreeNodes } from '@/hooks/workspaces/files/repositoryTreeVisibility';
import { useWorkspaceEntryHistory } from './useWorkspaceEntryHistory';

const NO_PRESERVED_PATHS: readonly string[] = [];

function joinPath(parent: string, name: string): string {
    const trimmedParent = parent.replace(/\/+$/g, '');
    const trimmedName = name.replace(/^\/+/g, '');
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
    visibilityMode?: 'project' | 'all';
    preservedPaths?: readonly string[];
    /** The folder the tree starts at (a Code folder page); the repository root by default. */
    rootDirectoryPath?: string;
    historyEnabled?: boolean;
    headOid?: string | null;
    repoRootPath?: string | null;
}>) {
    const scope = React.useMemo(() => input.scope, [input.scope.serverId, input.scope.machineId, input.scope.rootPath]);
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

    const tree = useLazyDirectoryTree({
        scopeKey: JSON.stringify([workspaceCacheKey, input.rootDirectoryPath ?? '']),
        enabled: input.enabled,
        retainNodesWhenDisabled: true,
        rootDirectoryPath: input.rootDirectoryPath ?? '',
        expandedPaths: input.expandedPaths,
        onExpandedPathsChange: input.onExpandedPathsChange,
        reloadToken: effectiveReloadToken,
        getCachedEntries,
        loadDirectoryEntries,
        warmDirectoryEntries,
        warmChildDirectoriesLimit: 2,
    });
    const classification = React.useMemo(() => readRepositoryTreeClassification(tree.nodes, (directoryPath) => ({
        available: getCachedWorkspaceRepositoryGitIgnoreAvailable({ workspaceCacheKey, directoryPath }),
        entries: getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath }),
    }), input.rootDirectoryPath ?? ''), [tree.nodes, workspaceCacheKey, input.rootDirectoryPath]);
    const gitIgnoreAvailable = classification.available;
    const preservedPaths = input.preservedPaths ?? NO_PRESERVED_PATHS;
    const nodes = React.useMemo(() => input.visibilityMode === 'project' && gitIgnoreAvailable === true
        ? projectRepositoryTreeNodes(tree.nodes, classification.ignoredPaths, preservedPaths)
        : tree.nodes, [tree.nodes, input.visibilityMode, gitIgnoreAvailable, classification.ignoredPaths, preservedPaths]);
    const demandedPaths = React.useMemo(() => nodes.filter(node => node.type === 'file' || node.type === 'directory').map(node => node.path), [nodes]);
    const history = useWorkspaceEntryHistory({ scope, folder: input.rootDirectoryPath ?? '', paths: demandedPaths,
        headOid: input.headOid, repoRootPath: input.repoRootPath, enabled: input.enabled && input.historyEnabled === true, reloadToken: input.reloadToken });
    return { ...tree, nodes, gitIgnoreAvailable, history };
}
