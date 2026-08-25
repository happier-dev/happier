import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

export function useProjectSurfaceActions(params: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    onRevealInFilesTreeNavigate?: () => void;
}>) {
    const pane = useAppPaneScope(params.scopeId);
    const routerRef = useProjectRouteRouterRef();

    const openFileInDetails = React.useCallback((fullPath: string) => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        deferOnWeb(() => {
            pane.openDetailsTab({
                key: `file:${fullPath}`,
                kind: 'file',
                title: fileName,
                resource: { kind: 'file', path: fullPath },
            });
        });
    }, [pane]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: `file:${fullPath}`,
                    kind: 'file',
                    title: fileName,
                    resource: { kind: 'file', path: fullPath },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const openReviewAllChanges = React.useCallback(() => {
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: 'scmReview:working',
                    kind: 'scmReview',
                    title: t('files.toolbar.review'),
                    resource: { kind: 'scmReview', scope: 'working' },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const openStashDetails = React.useCallback(() => {
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: 'scmStash',
                    kind: 'scmStash',
                    title: t('files.stash.detailsTitle'),
                    resource: { kind: 'scmStash' },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const openCreateWorktreeFlow = React.useCallback(() => {
        const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
        routerRef.current.push({
            pathname: '/new',
            params: buildNewSessionLaunchRouteParams({
                draftId,
                machineId: params.workspaceRef.machineId,
                directory: params.activeRootPath,
                worktree: 'new',
                targetServerId: params.workspaceRef.serverId,
            }),
        });
    }, [params.activeRootPath, params.workspaceRef.machineId, params.workspaceRef.serverId, routerRef]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const safeSha = sha.trim().split(/\s+/)[0] ?? '';
        if (!safeSha) return;
        deferOnWeb(() => {
            pane.openDetailsTab({
                key: `commit:${safeSha}`,
                kind: 'commit',
                title: safeSha.slice(0, 7),
                resource: { kind: 'commit', sha: safeSha },
            });
        });
    }, [pane]);

    const revealInFilesTree = React.useCallback((fullPath: string) => {
        params.onRevealInFilesTreeNavigate?.();
        const scope = {
            serverId: params.workspaceRef.serverId,
            machineId: params.workspaceRef.machineId,
            rootPath: params.activeRootPath,
        };
        const currentExpandedPaths = storage.getState().getWorkspaceRepositoryTreeExpandedPaths(scope);
        const nextExpandedPaths = computeExpandedPathsForReveal({
            expandedPaths: currentExpandedPaths,
            fullPath,
        });
        storage.getState().setWorkspaceRepositoryTreeExpandedPaths(scope, nextExpandedPaths);
    }, [
        params.activeRootPath,
        params.onRevealInFilesTreeNavigate,
        params.workspaceRef.machineId,
        params.workspaceRef.serverId,
    ]);

    return {
        openFileInDetails,
        openFileInDetailsPinned,
        openReviewAllChanges,
        openStashDetails,
        openCreateWorktreeFlow,
        openCommitInDetails,
        revealInFilesTree,
    };
}
