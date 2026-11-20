import * as React from 'react';

import { useLazyDirectoryTree } from '@/hooks/ui/filesystem/useLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectory';
import {
    getCachedWorkspaceRepositoryDirectoryEntries,
    getCachedWorkspaceRepositoryDirectoryMetadata,
    getCachedWorkspaceRepositoryGitIgnoreAvailable,
    listWorkspaceRepositoryDirectoryEntries,
    warmWorkspaceRepositoryDirectoryCache,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceRepositoryDirectoryRevision } from './useWorkspaceRepositoryDirectoryRevision';

import { readRepositoryTreeClassification } from '@/hooks/workspaces/files/repositoryTreeClassification';
import { projectRepositoryTreeNodes } from '@/hooks/workspaces/files/repositoryTreeVisibility';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
import { useWorkspaceEntryHistory } from './useWorkspaceEntryHistory';
import { useWorkspaceFileWriteSettlements } from '@/sync/domains/session/changes/hooks/useWorkspaceFileWriteSettlements';
import { useWorkspaceLiveFileWrites } from '@/sync/domains/session/changes/hooks/useWorkspaceLiveFileWrites';

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
        // A stopped attached workspace keeps its typed refusal so the root state can name it and offer Start (remote workspaces F7).
        return result.errorCode === 'managed_power_required' ? { ok: false, error: result.errorCode } : result;
    }
    return {
        ok: true,
        entries: toLazyEntries(directoryPath, result.entries),
        truncated: result.truncated,
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
    reconciliationPaused?: boolean;
}>) {
    const scope = React.useMemo(() => input.scope, [input.scope.serverId, input.scope.machineId, input.scope.rootPath, input.scope.workspace]);
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

    const loadDirectoryEntries = React.useCallback(async (directoryPath: string, signal: AbortSignal) => {
        const result = await listWorkspaceRepositoryDirectoryEntries({ scope, directoryPath, signal });
        return toLazyLoadResult(directoryPath, result);
    }, [scope]);

    const getCachedDirectoryMetadata = React.useCallback((directoryPath: string) => (
        getCachedWorkspaceRepositoryDirectoryMetadata({ workspaceCacheKey, directoryPath })
    ), [workspaceCacheKey]);

    const warmDirectoryEntries = React.useCallback(async (directoryPath: string, signal: AbortSignal) => {
        const result = await warmWorkspaceRepositoryDirectoryCache({ scope, directoryPath, signal });
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
        getCachedDirectoryMetadata,
        loadDirectoryEntries,
        warmDirectoryEntries,
        warmChildDirectoriesLimit: 2,
        reconciliationPaused: input.reconciliationPaused,
    });
    const fileWriteScope = input.enabled ? scope : null;
    const liveFileWrites = useWorkspaceLiveFileWrites(fileWriteScope);
    useWorkspaceFileWriteSettlements(fileWriteScope, tree.reconcilePaths);
    const classification = React.useMemo(() => readRepositoryTreeClassification(tree.nodes, (directoryPath) => ({
        available: getCachedWorkspaceRepositoryGitIgnoreAvailable({ workspaceCacheKey, directoryPath }),
        entries: getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath }),
    }), input.rootDirectoryPath ?? ''), [tree.nodes, workspaceCacheKey, input.rootDirectoryPath]);
    const gitIgnoreAvailable = classification.available;
    const preservedPaths = input.preservedPaths ?? NO_PRESERVED_PATHS;
    // Revealing an opened file extends `preservedPaths` on every open; the rows it yields are usually the
    // same rows, and the virtualized list redraws every mounted row when this array changes.
    const projectedNodesRef = React.useRef<typeof tree.nodes | undefined>(undefined);
    const nodes = React.useMemo(() => {
        const next = input.visibilityMode === 'project' && gitIgnoreAvailable === true
            ? projectRepositoryTreeNodes(tree.nodes, classification.ignoredPaths, preservedPaths)
            : tree.nodes;
        return projectedNodesRef.current = retainShallow(projectedNodesRef.current, next);
    }, [tree.nodes, input.visibilityMode, gitIgnoreAvailable, classification.ignoredPaths, preservedPaths]);
    const demandedPaths = React.useMemo(() => nodes.filter(node => node.type === 'file' || node.type === 'directory').map(node => node.path), [nodes]);
    const history = useWorkspaceEntryHistory({ scope, folder: input.rootDirectoryPath ?? '', paths: demandedPaths,
        headOid: input.headOid, repoRootPath: input.repoRootPath, enabled: input.enabled && input.historyEnabled === true, reloadToken: input.reloadToken });
    return { ...tree, nodes, gitIgnoreAvailable, history, liveFileWrites };
}
