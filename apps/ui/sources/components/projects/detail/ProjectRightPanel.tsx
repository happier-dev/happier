import { ProjectGitActionRailBadge, ProjectGitActionRailTooltip } from './ProjectGitActionRailBadge';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneActionRail, usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import { RightSidebarActionRail } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { toggleRightSidebarTab } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { RightSidebarIconTabBar } from '@/components/appShell/rightSidebar/RightSidebarIconTabBar';
import { RightSidebarPaneHeader } from '@/components/appShell/rightSidebar/RightSidebarPaneHeader';
import { AppRightSidebarTabSurface, useAppRightSidebarTabInputs } from '@/components/appShell/rightSidebar/appRightSidebarTabs';
import {
    getRightSidebarTabLabel,
    resolveProjectRightSidebarTabs,
    resolveRightSidebarTabSelection,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import {
    createPluginSurfacePaneLaunchStore,
    stagePluginSurfacePaneLaunch,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
    usePluginSurfacePaneLaunch,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { getPreferredLanguage, t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { ProjectRightPanelBrowserView } from './browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from './services/ProjectRightPanelServicesView';
import { ProjectScriptsBody } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ProjectBrowseFilesSurface } from './surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from './surfaces/ProjectGitSurface';
import { ProjectTerminalSurface } from './surfaces/ProjectTerminalSurface';
import { useProjectSurfaceActions } from './useProjectSurfaceActions';
import { useProjectSurfaceController } from './useProjectSurfaceController';
import {
    selectPluginDestinationSurfacePlacements,
    selectPluginRightSidebarTabPlacements,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { ProjectPageV1 } from './projectRouteState';
import { useActiveServerAccountScope, useProjectAccountRows } from '@/sync/domains/state/storage';
import { resolveProjectTerminalScope } from './projectTerminalScope';

type ProjectRightTabId = string;

const EMPTY_PLUGIN_DESTINATION: PluginUiDestinationReferenceV1 = Object.freeze({
    pluginId: '',
    localId: '',
});

export type ProjectRightPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    activePage?: ProjectPageV1;
    onSelectRootPath: (path: string) => void;
    onRequestClose?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        minHeight: 0,
        minWidth: 0,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
    },
    header: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    tabBarContainer: {
        flex: 1,
        alignItems: 'center',
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

function useProjectRightSidebarModel(props: ProjectRightPanelProps) {
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);
    const controller = useProjectSurfaceController({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
    });
    const viewerScope = useActiveServerAccountScope(props.workspaceRef.serverId);
    const projectRowsStatus = useProjectAccountRows()?.status;
    const terminalTabAvailable = React.useMemo(() => controller.checkoutWorkspace !== null
        && resolveProjectTerminalScope(props.scopeId, controller.checkoutWorkspace) !== null,
    [controller.checkoutWorkspace, projectRowsStatus, props.scopeId, viewerScope]);

    const pluginProjection = useScopedPluginUiProjection({
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
    });
    const pluginRightSidebarPlacements = React.useMemo(() => (
        pluginProjection.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginProjection.pluginUiProjection, 'project')
            : []
    ), [pluginProjection.pluginUiProjection]);
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: pluginProjection.pluginUiProjection,
            locale: pluginLocale,
        }),
        [pluginLocale, pluginProjection.pluginUiProjection],
    );
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: pluginProjection.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, pluginProjection.platform]);
    const appTabInputs = useAppRightSidebarTabInputs();
    const rightPanelTabs = React.useMemo(() => resolveProjectRightSidebarTabs({
        ...appTabInputs,
        terminalTabAvailable,
        activePage: props.activePage,
        presentation: deviceType === 'phone' ? 'mobile' : 'desktop',
        pluginPlacements: pluginRightSidebarPlacements,
        projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
        runtimeAdmission,
        localize: localizePluginText,
    }), [
        appTabInputs,
        terminalTabAvailable,
        deviceType,
        localizePluginText,
        pluginProjection.pluginUiProjection?.generation,
        pluginRightSidebarPlacements,
        props.activePage,
        runtimeAdmission,
    ]);
    const launcherTabs = React.useMemo(() => rightPanelTabs.filter(tab => !tab.hiddenInLauncher), [rightPanelTabs]);
    const availableTabIds = React.useMemo(() => new Set(rightPanelTabs.map((tab) => tab.id)), [rightPanelTabs]);
    const rightTabSelection = React.useMemo(() => resolveRightSidebarTabSelection<ProjectRightTabId>({
        activeTabId: scopeState?.right.activeTabId,
        selectedDestination: scopeState?.right.selectedDestination,
        tabs: rightPanelTabs,
        projectionPhase: pluginProjection.phase,
    }), [
        pluginProjection.phase,
        rightPanelTabs,
        scopeState?.right.activeTabId,
        scopeState?.right.selectedDestination,
    ]);
    const activeTab = rightTabSelection.kind === 'available'
        ? rightTabSelection.tab.id
        : null;
    const activePluginPlacement = rightTabSelection.kind === 'available'
        && rightTabSelection.tab.owner === 'plugin'
        ? rightTabSelection.tab.placement
        : null;
    const activeInstanceKey = scopeState?.right.selectedDestination?.kind === 'plugin'
        ? scopeState.right.selectedDestination.instanceKey
        : undefined;
    const accountLifetime = pluginProjection.accountLifetime;
    const [paneLaunchStore] = React.useState(createPluginSurfacePaneLaunchStore);
    const scopedLaunchFacts = React.useMemo(() => Object.freeze({
        serverId: pluginProjection.serverId ?? null,
        machineId: pluginProjection.machineId ?? null,
        interactionEnabled: pluginProjection.phase === 'current'
            && pluginProjection.interactionEnabled === true,
    }), [
        pluginProjection.interactionEnabled,
        pluginProjection.phase,
        pluginProjection.machineId,
        pluginProjection.serverId,
    ]);
    const activePaneLaunch = usePluginSurfacePaneLaunch({
        store: paneLaunchStore,
        placement: activePluginPlacement,
        targetKind: 'project',
        container: 'rightSidebarTab',
        accountLifetime,
        scopedLaunchFacts,
        destination: activePluginPlacement?.binding.destination ?? EMPTY_PLUGIN_DESTINATION,
        ...(activeInstanceKey === undefined ? {} : { instanceKey: activeInstanceKey }),
    });
    const setActiveTab = controller.setActiveTab;
    const selectTab = React.useCallback((tabId: string) => {
        const tab = rightPanelTabs.find((candidate) => candidate.id === tabId) ?? null;
        if (!tab || tab.disabledReason) {
            return;
        }
        if (tab.owner === 'plugin') {
            pane.selectRightDestination({
                kind: 'plugin',
                destination: tab.placement.binding.destination,
            });
            paneLaunchStore.retire();
            return;
        }
        setActiveTab(tabId);
        paneLaunchStore.retire();
    }, [pane, paneLaunchStore, rightPanelTabs, setActiveTab]);
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            paneLaunchStore.retire();
        });
        return () => retirement?.dispose();
    }, [accountLifetime, paneLaunchStore]);
    React.useEffect(() => () => { paneLaunchStore.retire(); }, [paneLaunchStore]);
    const openRightSidebarTab = React.useCallback((resolution: Parameters<typeof stagePluginSurfacePaneLaunch>[0]['resolution']) => {
        if (!stagePluginSurfacePaneLaunch({ store: paneLaunchStore, resolution })) {
            return { ok: false as const, code: 'unavailable' as const, reason: 'plugin_surface_open_origin_unavailable' };
        }
        pane.selectRightDestination({
            kind: 'plugin',
            destination: resolution.placement.binding.destination,
            ...(resolution.request.instanceKey === undefined ? {} : { instanceKey: resolution.request.instanceKey }),
        });
        return { ok: true as const };
    }, [pane, paneLaunchStore]);
    const targetNavigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const fallbackNavigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: pluginProjection.pluginUiProjection
            ? selectPluginDestinationSurfacePlacements(pluginProjection.pluginUiProjection)
            : [],
        targetKind: 'project',
        accountLifetime,
        scopedLaunchFacts,
        runtimeAdmission,
    });
    const navigationBinding = targetNavigationBinding ?? fallbackNavigationBinding;
    const sidebarOwner = React.useMemo(() => ({
        container: 'rightSidebarTab' as const,
        handler: openRightSidebarTab,
    }), [openRightSidebarTab]);
    useRegisterPluginSurfaceDestinationNavigationOwner(sidebarOwner, navigationBinding);
    const openSurface = navigationBinding.openSurface;
    const pluginBinding = React.useMemo<BoundPluginSurfaceBinding>(() => ({ openSurface }), [openSurface]);

    return {
        pane, workspaceScope, deviceType, pluginProjection, runtimeAdmission, rightPanelTabs, launcherTabs,
        availableTabIds, rightTabSelection, activeTab, activeInstanceKey,
        activePaneLaunch, pluginBinding, selectTab, setActiveTab, checkoutWorkspace: controller.checkoutWorkspace,
    };
}

const ProjectRightSidebarContext = React.createContext<ReturnType<typeof useProjectRightSidebarModel> | null>(null);

export function ProjectRightSidebarProvider(props: React.PropsWithChildren<ProjectRightPanelProps>): React.ReactElement {
    const model = useProjectRightSidebarModel(props);
    return <ProjectRightSidebarContext.Provider value={model}>{props.children}</ProjectRightSidebarContext.Provider>;
}

export function ProjectRightSidebarRail(): React.ReactElement | null {
    const model = React.useContext(ProjectRightSidebarContext);
    const hiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    if (!model) return null;
    return (
        <RightSidebarActionRail
            surfaceId="workspaceRail"
            testID="project-right-sidebar-action-rail"
            testIDPrefix="project-rightpanel-action"
            actions={model.launcherTabs.map((tab) => ({
                id: tab.id,
                label: getRightSidebarTabLabel(tab),
                icon: tab.icon,
                badge: tab.id === 'git' ? <ProjectGitActionRailBadge scope={model.workspaceScope} /> : undefined,
                tooltipContent: tab.id === 'git' ? <ProjectGitActionRailTooltip scope={model.workspaceScope} /> : undefined,
                active: !hiddenByDetails && model.pane.scopeState?.right.isOpen === true && model.activeTab === tab.id,
                disabled: Boolean(tab.disabledReason),
                onPress: () => toggleRightSidebarTab(model.pane, tab.id, model.activeTab, model.selectTab, hiddenByDetails),
            }))}
        />
    );
}

export const ProjectRightPanel = React.memo((props: ProjectRightPanelProps) => {
    const model = React.useContext(ProjectRightSidebarContext);
    return model
        ? <ProjectRightPanelContent {...props} model={model} />
        : <ProjectRightSidebarProvider {...props}><ProjectRightPanel {...props} /></ProjectRightSidebarProvider>;
});

function ProjectRightPanelContent(props: ProjectRightPanelProps & Readonly<{
    model: ReturnType<typeof useProjectRightSidebarModel>;
}>): React.ReactElement {
    const styles = stylesheet;
    const insets = useChromeSafeAreaInsets();
    const hasActionRail = usePaneActionRail();
    const {
        workspaceScope, deviceType, pluginProjection, runtimeAdmission, rightPanelTabs, launcherTabs,
        availableTabIds, rightTabSelection, activeTab, activeInstanceKey,
        activePaneLaunch, pluginBinding, selectTab, setActiveTab, checkoutWorkspace,
    } = props.model;
    const {
        openFileInDetails,
        openFileInDetailsPinned,
        openReviewAllChanges,
        openStashDetails,
        openCreateWorktreeFlow,
        openCommitInDetails,
        revealInFilesTree,
    } = useProjectSurfaceActions({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        onRevealInFilesTreeNavigate: () => setActiveTab('files'),
    });


    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: 'workspaceDetails',
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
    });

    return (
        <View testID="project-right-panel-root" style={styles.container}>
            {!hasActionRail ? <View style={[styles.header, { paddingTop: 10 + insets.top }]}>
                <View style={styles.tabBarContainer}>
                    <RightSidebarIconTabBar
                        tabs={launcherTabs}
                        activeTabId={activeTab ?? ''}
                        onSelectTab={selectTab}
                        testIDPrefix="project-rightpanel-tab"
                    />
                </View>
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <IconButton
                        testID="project-rightpanel-close"
                        onPress={props.onRequestClose}
                        accessibilityLabel={t('common.close')}
                        variant="plain"
                        size={resolveTouchTargetFloorPx() ?? 36}
                        iconName="x"
                        iconSize={16}
                    />
                ) : null}
            </View> : null}
            <RightSidebarPaneHeader
                tabs={rightPanelTabs}
                activeTabId={activeTab}
                testID="project-rightpanel-header"
            />
            <View style={styles.body}>
                <SurfaceStateSizeProvider size={deviceType === 'phone' ? 'phone' : 'pane'}>
                {rightTabSelection.kind === 'unresolved' ? (
                    <PaneLoadingFallback />
                ) : rightTabSelection.kind === 'unavailable' ? (
                    <PluginReactNativeUnavailable diagnostics={[rightTabSelection.reason]} />
                ) : (
                    <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    <RetainedPanelSurface isActive={activeTab === 'git'} testID="project-rightpanel-surface-git">
                        <React.Suspense fallback={<PaneLoadingFallback />}>
                            <ProjectGitSurface
                        scopeId={props.scopeId}
                                serverId={props.workspaceRef.serverId}
                                machineId={props.workspaceRef.machineId}
                                rootPath={props.activeRootPath}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                                onOpenReviewAllChanges={openReviewAllChanges}
                                onOpenStashDetails={openStashDetails}
                                onOpenCommit={openCommitInDetails}
                                onSelectWorkspacePath={props.onSelectRootPath}
                                onRequestCreateWorktreeFromAnotherBranch={openCreateWorktreeFlow}
                                onRevealInFilesTree={revealInFilesTree}
                            />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    <RetainedPanelSurface isActive={activeTab === 'files'} testID="project-rightpanel-surface-files">
                        <React.Suspense fallback={<PaneLoadingFallback />}>
                            <ProjectBrowseFilesSurface
                                workspaceRef={props.workspaceRef}
                                activeWorktreeId={props.activeWorktreeId}
                        scopeId={props.scopeId}
                                scope={workspaceScope}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                            />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    {availableTabIds.has('scripts') ? (
                        <RetainedPanelSurface isActive={activeTab === 'scripts'} testID="project-rightpanel-surface-scripts">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                {checkoutWorkspace ? <ProjectScriptsBody workspace={checkoutWorkspace} presentation="widget" testID="project-rightpanel-scripts" outputScopeId={props.scopeId} />
                                    : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} testID="project-rightpanel-scripts-unavailable" />}
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('terminal') ? (
                        <RetainedPanelSurface isActive={activeTab === 'terminal'} testID="project-rightpanel-surface-terminal">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <ProjectTerminalSurface scopeId={props.scopeId} workspaceRefId={props.workspaceRef.id}
                                    serverId={props.workspaceRef.serverId} machineId={props.workspaceRef.machineId}
                                    rootPath={props.activeRootPath} workspace={checkoutWorkspace} />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('browser') ? (
                        <RetainedPanelSurface isActive={activeTab === 'browser'} testID="project-rightpanel-surface-browser">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <ProjectRightPanelBrowserView
                                    workspaceRefId={props.workspaceRef.id}
                                    workspaceScope={workspaceScope}
                                    pluginProjection={pluginProjection}
                                />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('services') ? (
                        <RetainedPanelSurface isActive={activeTab === 'services'} testID="project-rightpanel-surface-services">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <ProjectRightPanelServicesView
                                    machineId={props.workspaceRef.machineId}
                                    workspaceRefId={props.workspaceRef.id}
                                    serverId={props.workspaceRef.serverId}
                                    workspaceRoot={props.activeRootPath}
                                    onOpenServiceInBrowser={openServiceInBrowser}
                                />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {rightPanelTabs
                        .filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin')
                        .map((tab) => tab.disabledReason ? null : (
                            <RetainedPanelSurface
                                key={tab.retentionKey}
                                isActive={activeTab === tab.id}
                                testID={`project-rightpanel-surface-${tab.id}`}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback />}>
                                    {tab.placement.binding.targetKind === 'app' ? (
                                        <AppRightSidebarTabSurface
                                            placement={tab.placement}
                                            binding={activeTab === tab.id ? pluginBinding : undefined}
                                            mountInstanceKey={activeTab === tab.id ? activeInstanceKey : undefined}
                                        />
                                    ) : <PluginSurfacePlacementHost
                                        placement={tab.placement}
                                        machineId={pluginProjection.machineId}
                                        serverId={pluginProjection.serverId}
                                        projectId={props.workspaceRef.id}
                                        pluginUiProjection={pluginProjection.pluginUiProjection}
                                        projectionInteractionEnabled={pluginProjection.phase === 'current'
                                            && pluginProjection.interactionEnabled === true}
                                        platform={pluginProjection.platform}
                                        formFactor={runtimeAdmission.formFactor}
                                        binding={activeTab === tab.id ? pluginBinding : undefined}
                                        launchInput={activeTab === tab.id ? activePaneLaunch?.input : undefined}
                                        mountInstanceKey={activeTab === tab.id ? activeInstanceKey : undefined}
                                    />}
                                </React.Suspense>
                            </RetainedPanelSurface>
                        ))}
                    </View>
                )}
                </SurfaceStateSizeProvider>
            </View>
        </View>
    );
}
