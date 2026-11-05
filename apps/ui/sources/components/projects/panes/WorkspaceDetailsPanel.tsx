import { useProjectSurfaceActions } from '@/components/projects/detail/useProjectSurfaceActions';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import { PluginDetailsPaneOverlay } from '@/components/appShell/panes/details/surfaces/PluginDetailsPaneOverlay';
import {
    BrowserSurfaceOpenButton,
    createBrowserLaunchpadDetailsTab,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import { resolveBrowserSurfacePlatform } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useOpenBrowserTargetInWorkspace } from '@/components/browser/surfaces/useOpenBrowserTargetInWorkspace';
import {
    DetailsSurfaceHost,
    createDetailsSurfacePaneCallbacks,
    type DetailsSurfaceScopeV1,
} from '@/components/appShell/panes/details/surfaces';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDeviceType } from '@/utils/platform/responsive';
import { useWorkspaceRefs, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import type { LocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useWorkspaceDetailsMachineName } from './useWorkspaceDetailsMachineName';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { buildWorkspaceCacheKey, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { createWorkspaceDetailsSurfaceRenderers } from './details/surfaces/workspaceDetailsSurfaceRegistry';
import { Icon } from '@/components/ui/icons/Icon';
import { useProjectNewSessionAction } from '@/components/projects/useProjectNewSessionAction';
import { WorkspaceSyncRelationshipList } from '@/components/workspaces/sync/WorkspaceSyncRelationshipList';
import { openWorkspaceSyncAddMachine } from '@/components/workspaces/sync/openWorkspaceSyncAddMachine';
import { createWorkspaceSyncConflictDetailsTab } from '@/components/workspaces/sync/workspaceSyncConflictDetailsTab';
import { createWorkspaceSyncRelationshipDetailsTab } from '@/components/workspaces/sync/workspaceSyncRelationshipDetailsTab';
import { buildActiveDetailsRouteParams, parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { EmptyEditorPage } from '@/components/workspaces/files/EmptyEditorPage';
import { useWorkspaceFileWriteTabPresentation } from '@/components/workspaces/files/useWorkspaceFileWriteTabPresentation';

export type WorkspaceDetailsPanelHeaderActionRenderParams = Readonly<{
    iconButtonStyle: Readonly<Record<string, unknown>>;
    iconColor: string;
}>;

export type WorkspaceDetailsPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    destinationTab?: DetailsTabState | null;
    activeRootPath?: string;
    activeWorktreeId?: string | null;
    displayPathOverride?: string;
    forceOverviewMode?: boolean;
    showTerminalHeaderAction?: boolean;
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
    const workspaceRefs = useWorkspaceRefs();
    const selectedWorkspaceRef = React.useMemo(() => {
        const selectedKey = tryBuildWorkspaceCacheKey({
            serverId: props.workspaceRef.serverId,
            machineId: props.workspaceRef.machineId,
            rootPath: effectiveRootPath,
        });
        if (!selectedKey) return null;
        if (selectedKey === tryBuildWorkspaceCacheKey(props.workspaceRef)) return props.workspaceRef;
        const result = resolveWorkspaceRefByScope(Array.isArray(workspaceRefs) ? workspaceRefs : [], {
            serverId: props.workspaceRef.serverId, machineId: props.workspaceRef.machineId, rootPath: effectiveRootPath,
        });
        return result.kind === 'resolved' ? result.ref : null;
    }, [effectiveRootPath, props.workspaceRef, workspaceRefs]);
    const filesController = useProjectSurfaceController({ scopeId: props.scopeId, workspaceRef: props.workspaceRef, activeRootPath: effectiveRootPath, activeWorktreeId: props.activeWorktreeId });
    const navigateFiles = React.useCallback(() => {
        if (deviceType === 'phone') filesController.navigateToSurface('browse');
    }, [deviceType, filesController]);
    const navigateChanges = React.useCallback(() => {
        if (deviceType === 'phone') filesController.navigateToSurface('git');
    }, [deviceType, filesController]);
    const { revealInFilesTree, openChanges, openFileInDetails, openFileInDetailsPinned, openReviewAllChanges } = useProjectSurfaceActions({
        scopeId: props.scopeId, workspaceRef: props.workspaceRef, activeRootPath: effectiveRootPath,
        onRevealInFilesTreeNavigate: navigateFiles, onOpenChangesNavigate: navigateChanges,
    });
    const displayPath = props.displayPathOverride ?? props.workspaceRef.rootPath;
    const machineName = useWorkspaceDetailsMachineName(props.workspaceRef.machineId);
    // The Project Details adapter owns the exact current scope facts for its
    // generic details surfaces. An optional explicit projection remains a
    // test/embedding override, while interaction/currentness comes from the
    // canonical scoped projection owner rather than a guessed `true` bit.
    const scopedPluginProjection = useScopedPluginUiProjection({
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
    });
    const pluginUiProjection = props.pluginUiProjection !== undefined
        ? props.pluginUiProjection
        : scopedPluginProjection.pluginUiProjection;
    const pluginBrowserProjection = props.pluginBrowserProjection !== undefined
        ? props.pluginBrowserProjection
        : scopedPluginProjection.pluginBrowserProjection;
    const pluginInteractionEnabled = scopedPluginProjection.phase === 'current'
        && scopedPluginProjection.interactionEnabled === true;

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: effectiveRootPath,
    }), [effectiveRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey(workspaceScope), [workspaceScope]);
    const resolveTabPresentation = useWorkspaceFileWriteTabPresentation(workspaceScope);
    const workspaceReviewCommentDrafts = useWorkspaceReviewCommentsDrafts(workspaceScope);
    const hasWorkspaceReviewCommentDrafts = workspaceReviewCommentDrafts.length > 0;

    // Resolve through the canonical preview-platform owner so the desktop host resolves to `desktop`
    // (finding #13 / Phase 5.5) instead of collapsing to `web`, and so this panel cannot drift from
    // the session-details panel's resolution.
    const pluginSurfacePlatform = resolveLocalServicePreviewPlatform(props.platform);
    const pluginSurfaceFormFactor = React.useMemo(
        () => resolvePluginUiRuntimeFormFactor({ deviceType }),
        [deviceType],
    );

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
        if (intent === 'pinned') openFileInDetailsPinned(path);
        else openFileInDetails(path);
    }, [openFileInDetails, openFileInDetailsPinned]);

    const openBrowserLaunchpadTab = React.useCallback(() => {
        pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [pane.openDetailsTab]);
    const workspaceSyncSelectedRefId = React.useCallback((summary: Parameters<typeof createWorkspaceSyncRelationshipDetailsTab>[0]) => {
        const selectedKey = tryBuildWorkspaceCacheKey({
            serverId: props.workspaceRef.serverId,
            machineId: props.workspaceRef.machineId,
            rootPath: effectiveRootPath,
        });
        return [summary.alpha, summary.beta].find((endpoint) =>
            endpoint.workspaceRef && tryBuildWorkspaceCacheKey(endpoint.workspaceRef) === selectedKey,
        )?.workspaceRefId ?? props.workspaceRef.id;
    }, [effectiveRootPath, props.workspaceRef.id, props.workspaceRef.machineId, props.workspaceRef.serverId]);
    const openWorkspaceSyncConflicts = React.useCallback((summary: Parameters<typeof createWorkspaceSyncConflictDetailsTab>[0]) => {
        pane.openDetailsTab(createWorkspaceSyncConflictDetailsTab(summary, workspaceSyncSelectedRefId(summary)), { intent: 'pinned' });
    }, [pane.openDetailsTab, workspaceSyncSelectedRefId]);
    const openWorkspaceSyncDetails = React.useCallback((summary: Parameters<typeof createWorkspaceSyncRelationshipDetailsTab>[0]) => {
        pane.openDetailsTab(createWorkspaceSyncRelationshipDetailsTab(summary, workspaceSyncSelectedRefId(summary)), { intent: 'pinned' });
    }, [pane.openDetailsTab, workspaceSyncSelectedRefId]);
    const openWorkspaceSyncAddMachineForProject = React.useCallback(() => {
        openWorkspaceSyncAddMachine(selectedWorkspaceRef ?? {
            serverId: props.workspaceRef.serverId,
            machineId: props.workspaceRef.machineId,
            rootPath: effectiveRootPath,
        }, openWorkspaceSyncDetails);
    }, [effectiveRootPath, openWorkspaceSyncDetails, props.workspaceRef.machineId, props.workspaceRef.serverId, selectedWorkspaceRef]);

    const emptyEditorScope = React.useMemo(() => ({
        serverId: props.workspaceRef.serverId, machineId: props.workspaceRef.machineId, rootPath: effectiveRootPath,
    }), [effectiveRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);
    // The editor column with nothing open (lab EM1). The Project's own facts live on its Overview, so
    // the column invites opening a file instead of repeating them; a forced overview keeps the facts.
    const renderEmptyState = React.useCallback(() => props.forceOverviewMode ? (
        <ItemList testID="project-details-info" containerStyle={{ paddingTop: theme.space.s12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={displayPath} mode="info" copy={displayPath} />
            </ItemGroup>
            <WorkspaceSyncRelationshipList
                title={t('workspaceSync.availableOn')}
                serverId={props.workspaceRef.serverId}
                workspaceRefId={selectedWorkspaceRef?.id ?? null}
                onAddMachine={openWorkspaceSyncAddMachineForProject}
                onOpenDetails={openWorkspaceSyncDetails}
                onOpenConflicts={openWorkspaceSyncConflicts}
            />
            {props.renderEmptyStateSupplementaryContent ? props.renderEmptyStateSupplementaryContent() : null}
            <View style={{ alignItems: 'center', paddingHorizontal: theme.space.s24, paddingTop: theme.space.s6 }}>
                <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('body'),  textAlign: 'center', maxWidth: 680 }}>
                    {t('projects.details.emptyBody')}
                </Text>
            </View>
        </ItemList>
    ) : (
        <EmptyEditorPage
            scope={emptyEditorScope}
            title={t('panes.emptyEditor.projectTitle')}
            reason={t('panes.emptyEditor.projectReason')}
            changedTitle={t('panes.emptyEditor.changedInProject')}
            onOpenFile={openFileInDetailsPinned}
            onReview={openReviewAllChanges}
        />
    ), [
        emptyEditorScope,
        openFileInDetailsPinned,
        openReviewAllChanges,
        displayName,
        displayPath,
        machineName,
        openWorkspaceSyncConflicts,
        openWorkspaceSyncDetails,
        openWorkspaceSyncAddMachineForProject,
        selectedWorkspaceRef,
        pluginSurfacePlatform,
        props,
        theme.colors.text.secondary,
    ]);

    const renderWorkspaceInfo = React.useCallback(() => (
        <ItemList testID="project-details-workspace-info" containerStyle={{ paddingTop: theme.space.s12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={displayPath} mode="info" copy={displayPath} />
            </ItemGroup>
            <WorkspaceSyncRelationshipList
                title={t('workspaceSync.availableOn')}
                serverId={props.workspaceRef.serverId}
                workspaceRefId={selectedWorkspaceRef?.id ?? null}
                onAddMachine={openWorkspaceSyncAddMachineForProject}
                onOpenDetails={openWorkspaceSyncDetails}
                onOpenConflicts={openWorkspaceSyncConflicts}
            />
        </ItemList>
    ), [displayName, displayPath, machineName, openWorkspaceSyncAddMachineForProject, openWorkspaceSyncConflicts, openWorkspaceSyncDetails, selectedWorkspaceRef]);

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
        openOverlay: pane.openDetailsOverlay,
        closeTab: pane.closeDetailsTab,
        pinTab: pane.pinDetailsTab,
        unpinTab: pane.unpinDetailsTab,
        replaceTab: pane.replaceDetailsTab,
    }), [
        pane.closeDetailsTab,
        pane.openDetailsOverlay,
        pane.openDetailsTab,
        pane.pinDetailsTab,
        pane.replaceDetailsTab,
        pane.unpinDetailsTab,
    ]);

    const openBrowserViewTarget = useOpenBrowserTargetInWorkspace({
        scopeId: props.scopeId, scope: 'workspaceDetails', accountLifetime: scopedPluginProjection.accountLifetime,
        openDetailsTab: pane.openDetailsTab, platform: resolveBrowserSurfacePlatform(props.platform),
        browserProfile: props.browserProductModels?.browserProfile?.profile,
    });
    const detailsSurfaceRenderers = React.useMemo(() => createWorkspaceDetailsSurfaceRenderers({
        localServiceLauncherState: props.localServiceLauncherState,
        localServicePreviewServerId: props.workspaceRef.serverId,
        onOpenTarget: openBrowserViewTarget,
        onRevealInFilesTree: revealInFilesTree,
        onOpenChanges: openChanges,
        scopeId: props.scopeId,
        workspaceRefId: props.workspaceRef.id,
        workspaceCacheKey,
        workspaceScope,
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.workspaceRef.rootPath,
        activeRootPath: effectiveRootPath,
        presentation: deviceType === 'phone' ? 'screen' : 'panel',
        terminalWorkspace: filesController.checkoutWorkspace,
        sessionIdForAugmentation: props.sessionIdForAugmentation ?? null,
        pinDetailsTab: pane.pinDetailsTab,
        openDetailsTab: pane.openDetailsTab,
        openFileTab,
        renderWorkspaceInfo,
        pluginUiProjection,
        pluginUiProjectionPhase: scopedPluginProjection.phase,
        pluginAccountLifetime: scopedPluginProjection.accountLifetime,
        pluginUiInteractionEnabled: pluginInteractionEnabled,
        pluginBrowserProjection,
        pluginBrowserActionSessionId: props.sessionIdForAugmentation ?? null,
        platform: pluginSurfacePlatform,
        formFactor: pluginSurfaceFormFactor,
        productModels: props.browserProductModels ?? undefined,
        nowMs: props.nowMs,
    }), [
        revealInFilesTree,
        openBrowserViewTarget,
        openChanges,
        deviceType,
        filesController.checkoutWorkspace,
        effectiveRootPath,
        openFileTab,
        pane.openDetailsTab,
        pane.pinDetailsTab,
        props.browserProductModels,
        props.localServiceLauncherState,
        props.nowMs,
        pluginInteractionEnabled,
        scopedPluginProjection.phase,
        scopedPluginProjection.accountLifetime,
        pluginUiProjection,
        pluginBrowserProjection,
        props.scopeId,
        props.sessionIdForAugmentation,
        props.workspaceRef.id,
        props.workspaceRef.machineId,
        props.workspaceRef.rootPath,
        props.workspaceRef.serverId,
        pluginSurfaceFormFactor,
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

    const renderOverlay = React.useCallback((overlay: NonNullable<typeof pane.scopeState>['details']['overlay']) => {
        if (!overlay) return null;
        return (
            <PluginDetailsPaneOverlay
                targetKind="project"
                projection={pluginUiProjection}
                overlay={overlay}
                callbacks={detailsSurfaceCallbacks}
                mount={{
                    projectId: props.workspaceRef.id,
                    machineId: props.workspaceRef.machineId,
                    serverId: props.workspaceRef.serverId,
                    platform: pluginSurfacePlatform,
                    formFactor: pluginSurfaceFormFactor,
                    projectionPhase: scopedPluginProjection.phase,
                    projectionInteractionEnabled: pluginInteractionEnabled,
                }}
            />
        );
    }, [
        pluginSurfacePlatform,
        pluginSurfaceFormFactor,
        scopedPluginProjection.phase,
        detailsSurfaceCallbacks,
        pluginInteractionEnabled,
        pluginUiProjection,
        props.workspaceRef.id,
        props.workspaceRef.machineId,
        props.workspaceRef.serverId,
    ]);

    const newSession = useProjectNewSessionAction({ workspaceRef: props.workspaceRef,
        activeRootPath: effectiveRootPath, scopeId: props.scopeId });
    // Launchers for another tab ride on the strip; a single tab's own header keeps only the pane's
    // controls (the Session pane's rule, lab session-D / files FB1: the drawer closes from its header).
    const renderStripActions = React.useCallback(() => {
        return (
            <>
                {props.renderHeaderActionsPrefix ? props.renderHeaderActionsPrefix({ iconButtonStyle, iconColor: theme.colors.text.secondary }) : null}
                {/* A phone's Project bar carries the browser and Terminal (its File page has no strip). */}
                {deviceType !== 'phone' ? (
                    <BrowserSurfaceOpenButton
                        onPress={openBrowserLaunchpadTab}
                        size={34}
                        testID="workspace-details-open-browser"
                    />
                ) : null}
                {hasWorkspaceReviewCommentDrafts ? (
                    <Pressable
                        onPress={newSession.open}
                        testID="workspace-details-open-review-comments-session"
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('newSession.title')}
                    >
                        <Icon name="chat-dots" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
                {props.showTerminalHeaderAction !== false && deviceType !== 'phone' ? (
                    <Pressable
                        onPress={() => {
                            pane.openBottom({ tabId: 'terminal' });
                        }}
                        testID="workspace-details-open-terminal"
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.terminal')}
                    >
                        <Icon name="terminal" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </>
        );
    }, [
        iconButtonStyle,
        hasWorkspaceReviewCommentDrafts,
        openBrowserLaunchpadTab,
        pane.openBottom,
        props.onRequestClose,
        props.renderHeaderActionsPrefix,
        props.workspaceRef.machineId,
        props.workspaceRef.serverId,
        requestClose,
        router,
        theme.colors.text.secondary,
        deviceType,
        effectiveRootPath,
        newSession.open,
    ]);

    // A pending approval must stay in sight: it rides with the pane's controls, into a single tab's header too.
    const { approvalNotice } = newSession;
    const renderLiveActions = React.useCallback(() => approvalNotice, [approvalNotice]);

    // The pane's own control: the docked column or drawer closes here (Editor first keeps its editor column).
    const editorArrangement = useOptionalAppPaneScopeLayout()?.arrangement === 'editor';
    const renderHeaderActions = React.useCallback(() => {
        if (deviceType === 'phone') return null;
        if (props.onRequestClose) return (
            <Pressable
                onPress={requestClose}
                style={iconButtonStyle}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
            >
                <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
            </Pressable>
        );
        if (editorArrangement || props.forceOverviewMode) return null;
        return (
            <IconButton
                variant="plain"
                size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
                onPress={requestClose}
                testID="workspace-details-close"
                accessibilityLabel={t('common.close')}
                icon={<Icon name="x" size={DETAILS_TAB_STRIP_METRICS.actionGlyphPx} color={theme.colors.text.secondary} />}
            />
        );
    }, [deviceType, editorArrangement, iconButtonStyle, props.forceOverviewMode, props.onRequestClose, requestClose, theme.colors.text.secondary]);

    const resolveTabHref = React.useCallback((tab: DetailsTabState) => {
        const details = parseSessionPaneUrlState(buildActiveDetailsRouteParams([tab], tab.key))?.details;
        if (details?.kind !== 'file' && details?.kind !== 'commit') return null;
        return buildProjectRouteHref({
            workspaceRefId: props.workspaceRef.id,
            serverId: props.workspaceRef.serverId,
            segment: details.kind === 'file' ? 'code' : 'changes', activeRootPath: effectiveRootPath, defaultRootPath: props.workspaceRef.rootPath,
            activeWorktreeId: props.activeWorktreeId,
            sourceSurface: details.kind === 'file' ? 'browse' : 'git', initialResource: details,
        });
    }, [effectiveRootPath, props.activeWorktreeId, props.workspaceRef.id, props.workspaceRef.serverId, props.workspaceRef.rootPath]);

    if (props.destinationTab !== undefined) return props.destinationTab ? renderTabContent(props.destinationTab) : renderEmptyState();

    return (
        <DetailsSplitWorkspace
            pane={pane}
            paddingTop={insets.top}
            headerPaddingTop={0}
            testIds={{
                root: 'workspace-details-panel-root',
                tab: (safeTabKey) => `workspace-details-tab-${safeTabKey}`,
                tabClose: (safeTabKey) => `workspace-details-tab-close-${safeTabKey}`,
            }}
            forceEmptyState={props.forceOverviewMode}
            resolveTabHref={resolveTabHref}
            resolveTabPresentation={resolveTabPresentation}
            renderTabContent={renderTabContent}
            renderOverlay={renderOverlay}
            renderStripActions={renderStripActions}
            renderLiveActions={renderLiveActions}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
        />
    );
});
