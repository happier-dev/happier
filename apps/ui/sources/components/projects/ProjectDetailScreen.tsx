import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { PopoverScope } from '@/components/ui/popover';
import { PageBottomBarSeatProvider } from '@/components/ui/layout/useFloatingChromeClearance';

import { t } from '@/text';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { persistProjectSelectionUiState, useProjectSelectionUiState } from '@/sync/domains/state/projectSelectionUiState';
import { useDeviceType } from '@/utils/platform/responsive';
import { SurfaceStateSizeProvider, useSurfaceStateCardSize } from '@/components/ui/surfaces/surfaceStateSize';
import { ProjectPagePaneScopeHost } from './detail/PluginProjectPageBody';
import { projectPageActionsKey } from './shell/ProjectShellHeader';
import { ProjectPageCatalogProvider } from './navigation/useProjectPageCatalog';
import { ProjectPhonePageStrip } from '@/components/navigation/mobile/chrome/bars/ProjectCockpitTabBar';
import { usePublishDetailPageMenuActions } from '@/components/navigation/mobile/chrome/pageMenuActions';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ProjectPageSelection } from '@/components/workspaceCockpit/project/projectCockpitState';
import { DetailsPaneSlotHost } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { DetailsPaneContentView } from '@/components/appShell/panes/details/DetailsPaneHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import type { RepoWorktreeSelectionResolution } from '@/components/workspaces/scm/worktrees/resolveRepoWorktreeSelection';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PROJECT_ROUTE_ROOT_SENTINEL, type ProjectPageV1, type ProjectMobileSurface, type ProjectAttachedDashboardSelection } from './detail/projectRouteState';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { WorkspaceDetailsPanel } from '@/components/projects/panes/WorkspaceDetailsPanel';
import { useWorkspaceRefById } from './detail/useWorkspaceRefById';
import { ProjectRightPanel, ProjectRightSidebarProvider, ProjectRightSidebarRail } from './detail/ProjectRightPanel';
import { ProjectWorktreeRecoveryToast } from './detail/ProjectWorktreeRecoveryToast';
import { ProjectOpenResolutionPage } from './ProjectOpenResolution';
import { ProjectShellHeaderHost } from './shell/ProjectShellHeaderHost';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import { createProjectInfoDetailsTab } from './detail/projectDetailsTabBuilders';
import { ListPresentationProvider, PageColumnProvider } from '@/components/ui/lists/listPresentation';
import { useProjectRouteActions } from './detail/useProjectRouteActions';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { RIGHT_SIDEBAR_BUILTIN_TABS } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { ProjectTerminalSurface } from './detail/surfaces/ProjectTerminalSurface';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefUnconfirmed } from './detail/useWorkspaceRefById';
import { ProjectAtmosphereFrame } from '@/components/atmosphere/ProjectAtmosphereFrame';
import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveSessionTerminalDockLocation } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { toggleEmbeddedTerminalInDockLocation } from '@/components/sessions/terminal/embeddedTerminalDocking';

const PROJECT_BUILTIN_DESTINATION_IDS = RIGHT_SIDEBAR_BUILTIN_TABS
    .filter((tab) => tab.scopes.includes('project'))
    .map((tab) => tab.id);

export const ProjectDetailScreen = React.memo((props: Readonly<{
    workspaceRefId: string;
    paneScopeId?: string;
    selectedPaneTabKey?: string;
    serverId?: string | null;
    /** Qualified candidate/recovery state from the route owner; U2 owns its presentation. */
    workspaceResolution?: WorkspaceRefResolutionV1 | WorkspaceRefUnconfirmed;
    layoutId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    recoveryToastKey?: string | null;
    page?: ProjectPageV1;
    selection?: ProjectPageSelection;
    surface?: ProjectMobileSurface;
    activeWorktreeId?: string | null;
    activeRootPath?: string | null;
    resolvedRouteCheckout?: Pick<RepoWorktreeSelectionResolution, 'resolvedRootPath' | 'resolvedWorktreeId'>;
    isFocused?: boolean;
    showWorktrees?: boolean;
    onSelectRootPath?: (path: string) => void | boolean | Promise<boolean>;
    onSetShowWorktrees?: (nextValue: boolean) => void;
    onPluginSurfaceOpenChange?: (handler: PluginSurfaceOpenHandler | undefined) => void;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const enclosingStateSize = useSurfaceStateCardSize();
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId, props.serverId);
    const destinationScopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspaceRefId, workspaceRef?.serverId ?? props.serverId));
    const scopeId = props.paneScopeId ?? destinationScopeId;
    const pane = useAppPaneScope(scopeId, scope => ({
        bottomTerminalActive: scope?.bottom.isOpen === true && scope.bottom.activeTabId === 'terminal',
        rightTerminalActive: scope?.right.isOpen === true && scope.right.activeTabId === 'terminal',
    }));
    const dockLocation = resolveSessionTerminalDockLocation(deviceType);
    const { bottomTerminalActive, rightTerminalActive } = pane.scopeState;
    const openProjectTerminal = React.useCallback(() => {
        toggleEmbeddedTerminalInDockLocation({ pane, dockLocation, bottomTerminalActive, rightTerminalActive,
            rightPaneHiddenByDetails: false });
    }, [bottomTerminalActive, dockLocation, pane, rightTerminalActive]);
    // Where this Project is available (Machines with a checkout, Add machine) opens beside the page, as its details.
    const openProjectInfo = React.useCallback(() => {
        pane.openDetailsTab(createProjectInfoDetailsTab(), { intent: 'pinned' });
    }, [pane]);
    const projectMenuActions = React.useMemo(() => [
        { id: 'availableOn', title: t('workspaceSync.availableOn'), testID: 'project-shell-header.availableOn', onSelect: openProjectInfo },
        { id: 'terminal', title: t('settings.terminal'), onSelect: openProjectTerminal },
    ], [openProjectInfo, openProjectTerminal]);
    // A phone draws no Project header: the same list goes to the phone bar's More while this page is the one shown.
    const projectPageFocused = useIsFocused();
    useCurrentUiContextLocalCommands(React.useMemo(() => projectPageFocused && props.isFocused !== false ? [{
        key: 'project-available-on', title: t('workspaceSync.availableOn'), invoke: openProjectInfo,
    }] : [], [openProjectInfo, projectPageFocused, props.isFocused]), { contextKey: scopeId });
    usePublishDetailPageMenuActions('project', deviceType === 'phone' && projectPageFocused ? projectMenuActions : null);
    // The page's menus and Add surfaces float inside its own column (header and body), never over the sidebar.
    const pageColumnRef = React.useRef<View>(null);
    const workspaceRefs = useWorkspaceRefs();
    const preferenceKeys = React.useMemo(() => workspaceRef
        ? resolveProjectSelectionPreferenceKeys(workspaceRefs, workspaceRef) : null, [workspaceRef, workspaceRefs]);
    // This Project adapter is the one public target/currentness source
    // consumed by AppPane. Keep the projection lookup here rather than giving
    // AppPane a fallback lookup keyed by an opaque scope id.
    const pluginProjection = useScopedPluginUiProjection({
        machineId: workspaceRef?.machineId ?? null,
        serverId: workspaceRef?.serverId ?? null,
    });
    const [localSelection, setLocalSelection] = React.useState<Readonly<{ storageKey: string; rootPath: string }> | null>(null);
    const localActiveRootPath = localSelection?.storageKey === preferenceKeys?.storageKey ? localSelection?.rootPath ?? null : null;
    const controlledActiveRootPath = props.activeRootPath ?? null;
    const workspaceRootPath = workspaceRef?.rootPath ?? '';
    const routeOwnsCheckout = props.resolvedRouteCheckout !== undefined;
    const { activeRootPath: persistedActiveRootPath, worktreeId: persistedWorktreeId } = useProjectSelectionUiState(routeOwnsCheckout ? null : preferenceKeys);
    React.useEffect(() => {
        if (!workspaceRef || !preferenceKeys) return;
        if (routeOwnsCheckout || controlledActiveRootPath != null) return;
        setLocalSelection((currentSelection) => {
            const currentPath = currentSelection?.storageKey === preferenceKeys.storageKey ? currentSelection.rootPath : null;
            if (currentPath == null) {
                return { storageKey: preferenceKeys.storageKey, rootPath: persistedActiveRootPath ?? workspaceRef.rootPath };
            }
            if (
                persistedActiveRootPath
                && currentPath === workspaceRef.rootPath
                && persistedActiveRootPath !== workspaceRef.rootPath
            ) {
                return { storageKey: preferenceKeys.storageKey, rootPath: persistedActiveRootPath };
            }
            return currentSelection;
        });
    }, [controlledActiveRootPath, persistedActiveRootPath, preferenceKeys, routeOwnsCheckout, workspaceRef]);

    const requestedActiveRootPath = controlledActiveRootPath ?? localActiveRootPath ?? persistedActiveRootPath ?? workspaceRootPath;
    const worktreeScope = React.useMemo(() => workspaceRef ? workspaceScopeFromProject(workspaceRef, workspaceRootPath) : null, [workspaceRef, workspaceRootPath]);
    const standaloneCheckout = useResolvedRepoWorktreeSelection({
        scope: routeOwnsCheckout ? null : worktreeScope,
        defaultRootPath: workspaceRootPath,
        requestedRootPath: requestedActiveRootPath,
        refreshOnMount: props.selection?.kind !== 'plugin',
        requestedWorktreeId: props.activeWorktreeId ?? (workspaceRef != null
            && controlledActiveRootPath == null
            && localActiveRootPath == null
            && persistedWorktreeId !== PROJECT_ROUTE_ROOT_SENTINEL
                ? persistedWorktreeId
                : null),
    });
    const { resolvedRootPath: resolvedActiveRootPath, resolvedWorktreeId: resolvedActiveWorktreeId } =
        props.resolvedRouteCheckout ?? standaloneCheckout;
    const { requestedRootPath, didRecoverMissingWorktree, availableWorktrees } = standaloneCheckout;
    const recoveryToastKey = props.recoveryToastKey ?? (!routeOwnsCheckout && didRecoverMissingWorktree
        ? `${workspaceRef?.id ?? props.workspaceRefId}:${requestedRootPath}`
        : null);
    const { navigateToSegment } = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        pane,
    });
    const handleSelectPage = React.useCallback((page: ProjectPageV1) => {
        navigateToSegment({ segment: page });
    }, [navigateToSegment]);
    const handleSelectWorkspace = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        navigateToSegment({ workspaceRef });
    }, [navigateToSegment]);
    const handleSelectRootPath = React.useCallback(async (path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath || !workspaceRef || !preferenceKeys) return;
        if (routeOwnsCheckout) {
            await props.onSelectRootPath?.(trimmedPath);
            return;
        }
        const nextWorktreeId = trimmedPath === workspaceRef.rootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        const accepted = props.onSelectRootPath
            ? await props.onSelectRootPath(trimmedPath)
            : await navigateToSegment({ activeRootPath: trimmedPath, activeWorktreeId: nextWorktreeId, method: 'replace' });
        if (accepted === false) return;
        if (controlledActiveRootPath == null) {
            setLocalSelection({ storageKey: preferenceKeys.storageKey, rootPath: trimmedPath });
        }
        persistProjectSelectionUiState(preferenceKeys, trimmedPath, nextWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL);
    }, [
        availableWorktrees,
        controlledActiveRootPath,
        props.onSelectRootPath,
        props.workspaceRefId,
        navigateToSegment,
        preferenceKeys,
        routeOwnsCheckout,
        workspaceRef,
    ]);

    React.useEffect(() => {
        if (routeOwnsCheckout || props.isFocused === false) return;
        if (!workspaceRef || !preferenceKeys) return;
        if (requestedRootPath === resolvedActiveRootPath) return;

        persistProjectSelectionUiState(preferenceKeys, resolvedActiveRootPath, resolvedActiveWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL);

        if (controlledActiveRootPath == null) {
            setLocalSelection({ storageKey: preferenceKeys.storageKey, rootPath: resolvedActiveRootPath });
        }

        if (controlledActiveRootPath != null) {
            props.onSelectRootPath?.(resolvedActiveRootPath);
        }
    }, [
        controlledActiveRootPath,
        props.isFocused,
        props.onSelectRootPath,
        props.workspaceRefId,
        preferenceKeys,
        requestedRootPath,
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        routeOwnsCheckout,
        workspaceRef,
    ]);

    const projectSurfaceScope = React.useMemo(() => (
        workspaceRef
            ? {
                targetKind: 'project' as const,
                projectId: workspaceRef.id,
                machineId: workspaceRef.machineId,
                serverId: workspaceRef.serverId,
                pluginUiProjection: pluginProjection.pluginUiProjection,
                accountLifetime: pluginProjection.accountLifetime,
                projectionPhase: pluginProjection.phase,
                interactionEnabled: pluginProjection.interactionEnabled,
                platform: pluginProjection.platform,
            }
            : null
    ), [
        pluginProjection.interactionEnabled,
        pluginProjection.phase,
        pluginProjection.platform,
        pluginProjection.pluginUiProjection,
        pluginProjection.accountLifetime,
        workspaceRef,
    ]);
    const renderProjectRightSidebar = React.useCallback(() => (
        workspaceRef
            ? <ProjectRightPanel
                activePage={props.page ?? 'overview'}
                scopeId={scopeId}
                workspaceRef={workspaceRef}
                activeRootPath={resolvedActiveRootPath}
                activeWorktreeId={resolvedActiveWorktreeId}
                onSelectRootPath={handleSelectRootPath}
            />
            : null
    ), [handleSelectRootPath, props.page, resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);
    const projectRightPaneBuiltinAdapter = React.useMemo(() => ({
        // Every built-in tab this pane can draw; availability (e.g. Problems while a File page offers them) is the panel's.
        destinationIds: PROJECT_BUILTIN_DESTINATION_IDS,
        defaultDestinationId: 'files',
        render: renderProjectRightSidebar,
    }), [renderProjectRightSidebar]);
    const projectRightSidebarAdapter = React.useMemo(() => ({
        render: renderProjectRightSidebar,
        renderActionRail: () => <ProjectRightSidebarRail />,
    }), [renderProjectRightSidebar]);
    const projectDetailsPaneAdapter = React.useMemo(() => ({
        destinationIds: ['details'],
        defaultDestinationId: 'details',
        render: () => workspaceRef ? <WorkspaceDetailsPanel
            workspaceRef={workspaceRef}
            scopeId={scopeId}
            activeRootPath={resolvedActiveRootPath}
            activeWorktreeId={resolvedActiveWorktreeId}
        /> : null,
    }), [resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);
    const terminalCheckout = React.useMemo(() => workspaceRef
        ? resolveProjectCheckoutWorkspaceRef(workspaceRefs, workspaceRef, resolvedActiveRootPath) : null,
    [resolvedActiveRootPath, workspaceRef, workspaceRefs]);
    const terminalWorkspace = React.useMemo(() => terminalCheckout ? workspaceAddressFromRefV2(terminalCheckout) : null, [terminalCheckout]);
    const projectBottomPaneAdapter = React.useMemo(() => ({
        destinationIds: ['terminal'],
        defaultDestinationId: 'terminal',
        render: () => workspaceRef ? <ProjectTerminalSurface scopeId={scopeId} workspaceRefId={workspaceRef.id}
            serverId={workspaceRef.serverId} machineId={terminalWorkspace ? resolveWorkspaceSyncExecutionMachineIdV1(terminalWorkspace) : ''} rootPath={resolvedActiveRootPath}
            workspace={terminalWorkspace} presentation="bottom" /> : null,
    }), [resolvedActiveRootPath, scopeId, terminalWorkspace, workspaceRef]);
    const wrapProjectScopeContent = React.useCallback((content: React.ReactNode) => (
        workspaceRef ? (
            <ProjectRightSidebarProvider
                activePage={props.page ?? 'overview'}
                scopeId={scopeId}
                workspaceRef={workspaceRef}
                activeRootPath={resolvedActiveRootPath}
                activeWorktreeId={resolvedActiveWorktreeId}
                onSelectRootPath={handleSelectRootPath}
            >
                {content}
            </ProjectRightSidebarProvider>
        ) : content
    ), [handleSelectRootPath, props.page, resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);

    const selectedPage = React.useMemo<ProjectPageSelection>(() => props.selection
        ?? { kind: 'builtin', page: props.page ?? 'overview' }, [props.selection, props.page]);

    if (!workspaceRef) {
        return <ProjectOpenResolutionPage resolution={props.workspaceResolution} />;
    }

    const mainSurface = deviceType === 'phone' ? props.surface ?? props.page ?? 'overview' : props.page ?? 'overview';
    const widePage = props.selection?.kind === 'plugin' || mainSurface === 'overview' || mainSurface === 'code';

    return (
        <ProjectPageCatalogProvider scopeId={scopeId} surface={mainSurface} workspaceRef={workspaceRef} activeRootPath={resolvedActiveRootPath}
            activeWorktreeId={resolvedActiveWorktreeId} selection={selectedPage}>
        <ProjectAtmosphereFrame project={{ serverId: workspaceRef.serverId, projectKey: workspaceRef.projectKey ?? workspaceRef.id }} focused={props.isFocused} column={pageColumnRef}>
        <View style={{ flex: 1 }} {...pane.overlayFocusReturnCaptureProps}>
            {/* The File page's kept key row and a selection's Ask bar stack through this seat, as in the Session cockpit. */}
            <PageBottomBarSeatProvider>
            <DetailsPaneSlotHost key={scopeId} renderHost={({ main, details, onCloseDetails }) => (
            <ProjectPagePaneScopeHost
                scopeId={scopeId}
                selectedPaneTabKey={props.selectedPaneTabKey}
                arrangement="honour"
                mainColumn={{
                    hideLabel: t('panes.mainColumn.hideProject'),
                    showLabel: t('panes.mainColumn.showProject'),
                    identity: {
                        mark: <Icon name="folder" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                        name: resolveWorkspaceRefDisplayName(workspaceRef),
                    },
                }}
                onPluginSurfaceOpenChange={props.onPluginSurfaceOpenChange}
                detailsPaneEnabled
                detailsPaneBuiltinAdapter={projectDetailsPaneAdapter}
                destinationDetails={details ? {
                    pane: <DetailsPaneContentView details={details} onClose={onCloseDetails} />,
                    onClose: onCloseDetails,
                    ...(details.companion ? { companion: true as const } : {}),
                } : undefined}
                surfaceScope={projectSurfaceScope!}
                rightPaneBuiltinAdapter={projectRightPaneBuiltinAdapter}
                bottomPaneBuiltinAdapter={projectBottomPaneAdapter}
                rightSidebarAdapter={projectRightSidebarAdapter}
                wrapScopeContent={wrapProjectScopeContent}
                main={main}
            />
            )}>
                    <ListPresentationProvider value="page">
                        <PageColumnProvider value={widePage ? 'wide' : 'reading'}>
                            <View ref={pageColumnRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                                <PopoverScope boundaryRef={pageColumnRef}>
                                {/* The six-page header (12s1) always spans the wide page column so it never shifts between
                                    pages; each body keeps its own column above. Phones keep the navigation bar and the page cockpit. */}
                                {deviceType !== 'phone' ? (
                                    <PageColumnProvider value="wide">
                                    <ProjectShellHeaderHost
                                        workspaceRef={workspaceRef}
                                        page={props.page ?? 'overview'}
                                        selection={selectedPage}
                                        activeRootPath={resolvedActiveRootPath}
                                        activeWorktreeId={resolvedActiveWorktreeId}
                                        onSelectRootPath={handleSelectRootPath}
                                        onSelectPage={handleSelectPage}
                                        onSelectWorkspace={handleSelectWorkspace}
                                        pageActionsKey={projectPageActionsKey(scopeId)}
                                        menuActions={projectMenuActions}
                                    />
                                    </PageColumnProvider>
                                ) : props.surface === undefined || props.surface === props.page ? (
                                    <ProjectPhoneTitle name={resolveWorkspaceRefDisplayName(workspaceRef)}
                                        repository={workspaceRef.repositoryIdentity?.repository ?? null} />
                                ) : null}
                                {/* Cockpit phones with page tabs at the top: the pinned pages, on every surface. */}
                                {deviceType === 'phone' ? <ProjectPhonePageStrip workspaceRefId={workspaceRef.id} /> : null}
                                {/* A phone's page cockpit is a phone host: its pages (the File page's key row and toolbar,
                                    state cards) take the phone composition, as the Session cockpit does. */}
                                <SurfaceStateSizeProvider size={deviceType === 'phone' ? 'phone' : enclosingStateSize}>
                                <ProjectCockpitShell
                                    scopeId={scopeId}
                                    workspaceRef={workspaceRef}
                                    activeRootPath={resolvedActiveRootPath}
                                    activeWorktreeId={resolvedActiveWorktreeId}
                                    surface={mainSurface}
                                    selection={selectedPage}
                                    layoutId={props.layoutId}
                                    attachedDashboard={props.attachedDashboard}
                                    isFocused={props.isFocused !== false}
                                    onSelectRootPath={handleSelectRootPath}
                                />
                                </SurfaceStateSizeProvider>
                                </PopoverScope>
                            </View>
                        </PageColumnProvider>
                    </ListPresentationProvider>
            </DetailsPaneSlotHost>
            </PageBottomBarSeatProvider>
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
        </ProjectAtmosphereFrame>
        </ProjectPageCatalogProvider>
    );
});

/**
 * A phone Project page's name (owner P1 11-15): the bar above holds Back, the Machine chip and ⋯
 * (`ProjectPhoneHead`), so the name is the page's large title on the page edge, its repository under it.
 */
function ProjectPhoneTitle(props: Readonly<{ name: string; repository: string | null }>) {
    const boundary = useAtmosphereBandBoundary();
    return <View ref={boundary?.ref} onLayout={boundary?.onLayout}>
        <NavigationLargeTitleProvider largeTitle>
            <PageHeader testID="project-phone-title" title={props.name}
                {...(props.repository ? { description: props.repository } : {})} />
        </NavigationLargeTitleProvider>
    </View>;
}
