import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { RightSidebarIconTabBar } from '@/components/appShell/rightSidebar/RightSidebarIconTabBar';
import {
    resolveProjectRightSidebarTabs,
    resolveRightSidebarActiveTab,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { ProjectRightPanelBrowserView } from './browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from './services/ProjectRightPanelServicesView';
import { ProjectBrowseFilesSurface } from './surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from './surfaces/ProjectGitSurface';
import { useProjectSurfaceActions } from './useProjectSurfaceActions';
import { useProjectSurfaceController } from './useProjectSurfaceController';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

type ProjectRightTabId = string;

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
    const rightPanelTabs = React.useMemo(() => resolveProjectRightSidebarTabs({
        presentation: deviceType === 'phone' ? 'mobile' : 'desktop',
        pluginPlacements: pluginRightSidebarPlacements,
        projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
    }), [deviceType, pluginProjection.pluginUiProjection?.generation, pluginRightSidebarPlacements]);
    const availableTabIds = React.useMemo(() => new Set(rightPanelTabs.map((tab) => tab.id)), [rightPanelTabs]);
    const controller = useProjectSurfaceController({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
    });
    const activeTab = resolveRightSidebarActiveTab<ProjectRightTabId>(controller.activeTab, rightPanelTabs);
    const setActiveTab = controller.setActiveTab;

    React.useEffect(() => {
        if (!scopeState?.right.isOpen) return;
        if (scopeState.right.activeTabId !== activeTab) {
            pane.setRightTab(activeTab);
        }
    }, [activeTab, pane, scopeState?.right.activeTabId, scopeState?.right.isOpen]);

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

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey({
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
                        activeTabId={activeTab}
                        onSelectTab={setActiveTab}
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
                        <Octicons name="x" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </View>
            <View style={styles.body}>
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
                                workspaceCacheKey={workspaceCacheKey}
                                serverId={props.workspaceRef.serverId}
                                machineId={props.workspaceRef.machineId}
                                rootPath={props.activeRootPath}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                            />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    {availableTabIds.has('browser') ? (
                        <RetainedPanelSurface isActive={activeTab === 'browser'} testID="project-rightpanel-surface-browser">
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <ProjectRightPanelBrowserView workspaceRefId={props.workspaceRef.id} />
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
                                        pluginUiProjection={pluginProjection.pluginUiProjection}
                                        projectionInteractionEnabled={pluginProjection.interactionEnabled}
                                        platform={pluginProjection.platform}
                                    />
                                </React.Suspense>
                            </RetainedPanelSurface>
                        ))}
                </View>
            </View>
        </View>
    );
});
