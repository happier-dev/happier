import * as React from 'react';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import {
    resolveRightSidebarMobileSurface,
    resolveProjectRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { buildProjectRouteHref, readProjectCodeRouteLocation, readProjectSelectedRouteResource, readProjectRouteStringParam } from './projectRouteState';
import type { WorkspaceCodeLocation } from '@/components/projects/files/code/WorkspaceCodeBrowserView';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { tryBuildWorkspaceCacheKey, workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceScmTabState } from '@/components/workspaces/scm/useWorkspaceScmTabState';
import { useScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import { resolveProjectRightTabId } from './resolveProjectRightTabId';
import {
    normalizeProjectMobileSurface,
    resolveProjectCockpitRouteFromPathname,
    resolveProjectPageForSurface,
    resolveProjectRightTabIdForSurface,
    type ProjectMobileSurface,
    type ProjectPageV1,
    type ProjectPageSelection,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

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
    const currentRoute = React.useMemo(() => resolveProjectCockpitRouteFromPathname(pathname), [pathname]);
    const page = currentRoute?.page ?? 'overview';
    const selection = currentRoute?.selection;
    const workspaceRefs = useWorkspaceRefs();
    const checkoutWorkspace = React.useMemo(() => {
        const checkout = resolveProjectCheckoutWorkspaceRef(workspaceRefs, params.workspaceRef, params.activeRootPath);
        return checkout ? workspaceAddressFromRefV2(checkout) : null;
    }, [params.activeRootPath, params.workspaceRef, workspaceRefs]);
    const workspaceScope = React.useMemo(() => workspaceScopeFromProject(params.workspaceRef, params.activeRootPath),
        [params.workspaceRef, params.activeRootPath]);
    const paneContext = React.useContext(AppPaneContext);
    const pane = useAppPaneScope(params.scopeId, scope => ({
        activeTabId: scope?.right.activeTabId,
        rightOpen: scope?.right.isOpen === true,
        gitTabState: scope?.right.tabState.git,
        reviewTabState: scope?.details.tabState[SESSION_DETAILS_SCM_REVIEW_TAB_KEY],
    }));
    const { setActiveGitSubTab } = useWorkspaceScmTabState({
        scopeState: { right: { tabState: { git: pane.scopeState.gitTabState } } }, setRightTabState: pane.setRightTabState,
    });
    const workspaceKey = tryBuildWorkspaceCacheKey(workspaceScope) ?? '';
    const { setPersistedReviewTabState } = useScmReviewTabState(workspaceScope.workspace ? workspaceKey : JSON.stringify([
        params.workspaceRef.serverId, params.workspaceRef.machineId, params.activeRootPath,
    ]), { patchDetailsTabState: pane.patchDetailsTabState }, SESSION_DETAILS_SCM_REVIEW_TAB_KEY, pane.scopeState.reviewTabState);
    const { setLocation } = useRepositoryTreeBrowserState(workspaceKey);
    const codeLocation = React.useMemo<WorkspaceCodeLocation>(() => readProjectCodeRouteLocation(routeParams)
        ?? { kind: 'folder', path: '' }, [routeParams.codeKind, routeParams.codePath]);
    React.useEffect(() => {
        if (page === 'code') setLocation(codeLocation);
    }, [codeLocation, page, setLocation]);
    const activeTab = pane.scopeState.activeTabId ?? resolveProjectRightTabId(null);

    const navigate = React.useCallback((surface: ProjectMobileSurface, nextPage: ProjectPageV1, layoutId?: string | null,
        nextSelection?: ProjectPageSelection) => {
        const details = paneContext?.getSnapshot().state.scopes[params.scopeId]?.details;
        routerRef.current.replace(buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id,
            surface,
            segment: nextPage,
            selection: nextSelection,
            serverId: params.workspaceRef.serverId,
            routeParams,
            layoutId,
            ...(layoutId !== undefined ? { attachedDashboard: null } : {}),
            activeRootPath: params.activeRootPath,
            activeWorktreeId: params.activeWorktreeId,
            defaultRootPath: params.workspaceRef.rootPath,
            initialResource: readProjectSelectedRouteResource(details ? buildDetailsWorkspaceStateView(details) : null) ?? null,
        }));
    }, [paneContext, params.scopeId, params.activeRootPath, params.activeWorktreeId, params.workspaceRef.id, params.workspaceRef.rootPath, params.workspaceRef.serverId, routeParams, routerRef]);
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
    const navigateToSurface = React.useCallback((surface: ProjectMobileSurface) => navigate(surface, page, undefined, selection), [navigate, page, selection]);
    const selectDashboard = React.useCallback((layoutId: string | null) => {
        navigate(normalizeProjectMobileSurface(readProjectRouteStringParam(routeParams.mobileSurface)) ?? page, page, layoutId);
    }, [navigate, page, routeParams.mobileSurface]);

    // A phone shows each side-pane tab as its own page in the one tab bar, never as the side pane over it.
    const showRightTabAsPage = React.useCallback((tabId: string) => {
        const tab = resolveProjectRightSidebarTabs({ presentation: 'mobile', activePage: page }).find((entry) => entry.id === tabId);
        // The registry surface vocabulary is shared across scopes (it also carries plugin and
        // session-only surfaces), so narrow through the project's own owner rather than
        // re-listing the project surfaces here.
        const mobileSurface = normalizeProjectMobileSurface(
            tab ? resolveRightSidebarMobileSurface(tab, 'project') : null,
        );
        if (!mobileSurface) return;
        // A tab with its own page opens that page (its tab in the bar); a companion opens over the current page.
        const surfacePage = resolveProjectPageForSurface(mobileSurface);
        if (surfacePage !== 'overview' || mobileSurface === 'overview') navigateToPage(surfacePage);
        else navigateToSurface(mobileSurface);
    }, [navigateToPage, navigateToSurface, page]);

    const setActiveTab = React.useCallback((tabId: string) => {
        if (deviceType !== 'phone') {
            pane.openRight({ tabId });
            pane.setRightTab(tabId);
            return;
        }
        pane.setRightTab(tabId);
        if (activeTab !== tabId) showRightTabAsPage(tabId);
    }, [activeTab, deviceType, pane, showRightTabAsPage]);

    /** Folding away a companion preserves the explicitly selected Project page. */
    const closeRetainedRightPaneOnPhone = React.useCallback(() => {
        if (deviceType !== 'phone' || !pane.scopeState.rightOpen) return;
        pane.closeRight();
    }, [deviceType, pane]);

    const syncSurface = React.useCallback((surface: ProjectMobileSurface) => {
        // Page selection never replaces the retained companion selection.
        if (surface === page) return;
        const targetRightTabId = resolveProjectRightTabIdForSurface(surface);
        if (!targetRightTabId) {
            return;
        }

        // A phone's page already shows the surface: only the selection is kept for a wider window.
        if (deviceType !== 'phone') pane.openRight({ tabId: targetRightTabId });
        if (pane.scopeState.activeTabId !== targetRightTabId) {
            pane.setRightTab(targetRightTabId);
        }
    }, [deviceType, page, pane, pane.scopeState.activeTabId]);

    return React.useMemo(() => ({
        activeTab,
        page,
        navigateToPage,
        navigateToSurface,
        selectDashboard,
        setActiveTab,
        syncSurface,
        closeRetainedRightPaneOnPhone,
        rightOpen: pane.scopeState.rightOpen,
        checkoutWorkspace,
        workspaceScope,
        codeLocation,
        navigateCodeLocation,
        openCodeHistory,
    }), [activeTab, checkoutWorkspace, codeLocation, navigateCodeLocation, openCodeHistory, navigateToPage, navigateToSurface, page,
        pane.scopeState.rightOpen, closeRetainedRightPaneOnPhone, selectDashboard, setActiveTab, syncSurface, workspaceScope]);
}
