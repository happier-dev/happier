import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { seedAndOpenProjectDraft } from '../activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from '../activation/projectOpenPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useWorkspaceFilePaneNavigation } from '@/components/workspaces/files/useWorkspaceFilePaneNavigation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { createProjectCommitDetailsTab, createProjectFileDetailsTab } from './projectDetailsTabBuilders';

export function useProjectSurfaceActions(params: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    onRevealInFilesTreeNavigate?: () => void;
    onOpenChangesNavigate?: () => void;
}>) {
    const pane = useAppPaneScope(params.scopeId);
    const navigateToOpen = useNavigateToProjectOpen();

    const openFileInDetails = React.useCallback((fullPath: string) => {
        deferOnWeb(() => {
            pane.openDetailsTab(createProjectFileDetailsTab(fullPath));
        });
    }, [pane]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        deferOnWeb(() => {
            pane.openDetailsTab(createProjectFileDetailsTab(fullPath), { intent: 'pinned' });
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
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== params.workspaceRef.serverId) return;
        fireAndForget(seedAndOpenProjectDraft({ lifetime, selection: { serverId: params.workspaceRef.serverId,
            machineId: params.workspaceRef.machineId, source: { kind: 'folder', path: params.activeRootPath },
            materialization: { kind: 'worktree', checkout: { kind: 'git_worktree', displayName: '', baseRef: null } } },
            navigate: navigateToOpen }), { tag: 'Project.openCreateWorktree' });
    }, [navigateToOpen, params.activeRootPath, params.workspaceRef.machineId, params.workspaceRef.serverId]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const tab = createProjectCommitDetailsTab(sha);
        if (!tab) return;
        deferOnWeb(() => {
            pane.openDetailsTab(tab);
        });
    }, [pane]);

    const navigateFilesPane = React.useCallback((tabId: 'files' | 'git') => {
        if (tabId === 'files') params.onRevealInFilesTreeNavigate?.();
        else params.onOpenChangesNavigate?.();
    }, [params.onRevealInFilesTreeNavigate, params.onOpenChangesNavigate]);
    const { revealInFilesTree, openChanges } = useWorkspaceFilePaneNavigation(params.scopeId, navigateFilesPane);

    return {
        openFileInDetails,
        openFileInDetailsPinned,
        openReviewAllChanges,
        openStashDetails,
        openCreateWorktreeFlow,
        openCommitInDetails,
        revealInFilesTree,
        openChanges,
    };
}
