import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { RightSidebarIconTabBar } from '@/components/appShell/rightSidebar/RightSidebarIconTabBar';
import {
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
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { getPreferredLanguage, t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { ProjectRightPanelBrowserView } from './browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from './services/ProjectRightPanelServicesView';
import { ProjectBrowseFilesSurface } from './surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from './surfaces/ProjectGitSurface';
import { useProjectSurfaceActions } from './useProjectSurfaceActions';
import { useProjectSurfaceController } from './useProjectSurfaceController';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { Icon } from '@/components/ui/icons/Icon';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

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
    closeButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

export const ProjectRightPanel = React.memo((props: ProjectRightPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const headerPaddingTop = 10;
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
    const rightPanelTabs = React.useMemo(() => resolveProjectRightSidebarTabs({
        presentation: deviceType === 'phone' ? 'mobile' : 'desktop',
        pluginPlacements: pluginRightSidebarPlacements,
        projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
        runtimeAdmission,
        localize: localizePluginText,
    }), [
        deviceType,
        localizePluginText,
        pluginProjection.pluginUiProjection?.generation,
        pluginRightSidebarPlacements,
        runtimeAdmission,
    ]);
    const availableTabIds = React.useMemo(() => new Set(rightPanelTabs.map((tab) => tab.id)), [rightPanelTabs]);
    const controller = useProjectSurfaceController({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
    });
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
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [paneLaunchStore] = React.useState(createPluginSurfacePaneLaunchStore);
    const scopedLaunchFacts = React.useMemo(() => Object.freeze({
        serverId: pluginProjection.serverId ?? null,
        machineId: pluginProjection.machineId ?? null,
        generation: pluginProjection.pluginUiProjection?.generation ?? null,
        interactionEnabled: pluginProjection.phase === 'current'
            && pluginProjection.interactionEnabled === true,
    }), [
        pluginProjection.interactionEnabled,
        pluginProjection.phase,
        pluginProjection.machineId,
        pluginProjection.pluginUiProjection?.generation,
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
            ? Object.values(pluginProjection.pluginUiProjection.surfacePlacementsById)
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

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: 'workspaceDetails',
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
    });

    return (
        <View testID="project-right-panel-root" style={styles.container}>
            <View style={[styles.header, { paddingTop: headerPaddingTop + insets.top }]}>
                <View style={styles.tabBarContainer}>
                    <RightSidebarIconTabBar
                        tabs={rightPanelTabs}
                        activeTabId={activeTab ?? ''}
                        onSelectTab={selectTab}
                        testIDPrefix="project-rightpanel-tab"
                    />
                </View>
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <Pressable
                        testID="project-rightpanel-close"
                        onPress={props.onRequestClose}
                        style={styles.closeButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Icon name="x" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </View>
            <View style={styles.body}>
                {rightTabSelection.kind === 'unresolved' ? (
                    <PaneLoadingFallback color={theme.colors.text.secondary} />
                ) : rightTabSelection.kind === 'unavailable' ? (
                    <PluginReactNativeUnavailable diagnostics={[rightTabSelection.reason]} />
                ) : (
                    <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    <RetainedPanelSurface isActive={activeTab === 'git'} testID="project-rightpanel-surface-git">
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <ProjectGitSurface
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
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <ProjectBrowseFilesSurface
                                scope={workspaceScope}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                            />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    {availableTabIds.has('browser') ? (
                        <RetainedPanelSurface isActive={activeTab === 'browser'} testID="project-rightpanel-surface-browser">
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <ProjectRightPanelBrowserView
                                    workspaceRefId={props.workspaceRef.id}
                                    pluginProjection={pluginProjection}
                                />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    ) : null}
                    {availableTabIds.has('services') ? (
                        <RetainedPanelSurface isActive={activeTab === 'services'} testID="project-rightpanel-surface-services">
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <ProjectRightPanelServicesView
                                    machineId={props.workspaceRef.machineId}
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
                                <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                    <PluginSurfacePlacementHost
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
                                    />
                                </React.Suspense>
                            </RetainedPanelSurface>
                        ))}
                    </View>
                )}
            </View>
        </View>
    );
});
