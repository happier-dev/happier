import * as React from 'react';
import { useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { PROJECT_ROUTE_ROOT_SENTINEL } from './projectRouteState';
import { resolveProjectRightTabId, type ProjectRightTabId } from './resolveProjectRightTabId';
import {
    resolveProjectRightTabIdForSurface,
    resolveProjectRoutePathForSurface,
    type ProjectMobileSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';

export function useProjectSurfaceController(params: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
}>) {
    const router = useRouter();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(params.scopeId);
    const activeTab = resolveProjectRightTabId(pane.scopeState?.right.activeTabId);
    const rawWorktreeId = params.activeRootPath === params.workspaceRef.rootPath
        ? PROJECT_ROUTE_ROOT_SENTINEL
        : params.activeWorktreeId ?? null;

    const navigateToSurface = React.useCallback((surface: ProjectMobileSurface) => {
        router.replace(resolveProjectRoutePathForSurface({
            workspaceRefId: params.workspaceRef.id,
            surface,
            rawWorktreeId,
        }));
    }, [params.workspaceRef.id, rawWorktreeId, router]);

    const setActiveTab = React.useCallback((tabId: ProjectRightTabId) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
        if (deviceType !== 'phone') {
            return;
        }
        if (activeTab === tabId) {
            return;
        }
        navigateToSurface(tabId === 'git' ? 'git' : 'browse');
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
