import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { Redirect, Stack, type Href, useLocalSearchParams } from 'expo-router';

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
    resolveProjectRouteSelectionQuery,
    resolveProjectRouteSegment,
    replaceProjectRouteSelection,
} from '@/components/projects/detail/projectRouteState';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import {
    migrateProjectRouteSegmentToMobileSurface,
    type ProjectMobileSurface,
    resolveProjectMobileSurfaceIntent,
    resolveProjectRoutePathForSurface,
} from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from '@/components/projects/detail/useProjectRouteRouterRef';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import {
    useLocalSetting,
    useLocalSettingMutable,
    usePersistProjectLastMobileSurface,
    useProjectLastMobileSurface,
} from '@/sync/domains/state/storage';
import { t } from '@/text';

type ClassicProjectHostedSurface = Extract<ProjectMobileSurface, 'browser' | 'services'>;

function resolveClassicProjectHostedSurface(surface: ProjectMobileSurface): ClassicProjectHostedSurface | null {
    return surface === 'browser' || surface === 'services' ? surface : null;
}

function appendClassicProjectHostedSurfaceHint(href: string, surface: ClassicProjectHostedSurface): string {
    const [pathname = href, queryString = ''] = href.split('?', 2);
    const searchParams = new URLSearchParams(queryString);
    searchParams.set('mobileSurface', surface);
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
}

export default React.memo(() => {
    const routerRef = useProjectRouteRouterRef();
    const isFocused = useIsFocused();
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
    const lastMobileSurface = useProjectLastMobileSurface(workspaceRefId || null);
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const persistProjectLastMobileSurface = usePersistProjectLastMobileSurface();
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
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        const nextWorktreeId = trimmedPath === workspaceRef.rootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        replaceProjectRouteSelection({
            router: routerRef.current,
            workspaceRefId: workspaceRef.id,
            activeRootPath: trimmedPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: nextWorktreeId,
            showWorktrees,
        });
    }, [availableWorktrees, routerRef, showWorktrees, workspaceRef]);

    const handleSetShowWorktrees = React.useCallback((nextValue: boolean) => {
        if (!workspaceRef) return;
        replaceProjectRouteSelection({
            router: routerRef.current,
            workspaceRefId: workspaceRef.id,
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId,
            showWorktrees: nextValue,
        });
    }, [activeRootPath, activeWorktreeId, fallbackRootPath, routerRef, workspaceRef]);

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

    const persistedSurface = migrateProjectRouteSegmentToMobileSurface(lastMobileSurface);
    const rootMobileSurface = resolveProjectMobileSurfaceIntent({
        routeKind: 'index',
        activeRightTabId: pane.scopeState?.right?.activeTabId,
        detailsTargetPresent: (pane.scopeState?.details?.tabs?.length ?? 0) > 0,
        overviewVisible: showWorktrees,
        persistedSurface,
        explicitSurfaceHint: explicitMobileSurfaceHint,
    });
    const canonicalActiveRootPath = activeRootPath ?? fallbackRootPath;
    const canonicalRouteSelectionQuery = workspaceRef
        ? resolveProjectRouteSelectionQuery({
            activeRootPath: canonicalActiveRootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId,
        })
        : { rawWorktreeId: null, rawActiveRootPath: null };
    const canonicalWorktreeQueryValue = canonicalRouteSelectionQuery.rawWorktreeId;
    const shouldCanonicalizeCockpitIndexRoute = Boolean(
        isFocused
        && workspaceRef
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
            ...canonicalRouteSelectionQuery,
        })
        : null;
    const handleSelectCockpitRootPath = React.useCallback((path: string) => {
        if (!workspaceRef) return;
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        const nextWorktreeId = trimmedPath === workspaceRef.rootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        routerRef.current.replace(resolveProjectRoutePathForSurface({
            workspaceRefId: workspaceRef.id,
            surface: 'overview',
            ...resolveProjectRouteSelectionQuery({
                activeRootPath: trimmedPath,
                defaultRootPath: workspaceRef.rootPath,
                activeWorktreeId: nextWorktreeId,
            }),
        }));
    }, [availableWorktrees, routerRef, workspaceRef]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!workspaceRefId) return;
        if (lastMobileSurface === rootMobileSurface) return;
        persistProjectLastMobileSurface(workspaceRefId, rootMobileSurface);
    }, [
        isFocused,
        lastMobileSurface,
        persistProjectLastMobileSurface,
        rootMobileSurface,
        workspaceRefId,
    ]);

    React.useEffect(() => {
        if (!isFocused) return;
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
        isFocused,
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
                    isFocused={isFocused}
                    onSelectRootPath={handleSelectCockpitRootPath}
                />
            </>
        );
    }

    if (isFocused && workspaceRefId && showWorkspaceExperienceToggle) {
        const classicHostedSurface = resolveClassicProjectHostedSurface(rootMobileSurface);
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
                        lastMobileSurface,
                    )
            ) as Href;
            if (cockpitEnabled) {
                return <Redirect href={href} />;
            }
            const legacySegment = resolveProjectRouteSegment(
                pane.scopeState?.right?.activeTabId,
                lastMobileSurface,
            );
            const queryParams = new URLSearchParams();
            if (rawWorktreeId) {
                queryParams.set('worktreeId', rawWorktreeId);
            } else if (rawLegacyActiveRootPath) {
                queryParams.set('activeRootPath', rawLegacyActiveRootPath);
            }
            if (classicHostedSurface) {
                queryParams.set('mobileSurface', classicHostedSurface);
            }
            const query = queryParams.toString();
            const legacyHref = (
                query
                    ? `/projects/${encodeURIComponent(workspaceRefId)}/${classicHostedSurface ? 'files' : legacySegment}?${query}`
                    : `/projects/${encodeURIComponent(workspaceRefId)}/${classicHostedSurface ? 'files' : legacySegment}`
            ) as Href;
            return <Redirect href={legacyHref} />;
        }
        const href = buildProjectRouteHref({
            workspaceRefId,
            segment: classicHostedSurface
                ? 'files'
                : resolveProjectRouteSegment(
                    pane.scopeState?.right?.activeTabId,
                    lastMobileSurface,
                ),
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef?.rootPath ?? '',
            activeWorktreeId,
        });
        const redirectHref = classicHostedSurface
            ? appendClassicProjectHostedSurfaceHint(href, classicHostedSurface)
            : href;
        return <Redirect href={redirectHref as Href} />;
    }

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ProjectDetailScreen
                workspaceRefId={workspaceRefId}
                activeRootPath={activeRootPath}
                isFocused={isFocused}
                showWorktrees={showWorktrees}
                onSelectRootPath={handleSelectRootPath}
                onSetShowWorktrees={handleSetShowWorktrees}
            />
        </>
    );
});
