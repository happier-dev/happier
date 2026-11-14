import * as React from 'react';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { projectPageSelectionId, resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import type { ProjectPageSelection } from '@/components/workspaceCockpit/project/projectCockpitState';
import { buildProjectRouteHref, readProjectSelectedRouteResource, type ProjectRouteSegment, type ProjectDetailsSourceSurface } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { usePersistProjectLastMobileSurface } from '@/sync/domains/state/storage';
import { openEmbeddedToolInDockLocation } from '@/components/sessions/terminal/embeddedTerminalDocking';

export function useProjectRouteActions(params: Readonly<{
    workspaceRef: WorkspaceRefV1 | null;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
    sourceSurface?: ProjectDetailsSourceSurface | null;
    pane?: Pick<AppPaneScopeApi, 'scopeId'> & Parameters<typeof openEmbeddedToolInDockLocation>[0]['pane'] | null;
}>) {
    const paneContext = React.useContext(AppPaneContext);
    const routerRef = useProjectRouteRouterRef();
    const persistPage = usePersistProjectLastMobileSurface();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const currentRoute = React.useMemo(() => resolveProjectCockpitRouteFromPathname(pathname), [pathname]);
    const page = currentRoute?.page ?? 'overview';
    const selection = currentRoute?.selection;
    const buildHref = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        selection?: ProjectPageSelection;
        showWorktrees?: boolean;
        sourceSurface?: ProjectDetailsSourceSurface | null;
        workspaceRef?: WorkspaceRefV1;
        activeRootPath?: string;
        activeWorktreeId?: string | null;
    }>) => {
        const workspaceRef = input?.workspaceRef ?? params.workspaceRef;
        const details = params.pane ? paneContext?.getSnapshot().state.scopes[params.pane.scopeId]?.details : null;
        return workspaceRef ? buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            serverId: workspaceRef.serverId,
            segment: input?.segment ?? page,
            selection: input?.selection ?? (input?.segment ? undefined : selection),
            routeParams,
            activeRootPath: input?.activeRootPath ?? (input?.workspaceRef ? workspaceRef.rootPath : params.activeRootPath),
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: input?.activeWorktreeId !== undefined ? input.activeWorktreeId : input?.workspaceRef ? null : params.activeWorktreeId,
            showWorktrees: input?.showWorktrees ?? params.showWorktrees,
            sourceSurface: input?.sourceSurface ?? params.sourceSurface,
            initialResource: params.pane ? readProjectSelectedRouteResource(details ? buildDetailsWorkspaceStateView(details) : null) ?? null : undefined,
        }) : '/projects';
    }, [page, selection, paneContext, params.activeRootPath, params.activeWorktreeId, params.pane?.scopeId, params.showWorktrees, params.sourceSurface, params.workspaceRef, routeParams]);
    const navigateToSegment = React.useCallback(async (input: Readonly<{
        segment?: ProjectRouteSegment;
        selection?: ProjectPageSelection;
        showWorktrees?: boolean;
        method?: 'push' | 'replace';
        sourceSurface?: ProjectDetailsSourceSurface | null;
        workspaceRef?: WorkspaceRefV1;
        activeRootPath?: string;
        activeWorktreeId?: string | null;
    }>) => {
        const workspaceRef = params.workspaceRef;
        if (!workspaceRef) return false;
        const accepted = await routerRef.current[input.method ?? 'push'](buildHref(input));
        const selected = input.selection ?? (input.segment ? { kind: 'builtin' as const, page: input.segment } : null);
        if (accepted && selected) persistPage(input.workspaceRef?.id ?? workspaceRef.id, projectPageSelectionId(selected),
            input.workspaceRef?.serverId ?? workspaceRef.serverId);
        return accepted;
    }, [buildHref, params.workspaceRef, persistPage, routerRef]);
    const replaceOverviewVisibility = React.useCallback((input: Readonly<{ segment?: ProjectRouteSegment; visible: boolean }>) => {
        navigateToSegment({ segment: input.visible ? 'overview' : input.segment ?? page, showWorktrees: input.visible, method: 'replace' });
    }, [navigateToSegment, page]);
    const openWorktreesInDetails = React.useCallback((method: 'push' | 'replace' = 'push') => {
        navigateToSegment({ segment: 'overview', showWorktrees: true, method });
    }, [navigateToSegment]);
    const openTerminal = React.useCallback((input?: Readonly<{ exitOverview?: boolean }>) =>
        navigateToSegment({ segment: 'terminal', ...(input?.exitOverview ? { showWorktrees: false } : {}) }),
    [navigateToSegment]);
    const openBrowser = React.useCallback(() => {
        if (params.pane) openEmbeddedToolInDockLocation({ pane: params.pane, tool: 'browser' });
    }, [params.pane]);
    return { buildHref, navigateToSegment, openBrowser, openTerminal, openWorktreesInDetails, replaceOverviewVisibility };
}
