import * as React from 'react';
import { Stack, useIsFocused, useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { useProjectInitialResource } from './useProjectInitialResource';
import { useProjectRouteActions } from './useProjectRouteActions';
import { ProjectPageBackProvider } from './projectPageBack';
import { useProjectRouteHeaderOptions } from './useProjectRouteHeaderOptions';
import { PROJECT_ROUTE_ROOT_SENTINEL, readProjectAttachedDashboardSelection, readProjectRouteStringParam, readProjectRouteWorktreeSelection, readProjectSelectedRouteResource, replaceProjectRouteSelection } from './projectRouteState';
import { useWorkspaceRefResolutionById } from './useWorkspaceRefById';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { useProjectLastMobileSurface, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { persistProjectSelectionUiState, useProjectSelectionUiState } from '@/sync/domains/state/projectSelectionUiState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

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
    const rememberedPage = useProjectLastMobileSurface(workspaceRefId, workspaceRef?.serverId ?? serverId);
    const surfaceHint = readProjectRouteStringParam(params.mobileSurface);
    const pageRoute = React.useMemo(() => resolveProjectCockpitRouteFromPathname(pathname, rememberedPage, surfaceHint),
        [pathname, rememberedPage, surfaceHint]);
    const page = pageRoute?.page ?? 'overview';
    const pageSelection = pageRoute?.selection;
    const surface = pageRoute?.surface ?? page;
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(workspaceRefId, workspaceRef?.serverId ?? serverId));
    const pane = useAppPaneScope(scopeId, () => null);
    const paneContext = React.useContext(AppPaneContext);
    const resourcePending = useProjectInitialResource(pane, workspaceRef);
    const { activeRootPath: persistedActiveRootPath, worktreeId: persistedWorktreeId } = useProjectSelectionUiState(preferenceKeys);
    const fallbackRootPath = workspaceRef?.rootPath ?? readProjectRouteStringParam(params.activeRootPath) ?? '';
    const selection = readProjectRouteWorktreeSelection({
        rawWorktreeId: params.worktreeId,
        rawLegacyActiveRootPath: params.activeRootPath,
        defaultRootPath: fallbackRootPath,
        persistedActiveRootPath,
        persistedWorktreeId,
    });
    const { requestedRootPath, didRecoverMissingWorktree, resolvedRootPath: activeRootPath, resolvedWorktreeId: activeWorktreeId, availableWorktrees } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: fallbackRootPath,
        requestedRootPath: selection.requestedRootPath,
        requestedWorktreeId: selection.requestedWorktreeId,
        refreshOnMount: pageSelection?.kind !== 'plugin',
    });
    const replaceSelection = React.useCallback((path: string, nextShowWorktrees = showWorktrees) => {
        if (!workspaceRef || !path.trim()) return;
        const details = paneContext?.getSnapshot().state.scopes[scopeId]?.details;
        return replaceProjectRouteSelection({
            router: routerRef.current,
            workspaceRefId,
            serverId: workspaceRef.serverId,
            segment: page,
            selection: pageSelection,
            surface,
            routeParams: params,
            initialResource: readProjectSelectedRouteResource(details ? buildDetailsWorkspaceStateView(details) : null) ?? (resourcePending ? undefined : null),
            activeRootPath: path,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: path === workspaceRef.rootPath ? null : findVisibleRepoWorktreeByPath(availableWorktrees, path)?.id ?? null,
            showWorktrees: nextShowWorktrees,
        });
    }, [availableWorktrees, page, pageSelection, paneContext, scopeId, params, resourcePending, routerRef, showWorktrees, surface, workspaceRef, workspaceRefId]);
    const selectRootPath = React.useCallback((path: string) => replaceSelection(path), [replaceSelection]);
    React.useEffect(() => {
        if (!isFocused || !workspaceRef || !preferenceKeys) return;
        const worktreeId = activeWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL;
        persistProjectSelectionUiState(preferenceKeys, activeRootPath, worktreeId);
    }, [activeRootPath, activeWorktreeId, isFocused, preferenceKeys, workspaceRef]);
    const setShowWorktrees = React.useCallback((value: boolean) => replaceSelection(activeRootPath, value), [activeRootPath, replaceSelection]);
    const actions = useProjectRouteActions({ workspaceRef, activeRootPath, activeWorktreeId, showWorktrees, pane });
    // A page's pushed detail (a phone Service) takes the bar's Back while it is open; otherwise Back leaves the Project.
    const [pageBack, setPageBack] = React.useState<(() => void) | null>(null);
    const registerPageBack = React.useCallback((back: (() => void) | null) => setPageBack(() => back), []);
    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath,
        testIdPrefix: 'project-header',
        showWorktreesButton: true,
        ...(pageBack ? { onBack: pageBack } : {}),
        onToggleWorktrees: () => actions.replaceOverviewVisibility({ visible: !showWorktrees }),
        onOpenBrowser: actions.openBrowser,
        onOpenTerminal: () => actions.openTerminal({ exitOverview: true }),
    });
    if (pageRoute === null && pathname.includes('/plugins/')) {
        return <><Stack.Screen options={screenOptions} /><SurfaceStateCard kind="unavailable" title={t('common.unavailable')} /></>;
    }
    return <ProjectPageBackProvider value={registerPageBack}>
        <Stack.Screen options={screenOptions} />
        <ProjectDetailScreen
            workspaceRefId={workspaceRefId}
            serverId={serverId}
            workspaceResolution={workspaceResolution}
            layoutId={readProjectRouteStringParam(params.layoutId) ?? undefined}
            attachedDashboard={readProjectAttachedDashboardSelection(params)}
            recoveryToastKey={didRecoverMissingWorktree ? `${workspaceRefId}:${requestedRootPath}` : null}
            page={page}
            selection={pageSelection}
            surface={surface}
            activeRootPath={activeRootPath}
            activeWorktreeId={activeWorktreeId}
            isFocused={isFocused}
            showWorktrees={showWorktrees}
            onSelectRootPath={selectRootPath}
            onSetShowWorktrees={setShowWorktrees}
        />
    </ProjectPageBackProvider>;
});
