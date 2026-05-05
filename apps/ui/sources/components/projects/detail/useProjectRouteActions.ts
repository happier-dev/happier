import * as React from 'react';
import { useRouter } from 'expo-router';

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
    resolveProjectRouteActiveRootParam,
    type ProjectRouteSegment,
} from './projectRouteState';

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
    pane?: AppPaneScopeApi | null;
}>) {
    const router = useRouter();
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
    }>): string => {
        if (!workspaceRefId || !workspaceRootPath) {
            return '/projects';
        }
        return buildProjectRouteHref({
            workspaceRefId,
            segment: input?.segment,
            activeRootPath: params.activeRootPath,
            defaultRootPath: workspaceRootPath,
            activeWorktreeId: params.activeWorktreeId,
            showWorktrees: input?.showWorktrees,
        });
    }, [
        params.activeRootPath,
        params.activeWorktreeId,
        workspaceRefId,
        workspaceRootPath,
    ]);

    const buildCockpitHref = React.useCallback((surface: ProjectMobileSurface): string => {
        if (!workspaceRefId || !workspaceRootPath) {
            return '/projects';
        }
        return resolveProjectRoutePathForSurface({
            workspaceRefId,
            surface,
            rawWorktreeId: resolveProjectRouteActiveRootParam(
                params.activeRootPath,
                workspaceRootPath,
                params.activeWorktreeId,
            ) ?? null,
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
    }>) => {
        if (!workspaceRefId) return;
        const href = buildHref({
            segment: input.segment,
            showWorktrees: input.showWorktrees,
        });
        if (input.method === 'replace') {
            router.replace(href);
            return;
        }
        router.push(href);
    }, [buildHref, router, workspaceRefId]);

    const replaceOverviewVisibility = React.useCallback((input: Readonly<{
        segment?: ProjectRouteSegment;
        visible: boolean;
    }>) => {
        if (cockpitEnabled) {
            router.replace(buildCockpitHref(
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
    }, [buildCockpitHref, cockpitEnabled, navigateToSegment, router]);

    const openWorktreesInDetails = React.useCallback((method: 'push' | 'replace' = 'push') => {
        if (cockpitEnabled) {
            const href = buildCockpitHref('overview');
            if (method === 'replace') {
                router.replace(href);
                return;
            }
            router.push(href);
            return;
        }
        navigateToSegment({
            segment: 'details',
            showWorktrees: true,
            method,
        });
    }, [buildCockpitHref, cockpitEnabled, navigateToSegment, router]);

    const openTerminal = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        exitOverview?: boolean;
    }>) => {
        if (!workspaceRefId || !openDetailsTab) return;
        if (input?.exitOverview === true && params.showWorktrees === true) {
            if (cockpitEnabled) {
                router.replace(buildCockpitHref(resolveProjectSurfaceForSegment(input.segment)));
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
        router,
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
