import * as React from 'react';

import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { resolveRepoWorktreeSelection, type RepoWorktreeSelectionResolution } from './resolveRepoWorktreeSelection';

export function useResolvedRepoWorktreeSelection(params: Readonly<{
    scope: WorkspaceScopeBase | null;
    defaultRootPath: string;
    requestedRootPath: string | null | undefined;
    requestedWorktreeId?: string | null | undefined;
    refreshOnMount?: boolean;
}>): RepoWorktreeSelectionResolution & Readonly<{
    availableWorktrees: ReadonlyArray<Readonly<{ id?: string; path: string; isPrunable?: boolean }>> | null;
}> {
    const requested = resolveRepoWorktreeSelection(params);
    // The default checkout is already resolved. Its presented surface supplies repository facts;
    // only a requested worktree needs discovery before that surface can settle its selection.
    const needsDiscovery = requested.requestedWorktreeId !== null || requested.requestedRootPath !== params.defaultRootPath;
    const { snapshot } = useWorkspaceScmSnapshotController(params.scope, {
        refreshOnMount: params.refreshOnMount !== false && needsDiscovery,
        detail: 'summary',
    });
    const availableWorktrees = snapshot?.repo?.isRepo === true
        ? (snapshot.repo.worktrees ?? [])
        : null;

    return React.useMemo(() => ({
        ...resolveRepoWorktreeSelection({
            requestedRootPath: params.requestedRootPath,
            requestedWorktreeId: params.requestedWorktreeId,
            defaultRootPath: params.defaultRootPath,
            availableWorktrees,
        }),
        availableWorktrees,
    }), [availableWorktrees, params.defaultRootPath, params.requestedRootPath, params.requestedWorktreeId]);
}
