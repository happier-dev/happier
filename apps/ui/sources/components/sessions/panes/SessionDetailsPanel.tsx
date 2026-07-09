import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
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
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';
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
import { useSessionBrowserContextRuntimeContext } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { useSessionBrowserRecordingRuntime } from '@/components/sessions/browser/sessionBrowserRecordingRuntime';
import { createManagedChromiumBrowserAnnotationCaptureProvider } from '@/sync/domains/browser/context';

export type SessionDetailsPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
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
}>;

export const SessionDetailsPanel = React.memo((props: SessionDetailsPanelProps) => {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
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
        pluginUiProjection: props.pluginUiProjection,
        peerMediationObservabilityScope: props.peerMediationObservabilityScope,
        platform: props.platform,
    });
    const sessionBrowserContextRuntime = useSessionBrowserContextRuntimeContext();
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
    const liveSimulatorPreview = useSimulatorPreviewLiveSurface({
        runtime: {
            machineId: pluginRuntime.machineId,
            serverId: pluginRuntime.serverId,
            enabled: props.simulatorPreview === undefined,
            viewerId: `session:${props.sessionId}:simulator-preview`,
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
        nowMs: props.nowMs,
    }).feed;
    const managedAnnotationCaptureProvider = React.useMemo(() => {
        if (!pluginRuntime.machineId) return null;
        return createManagedChromiumBrowserAnnotationCaptureProvider({
            machineId: pluginRuntime.machineId,
            serverId: pluginRuntime.serverId,
        });
    }, [pluginRuntime.machineId, pluginRuntime.serverId]);
    const browserContextProductModel = React.useMemo(() => {
        const shellContext = sessionBrowserContextRuntime?.browserShellContext;
        if (!shellContext || !managedAnnotationCaptureProvider) return shellContext;
        return {
            ...shellContext,
            annotationCaptureProvider: managedAnnotationCaptureProvider,
            managedAnnotationCaptureProvider: true,
        };
    }, [managedAnnotationCaptureProvider, sessionBrowserContextRuntime?.browserShellContext]);
    const liveBrowserRecordingRuntime = useSessionBrowserRecordingRuntime({
        enabled: props.browserRecording === undefined,
        scopeKey: props.sessionId,
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

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        deferOnWeb(() => {
            pane.openDetailsTab(createSessionFileDetailsTab(path), { intent });
        });
    }, [pane]);

    const openBrowserLaunchpadTab = React.useCallback(() => {
        pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [pane]);

    const paneRef = React.useRef(pane);
    React.useEffect(() => {
        paneRef.current = pane;
    }, [pane]);
    const startEditingFileHandlersRef = React.useRef(new Map<string, () => void>());
    const getStartEditingFileHandler = React.useCallback((tabKey: string, isPreview: boolean): () => void => {
        const cacheKey = `${tabKey}:${isPreview ? 'preview' : 'pinned'}`;
        const cached = startEditingFileHandlersRef.current.get(cacheKey);
        if (cached) return cached;

        const handler = () => {
            if (isPreview) {
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

    const detailsSurfaceRenderers = React.useMemo(() => createSessionDetailsSurfaceRenderers({
            sessionId: props.sessionId,
            scopeId: props.scopeId,
            machineId: pluginRuntime.machineId,
            serverId: pluginRuntime.serverId,
            pluginUiProjection: pluginRuntime.pluginUiProjection,
            localServicePreviewState,
            peerMediationObservabilityState,
            peerMediationObservabilityScope: pluginRuntime.peerMediationObservabilityScope,
            simulatorPreview,
            platform: pluginRuntime.platform,
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
            closeDetailsTab: pane.closeDetailsTab,
            openDetailsTab: pane.openDetailsTab,
    }), [
        browserLaunchpad,
        browserProductModels,
        getStartEditingFileHandler,
        localServiceLauncherState,
        localServicePreviewState,
        openFileTab,
        pane.closeDetailsTab,
        pane.openDetailsTab,
        peerMediationObservabilityState,
        pluginRuntime.machineId,
        pluginRuntime.peerMediationObservabilityScope,
        pluginRuntime.platform,
        pluginRuntime.pluginUiProjection,
        pluginRuntime.serverId,
        browserRecording,
        props.nowMs,
        props.scopeId,
        props.sessionId,
        requestClose,
        sessionScreenTestIdsEnabled,
        simulatorPreview,
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

    const iconButtonStyle = {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    };

    const testIds = React.useMemo(() => ({
        root: resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-panel-root') ?? 'session-details-panel-root',
        tab: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-${safeTabKey}`),
        tabPin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-pin-${safeTabKey}`),
        tabUnpin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-unpin-${safeTabKey}`),
        tabClose: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-close-${safeTabKey}`),
    }), [sessionScreenTestIdsEnabled]);

    const closeButton = (
        <Pressable
            onPress={requestClose}
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-close')}
            style={closeButtonAtStart ? undefined : iconButtonStyle}
            hitSlop={closeButtonAtStart ? 15 : undefined}
            accessibilityRole="button"
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('session.detailsPanel.closeA11y')}
        >
            {closeButtonAtStart ? (
                <SafeIonicons
                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                    size={24}
                    color={theme.colors.chrome.header.foreground}
                />
            ) : (
                <Octicons name="chevron-right" size={18} color={theme.colors.text.secondary} />
            )}
        </Pressable>
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
        const browserOpenButton = (
            <BrowserSurfaceOpenButton
                onPress={openBrowserLaunchpadTab}
                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-open-browser') ?? 'session-details-open-browser'}
                style={iconButtonStyle}
                disabledStyle={{ opacity: 0.45 }}
                iconColor={theme.colors.text.secondary}
            />
        );

        if (!showHeaderActions) {
            return browserOpenButton;
        }

        return (
            <>
                {browserOpenButton}
                {Platform.OS === 'web' ? (
                    <Pressable
                        onPress={paneFocusMode.toggle}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-focus-toggle')}
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
                {showRightPaneToggle ? (
                    <Pressable
                        onPress={toggleRightPane}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-right-pane-toggle')}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={
                            rightPaneOpen
                                ? t('session.detailsPanel.closeRightSidebarA11y')
                                : t('session.detailsPanel.openRightSidebarA11y')
                        }
                    >
                        <Octicons
                            name={rightPaneOpen ? 'sidebar-collapse' : 'sidebar-expand'}
                            size={18}
                            color={theme.colors.text.secondary}
                        />
                    </Pressable>
                ) : null}
                {closeButtonAtStart ? null : closeButton}
            </>
        );
    }, [
        closeButton,
        closeButtonAtStart,
        iconButtonStyle,
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

    return (
        <DetailsSplitWorkspace
            pane={pane}
            paddingTop={panelPaddingTop}
            headerPaddingTop={10}
            testIds={testIds}
            resolveTabIconName={(tab) =>
                resolveSessionDetailsSurfaceIconName({
                    tab,
                    pluginUiProjection: pluginRuntime.pluginUiProjection,
                }) ?? resolveProviderSessionDetailsTabIconName(tab)
            }
            renderTabContent={renderTabContent}
            renderHeaderLeadingActions={renderHeaderLeadingActions}
            renderHeaderActions={renderHeaderActions}
        />
    );
});
