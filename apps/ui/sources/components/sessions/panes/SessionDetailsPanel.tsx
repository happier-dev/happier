import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
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
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { useDeviceType } from '@/utils/platform/responsive';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SidebarCollapseIcon, SidebarExpandIcon } from '@/components/navigation/shell/SidebarIcons';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { createSessionBoardDetailsTab, createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';
import { SessionDetailsEmptyState } from './details/SessionDetailsEmptyState';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { usePaneFocusMode } from '@/components/appShell/panes/focusMode/usePaneFocusMode';
import {
    createSessionDetailsSurfaceRenderers,
    resolveSessionDetailsSurfaceIconName,
} from './surfaces/sessionDetailsSurfaceRegistry';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import {
    type LocalServiceLauncherState,
    useLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { PeerMediationObservabilityUiStore } from '@/sync/domains/machines/peer/mediation/observability';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { BrowserShellRecordingState } from '@/components/browser/BrowserShell';
import {
    BrowserSurfaceOpenButton,
    createBrowserLaunchpadDetailsTab,
    mergeBrowserSurfaceProductModels,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import { useBrowserSurfaceHostProps } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useSessionDetailsPanelPluginRuntime } from './useSessionDetailsPanelPluginRuntime';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import { usePeerMediationObservabilityStore } from '@/sync/domains/machines/peer/mediation/observability/usePeerMediationObservabilityStore';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import { useSimulatorPreviewLiveSurface } from '@/components/devices/simulator/relay/useSimulatorPreviewLiveSurface';
import { useSimulatorLiveStreamRelaySocket } from '@/components/devices/simulator/relay/useSimulatorLiveStreamRelaySocket';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { useSessionBrowserContextProductModel } from '@/components/sessions/browser/useSessionBrowserContextProductModel';
import { Icon } from '@/components/ui/icons/Icon';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import { SESSION_BOARD_DESTINATION } from '@/components/sessions/board/sessionBoardDestination';
import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { isSessionBoardVisibleInDetails } from '@/components/sessions/board/sessionBoardDetailsVisibility';

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
    const controlledDestination = props.destinationTab !== undefined;
    const requestClose = props.onRequestClose ?? pane.closeDetails;
    const paneFocusMode = usePaneFocusMode(props.scopeId);
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const showHeaderActions = props.showHeaderActions !== false;
    const closeButtonAtStart = showHeaderActions && props.presentation === 'screen' && Platform.OS !== 'web';
    const panelPaddingTop = closeButtonAtStart ? 0 : insets.top;
    const rightPaneOpen = pane.scopeState?.right?.isOpen === true;
    const showRightPaneToggle = showHeaderActions && props.presentation !== 'screen';
    const pluginRuntime = useSessionDetailsPanelPluginRuntime({
        sessionId: props.sessionId,
        routeServerId: props.routeServerId,
        paneSurfaceScope: props.paneSurfaceScope,
        pluginUiProjection: props.pluginUiProjection,
        peerMediationObservabilityScope: props.peerMediationObservabilityScope,
        platform: props.platform,
    });
    const session = useSessionViewShellSession(props.sessionId, pluginRuntime.serverId);
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(pluginRuntime.serverId);
    const deviceType = useDeviceType();
    const pluginRuntimeFormFactor = React.useMemo(
        () => resolvePluginUiRuntimeFormFactor({ deviceType }),
        [deviceType],
    );
    const liveLocalServicePreviewState = useLocalServicePreviewState({
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        enabled: props.localServicePreviewState === undefined,
    });
    const liveLocalServiceLauncherState = useLocalServiceLauncherState({
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        sessionId: props.sessionId,
        enabled: props.localServiceLauncherState === undefined,
    });
    const livePeerMediationObservabilityState = usePeerMediationObservabilityStore({
        scope: pluginRuntime.peerMediationObservabilityScope,
        source: 'server',
        serverId: pluginRuntime.serverId,
        enabled: props.peerMediationObservabilityState === undefined,
    });
    const localServicePreviewState =
        props.localServicePreviewState !== undefined
            ? props.localServicePreviewState
            : liveLocalServicePreviewState;
    const localServiceLauncherState =
        props.localServiceLauncherState !== undefined
            ? props.localServiceLauncherState
            : liveLocalServiceLauncherState;
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
    // Route the launchpad feed through the shared browser-host bootstrap so the session and
    // workspace details panels assemble the identical feed and cannot drift apart (BRW-13). The
    // launcher/preview states are injected from the values already resolved above, so the helper
    // does not spin up duplicate live controllers.
    const browserLaunchpad = useBrowserSurfaceHostProps({
        scope: 'sessionDetails',
        sessionId: props.sessionId,
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        // OWNER-PLATFORM: do NOT leak the local-preview platform (`LocalServicePreviewPlatform`,
        // which cannot represent `desktop` and defaults non-mobile to `'web'`) into the browser
        // surface — that is B-RC1. Omit it so the hook resolves the browser platform Tauri-aware.
        launcherState: localServiceLauncherState,
        localServicePreviewState,
        pluginBrowserProjection: pluginRuntime.pluginBrowserProjection,
        pluginUiProjection: pluginRuntime.pluginUiProjection,
        nowMs: props.nowMs,
    }).feed;
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
        deferOnWeb(() => {
            openDetailsTab(createSessionFileDetailsTab(path), { intent });
        });
    }, [openDetailsTab]);

    const openBrowserLaunchpadTab = React.useCallback(() => {
        openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [openDetailsTab]);

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

    const detailsSurfaceRenderers = React.useMemo(() => session ? createSessionDetailsSurfaceRenderers({
            sessionId: props.sessionId,
            session,
            scopeId: props.scopeId,
            machineId: pluginRuntime.machineId,
            serverId: pluginRuntime.serverId,
            pluginUiProjection: pluginRuntime.pluginUiProjection,
            pluginUiProjectionPhase: pluginRuntime.phase,
            pluginUiInteractionEnabled: pluginRuntime.phase === 'current'
                && pluginRuntime.interactionEnabled === true,
            pluginBrowserProjection: pluginRuntime.pluginBrowserProjection,
            callerHostedHtmlRuntime,
            localServicePreviewState,
            peerMediationObservabilityState,
            peerMediationObservabilityScope: pluginRuntime.peerMediationObservabilityScope,
            simulatorPreview,
            platform: pluginRuntime.platform,
            formFactor: pluginRuntimeFormFactor,
            productModels: browserProductModels,
            browserRecording,
            launchpadRows: browserLaunchpad.rows,
            launchpadRefreshStatus: browserLaunchpad.refreshStatus,
            launchpadRefreshError: browserLaunchpad.refreshError,
            nowMs: props.nowMs,
            requestClose,
            openFileTab,
            getStartEditingFileHandler,
            sessionScreenTestIdsEnabled,
            closeDetailsTab,
            openDetailsTab,
            boardHost: paneFocusMode.active ? 'focusedDetails' : 'details',
            resolveBoardPrimaryHost: props.resolveBoardPrimaryHost,
        }) : [], [
        browserLaunchpad,
        browserProductModels,
        getStartEditingFileHandler,
        localServiceLauncherState,
        localServicePreviewState,
        openFileTab,
        closeDetailsTab,
        openDetailsTab,
        paneFocusMode.active,
        props.resolveBoardPrimaryHost,
        peerMediationObservabilityState,
        pluginRuntime.machineId,
        pluginRuntime.interactionEnabled,
        pluginRuntime.phase,
        pluginRuntime.peerMediationObservabilityScope,
        pluginRuntime.platform,
        pluginRuntimeFormFactor,
        pluginRuntime.pluginUiProjection,
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

    const renderEmptyState = React.useCallback(() => (
        <SessionDetailsEmptyState
            sessionId={props.sessionId}
            serverId={pluginRuntime.serverId}
            openDetailsTab={openDetailsTab}
            onBrowseFiles={() => pane.openRight({ tabId: 'files' })}
        />
    ), [openDetailsTab, pane.openRight, pluginRuntime.serverId, props.sessionId]);

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

    const renderHeaderActions = React.useCallback(() => {
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

        if (!showHeaderActions) {
            return <>{showDedicatedBoardAction ? boardOpenButton : null}{browserOpenButton}</>;
        }

        return (
            <>
                {showDedicatedBoardAction ? boardOpenButton : null}
                {browserOpenButton}
                {Platform.OS === 'web' ? (
                    <IconButton
                        variant="plain"
                        size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
                        tooltip={paneFocusMode.active ? t('session.detailsPanel.exitFocusModeA11y') : t('session.detailsPanel.enterFocusModeA11y')}
                        onPress={paneFocusMode.toggle}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-focus-toggle')}
                        disabled={!paneFocusMode.canEnter}
                        selected={paneFocusMode.active}
                        accessibilityLabel={
                            paneFocusMode.active
                                ? t('session.detailsPanel.exitFocusModeA11y')
                                : t('session.detailsPanel.enterFocusModeA11y')
                        }
                        icon={<Icon
                            name={paneFocusMode.active ? 'arrows-in' : 'arrows-out'}
                            size={DETAILS_TAB_STRIP_METRICS.actionGlyphPx}
                            color={theme.colors.text.secondary}
                        />}
                    />
                ) : null}
                {showRightPaneToggle ? (
                    <IconButton
                        variant="plain"
                        size={DETAILS_TAB_STRIP_METRICS.actionSizePx}
                        onPress={toggleRightPane}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-right-pane-toggle')}
                        accessibilityLabel={
                            rightPaneOpen
                                ? t('session.detailsPanel.closeRightSidebarA11y')
                                : t('session.detailsPanel.openRightSidebarA11y')
                        }
                        icon={rightPaneOpen
                            ? <SidebarCollapseIcon edge="right" size={18} color={theme.colors.text.secondary} />
                            : <SidebarExpandIcon edge="right" size={18} color={theme.colors.text.secondary} />}
                    />
                ) : null}
                {closeButtonAtStart ? null : closeButton}
            </>
        );
    }, [
        closeButton,
        closeButtonAtStart,
        iconButtonStyle,
        openBoardTab,
        showDedicatedBoardAction,
        openBrowserLaunchpadTab,
        paneFocusMode.active,
        paneFocusMode.canEnter,
        paneFocusMode.toggle,
        rightPaneOpen,
        sessionScreenTestIdsEnabled,
        showHeaderActions,
        showRightPaneToggle,
        theme.colors.text.secondary,
        toggleRightPane,
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
            resolveTabIconName={(tab) =>
                resolveSessionDetailsSurfaceIconName({
                    tab,
                }) ?? resolveProviderSessionDetailsTabIconName(tab)
            }
            renderTabContent={renderTabContent}
            renderOverlay={renderOverlay}
            renderHeaderLeadingActions={renderHeaderLeadingActions}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
        />
    );
    // The pushed phone route recomposes every tab's header and state for the phone (details lab 2).
    return props.presentation === 'screen' && deviceType === 'phone'
        ? <SurfaceStateSizeProvider size="phone">{workspace}</SurfaceStateSizeProvider>
        : workspace;
});
