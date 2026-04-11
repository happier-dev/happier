import * as React from 'react';
import { Redirect, Stack, type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import {
    PROJECT_ROUTE_ROOT_SENTINEL,
    buildProjectRouteHref,
    readProjectRouteStringParam,
    readProjectRouteWorktreeSelection,
    resolveProjectRouteSegment,
    replaceProjectRouteSelection,
} from '@/components/projects/detail/projectRouteState';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import {
    migrateProjectRouteSegmentToMobileSurface,
    resolveProjectMobileSurfaceIntent,
    resolveProjectRoutePathForSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export default React.memo(() => {
    const router = useRouter();
    const params = useLocalSearchParams<{
        workspaceRefId?: string | string[];
        mobileSurface?: string | string[];
        worktreeId?: string | string[];
        activeRootPath?: string | string[];
        showWorktrees?: string | string[];
    }>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const explicitMobileSurfaceHint = readProjectRouteStringParam(params.mobileSurface);
    const rawWorktreeId = readProjectRouteStringParam(params.worktreeId);
    const rawLegacyActiveRootPath = readProjectRouteStringParam(params.activeRootPath);
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
    const {
        deviceType,
        cockpitEnabled,
        showWorkspaceExperienceToggle,
        workspaceExperienceToggleLabelKey,
        toggleWorkspaceExperience,
    } = useMobileWorkspaceExperienceState();
    const lastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setLastMobileSurfaceByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastActiveWorktreeIdByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveWorktreeIdByWorkspaceRefId');
    const scopeId = buildProjectPaneScopeId(workspaceRefId);
    const pane = useAppPaneScope(scopeId);
    const workspaceRef = useWorkspaceRefById(workspaceRefId);
    const fallbackRootPath = workspaceRef?.rootPath ?? readProjectRouteStringParam(params.activeRootPath) ?? '';
    const persistedRootPath = workspaceRefId
        ? (lastActiveRootPathByWorkspaceRefId?.[workspaceRefId] ?? null)
        : null;
    const persistedWorktreeId = workspaceRefId
        ? (lastActiveWorktreeIdByWorkspaceRefId?.[workspaceRefId] ?? null)
        : null;
    const routeSelection = fallbackRootPath
        ? readProjectRouteWorktreeSelection({
            rawWorktreeId: params.worktreeId,
            rawLegacyActiveRootPath: params.activeRootPath,
            defaultRootPath: fallbackRootPath,
            persistedActiveRootPath: typeof persistedRootPath === 'string' ? persistedRootPath : null,
            persistedWorktreeId: typeof persistedWorktreeId === 'string' ? persistedWorktreeId : null,
        })
        : { requestedRootPath: null, requestedWorktreeId: null };
    const {
        resolvedRootPath: activeRootPath,
        resolvedWorktreeId: activeWorktreeId,
        availableWorktrees,
    } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: workspaceRef?.rootPath ?? fallbackRootPath,
        requestedRootPath: routeSelection.requestedRootPath,
        requestedWorktreeId: routeSelection.requestedWorktreeId,
    });

    const handleSelectRootPath = React.useCallback((path: string) => {
        if (!workspaceRef) return;
        const nextWorktreeId = path === workspaceRef.rootPath
            ? null
            : (availableWorktrees?.find((worktree) => worktree.isPrunable !== true && worktree.path === path)?.id ?? null);
        replaceProjectRouteSelection({
            router,
            workspaceRefId: workspaceRef.id,
            activeRootPath: path,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: nextWorktreeId,
            showWorktrees,
        });
    }, [availableWorktrees, router, showWorktrees, workspaceRef]);

    const handleSetShowWorktrees = React.useCallback((nextValue: boolean) => {
        if (!workspaceRef) return;
        replaceProjectRouteSelection({
            router,
            workspaceRefId: workspaceRef.id,
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId,
            showWorktrees: nextValue,
        });
    }, [activeRootPath, activeWorktreeId, fallbackRootPath, router, workspaceRef]);

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: activeRootPath ?? fallbackRootPath,
        activeWorktreeId,
        showWorktrees,
        pane,
    });
    const replaceOverviewVisibility = routeActions.replaceOverviewVisibility;
    const openTerminal = routeActions.openTerminal;
    const handleToggleWorktrees = React.useCallback(() => {
        replaceOverviewVisibility({ visible: !showWorktrees });
    }, [replaceOverviewVisibility, showWorktrees]);
    const handleOpenTerminal = React.useCallback(() => {
        openTerminal({ exitOverview: true });
    }, [openTerminal]);

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: activeRootPath ?? fallbackRootPath,
        testIdPrefix: deviceType === 'phone' ? 'project-mobile-header' : 'project-desktop-header',
        showWorktreesButton: true,
        showWorkspaceExperienceButton: showWorkspaceExperienceToggle,
        workspaceExperienceToggleA11yLabel: t(workspaceExperienceToggleLabelKey),
        onToggleWorkspaceExperience: showWorkspaceExperienceToggle ? toggleWorkspaceExperience : undefined,
        onToggleWorktrees: handleToggleWorktrees,
        onOpenTerminal: handleOpenTerminal,
    });

    const persistedSurface = migrateProjectRouteSegmentToMobileSurface(
        typeof lastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] === 'string'
            ? lastMobileSurfaceByWorkspaceRefId[workspaceRefId]
            : null,
    );
    const rootMobileSurface = resolveProjectMobileSurfaceIntent({
        routeKind: 'index',
        activeRightTabId: pane.scopeState?.right?.activeTabId,
        detailsTargetPresent: (pane.scopeState?.details?.tabs?.length ?? 0) > 0,
        overviewVisible: showWorktrees,
        persistedSurface,
        explicitSurfaceHint: explicitMobileSurfaceHint,
    });
    const canonicalActiveRootPath = activeRootPath ?? fallbackRootPath;
    const canonicalWorktreeQueryValue = workspaceRef && canonicalActiveRootPath === workspaceRef.rootPath
        ? PROJECT_ROUTE_ROOT_SENTINEL
        : (activeWorktreeId ?? null);
    const shouldCanonicalizeCockpitIndexRoute = Boolean(
        workspaceRef
        && cockpitEnabled
        && (
            rootMobileSurface !== 'overview'
            || routeSelection.requestedRootPath !== canonicalActiveRootPath
            || (routeSelection.requestedWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL) !== (canonicalWorktreeQueryValue ?? PROJECT_ROUTE_ROOT_SENTINEL)
        ),
    );
    const canonicalCockpitHref = workspaceRef
        ? resolveProjectRoutePathForSurface({
            workspaceRefId: workspaceRef.id,
            surface: rootMobileSurface,
            rawWorktreeId: canonicalWorktreeQueryValue,
        })
        : null;

    React.useEffect(() => {
        if (!workspaceRefId) return;
        if (lastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] === rootMobileSurface) return;
        setLastMobileSurfaceByWorkspaceRefId({
            ...(lastMobileSurfaceByWorkspaceRefId ?? {}),
            [workspaceRefId]: rootMobileSurface,
        });
    }, [
        lastMobileSurfaceByWorkspaceRefId,
        rootMobileSurface,
        setLastMobileSurfaceByWorkspaceRefId,
        workspaceRefId,
    ]);

    React.useEffect(() => {
        if (!workspaceRefId) return;
        if (!canonicalActiveRootPath) return;
        const nextStoredWorktreeId = canonicalWorktreeQueryValue ?? PROJECT_ROUTE_ROOT_SENTINEL;
        const rootPathIsCurrent = lastActiveRootPathByWorkspaceRefId?.[workspaceRefId] === canonicalActiveRootPath;
        const worktreeIsCurrent = lastActiveWorktreeIdByWorkspaceRefId?.[workspaceRefId] === nextStoredWorktreeId;
        if (rootPathIsCurrent && worktreeIsCurrent) return;
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [workspaceRefId]: canonicalActiveRootPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [workspaceRefId]: nextStoredWorktreeId,
        });
    }, [
        canonicalActiveRootPath,
        canonicalWorktreeQueryValue,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
        workspaceRefId,
    ]);

    if (
        workspaceRef
        && cockpitEnabled
        && workspaceRefId
    ) {
        if (shouldCanonicalizeCockpitIndexRoute && canonicalCockpitHref) {
            return <Redirect href={canonicalCockpitHref as Href} />;
        }
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <ProjectCockpitShell
                    workspaceRef={workspaceRef}
                    scopeId={scopeId}
                    activeRootPath={canonicalActiveRootPath}
                    activeWorktreeId={activeWorktreeId}
                    surface={rootMobileSurface}
                    onSelectRootPath={(path) => {
                        if (!workspaceRef) return;
                        const nextWorktreeId = path === workspaceRef.rootPath
                            ? PROJECT_ROUTE_ROOT_SENTINEL
                            : (availableWorktrees?.find((worktree) => worktree.isPrunable !== true && worktree.path === path)?.id ?? null);
                        router.replace(resolveProjectRoutePathForSurface({
                            workspaceRefId: workspaceRef.id,
                            surface: 'overview',
                            rawWorktreeId: nextWorktreeId,
                        }));
                    }}
                />
            </>
        );
    }

    if (workspaceRefId && showWorkspaceExperienceToggle) {
        if (!workspaceRef) {
            const href = (
                cockpitEnabled
                    ? resolveProjectRoutePathForSurface({
                        workspaceRefId,
                        surface: rootMobileSurface,
                        rawWorktreeId,
                        rawActiveRootPath: rawLegacyActiveRootPath,
                    })
                    : resolveProjectRouteSegment(
                        pane.scopeState?.right?.activeTabId,
                        typeof lastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] === 'string'
                            ? lastMobileSurfaceByWorkspaceRefId[workspaceRefId]
                            : null,
                    )
            ) as Href;
            if (cockpitEnabled) {
                return <Redirect href={href} />;
            }
            const legacySegment = resolveProjectRouteSegment(
                pane.scopeState?.right?.activeTabId,
                typeof lastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] === 'string'
                    ? lastMobileSurfaceByWorkspaceRefId[workspaceRefId]
                    : null,
            );
            const queryParams = new URLSearchParams();
            if (rawWorktreeId) {
                queryParams.set('worktreeId', rawWorktreeId);
            } else if (rawLegacyActiveRootPath) {
                queryParams.set('activeRootPath', rawLegacyActiveRootPath);
            }
            const query = queryParams.toString();
            const legacyHref = (
                query
                    ? `/projects/${encodeURIComponent(workspaceRefId)}/${legacySegment}?${query}`
                    : `/projects/${encodeURIComponent(workspaceRefId)}/${legacySegment}`
            ) as Href;
            return <Redirect href={legacyHref} />;
        }
        const href = buildProjectRouteHref({
            workspaceRefId,
            segment: resolveProjectRouteSegment(
                pane.scopeState?.right?.activeTabId,
                typeof lastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] === 'string'
                    ? lastMobileSurfaceByWorkspaceRefId[workspaceRefId]
                    : null,
            ),
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef?.rootPath ?? '',
            activeWorktreeId,
        }) as Href;
        return <Redirect href={href} />;
    }

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ProjectDetailScreen
                workspaceRefId={workspaceRefId}
                activeRootPath={activeRootPath}
                showWorktrees={showWorktrees}
                onSelectRootPath={handleSelectRootPath}
                onSetShowWorktrees={handleSetShowWorktrees}
            />
        </>
    );
});
