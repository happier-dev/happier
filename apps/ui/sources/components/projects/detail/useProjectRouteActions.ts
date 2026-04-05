import * as React from 'react';
import { useRouter } from 'expo-router';

import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { openProjectTerminalDetailsTab } from './openProjectTerminalDetailsTab';
import { buildProjectRouteHref, type ProjectRouteSegment } from './projectRouteState';

export function useProjectRouteActions(params: Readonly<{
    workspaceRef: WorkspaceRefV1 | null;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
    pane?: AppPaneScopeApi | null;
}>) {
    const router = useRouter();

    const buildHref = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        showWorktrees?: boolean;
    }>): string => {
        if (!params.workspaceRef) {
            return '/projects';
        }
        return buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id,
            segment: input?.segment,
            activeRootPath: params.activeRootPath,
            defaultRootPath: params.workspaceRef.rootPath,
            activeWorktreeId: params.activeWorktreeId,
            showWorktrees: input?.showWorktrees,
        });
    }, [
        params.activeRootPath,
        params.activeWorktreeId,
        params.workspaceRef,
    ]);

    const navigateToSegment = React.useCallback((input: Readonly<{
        segment?: ProjectRouteSegment;
        showWorktrees?: boolean;
        method?: 'push' | 'replace';
    }>) => {
        if (!params.workspaceRef) return;
        const href = buildHref({
            segment: input.segment,
            showWorktrees: input.showWorktrees,
        });
        if (input.method === 'replace') {
            router.replace(href);
            return;
        }
        router.push(href);
    }, [buildHref, params.workspaceRef, router]);

    const replaceOverviewVisibility = React.useCallback((input: Readonly<{
        segment?: ProjectRouteSegment;
        visible: boolean;
    }>) => {
        navigateToSegment({
            segment: input.segment,
            showWorktrees: input.visible,
            method: 'replace',
        });
    }, [navigateToSegment]);

    const openWorktreesInDetails = React.useCallback((method: 'push' | 'replace' = 'push') => {
        navigateToSegment({
            segment: 'details',
            showWorktrees: true,
            method,
        });
    }, [navigateToSegment]);

    const openTerminal = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        exitOverview?: boolean;
    }>) => {
        if (!params.workspaceRef || !params.pane) return;
        if (input?.exitOverview === true && params.showWorktrees === true) {
            navigateToSegment({
                segment: input.segment,
                showWorktrees: false,
                method: 'replace',
            });
        }
        openProjectTerminalDetailsTab(params.pane);
    }, [navigateToSegment, params.pane, params.showWorktrees, params.workspaceRef]);

    return {
        buildHref,
        navigateToSegment,
        openTerminal,
        openWorktreesInDetails,
        replaceOverviewVisibility,
    };
}
