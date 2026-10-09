import * as React from 'react';
import { Stack, useIsFocused, useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { useProjectInitialResource } from './useProjectInitialResource';
import { useProjectRouteActions } from './useProjectRouteActions';
import { useProjectRouteHeaderOptions } from './useProjectRouteHeaderOptions';
import { PROJECT_ROUTE_ROOT_SENTINEL, readProjectRouteStringParam, readProjectRouteWorktreeSelection, readProjectSelectedRouteResource, replaceProjectRouteSelection } from './projectRouteState';
import { useWorkspaceRefResolutionById } from './useWorkspaceRefById';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { useLocalSetting, useLocalSettingMutable, usePersistProjectLastMobileSurface, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys, writeProjectSelectionPreference } from '@/sync/domains/settings/projectSelectionPersistence';

export const ProjectDestinationBody = React.memo(() => {
    const routerRef = useProjectRouteRouterRef();
    const isFocused = useIsFocused();
    const pathname = usePathname();
    const params = useLocalSearchParams<Record<string, string | string[]>>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const serverId = readProjectRouteStringParam(params.serverId);
    const workspaceResolution = useWorkspaceRefResolutionById(workspaceRefId, serverId);
    const workspaceRef = workspaceResolution.kind === 'resolved' ? workspaceResolution.ref : null;
    const workspaceRefs = useWorkspaceRefs();
    const preferenceKeys = React.useMemo(() => workspaceRef
        ? resolveProjectSelectionPreferenceKeys(workspaceRefs, workspaceRef) : null, [workspaceRef, workspaceRefs]);
    const pageRoute = resolveProjectCockpitRouteFromPathname(pathname, null, readProjectRouteStringParam(params.mobileSurface));
    const page = pageRoute?.page ?? 'overview';
    const surface = pageRoute?.surface ?? page;
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(workspaceRefId, workspaceRef?.serverId ?? serverId));
    const pane = useAppPaneScope(scopeId);
    const resourcePending = useProjectInitialResource(pane, workspaceRef);
    const roots = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const worktreeIds = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setRoots] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const [, setWorktreeIds] = useLocalSettingMutable('projectLastActiveWorktreeIdByWorkspaceRefId');
    const persistPage = usePersistProjectLastMobileSurface();
    const fallbackRootPath = workspaceRef?.rootPath ?? readProjectRouteStringParam(params.activeRootPath) ?? '';
    const selection = readProjectRouteWorktreeSelection({
        rawWorktreeId: params.worktreeId,
        rawLegacyActiveRootPath: params.activeRootPath,
        defaultRootPath: fallbackRootPath,
        persistedActiveRootPath: readProjectSelectionPreference(roots, preferenceKeys),
        persistedWorktreeId: readProjectSelectionPreference(worktreeIds, preferenceKeys),
    });
    const { requestedRootPath, didRecoverMissingWorktree, resolvedRootPath: activeRootPath, resolvedWorktreeId: activeWorktreeId, availableWorktrees } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: fallbackRootPath,
        requestedRootPath: selection.requestedRootPath,
        requestedWorktreeId: selection.requestedWorktreeId,
    });
    const replaceSelection = React.useCallback((path: string, nextShowWorktrees = showWorktrees) => {
        if (!workspaceRef || !path.trim()) return;
        replaceProjectRouteSelection({
            router: routerRef.current,
            workspaceRefId,
            serverId: workspaceRef.serverId,
            segment: page,
            surface,
            routeParams: params,
            initialResource: readProjectSelectedRouteResource(pane.scopeState?.details) ?? (resourcePending ? undefined : null),
            activeRootPath: path,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: path === workspaceRef.rootPath ? null : findVisibleRepoWorktreeByPath(availableWorktrees, path)?.id ?? null,
            showWorktrees: nextShowWorktrees,
        });
    }, [availableWorktrees, page, pane.scopeState?.details, params, resourcePending, routerRef, showWorktrees, surface, workspaceRef, workspaceRefId]);
    const selectRootPath = React.useCallback((path: string) => replaceSelection(path), [replaceSelection]);
    React.useEffect(() => {
        if (!isFocused || !workspaceRef || !preferenceKeys) return;
        persistPage(workspaceRefId, page, workspaceRef.serverId);
        if (roots?.[preferenceKeys.storageKey] !== activeRootPath) setRoots(writeProjectSelectionPreference(roots, preferenceKeys, activeRootPath));
        const worktreeId = activeWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL;
        if (worktreeIds?.[preferenceKeys.storageKey] !== worktreeId) setWorktreeIds(writeProjectSelectionPreference(worktreeIds, preferenceKeys, worktreeId));
    }, [activeRootPath, activeWorktreeId, isFocused, page, persistPage, preferenceKeys, roots, setRoots, setWorktreeIds, worktreeIds, workspaceRef, workspaceRefId]);
    const setShowWorktrees = React.useCallback((value: boolean) => replaceSelection(activeRootPath, value), [activeRootPath, replaceSelection]);
    const actions = useProjectRouteActions({ workspaceRef, activeRootPath, activeWorktreeId, showWorktrees, pane });
    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath,
        testIdPrefix: 'project-header',
        showWorktreesButton: true,
        onToggleWorktrees: () => actions.replaceOverviewVisibility({ visible: !showWorktrees }),
        onOpenTerminal: () => actions.openTerminal({ exitOverview: true }),
    });
    return <>
        <Stack.Screen options={screenOptions} />
        <ProjectDetailScreen
            workspaceRefId={workspaceRefId}
            serverId={serverId}
            workspaceResolution={workspaceResolution}
            dashboardId={readProjectRouteStringParam(params.dashboardId) ?? undefined}
            recoveryToastKey={didRecoverMissingWorktree ? `${workspaceRefId}:${requestedRootPath}` : null}
            page={page}
            surface={surface}
            activeRootPath={activeRootPath}
            activeWorktreeId={activeWorktreeId}
            isFocused={isFocused}
            showWorktrees={showWorktrees}
            onSelectRootPath={selectRootPath}
            onSetShowWorktrees={setShowWorktrees}
        />
    </>;
});
