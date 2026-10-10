import * as React from 'react';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    resolveRightSidebarMobileSurface,
    resolveProjectRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { buildProjectRouteHref, readProjectCodeRouteLocation, readProjectSelectedRouteResource, readProjectRouteStringParam } from './projectRouteState';
import type { WorkspaceCodeLocation } from '@/components/projects/files/code/WorkspaceCodeBrowserView';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceScmTabState } from '@/components/workspaces/scm/useWorkspaceScmTabState';
import { useScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import { resolveProjectRightTabId } from './resolveProjectRightTabId';
import {
    normalizeProjectMobileSurface,
    resolveProjectCockpitRouteFromPathname,
    resolveProjectRightTabIdForSurface,
    type ProjectMobileSurface,
    type ProjectPageV1,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export function useProjectSurfaceController(params: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
}>) {
    const routerRef = useProjectRouteRouterRef();
    const deviceType = useDeviceType();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const page = resolveProjectCockpitRouteFromPathname(pathname)?.page ?? 'overview';
    const workspaceRefs = useWorkspaceRefs();
    const checkoutWorkspace = React.useMemo(() => {
        const checkout = resolveProjectCheckoutWorkspaceRef(workspaceRefs, params.workspaceRef, params.activeRootPath);
        return checkout ? workspaceAddressFromRefV1(checkout) : null;
    }, [params.activeRootPath, params.workspaceRef, workspaceRefs]);
    const pane = useAppPaneScope(params.scopeId);
    const { setActiveGitSubTab } = useWorkspaceScmTabState(pane);
    const { setPersistedReviewTabState } = useScmReviewTabState(JSON.stringify([
        params.workspaceRef.serverId, params.workspaceRef.machineId, params.activeRootPath,
    ]), pane);
    const workspaceKey = tryBuildWorkspaceCacheKey({ serverId: params.workspaceRef.serverId,
        machineId: params.workspaceRef.machineId, rootPath: params.activeRootPath }) ?? '';
    const { setLocation } = useRepositoryTreeBrowserState(workspaceKey);
    const codeLocation = React.useMemo<WorkspaceCodeLocation>(() => readProjectCodeRouteLocation(routeParams)
        ?? { kind: 'folder', path: '' }, [routeParams.codeKind, routeParams.codePath]);
    React.useEffect(() => {
        if (page === 'code') setLocation(codeLocation);
    }, [codeLocation, page, setLocation]);
    const activeTab = pane.scopeState?.right.activeTabId ?? resolveProjectRightTabId(null);

    const navigate = React.useCallback((surface: ProjectMobileSurface, nextPage: ProjectPageV1, layoutId?: string | null) => {
        routerRef.current.replace(buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id,
            surface,
            segment: nextPage,
            serverId: params.workspaceRef.serverId,
            routeParams,
            layoutId,
            ...(layoutId !== undefined ? { attachedDashboard: null } : {}),
            activeRootPath: params.activeRootPath,
            activeWorktreeId: params.activeWorktreeId,
            defaultRootPath: params.workspaceRef.rootPath,
            initialResource: readProjectSelectedRouteResource(pane.scopeState?.details) ?? null,
        }));
    }, [pane.scopeState?.details, params.activeRootPath, params.activeWorktreeId, params.workspaceRef.id, params.workspaceRef.rootPath, params.workspaceRef.serverId, routeParams, routerRef]);
    const navigateToPage = React.useCallback((nextPage: ProjectPageV1) => navigate(nextPage, nextPage), [navigate]);
    const navigateCodeLocation = React.useCallback((location: WorkspaceCodeLocation) => {
        routerRef.current.push(buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id, serverId: params.workspaceRef.serverId,
            segment: 'code', activeRootPath: params.activeRootPath, defaultRootPath: params.workspaceRef.rootPath,
            activeWorktreeId: params.activeWorktreeId, routeParams, initialResource: null, codeLocation: location,
        }));
    }, [params.activeRootPath, params.activeWorktreeId, params.workspaceRef.id, params.workspaceRef.rootPath,
        params.workspaceRef.serverId, routeParams, routerRef]);
    const openCodeHistory = React.useCallback((location: WorkspaceCodeLocation) => {
        setPersistedReviewTabState({ projectChangesMode: 'git' });
        setActiveGitSubTab('history');
        routerRef.current.push(buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id, serverId: params.workspaceRef.serverId,
            segment: 'changes', activeRootPath: params.activeRootPath, defaultRootPath: params.workspaceRef.rootPath,
            activeWorktreeId: params.activeWorktreeId, routeParams, initialResource: null, codeLocation: location,
        }));
    }, [params.activeRootPath, params.activeWorktreeId, params.workspaceRef.id, params.workspaceRef.rootPath,
        params.workspaceRef.serverId, routeParams, routerRef, setActiveGitSubTab, setPersistedReviewTabState]);
    const navigateToSurface = React.useCallback((surface: ProjectMobileSurface) => navigate(surface, page), [navigate, page]);
    const selectDashboard = React.useCallback((layoutId: string | null) => {
        navigate(normalizeProjectMobileSurface(readProjectRouteStringParam(routeParams.mobileSurface)) ?? page, page, layoutId);
    }, [navigate, page, routeParams.mobileSurface]);

    const setActiveTab = React.useCallback((tabId: string) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
        if (deviceType !== 'phone') {
            return;
        }
        if (activeTab === tabId) {
            return;
        }
        const tab = resolveProjectRightSidebarTabs({ presentation: 'mobile', activePage: page }).find((entry) => entry.id === tabId);
        // The registry surface vocabulary is shared across scopes (it also carries plugin and
        // session-only surfaces), so narrow through the project's own owner rather than
        // re-listing the project surfaces here.
        const mobileSurface = normalizeProjectMobileSurface(
            tab ? resolveRightSidebarMobileSurface(tab, 'project') : null,
        );
        if (mobileSurface) {
            navigateToSurface(mobileSurface);
        }
    }, [activeTab, deviceType, navigateToSurface, page, pane]);

    const syncSurface = React.useCallback((surface: ProjectMobileSurface) => {
        // Page selection never replaces the retained companion selection.
        if (surface === page) return;
        const targetRightTabId = resolveProjectRightTabIdForSurface(surface);
        if (!targetRightTabId) {
            return;
        }

        pane.openRight({ tabId: targetRightTabId });
        if (pane.scopeState?.right?.activeTabId !== targetRightTabId) {
            pane.setRightTab(targetRightTabId);
        }
    }, [page, pane, pane.scopeState?.right?.activeTabId]);

    return React.useMemo(() => ({
        activeTab,
        page,
        navigateToPage,
        navigateToSurface,
        selectDashboard,
        setActiveTab,
        syncSurface,
        checkoutWorkspace,
        codeLocation,
        navigateCodeLocation,
        openCodeHistory,
    }), [activeTab, checkoutWorkspace, codeLocation, navigateCodeLocation, openCodeHistory, navigateToPage, navigateToSurface, page, selectDashboard, setActiveTab, syncSurface]);
}
