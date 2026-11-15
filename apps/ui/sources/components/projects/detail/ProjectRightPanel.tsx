import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { useOptionalProjectPageCatalog } from '@/components/projects/navigation/useProjectPageCatalog';
import { ProjectGitActionRailBadge, ProjectGitActionRailTooltip } from './ProjectGitActionRailBadge';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
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
import { SidePaneBodyProvider } from '@/components/ui/lists/listPresentation';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { getPreferredLanguage, t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { ProjectRightPanelBrowserView } from './browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from './services/ProjectRightPanelServicesView';
import { ProjectScriptsBody } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { ProjectWidgetsPane } from './ProjectOverviewWidgets';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ProjectFilesPaneSurface } from './surfaces/ProjectBrowseFilesSurface';
import { PaneHeaderSlotProvider, PaneHeaderSlotScope } from '@/components/appShell/panes/paneHeaderSlot';
import { ProjectGitSurface } from './surfaces/ProjectGitSurface';
import { ProjectTerminalSurface } from './surfaces/ProjectTerminalSurface';
import { useProjectSurfaceActions } from './useProjectSurfaceActions';
import { useProjectSurfaceController } from './useProjectSurfaceController';
import {
    selectPluginDestinationSurfacePlacements,
    selectPluginRightSidebarTabPlacements,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { ProjectPageV1 } from './projectRouteState';
import { useActiveServerAccountScope, useProjectAccountRows } from '@/sync/domains/state/storage';
import { resolveProjectTerminalScope } from './projectTerminalScope';
import { CheckoutReachabilityLine, CheckoutReachabilityScope } from '@/components/workspaces/reachability/checkoutReachability';
import { CodeIntelligencePaneTab } from '@/components/workspaces/files/intelligence/CodeIntelligencePaneTab';
import { useCodeIntelligencePaneProducer } from '@/components/workspaces/files/intelligence/codeIntelligencePaneStore';
import { useRightSidebarContentFacts } from '@/components/appShell/rightSidebar/useRightSidebarContentFacts';
import { useLocalServiceInventoryHasRunningServices } from '@/sync/domains/local/services/inventory/useLocalServiceInventoryRunningCount';
import { useProjectContext } from '@/components/projects/useProjectContext';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { resolveSessionTerminalDockLocation } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { openEmbeddedToolInDockLocation, toggleEmbeddedTerminalInDockLocation } from '@/components/sessions/terminal/embeddedTerminalDocking';

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
        minHeight: 0,
        minWidth: 0,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
    },
    header: {
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
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
    const catalog = useOptionalProjectPageCatalog();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId, scope => ({
        isOpen: scope?.right?.isOpen,
        activeTabId: scope?.right?.activeTabId,
        selectedDestination: scope?.right?.selectedDestination,
        bottomTerminalActive: scope?.bottom.isOpen === true && scope.bottom.activeTabId === 'terminal',
        rightTerminalActive: scope?.right.isOpen === true && scope.right.activeTabId === 'terminal',
    }));
    const scopeState = pane.scopeState;
    const dockLocation = resolveSessionTerminalDockLocation(deviceType);
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const { bottomTerminalActive, rightTerminalActive } = scopeState;
    const terminal = React.useMemo(() => ({
        available: true,
        dockLocation,
        active: dockLocation === 'bottom' ? bottomTerminalActive : rightTerminalActive && !rightPaneHiddenByDetails,
        onPress: () => {
            toggleEmbeddedTerminalInDockLocation({ pane, dockLocation, bottomTerminalActive, rightTerminalActive,
                rightPaneHiddenByDetails: rightPaneHiddenByDetails === true });
        },
    }), [bottomTerminalActive, dockLocation, pane, rightPaneHiddenByDetails, rightTerminalActive]);
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
    const activeCheckout = useProjectAccountWorkspaceRef(controller.checkoutWorkspace?.workspaceId ?? null, props.workspaceRef.serverId);
    const projectContext = useProjectContext({ serverId: props.workspaceRef.serverId, projectRef: props.workspaceRef, activeCheckout });
    const viewerScope = useActiveServerAccountScope(props.workspaceRef.serverId);
    const projectRowsStatus = useProjectAccountRows()?.status;
    const checkoutTerminalAvailable = React.useMemo(() => controller.checkoutWorkspace !== null
        && resolveProjectTerminalScope(props.scopeId, controller.checkoutWorkspace) !== null,
    [controller.checkoutWorkspace, projectRowsStatus, props.scopeId, viewerScope]);
    const terminalTabAvailable = terminal.available && checkoutTerminalAvailable;

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
    const localizePluginText = usePluginLocalizedTextResolver({
            projection: pluginProjection.pluginUiProjection,
            locale: pluginLocale,
    });
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: pluginProjection.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, pluginProjection.platform]);
    const appTabInputs = useAppRightSidebarTabInputs(props.workspaceRef.serverId);
    const codeIntelligenceAvailable = useCodeIntelligencePaneProducer(props.scopeId) !== null;
    const rightPanelTabs = React.useMemo(() => catalog?.items.flatMap(item => item.companion ? [item.companion] : []) ?? resolveProjectRightSidebarTabs({
        ...appTabInputs,
        codeIntelligenceAvailable,
        terminalTabAvailable,
        activePage: props.activePage,
        presentation: deviceType === 'phone' ? 'mobile' : 'desktop',
        pluginPlacements: pluginRightSidebarPlacements,
        policyContext: projectContext.policyContext,
        runtimeAdmission,
        localize: localizePluginText,
    }), [
        catalog?.items,
        appTabInputs,
        codeIntelligenceAvailable,
        terminalTabAvailable,
        deviceType,
        localizePluginText,
        pluginRightSidebarPlacements,
        projectContext.policyContext,
        props.activePage,
        runtimeAdmission,
    ]);
    const launcherTabs = React.useMemo(() => rightPanelTabs.filter(tab => !tab.hiddenInLauncher), [rightPanelTabs]);
    const availableTabIds = React.useMemo(() => new Set(rightPanelTabs.map((tab) => tab.id)), [rightPanelTabs]);
    const rightTabSelection = React.useMemo(() => resolveRightSidebarTabSelection<ProjectRightTabId>({
        activeTabId: scopeState.activeTabId,
        selectedDestination: scopeState.selectedDestination,
        tabs: rightPanelTabs,
        projectionPhase: pluginProjection.phase,
    }), [
        pluginProjection.phase,
        rightPanelTabs,
        scopeState.activeTabId,
        scopeState.selectedDestination,
    ]);
    const activeTab = rightTabSelection.kind === 'available'
        ? rightTabSelection.tab.id
        : null;
    const activePluginPlacement = rightTabSelection.kind === 'available'
        && rightTabSelection.tab.owner === 'plugin'
        ? rightTabSelection.tab.placement
        : null;
    const activeInstanceKey = scopeState.selectedDestination?.kind === 'plugin'
        ? scopeState.selectedDestination.instanceKey
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
        if (tab.id === 'terminal') {
            terminal.onPress();
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
    }, [pane, paneLaunchStore, rightPanelTabs, setActiveTab, terminal]);
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
        projection: pluginProjection.pluginUiProjection,
        placements: pluginProjection.pluginUiProjection
            ? selectPluginDestinationSurfacePlacements(pluginProjection.pluginUiProjection)
            : [],
        targetKind: 'project',
        accountLifetime,
        scopedLaunchFacts,
        runtimeAdmission,
        policyContext: projectContext.policyContext,
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
        pane, catalog, scopeId: props.scopeId, projectId: projectContext.target?.checkout?.id, projectContext, workspaceScope, deviceType, pluginProjection, runtimeAdmission, rightPanelTabs, launcherTabs,
        availableTabIds, rightTabSelection, activeTab, activeInstanceKey,
        activePaneLaunch, pluginBinding, selectTab, terminal, setActiveTab, checkoutWorkspace: controller.checkoutWorkspace,
    };
}

/** Standalone pane specimens borrow the same admitted registry; mounted Projects lend their catalog owner. */
function readProjectRightSidebarColumn(model: ReturnType<typeof useProjectRightSidebarModel>): ShellColumnActionOwner {
    return model.catalog?.readColumn('side') ?? {
        present: true, visible: model.pane.scopeState.isOpen === true, available: true,
        tabs: model.rightPanelTabs.map(tab => tab.id), selectTab: model.selectTab,
        setVisible: visible => { if (visible) model.pane.openRight(); else model.pane.closeRight(); },
    };
}

const ProjectRightSidebarContext = React.createContext<ReturnType<typeof useProjectRightSidebarModel> | null>(null);

export function ProjectRightSidebarProvider(props: React.PropsWithChildren<ProjectRightPanelProps>): React.ReactElement {
    const model = useProjectRightSidebarModel(props);
    // The Project page and this pane each head their column with the checkout's reachability line; surfaces beneath inherit it.
    return <ProjectRightSidebarContext.Provider value={model}>
        <CheckoutReachabilityScope scope={model.workspaceScope}>{props.children}</CheckoutReachabilityScope>
    </ProjectRightSidebarContext.Provider>;
}

export function ProjectRightSidebarRail(): React.ReactElement | null {
    const model = React.useContext(ProjectRightSidebarContext);
    const hiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const runningServices = useLocalServiceInventoryHasRunningServices({
        serverId: model?.workspaceScope.serverId ?? '', machineId: model?.workspaceScope.machineId ?? null, enabled: false,
    });
    const contentFacts = useRightSidebarContentFacts({ scopeId: model?.scopeId ?? '', runningServices });
    const executeNavigation = useMountedScopeActionCommand(model?.pluginProjection.accountLifetime?.scope ?? null);
    if (!model) return null;
    const readSide = (): ShellColumnActionOwner => {
        const owner = readProjectRightSidebarColumn(model);
        return { ...owner, selectTab: id => {
            if (hiddenByDetails) model.pane.closeDetails();
            owner.selectTab?.(id);
        } };
    };
    return (
        <RightSidebarActionRail
            surfaceId="workspaceRail"
            testID="project-right-sidebar-action-rail"
            testIDPrefix="project-rightpanel-action"
            actions={model.launcherTabs.map((tab) => ({
                id: tab.id,
                label: getRightSidebarTabLabel(tab),
                icon: tab.icon,
                group: tab.owner === 'builtin' ? tab.railGroup : 'plugins',
                defaultPlacement: tab.defaultPlacement ?? (tab.owner === 'plugin' ? 'overflow' : undefined),
                allowedPlacements: tab.allowedPlacements,
                pluginCount: tab.owner === 'plugin' ? { tab, runtime: {
                    pluginUiProjection: model.pluginProjection.pluginUiProjection,
                    machineId: model.pluginProjection.machineId, serverId: model.pluginProjection.serverId,
                    accountLifetime: model.pluginProjection.accountLifetime,
                    interactionEnabled: model.pluginProjection.phase === 'current' && model.pluginProjection.interactionEnabled === true,
                }, projectId: model.projectId, ...(tab.placement.binding.targetKind === 'project' && model.projectContext.target
                    ? { target: model.projectContext.target } : {}),
                    mountInstanceKey: model.activeTab === tab.id ? model.activeInstanceKey : undefined,
                    launchInput: model.activeTab === tab.id && tab.placement.binding.targetKind !== 'app' ? model.activePaneLaunch?.input : undefined,
                } : undefined,
                hasContent: !hiddenByDetails && model.pane.scopeState.isOpen === true && model.activeTab === tab.id
                    ? true : tab.owner === 'builtin' ? tab.readContent?.(contentFacts) : null,
                badge: tab.id === 'git' ? <ProjectGitActionRailBadge scope={model.workspaceScope} /> : undefined,
                renderBadgeSignal: tab.id === 'git' ? (renderSignal: RailBadgeSignalRenderer) => <ProjectGitActionRailBadge scope={model.workspaceScope} renderSignal={renderSignal} /> : undefined,
                tooltipContent: tab.id === 'git' ? <ProjectGitActionRailTooltip scope={model.workspaceScope} /> : undefined,
                active: tab.id === 'terminal' ? model.terminal.active
                    : !hiddenByDetails && model.pane.scopeState.isOpen === true && model.activeTab === tab.id,
                disabled: Boolean(tab.disabledReason),
                onPress: () => {
                    if (tab.id === 'terminal') {
                        model.terminal.onPress();
                        return;
                    }
                    if (tab.id === 'browser') {
                        openEmbeddedToolInDockLocation({ pane: model.pane, tool: 'browser' });
                        return;
                    }
                    const visible = Boolean(hiddenByDetails) || model.pane.scopeState.isOpen !== true || model.activeTab !== tab.id;
                    void executeNavigation('shell.column.set', { column: 'side', visible, ...(visible ? { tab: tab.id } : {}) },
                        { kind: 'shell.column', column: 'side', read: readSide });
                },
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

const ProjectRightPanelServicesSurface = React.memo((props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    accountLifetime: ServerAccountScopeLifetime | null;
}>) => {
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: 'workspaceDetails',
        accountLifetime: props.accountLifetime,
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
    });

    return (
        <React.Suspense fallback={<PaneLoadingFallback />}>
            <ProjectRightPanelServicesView
                machineId={props.workspaceRef.machineId}
                workspaceRefId={props.workspaceRef.id}
                serverId={props.workspaceRef.serverId}
                workspaceRoot={props.activeRootPath}
                onOpenServiceInBrowser={openServiceInBrowser}
            />
        </React.Suspense>
    );
});

function ProjectRightPanelContent(props: ProjectRightPanelProps & Readonly<{
    model: ReturnType<typeof useProjectRightSidebarModel>;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const insets = useChromeSafeAreaInsets();
    const hasActionRail = usePaneActionRail();
    const executeNavigation = useMountedScopeActionCommand(props.model.pluginProjection.accountLifetime?.scope ?? null);
    const {
        workspaceScope, deviceType, pluginProjection, runtimeAdmission, rightPanelTabs, launcherTabs,
        availableTabIds, rightTabSelection, activeTab, activeInstanceKey,
        activePaneLaunch, pluginBinding, setActiveTab, checkoutWorkspace,
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
    return (
        <PaneHeaderSlotProvider>
        <View testID="project-right-panel-root" style={[styles.container, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            {!hasActionRail ? <View style={[styles.header, { paddingTop: 10 + insets.top, backgroundColor: materialColor(theme.colors.surface.inset, 'transparent') }]}>
                <View style={styles.tabBarContainer}>
                    <RightSidebarIconTabBar
                        tabs={launcherTabs}
                        activeTabId={activeTab ?? ''}
                        onSelectTab={id => { void executeNavigation('shell.column.set', { column: 'side', visible: true, tab: id },
                            { kind: 'shell.column', column: 'side', read: () => readProjectRightSidebarColumn(props.model) }); }}
                        testIDPrefix="project-rightpanel-tab"
                    />
                </View>
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <IconButton
                        testID="project-rightpanel-close"
                        onPress={props.onRequestClose}
                        accessibilityLabel={t('common.close')}
                        variant="plain"
                        size={36}
                        iconName="x"
                        iconSize={16}
                    />
                ) : null}
            </View> : null}
            <RightSidebarPaneHeader
                scopeId={props.scopeId}
                tabs={rightPanelTabs}
                activeTabId={activeTab}
                onClose={deviceType === 'phone' ? props.onRequestClose ?? props.model.pane.closeRight : undefined}
                testID="project-rightpanel-header"
            />
            {/* The page's line spans only its own column, and a phone pane covers it: the pane says it under its header too. */}
            <CheckoutReachabilityLine scope={workspaceScope} testID="project-rightpanel-reachability" />
            <View style={styles.body}>
                <SurfaceStateSizeProvider size={deviceType === 'phone' ? 'phone' : 'pane'}><SidePaneBodyProvider>
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
                            {/* What the tree publishes (its live line and +) lands on this tab's pane header. */}
                            <PaneHeaderSlotScope slotKey="files">
                                <ProjectFilesPaneSurface
                                    workspaceRef={props.workspaceRef}
                                    scopeId={props.scopeId}
                                    scope={workspaceScope}
                                    onOpenFile={openFileInDetails}
                                    onOpenFilePinned={openFileInDetailsPinned}
                                />
                            </PaneHeaderSlotScope>
                        </React.Suspense>
                    </RetainedPanelSurface>
                    {availableTabIds.has('problems') ? (
                        <RetainedPanelSurface isActive={activeTab === 'problems'} testID="project-rightpanel-surface-problems">
                            <CodeIntelligencePaneTab scopeId={props.scopeId} kind="problems" active={activeTab === 'problems'} />
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('references') ? (
                        <RetainedPanelSurface isActive={activeTab === 'references'} testID="project-rightpanel-surface-references">
                            <CodeIntelligencePaneTab scopeId={props.scopeId} kind="references" active={activeTab === 'references'} />
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('scripts') ? (
                        <RetainedPanelSurface isActive={activeTab === 'scripts'} testID="project-rightpanel-surface-scripts">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                {checkoutWorkspace ? <ProjectScriptsBody workspace={checkoutWorkspace} presentation="rail" testID="project-rightpanel-scripts" outputScopeId={props.scopeId} />
                                    : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} testID="project-rightpanel-scripts-unavailable" />}
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('widgets') ? (
                        <RetainedPanelSurface isActive={activeTab === 'widgets'} testID="project-rightpanel-surface-widgets">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <ProjectWidgetsPane workspaceRef={props.workspaceRef} activeRootPath={props.activeRootPath}
                                    testID="project-rightpanel-widgets" />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('terminal') && props.model.terminal.dockLocation === 'sidebar' ? (
                        <RetainedPanelSurface isActive={activeTab === 'terminal'} testID="project-rightpanel-surface-terminal">
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <ProjectTerminalSurface scopeId={props.scopeId} workspaceRefId={props.workspaceRef.id}
                                    serverId={props.workspaceRef.serverId} machineId={props.workspaceRef.machineId}
                                    rootPath={props.activeRootPath} workspace={checkoutWorkspace} presentation="right" />
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
                            <ProjectRightPanelServicesSurface
                                workspaceRef={props.workspaceRef}
                                scopeId={props.scopeId}
                                activeRootPath={props.activeRootPath}
                                accountLifetime={pluginProjection.accountLifetime}
                            />
                        </RetainedPanelSurface>
                    ) : null}
                    {rightPanelTabs
                        .filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin')
                        .map((tab) => tab.disabledReason ? null : (
                            <RetainedPanelSurface
                                key={tab.id}
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
                                        projectId={props.model.projectContext.target?.checkout?.id}
                                        projectContext={props.model.projectContext}
                                        policyContext={props.model.projectContext.policyContext}
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
                </SidePaneBodyProvider></SurfaceStateSizeProvider>
            </View>
        </View>
        </PaneHeaderSlotProvider>
    );
}
