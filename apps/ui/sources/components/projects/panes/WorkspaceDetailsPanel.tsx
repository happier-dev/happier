import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import {
    BrowserSurfaceOpenButton,
    createBrowserLaunchpadDetailsTab,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import { useBrowserSurfaceHostProps } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import {
    DetailsSurfaceHost,
    createDetailsSurfacePaneCallbacks,
    type DetailsSurfaceScopeV1,
} from '@/components/appShell/panes/details/surfaces';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneFocusMode } from '@/components/appShell/panes/focusMode/usePaneFocusMode';
import { useDeviceType } from '@/utils/platform/responsive';
import { useAllMachines, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import {
    type LocalServiceLauncherState,
    useLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { openProjectTerminalDetailsTab } from '@/components/projects/detail/openProjectTerminalDetailsTab';
import { PluginSurfacePlacementStack } from '@/components/plugins/surfaces';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { createWorkspaceDetailsSurfaceRenderers } from './details/surfaces/workspaceDetailsSurfaceRegistry';

export type WorkspaceDetailsPanelHeaderActionRenderParams = Readonly<{
    iconButtonStyle: Readonly<Record<string, unknown>>;
    iconColor: string;
}>;

export type WorkspaceDetailsPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath?: string;
    displayPathOverride?: string;
    forceOverviewMode?: boolean;
    showTerminalHeaderAction?: boolean;
    showFocusModeToggle?: boolean;
    sessionIdForAugmentation?: string | null;
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
    browserProductModels?: BrowserSurfaceProductModels | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    localServiceLauncherState?: LocalServiceLauncherState | null;
    pluginSurfacePlacementScope?: 'workspace' | 'project';
    platform?: LocalServicePreviewPlatform;
    nowMs?: () => number;
    renderHeaderActionsPrefix?: (params: WorkspaceDetailsPanelHeaderActionRenderParams) => React.ReactNode;
    renderEmptyStateSupplementaryContent?: () => React.ReactNode;
}>;

export const WorkspaceDetailsPanel = React.memo((props: WorkspaceDetailsPanelProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const requestClose = props.onRequestClose ?? pane.closeDetails;
    const effectiveRootPath = props.activeRootPath ?? props.workspaceRef.rootPath;
    const displayPath = props.displayPathOverride ?? props.workspaceRef.rootPath;
    const paneFocusMode = usePaneFocusMode(props.scopeId);
    const allMachines = useAllMachines();

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: effectiveRootPath,
    }), [effectiveRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey(workspaceScope), [workspaceScope]);
    const workspaceReviewCommentDrafts = useWorkspaceReviewCommentsDrafts(workspaceScope);
    const hasWorkspaceReviewCommentDrafts = workspaceReviewCommentDrafts.length > 0;

    const machineName = React.useMemo(() => {
        const machine = allMachines.find((m) => m.id === props.workspaceRef.machineId) ?? null;
        return getMachineDisplayName(machine) ?? props.workspaceRef.machineId;
    }, [allMachines, props.workspaceRef.machineId]);
    const localServicePreviewState = useLocalServicePreviewState({
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
    });
    const liveLocalServiceLauncherState = useLocalServiceLauncherState({
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
        enabled: props.localServiceLauncherState === undefined,
    });
    const localServiceLauncherState =
        props.localServiceLauncherState !== undefined
            ? props.localServiceLauncherState
            : liveLocalServiceLauncherState;
    // Route the launchpad feed through the shared browser-host bootstrap so the workspace and
    // session details panels assemble the identical feed (BRW-13). This converges the prior drift
    // where the workspace panel omitted pluginBrowserProjection + nowMs and therefore could never
    // surface hosted-plugin browser targets. Launcher/preview states are injected from the values
    // already resolved above, so the helper does not spin up duplicate live controllers.
    const browserLaunchpad = useBrowserSurfaceHostProps({
        scope: 'workspaceDetails',
        workspaceRefId: props.workspaceRef.id,
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
        platform: props.platform,
        launcherState: localServiceLauncherState,
        localServicePreviewState,
        pluginBrowserProjection: props.pluginBrowserProjection,
        nowMs: props.nowMs,
    }).feed;
    const pluginSurfacePlacementScope = props.pluginSurfacePlacementScope ?? 'workspace';
    const pluginSurfacePlacement = `${pluginSurfacePlacementScope}.details`;
    const pluginMainSurfacePlacement = `${pluginSurfacePlacementScope}.main`;
    // Resolve through the canonical preview-platform owner so the desktop host resolves to `desktop`
    // (finding #13 / Phase 5.5) instead of collapsing to `web`, and so this panel cannot drift from
    // the session-details panel's resolution.
    const pluginSurfacePlatform = resolveLocalServicePreviewPlatform(props.platform);

    const displayName = React.useMemo(() => resolveWorkspaceRefDisplayName(props.workspaceRef), [props.workspaceRef]);

    const iconButtonStyle = React.useMemo(() => ({
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    }), [theme.colors.border.default, theme.colors.surface.base]);

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        const fileName = path.split('/').pop() ?? path;
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: `file:${path}`,
                    kind: 'file',
                    title: fileName,
                    resource: { kind: 'file', path },
                },
                { intent },
            );
        });
    }, [pane]);

    const openBrowserLaunchpadTab = React.useCallback(() => {
        pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [pane]);

    const renderEmptyState = React.useCallback(() => (
        <ItemList testID="project-details-info" containerStyle={{ paddingTop: 12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={displayPath} mode="info" copy={displayPath} />
            </ItemGroup>
            {props.renderEmptyStateSupplementaryContent ? props.renderEmptyStateSupplementaryContent() : null}
            <PluginSurfacePlacementStack
                placement={pluginMainSurfacePlacement}
                pluginUiProjection={props.pluginUiProjection}
                localServicePreviewState={localServicePreviewState}
                machineId={props.workspaceRef.machineId}
                serverId={props.workspaceRef.serverId}
                platform={pluginSurfacePlatform}
                targetKind={pluginSurfacePlacementScope}
                testID={`${pluginSurfacePlacementScope}-main-plugin-surface-placements`}
            />
            <PluginSurfacePlacementStack
                placement={pluginSurfacePlacement}
                pluginUiProjection={props.pluginUiProjection}
                localServicePreviewState={localServicePreviewState}
                machineId={props.workspaceRef.machineId}
                serverId={props.workspaceRef.serverId}
                platform={pluginSurfacePlatform}
                targetKind={pluginSurfacePlacementScope}
                testID={`${pluginSurfacePlacementScope}-details-plugin-surface-placements`}
            />
            <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 6 }}>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center', maxWidth: 680 }}>
                    {t('projects.details.emptyBody')}
                </Text>
            </View>
        </ItemList>
    ), [
        displayName,
        displayPath,
        localServiceLauncherState,
        localServicePreviewState,
        machineName,
        pluginMainSurfacePlacement,
        pluginSurfacePlacement,
        pluginSurfacePlacementScope,
        pluginSurfacePlatform,
        props,
        theme.colors.text.secondary,
    ]);

    const renderWorkspaceInfo = React.useCallback(() => (
        <ItemList testID="project-details-workspace-info" containerStyle={{ paddingTop: 12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={displayPath} mode="info" copy={displayPath} />
            </ItemGroup>
        </ItemList>
    ), [displayName, displayPath, machineName]);

    const detailsSurfaceScope = React.useMemo<DetailsSurfaceScopeV1>(() => ({
        kind: 'project',
        workspaceRefId: props.workspaceRef.id,
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.workspaceRef.rootPath,
        activeRootPath: effectiveRootPath,
    }), [
        effectiveRootPath,
        props.workspaceRef.id,
        props.workspaceRef.machineId,
        props.workspaceRef.rootPath,
        props.workspaceRef.serverId,
    ]);

    const detailsSurfaceCallbacks = React.useMemo(() => createDetailsSurfacePaneCallbacks({
        openTab: pane.openDetailsTab,
        closeTab: pane.closeDetailsTab,
        pinTab: pane.pinDetailsTab,
        unpinTab: pane.unpinDetailsTab,
        replaceTab: pane.replaceDetailsTab,
    }), [
        pane.closeDetailsTab,
        pane.openDetailsTab,
        pane.pinDetailsTab,
        pane.replaceDetailsTab,
        pane.unpinDetailsTab,
    ]);

    const detailsSurfaceRenderers = React.useMemo(() => createWorkspaceDetailsSurfaceRenderers({
        scopeId: props.scopeId,
        workspaceRefId: props.workspaceRef.id,
        workspaceCacheKey,
        workspaceScope,
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.workspaceRef.rootPath,
        activeRootPath: effectiveRootPath,
        presentation: deviceType === 'phone' ? 'screen' : 'panel',
        sessionIdForAugmentation: props.sessionIdForAugmentation ?? null,
        pinDetailsTab: pane.pinDetailsTab,
        openDetailsTab: pane.openDetailsTab,
        openFileTab,
        renderWorkspaceInfo,
        launchpadRows: browserLaunchpad.rows,
        launchpadRefreshStatus: browserLaunchpad.refreshStatus,
        launchpadRefreshError: browserLaunchpad.refreshError,
        pluginUiProjection: props.pluginUiProjection,
        pluginBrowserProjection: props.pluginBrowserProjection,
        pluginBrowserActionSessionId: props.sessionIdForAugmentation ?? null,
        platform: pluginSurfacePlatform,
        productModels: props.browserProductModels ?? undefined,
    }), [
        browserLaunchpad,
        deviceType,
        effectiveRootPath,
        openFileTab,
        pane.openDetailsTab,
        pane.pinDetailsTab,
        props.browserProductModels,
        props.pluginUiProjection,
        props.pluginBrowserProjection,
        props.scopeId,
        props.sessionIdForAugmentation,
        props.workspaceRef.id,
        props.workspaceRef.machineId,
        props.workspaceRef.rootPath,
        props.workspaceRef.serverId,
        pluginSurfacePlatform,
        renderWorkspaceInfo,
        workspaceCacheKey,
        workspaceScope,
    ]);

    const renderTabContent = React.useCallback((tab: DetailsTabState) => {
        return (
            <DetailsSurfaceHost
                tab={tab}
                scope={detailsSurfaceScope}
                region="details"
                renderers={detailsSurfaceRenderers}
                callbacks={detailsSurfaceCallbacks}
            />
        );
    }, [
        detailsSurfaceCallbacks,
        detailsSurfaceRenderers,
        detailsSurfaceScope,
    ]);

    const renderHeaderActions = React.useCallback(() => {
        const openNewSessionWithReviewComments = () => {
            router.push({
                pathname: '/new',
                params: {
                    machineId: props.workspaceRef.machineId,
                    directory: effectiveRootPath,
                    spawnServerId: props.workspaceRef.serverId,
                },
            });
        };
        return (
            <>
                {props.renderHeaderActionsPrefix ? props.renderHeaderActionsPrefix({ iconButtonStyle, iconColor: theme.colors.text.secondary }) : null}
                <BrowserSurfaceOpenButton
                    onPress={openBrowserLaunchpadTab}
                    testID="workspace-details-open-browser"
                    style={iconButtonStyle}
                    disabledStyle={{ opacity: 0.45 }}
                    iconColor={theme.colors.text.secondary}
                />
                {hasWorkspaceReviewCommentDrafts ? (
                    <Pressable
                        onPress={openNewSessionWithReviewComments}
                        testID="workspace-details-open-review-comments-session"
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('newSession.title')}
                    >
                        <Ionicons name="chatbox-ellipses-outline" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
                {props.showTerminalHeaderAction !== false && deviceType !== 'phone' ? (
                    <Pressable
                        onPress={() => {
                            openProjectTerminalDetailsTab({
                                openDetailsTab: pane.openDetailsTab,
                                cwd: effectiveRootPath,
                            });
                        }}
                        testID="workspace-details-open-terminal"
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.terminal')}
                    >
                        <Ionicons name="terminal-outline" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
                {props.showFocusModeToggle !== false && Platform.OS === 'web' ? (
                    <Pressable
                        onPress={paneFocusMode.toggle}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        disabled={!paneFocusMode.canEnter}
                        accessibilityLabel={
                            paneFocusMode.active
                                ? t('session.detailsPanel.exitFocusModeA11y')
                                : t('session.detailsPanel.enterFocusModeA11y')
                        }
                    >
                        <Ionicons
                            name={paneFocusMode.active ? 'contract-outline' : 'expand-outline'}
                            size={18}
                            color={theme.colors.text.secondary}
                        />
                    </Pressable>
                ) : null}
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <Pressable
                        onPress={requestClose}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Octicons name="chevron-right" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </>
        );
    }, [
        iconButtonStyle,
        hasWorkspaceReviewCommentDrafts,
        openBrowserLaunchpadTab,
        pane,
        paneFocusMode.active,
        paneFocusMode.canEnter,
        paneFocusMode.toggle,
        props.onRequestClose,
        props.renderHeaderActionsPrefix,
        props.workspaceRef.machineId,
        props.workspaceRef.serverId,
        requestClose,
        router,
        theme.colors.text.secondary,
        deviceType,
        effectiveRootPath,
    ]);

    return (
        <DetailsSplitWorkspace
            pane={pane}
            paddingTop={insets.top}
            headerPaddingTop={10}
            testIds={{
                root: 'workspace-details-panel-root',
                tab: (safeTabKey) => `workspace-details-tab-${safeTabKey}`,
                tabClose: (safeTabKey) => `workspace-details-tab-close-${safeTabKey}`,
            }}
            forceEmptyState={props.forceOverviewMode}
            renderTabContent={renderTabContent}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
        />
    );
});
