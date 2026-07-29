import * as React from 'react';

import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSetting } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import {
    resolveProjectRoutePathForSurface,
    type ProjectMobileSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';

import {
    buildProjectTerminalDetailsInstanceId,
    openProjectTerminalDetailsTab,
} from './openProjectTerminalDetailsTab';
import {
    buildProjectRouteHref,
    resolveProjectRouteSelectionQuery,
    type ProjectRouteSegment,
    type ProjectDetailsSourceSurface,
} from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

function resolveProjectSurfaceForSegment(segment?: ProjectRouteSegment): ProjectMobileSurface {
    if (segment === 'git') {
        return 'git';
    }
    if (segment === 'files') {
        return 'browse';
    }
    return 'tabs';
}

export function useProjectRouteActions(params: Readonly<{
    workspaceRef: WorkspaceRefV1 | null;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
    sourceSurface?: ProjectDetailsSourceSurface | null;
    pane?: AppPaneScopeApi | null;
}>) {
    const routerRef = useProjectRouteRouterRef();
    const deviceType = useDeviceType();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const workspaceRefId = params.workspaceRef?.id ?? null;
    const workspaceRootPath = params.workspaceRef?.rootPath ?? null;
    const openDetailsTab = params.pane?.openDetailsTab;
    const cockpitEnabled = isMobileWorkspaceCockpitEnabled({
        deviceType,
        mobileWorkspaceExperience,
    });

    const buildHref = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        showWorktrees?: boolean;
        sourceSurface?: ProjectDetailsSourceSurface | null;
    }>): string => {
        if (!workspaceRefId || !workspaceRootPath) {
            return '/projects';
        }
        const sourceSurface = input?.segment === 'details'
            ? (input.sourceSurface ?? params.sourceSurface ?? null)
            : null;
        return buildProjectRouteHref({
            workspaceRefId,
            segment: input?.segment,
            activeRootPath: params.activeRootPath,
            defaultRootPath: workspaceRootPath,
            activeWorktreeId: params.activeWorktreeId,
            showWorktrees: input?.showWorktrees,
            sourceSurface,
        });
    }, [
        params.activeRootPath,
        params.activeWorktreeId,
        params.sourceSurface,
        workspaceRefId,
        workspaceRootPath,
    ]);

    const buildCockpitHref = React.useCallback((surface: ProjectMobileSurface): string => {
        if (!workspaceRefId || !workspaceRootPath) {
            return '/projects';
        }
        const routeSelectionQuery = resolveProjectRouteSelectionQuery({
            activeRootPath: params.activeRootPath,
            defaultRootPath: workspaceRootPath,
            activeWorktreeId: params.activeWorktreeId,
        });
        return resolveProjectRoutePathForSurface({
            workspaceRefId,
            surface,
            rawWorktreeId: routeSelectionQuery.rawWorktreeId,
            rawActiveRootPath: routeSelectionQuery.rawActiveRootPath,
        });
    }, [
        params.activeRootPath,
        params.activeWorktreeId,
        workspaceRefId,
        workspaceRootPath,
    ]);

    const navigateToSegment = React.useCallback((input: Readonly<{
        segment?: ProjectRouteSegment;
        showWorktrees?: boolean;
        method?: 'push' | 'replace';
        sourceSurface?: ProjectDetailsSourceSurface | null;
    }>) => {
        if (!workspaceRefId) return;
        const href = buildHref({
            segment: input.segment,
            showWorktrees: input.showWorktrees,
            sourceSurface: input.sourceSurface,
        });
        if (input.method === 'replace') {
            routerRef.current.replace(href);
            return;
        }
        routerRef.current.push(href);
    }, [buildHref, routerRef, workspaceRefId]);

    const replaceOverviewVisibility = React.useCallback((input: Readonly<{
        segment?: ProjectRouteSegment;
        visible: boolean;
    }>) => {
        if (cockpitEnabled) {
            routerRef.current.replace(buildCockpitHref(
                input.visible
                    ? 'overview'
                    : resolveProjectSurfaceForSegment(input.segment),
            ));
            return;
        }
        navigateToSegment({
            segment: input.segment,
            showWorktrees: input.visible,
            method: 'replace',
        });
    }, [buildCockpitHref, cockpitEnabled, navigateToSegment, routerRef]);

    const openWorktreesInDetails = React.useCallback((method: 'push' | 'replace' = 'push') => {
        if (cockpitEnabled) {
            const href = buildCockpitHref('overview');
            if (method === 'replace') {
                routerRef.current.replace(href);
                return;
            }
            routerRef.current.push(href);
            return;
        }
        navigateToSegment({
            segment: 'details',
            showWorktrees: true,
            method,
        });
    }, [buildCockpitHref, cockpitEnabled, navigateToSegment, routerRef]);

    const openTerminal = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        exitOverview?: boolean;
    }>) => {
        if (!workspaceRefId || !openDetailsTab) return;
        if (input?.exitOverview === true && params.showWorktrees === true) {
            if (cockpitEnabled) {
                routerRef.current.replace(buildCockpitHref(resolveProjectSurfaceForSegment(input.segment)));
            } else {
                navigateToSegment({
                    segment: input.segment,
                    showWorktrees: false,
                    method: 'replace',
                });
            }
        }
        openProjectTerminalDetailsTab({
            openDetailsTab,
            cwd: params.activeRootPath,
            terminalInstanceId: buildProjectTerminalDetailsInstanceId(workspaceRefId),
        });
    }, [
        buildCockpitHref,
        cockpitEnabled,
        navigateToSegment,
        openDetailsTab,
        params.activeRootPath,
        params.showWorktrees,
        routerRef,
        workspaceRefId,
    ]);

    return {
        buildHref,
        navigateToSegment,
        openTerminal,
        openWorktreesInDetails,
        replaceOverviewVisibility,
    };
}
