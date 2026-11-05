import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { getRightSidebarBuiltinTab } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { PaneSurfaceScope } from '@/components/appShell/panes/types';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import { PluginDetailsPaneOverlay } from '@/components/appShell/panes/details/surfaces/PluginDetailsPaneOverlay';
import { DetailsSurfaceFallback } from '@/components/appShell/panes/details/surfaces/DetailsSurfaceFallback';
import { DETAILS_TAB_STRIP_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import type { DetailsTab, DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    DetailsSurfaceHost,
    createDetailsSurfacePaneCallbacks,
    type DetailsSurfaceScopeV1,
} from '@/components/appShell/panes/details/surfaces';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    resolveProviderSessionDetailsTabIconName,
} from '@/agents/registry/sessionSubagentUiBehavior';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SidebarCollapseIcon, SidebarExpandIcon } from '@/components/navigation/shell/SidebarIcons';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { createSessionBoardDetailsTab, createSessionScmReviewDetailsTab } from './details/sessionDetailsTabBuilders';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { EmptyEditorPage } from '@/components/workspaces/files/EmptyEditorPage';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import {
    createSessionDetailsSurfaceRenderers,
    resolveSessionDetailsSurfaceIconName,
} from './surfaces/sessionDetailsSurfaceRegistry';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { LocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import type { PeerMediationObservabilityUiStore } from '@/sync/domains/machines/peer/mediation/observability';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { BrowserShellRecordingState } from '@/components/browser/BrowserShell';
import {
    BrowserSurfaceOpenButton,
    mergeBrowserSurfaceProductModels,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import { resolveBrowserSurfacePlatform } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useOpenBrowserTargetInWorkspace } from '@/components/browser/surfaces/useOpenBrowserTargetInWorkspace';
import { useSessionDetailsPanelPluginRuntime } from './useSessionDetailsPanelPluginRuntime';
import { usePeerMediationObservabilityStore } from '@/sync/domains/machines/peer/mediation/observability/usePeerMediationObservabilityStore';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import { useSimulatorPreviewLiveSurface } from '@/components/devices/simulator/relay/useSimulatorPreviewLiveSurface';
import { useSimulatorLiveStreamRelaySocket } from '@/components/devices/simulator/relay/useSimulatorLiveStreamRelaySocket';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { useSessionBrowserContextProductModel } from '@/components/sessions/browser/useSessionBrowserContextProductModel';
import { Icon } from '@/components/ui/icons/Icon';
import {
    SessionViewerSourceAccountScopeProvider,
    useSessionViewerSourceAccountLifetime,
} from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import { SESSION_BOARD_DESTINATION } from '@/components/sessions/board/sessionBoardDestination';
import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { isSessionBoardVisibleInDetails } from '@/components/sessions/board/sessionBoardDetailsVisibility';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { useWorkspaceFileWriteTabPresentation } from '@/components/workspaces/files/useWorkspaceFileWriteTabPresentation';
import { TrackCapsule, TrackInputBoundary, useSessionTrack } from '@/components/sessions/files/track/SessionTrack';

export type SessionDetailsPanelProps = Readonly<{
    sessionId: string;
    routeServerId?: string | null;
    scopeId: string;
    /** Undefined retains the shared pane workspace; null is a controlled empty destination. */
    destinationTab?: DetailsTabState | null;
    destinationActive?: boolean;
    onOpenDestinationTab?: (tab: DetailsTab) => void;
    /** Exact AppPane target/projection facts when this panel is driver-rendered. */
    paneSurfaceScope?: Extract<PaneSurfaceScope, Readonly<{ targetKind: 'session' }>>;
    presentation?: 'pane' | 'screen';
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
    /**
     * Cockpit embeds details inside the shared session chrome, so the per-panel close/focus
     * controls would duplicate route-level navigation controls.
     */
    showHeaderActions?: boolean;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServiceLauncherState?: LocalServiceLauncherState | null;
    peerMediationObservabilityState?: PeerMediationObservabilityUiStore | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    platform?: LocalServicePreviewPlatform;
    browserProductModels?: BrowserSurfaceProductModels | null;
    browserRecording?: BrowserShellRecordingState | null;
    nowMs?: () => number;
    /** One executable-mount decision derived by the enclosing Session shell. */
    resolveBoardPrimaryHost?: SessionBoardPrimaryMountResolver;
}>;

export const SessionDetailsPanel = React.memo((props: SessionDetailsPanelProps) => {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
    const { open: openWorkspaceFile } = useWorkspaceFileOpener();
    const controlledDestination = props.destinationTab !== undefined;
    const requestClose = props.onRequestClose ?? pane.closeDetails;
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const showHeaderActions = props.showHeaderActions !== false;
    const closeButtonAtStart = showHeaderActions && props.presentation === 'screen' && Platform.OS !== 'web';
    const panelPaddingTop = closeButtonAtStart ? 0 : insets.top;
    const rightPaneOpen = pane.scopeState?.right?.isOpen === true;
    const showRightPaneToggle = showHeaderActions && props.presentation !== 'screen';
    const inheritedViewerAccountLifetime = useSessionViewerSourceAccountLifetime();
    const pluginRuntime = useSessionDetailsPanelPluginRuntime({
        sessionId: props.sessionId,
        routeServerId: props.routeServerId,
        paneSurfaceScope: props.paneSurfaceScope,
        pluginUiProjection: props.pluginUiProjection,
        peerMediationObservabilityScope: props.peerMediationObservabilityScope,
        platform: props.platform,
    });
    const session = useSessionViewShellSession(props.sessionId, pluginRuntime.serverId);
    const fileWriteScope = useWorkspaceScopeForSession(props.sessionId, pluginRuntime.serverId);
    const resolveTabPresentation = useWorkspaceFileWriteTabPresentation(fileWriteScope);
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(pluginRuntime.serverId);
    const deviceType = useDeviceType();
    const pluginRuntimeFormFactor = React.useMemo(
        () => resolvePluginUiRuntimeFormFactor({ deviceType }),
        [deviceType],
    );
    const livePeerMediationObservabilityState = usePeerMediationObservabilityStore({
        scope: pluginRuntime.peerMediationObservabilityScope,
        source: 'server',
        serverId: pluginRuntime.serverId,
        enabled: props.peerMediationObservabilityState === undefined,
    });
    const localServicePreviewState = props.localServicePreviewState;
    const localServiceLauncherState = props.localServiceLauncherState;
    const peerMediationObservabilityState =
        props.peerMediationObservabilityState !== undefined
            ? props.peerMediationObservabilityState
            : livePeerMediationObservabilityState;
    // Live `server_relay` ingestion (Phase 8.1b): resolve the host machine's relay socket
    // and thread decoded frames into the simulator preview view-model. The socket hook is
    // gated behind the `devices.simulatorPreview` decision, so this stays inert until that
    // gate is flipped (5.3 representation migration, separate lane).
    const simulatorRelaySocket = useSimulatorLiveStreamRelaySocket({
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        enabled: props.simulatorPreview === undefined,
    });
    const mountedSessionAddress = normalizeSessionAddress(pluginRuntime.serverId, props.sessionId);
    const trackSessionAddress = React.useMemo(() => mountedSessionAddress ?? { serverId: pluginRuntime.serverId ?? '', sessionId: props.sessionId },
        [mountedSessionAddress?.serverId, mountedSessionAddress?.sessionId, pluginRuntime.serverId, props.sessionId]);
    const track = useSessionTrack({ scopeId: props.scopeId, sessionAddress: trackSessionAddress,
        workspaceRoot: fileWriteScope?.rootPath ?? null, active: !controlledDestination });
    const mountedBoard = useMountedSessionBoardController(mountedSessionAddress);
    const callerHostedHtmlRuntime = mountedBoard?.callerHostedHtmlRuntime ?? null;
    const boardHasContent = mountedBoard?.binding.status === 'ready'
        && mountedBoard.binding.snapshot.itemsById.size > 0;
    const showDedicatedBoardAction = boardFeatureEnabled
        && (boardHasContent || isSessionBoardVisibleInDetails(pane.scopeState?.details));
    const liveSimulatorPreview = useSimulatorPreviewLiveSurface({
        runtime: {
            machineId: pluginRuntime.machineId,
            serverId: pluginRuntime.serverId,
            enabled: props.simulatorPreview === undefined,
            viewerId: JSON.stringify([
                mountedSessionAddress ? sessionAddressKey(mountedSessionAddress) : props.scopeId,
                'simulator-preview',
            ]),
            nowMs: props.nowMs,
        },
        relay: { socket: simulatorRelaySocket },
    });
    const simulatorPreview =
        props.simulatorPreview !== undefined
            ? props.simulatorPreview
            : liveSimulatorPreview;
    const browserContextProductModel = useSessionBrowserContextProductModel({
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
    });
    const liveBrowserRecordingRuntime = useSessionBrowserRecordingRuntime({
        enabled: props.browserRecording === undefined,
        scopeKey: mountedSessionAddress ? sessionAddressKey(mountedSessionAddress) : props.scopeId,
        sessionId: props.sessionId,
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        nowMs: props.nowMs,
    });
    const browserRecording = props.browserRecording !== undefined
        ? props.browserRecording
        : liveBrowserRecordingRuntime?.browserShellRecording ?? null;
    const browserProductModels = React.useMemo(() => mergeBrowserSurfaceProductModels(props.browserProductModels, {
        browserContext: browserContextProductModel,
        browserRecording,
    }), [
        browserRecording,
        browserContextProductModel,
        props.browserProductModels,
    ]);

    const openDetailsTab = React.useCallback<typeof pane.openDetailsTab>((tab, options) => {
        if (controlledDestination) {
            props.onOpenDestinationTab?.(tab);
            return;
        }
        pane.openDetailsTab(tab, options);
    }, [controlledDestination, pane.openDetailsTab, props.onOpenDestinationTab]);
    const closeDetailsTab = React.useCallback((tabKey: string) => {
        if (controlledDestination) {
            requestClose();
            return;
        }
        pane.closeDetailsTab(tabKey);
    }, [controlledDestination, pane.closeDetailsTab, requestClose]);
    const replaceDetailsTab = React.useCallback<typeof pane.replaceDetailsTab>((tabKey, tab, options) => {
        if (controlledDestination) {
            props.onOpenDestinationTab?.(tab);
            return;
        }
        pane.replaceDetailsTab(tabKey, tab, options);
    }, [controlledDestination, pane.replaceDetailsTab, props.onOpenDestinationTab]);

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        const serverId = props.paneSurfaceScope?.serverId ?? props.routeServerId ?? pluginRuntime.serverId;
        if (!serverId) return;
        void openWorkspaceFile({ kind: 'session', sessionId: props.sessionId, serverId, path },
            { intent: intent === 'pinned' ? 'pinned' : 'preview' });
    }, [openWorkspaceFile, pluginRuntime.serverId, props.paneSurfaceScope?.serverId, props.routeServerId, props.sessionId]);

    const openBrowserLaunchpadTab = React.useCallback(() => {
        pane.openRight({ tabId: getRightSidebarBuiltinTab('browser').id, present: false });
    }, [pane.openRight]);

    const openBoardTab = React.useCallback(() => {
        openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' });
    }, [openDetailsTab]);

    const paneRef = React.useRef(pane);
    const controlledDestinationRef = React.useRef(controlledDestination);
    React.useEffect(() => {
        paneRef.current = pane;
        controlledDestinationRef.current = controlledDestination;
    }, [controlledDestination, pane]);
    const startEditingFileHandlersRef = React.useRef(new Map<string, () => void>());
    const getStartEditingFileHandler = React.useCallback((tabKey: string, isPreview: boolean): () => void => {
        const cacheKey = `${tabKey}:${isPreview ? 'preview' : 'pinned'}`;
        const cached = startEditingFileHandlersRef.current.get(cacheKey);
        if (cached) return cached;

        const handler = () => {
            if (isPreview && !controlledDestinationRef.current) {
                paneRef.current.pinDetailsTab(tabKey);
            }
        };
        startEditingFileHandlersRef.current.set(cacheKey, handler);
        return handler;
    }, []);

    const detailsSurfaceScope = React.useMemo<DetailsSurfaceScopeV1>(() => ({
        kind: 'session',
        sessionId: props.sessionId,
        serverId: pluginRuntime.serverId,
        machineId: pluginRuntime.machineId,
    }), [pluginRuntime.machineId, pluginRuntime.serverId, props.sessionId]);

    const detailsSurfaceCallbacks = React.useMemo(() => createDetailsSurfacePaneCallbacks({
        openTab: openDetailsTab,
        openOverlay: controlledDestination ? undefined : pane.openDetailsOverlay,
        closeTab: closeDetailsTab,
        pinTab: controlledDestination ? undefined : pane.pinDetailsTab,
        unpinTab: controlledDestination ? undefined : pane.unpinDetailsTab,
        replaceTab: replaceDetailsTab,
    }), [
        controlledDestination,
        closeDetailsTab,
        pane.openDetailsOverlay,
        openDetailsTab,
        pane.pinDetailsTab,
        replaceDetailsTab,
        pane.unpinDetailsTab,
    ]);

    const openBrowserViewTarget = useOpenBrowserTargetInWorkspace({
        scopeId: props.scopeId,
        scope: 'sessionDetails',
        accountLifetime: pluginRuntime.accountLifetime,
        openDetailsTab,
        platform: resolveBrowserSurfacePlatform(pluginRuntime.platform),
        browserProfile: browserProductModels?.browserProfile?.profile,
        localServicePreviewState,
    });
    const detailsSurfaceRenderers = React.useMemo(() => session ? createSessionDetailsSurfaceRenderers({
            onOpenTarget: openBrowserViewTarget,
            sessionId: props.sessionId,
            session,
            scopeId: props.scopeId,
            machineId: pluginRuntime.machineId,
            serverId: pluginRuntime.serverId,
            pluginUiProjection: pluginRuntime.pluginUiProjection,
            pluginAccountLifetime: pluginRuntime.accountLifetime,
            pluginUiProjectionPhase: pluginRuntime.phase,
            pluginUiInteractionEnabled: pluginRuntime.phase === 'current'
                && pluginRuntime.interactionEnabled === true,
            pluginBrowserProjection: pluginRuntime.pluginBrowserProjection,
            callerHostedHtmlRuntime,
            localServicePreviewState,
            localServiceLauncherState,
            peerMediationObservabilityState,
            peerMediationObservabilityScope: pluginRuntime.peerMediationObservabilityScope,
            simulatorPreview,
            platform: pluginRuntime.platform,
            formFactor: pluginRuntimeFormFactor,
            productModels: browserProductModels,
            browserRecording,
            nowMs: props.nowMs,
            requestClose,
            openFileTab,
            getStartEditingFileHandler,
            sessionScreenTestIdsEnabled,
            closeDetailsTab,
            openDetailsTab,
            boardHost: pane.scopeState?.mainHidden === true ? 'focusedDetails' : 'details',
            resolveBoardPrimaryHost: props.resolveBoardPrimaryHost,
        }) : [], [
        openBrowserViewTarget,
        browserProductModels,
        getStartEditingFileHandler,
        localServiceLauncherState,
        localServicePreviewState,
        openFileTab,
        closeDetailsTab,
        openDetailsTab,
        pane.scopeState?.mainHidden,
        props.resolveBoardPrimaryHost,
        peerMediationObservabilityState,
        pluginRuntime.machineId,
        pluginRuntime.interactionEnabled,
        pluginRuntime.phase,
        pluginRuntime.peerMediationObservabilityScope,
        pluginRuntime.platform,
        pluginRuntimeFormFactor,
        pluginRuntime.pluginUiProjection,
        pluginRuntime.accountLifetime,
        pluginRuntime.pluginBrowserProjection,
        callerHostedHtmlRuntime,
        pluginRuntime.serverId,
        browserRecording,
        props.nowMs,
        props.scopeId,
        props.sessionId,
        session,
        requestClose,
        sessionScreenTestIdsEnabled,
        simulatorPreview,
    ]);

    const renderTabContent = React.useCallback((
        tab: DetailsTabState,
        presentation: Readonly<{ active: boolean }>,
    ) => {
        if (!session) return <DetailsSurfaceFallback status="pending" />;
        return (
            <DetailsSurfaceHost
                tab={tab}
                scope={detailsSurfaceScope}
                region="details"
                // Every tab stays mounted for content, scroll and view continuity, so
                // the incumbent group's own activity is the only truthful answer here.
                // Defaulting it to `true` left a hidden Board pane owning the shared
                // editor and re-registering the continuity draft guard.
                active={presentation.active}
                renderers={detailsSurfaceRenderers}
                callbacks={detailsSurfaceCallbacks}
            />
        );
    }, [
        detailsSurfaceCallbacks,
        detailsSurfaceRenderers,
        detailsSurfaceScope,
        session,
    ]);

    const openEmptyEditorFile = React.useCallback((path: string) => {
        openFileTab(path, 'pinned');
    }, [openFileTab]);
    const openEmptyEditorReview = React.useCallback(() => {
        openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
    }, [openDetailsTab]);
    // The editor column with nothing open (lab EM1). It mounts only while Details is empty, so the
    // always-mounted panel never subscribes to the working tree.
    const renderEmptyState = React.useCallback(() => (
        <EmptyEditorPage
            scope={fileWriteScope}
            sessionId={props.sessionId}
            title={t('panes.emptyEditor.title')}
            reason={t('panes.emptyEditor.reason')}
            changedTitle={t('panes.emptyEditor.changedInSession')}
            onOpenFile={openEmptyEditorFile}
            onReview={openEmptyEditorReview}
        />
    ), [fileWriteScope, openEmptyEditorFile, openEmptyEditorReview, props.sessionId]);

    const renderOverlay = React.useCallback((overlay: NonNullable<typeof pane.scopeState>['details']['overlay']) => {
        if (!overlay) return null;
        return (
            <PluginDetailsPaneOverlay
                targetKind="session"
                projection={pluginRuntime.pluginUiProjection}
                overlay={overlay}
                callbacks={detailsSurfaceCallbacks}
                mount={{
                    sessionId: props.sessionId,
                    machineId: pluginRuntime.machineId,
                    serverId: pluginRuntime.serverId,
                    platform: pluginRuntime.platform,
                    formFactor: pluginRuntimeFormFactor,
                    projectionPhase: pluginRuntime.phase,
                    projectionInteractionEnabled: pluginRuntime.phase === 'current'
                        && pluginRuntime.interactionEnabled === true,
                }}
            />
        );
    }, [
        pluginRuntime.interactionEnabled,
        pluginRuntime.machineId,
        pluginRuntime.platform,
        pluginRuntime.phase,
        pluginRuntimeFormFactor,
        pluginRuntime.pluginUiProjection,
        pluginRuntime.serverId,
        detailsSurfaceCallbacks,
        props.sessionId,
    ]);

    // Geometry only. A bordered box around a single glyph is chrome competing with the content
    // beside it, and this header had four of them. The three controls below use the canonical
    // `IconButton`; `BrowserSurfaceOpenButton` renders its own Pressable, so it cannot be wrapped in
    // one and takes the matching geometry instead.
    const iconButtonStyle = {
        width: DETAILS_TAB_STRIP_METRICS.actionSizePx,
        height: DETAILS_TAB_STRIP_METRICS.actionSizePx,
        borderRadius: 8,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    };

    const testIds = React.useMemo(() => ({
        root: resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-panel-root') ?? 'session-details-panel-root',
        tab: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-${safeTabKey}`),
        tabPin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-pin-${safeTabKey}`),
        tabUnpin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-unpin-${safeTabKey}`),
        tabClose: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-close-${safeTabKey}`),
    }), [sessionScreenTestIdsEnabled]);

    const closeButton = (
        <IconButton
            variant="plain"
            size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
            onPress={requestClose}
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-close')}
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('session.detailsPanel.closeA11y')}
            icon={closeButtonAtStart
                ? <Icon
                    name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                    size={24}
                    color={theme.colors.chrome.header.foreground}
                />
                : <Icon name="x" size={DETAILS_TAB_STRIP_METRICS.actionGlyphPx} color={theme.colors.text.secondary} />}
        />
    );

    const toggleRightPane = React.useCallback(() => {
        if (rightPaneOpen) {
            pane.closeRight();
            return;
        }
        pane.openRight();
    }, [pane, rightPaneOpen]);

    const renderHeaderLeadingActions = React.useCallback(() => (
        showHeaderActions && closeButtonAtStart ? closeButton : null
    ), [closeButton, closeButtonAtStart, showHeaderActions]);

    // Launchers and workspace chrome ride on the strip; a single tab's own header (a peek) keeps
    // only the pane's controls (lab `session-D`: ⤢ and ×).
    const renderLiveActions = React.useCallback(() => {
        const trackCapsule = track.target ? <TrackCapsule track={track} /> : null;
        const rightPaneToggle = showHeaderActions && showRightPaneToggle ? (
            <IconButton
                variant="plain"
                size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
                onPress={toggleRightPane}
                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-right-pane-toggle') ?? 'session-details-right-pane-toggle'}
                accessibilityLabel={
                    rightPaneOpen
                        ? t('session.detailsPanel.closeRightSidebarA11y')
                        : t('session.detailsPanel.openRightSidebarA11y')
                }
                icon={rightPaneOpen
                    ? <SidebarCollapseIcon edge="right" size={18} color={theme.colors.text.secondary} />
                    : <SidebarExpandIcon edge="right" size={18} color={theme.colors.text.secondary} />}
            />
        ) : null;
        return trackCapsule === null && rightPaneToggle === null ? null : <>{trackCapsule}{rightPaneToggle}</>;
    }, [rightPaneOpen, sessionScreenTestIdsEnabled, showHeaderActions, showRightPaneToggle, theme.colors.text.secondary, toggleRightPane, track]);

    // Launchers ride on the strip; a single tab's own header (a peek) keeps only the pane's controls
    // and what must stay reachable (lab `session-D`: ⤢ and ×).
    const renderStripActions = React.useCallback(() => {
        const boardOpenButton = (
            <IconButton
                variant="plain"
                size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
                onPress={openBoardTab}
                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-open-board') ?? 'session-details-open-board'}
                accessibilityLabel={t(SESSION_BOARD_DESTINATION.labelKey)}
                icon={<Icon name={SESSION_BOARD_DESTINATION.icon} size={DETAILS_TAB_STRIP_METRICS.actionGlyphPx} color={theme.colors.text.secondary} />}
            />
        );
        const browserOpenButton = (
            <BrowserSurfaceOpenButton
                onPress={openBrowserLaunchpadTab}
                size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-open-browser') ?? 'session-details-open-browser'}
            />
        );

        return (
            <>
                {showDedicatedBoardAction ? boardOpenButton : null}
                {browserOpenButton}
            </>
        );
    }, [
        openBoardTab,
        showDedicatedBoardAction,
        openBrowserLaunchpadTab,
        sessionScreenTestIdsEnabled,
        theme.colors.text.secondary,
    ]);

    const renderHeaderActions = React.useCallback(() => {
        if (!showHeaderActions) return null;
        return (
            <>
                {closeButtonAtStart ? null : closeButton}
            </>
        );
    }, [
        closeButton,
        closeButtonAtStart,
        showHeaderActions,
    ]);

    const workspace = controlledDestination
        ? props.destinationTab
            ? renderTabContent(props.destinationTab, { active: props.destinationActive ?? true })
            : renderEmptyState()
        : (
        <DetailsSplitWorkspace
            sessionId={props.sessionId}
            serverId={pluginRuntime.serverId}
            pane={pane}
            paddingTop={panelPaddingTop}
            headerPaddingTop={0}
            testIds={testIds}
            resolveTabPresentation={resolveTabPresentation}
            resolveTabIconName={(tab) =>
                resolveSessionDetailsSurfaceIconName({
                    tab,
                }) ?? resolveProviderSessionDetailsTabIconName(tab)
            }
            renderTabContent={renderTabContent}
            renderOverlay={renderOverlay}
            renderHeaderLeadingActions={renderHeaderLeadingActions}
            renderStripActions={renderStripActions}
            renderLiveActions={renderLiveActions}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
        />
    );
    // The pushed phone route recomposes every tab's header and state for the phone (details lab 2).
    const tracked = <TrackInputBoundary track={track}>{workspace}</TrackInputBoundary>;
    const presented = props.presentation === 'screen' && deviceType === 'phone'
        ? <SurfaceStateSizeProvider size="phone">{tracked}</SurfaceStateSizeProvider>
        : tracked;
    // A retained viewer source (a Computer or Browser tab) binds nothing without the Session's
    // admitted Home/Account authority. Inside the Session shell it is inherited; a Details route or
    // phone scene rendered outside it takes this panel's own runtime authority.
    return (
        <SessionViewerSourceAccountScopeProvider accountLifetime={inheritedViewerAccountLifetime ?? pluginRuntime.accountLifetime}>
            {presented}
        </SessionViewerSourceAccountScopeProvider>
    );
});
