import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    resolveRightSidebarMobileSurface,
    resolveProjectRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveProjectRouteSelectionQuery } from './projectRouteState';
import { resolveProjectRightTabId } from './resolveProjectRightTabId';
import {
    normalizeProjectMobileSurface,
    resolveProjectRightTabIdForSurface,
    resolveProjectRoutePathForSurface,
    type ProjectMobileSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

export function useProjectSurfaceController(params: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
}>) {
    const routerRef = useProjectRouteRouterRef();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(params.scopeId);
    const activeTab = pane.scopeState?.right.activeTabId ?? resolveProjectRightTabId(null);
    const routeSelectionQuery = React.useMemo(() => resolveProjectRouteSelectionQuery({
        activeRootPath: params.activeRootPath,
        defaultRootPath: params.workspaceRef.rootPath,
        activeWorktreeId: params.activeWorktreeId,
    }), [params.activeRootPath, params.activeWorktreeId, params.workspaceRef.rootPath]);

    const navigateToSurface = React.useCallback((surface: ProjectMobileSurface) => {
        routerRef.current.replace(resolveProjectRoutePathForSurface({
            workspaceRefId: params.workspaceRef.id,
            surface,
            ...routeSelectionQuery,
        }));
    }, [params.workspaceRef.id, routeSelectionQuery, routerRef]);

    const setActiveTab = React.useCallback((tabId: string) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
        if (deviceType !== 'phone') {
            return;
        }
        if (activeTab === tabId) {
            return;
        }
        const tab = resolveProjectRightSidebarTabs({ presentation: 'mobile' }).find((entry) => entry.id === tabId);
        // The registry surface vocabulary is shared across scopes (it also carries plugin and
        // session-only surfaces), so narrow through the project's own owner rather than
        // re-listing the project surfaces here.
        const mobileSurface = normalizeProjectMobileSurface(
            tab ? resolveRightSidebarMobileSurface(tab, 'project') : null,
        );
        if (mobileSurface) {
            navigateToSurface(mobileSurface);
        }
    }, [activeTab, deviceType, navigateToSurface, pane]);

    const syncSurface = React.useCallback((surface: ProjectMobileSurface) => {
        const targetRightTabId = resolveProjectRightTabIdForSurface(surface);
        if (!targetRightTabId) {
            if (pane.scopeState?.right?.isOpen === true) {
                pane.closeRight();
            }
            return;
        }

        pane.openRight({ tabId: targetRightTabId });
        if (pane.scopeState?.right?.activeTabId !== targetRightTabId) {
            pane.setRightTab(targetRightTabId);
        }
    }, [pane, pane.scopeState?.right?.activeTabId, pane.scopeState?.right?.isOpen]);

    return React.useMemo(() => ({
        activeTab,
        navigateToSurface,
        setActiveTab,
        syncSurface,
    }), [activeTab, navigateToSurface, setActiveTab, syncSurface]);
}
