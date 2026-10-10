import { SessionTerminalRailBadge } from '@/components/sessions/terminal/strip/SessionTerminalRailBadge';
import { SessionGitActionRailBadge, SessionGitActionRailTooltip } from './SessionGitActionRailBadge';
import { SessionCollaborationRailBadge, useSessionConversationMentioned } from '@/components/sessions/collaboration/sessionConversationAttention';
import { parseSessionPaneScopeId } from './sessionPaneScopeId';
import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneActionRail, usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { RightSidebarActionRail, type RightSidebarRailAction } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { toggleRightSidebarTab } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { useSessionTerminalAction } from '@/components/sessions/terminal/useSessionTerminalAction';
import { toggleSessionReview } from './sessionPaneActions';
import { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } from './details/sessionDetailsTabBuilders';
import { RightSidebarIconTabBar } from '@/components/appShell/rightSidebar/RightSidebarIconTabBar';
import { RightSidebarPaneHeader } from '@/components/appShell/rightSidebar/RightSidebarPaneHeader';
import { usePaneCompanionActions } from '@/components/sessions/companion/glances/usePaneCompanionActions';
import { PaneHeaderSlotProvider, PaneHeaderSlotScope } from '@/components/appShell/panes/paneHeaderSlot';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { AppRightSidebarTabSurface, useAppRightSidebarTabInputs } from '@/components/appShell/rightSidebar/appRightSidebarTabs';
import {
    resolveSessionRightSidebarTabs,
    resolveRightSidebarTabSelection,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import {
    PluginSurfacePaneLaunchScope,
    stagePluginSurfacePaneLaunch,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
    usePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { SessionPaneErrorBoundary, SessionPaneLazyLoader } from './SessionPaneLazyLoader';
import { SessionWorkViewWithTriggers } from '@/components/workflows/triggers/SessionWorkViewWithTriggers';
import { useSessionWorkSources } from '@/components/sessions/work/sessionWorkSources';
import { SessionBoardPane } from '@/components/sessions/board/SessionBoardPane';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
import { getPreferredLanguage, t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { SessionRightPanelBrowserView } from './browser/SessionRightPanelBrowserView';
import { SessionRightPanelServicesView } from './services/SessionRightPanelServicesView';
import { SessionRightPanelScriptsView, useSessionProjectCheckout } from './scripts/SessionRightPanelScriptsView';
import { SessionBrowseFilesSurface } from './surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from './surfaces/SessionGitSurface';
import { SessionTerminalSurface } from './surfaces/SessionTerminalSurface';
import { useSessionFileDetailsOpener } from './useSessionFileDetailsOpener';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import {
    selectPluginDestinationSurfacePlacements,
    selectPluginRightSidebarTabPlacements,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import {
    useSessionAddressForSessionId,
    useSessionPluginRuntime,
    type SessionPaneSurfaceScope,
    type SessionPluginRuntimeState,
} from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useDeviceType } from '@/utils/platform/responsive';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { createSessionBoardDetailsTab } from './details/sessionDetailsTabBuilders';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { useSessionProjectScmIsRepo } from '@/sync/store/hooks';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';

const loadSessionCollaborationSurface = async () => (await import('@/components/sessions/collaboration/SessionCollaborationSurface')).SessionCollaborationSurface;

export type SessionRightPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
    /** Exact AppPane target/projection facts when this panel is driver-rendered. */
    paneSurfaceScope?: SessionPaneSurfaceScope;
    presentation?: 'pane' | 'screen';
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the
     * same surface as the desktop right pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
    /** One executable-mount decision derived by the enclosing Session shell. */
    resolveBoardPrimaryHost?: SessionBoardPrimaryMountResolver;
}>;

const NO_BOARD_PRIMARY_MOUNT: SessionBoardPrimaryMountResolver = () => null;

type RightTabId = string;

const EMPTY_PLUGIN_DESTINATION: PluginUiDestinationReferenceV1 = Object.freeze({
    pluginId: '',
    localId: '',
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        minHeight: 0,
        minWidth: 0,
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

function SessionRetainedPane({ tabId, ...props }: React.ComponentProps<typeof RetainedPanelSurface> & Readonly<{ tabId: string }>) {
    return (
        <RetainedPanelSurface {...props}>
            <SessionPaneErrorBoundary testID={props.testID ?? 'session-rightpanel-pane'}>
                {/* What the tab publishes (its live line and next step) lands on this tab's pane header. */}
                <PaneHeaderSlotScope slotKey={tabId}>
                    {props.children}
                </PaneHeaderSlotScope>
            </SessionPaneErrorBoundary>
        </RetainedPanelSurface>
    );
}

/**
 * Desktop AppPane and standalone fullscreen routes share the same generic
 * handoff owner when nested. A standalone route establishes that owner at its
 * own boundary instead of creating a Session-local launch store.
 */
const SessionRightSidebarContext = React.createContext<ReturnType<typeof useSessionRightSidebarModel> | null>(null);

export function SessionRightSidebarProvider(props: SessionRightPanelProps & Readonly<{ children: React.ReactNode }>) {
    const inherited = React.useContext(SessionRightSidebarContext);
    if (inherited?.scopeId === props.scopeId) return <>{props.children}</>;
    return <SessionRightSidebarScopeProvider {...props} />;
}

function SessionRightSidebarScopeProvider(props: SessionRightPanelProps & Readonly<{ children: React.ReactNode }>) {
    const sessionAddress = useSessionAddressForSessionId(
        props.sessionId,
        props.paneSurfaceScope?.serverId ?? parseSessionPaneScopeId(props.scopeId)?.address?.serverId,
    );
    const pluginRuntime = useSessionPluginRuntime({
        address: sessionAddress,
        paneSurfaceScope: props.paneSurfaceScope,
    });
    const launchScope = usePluginSurfacePaneLaunchScope();
    const content = <SessionRightSidebarModelProvider {...props} sessionAddress={sessionAddress} pluginRuntime={pluginRuntime} />;
    return launchScope?.accountLifetime === pluginRuntime.accountLifetime
        ? content
        : <PluginSurfacePaneLaunchScope accountLifetime={pluginRuntime.accountLifetime}>{content}</PluginSurfacePaneLaunchScope>;
}

type SessionRightSidebarRuntimeProps = Readonly<{
    sessionAddress: ReturnType<typeof useSessionAddressForSessionId>;
    pluginRuntime: SessionPluginRuntimeState;
}>;

function SessionRightSidebarModelProvider(props: SessionRightPanelProps & SessionRightSidebarRuntimeProps & Readonly<{ children: React.ReactNode }>) {
    const model = useSessionRightSidebarModel(props);
    return <SessionRightSidebarContext.Provider value={model}>{props.children}</SessionRightSidebarContext.Provider>;
}

function useSessionRightSidebar() {
    const model = React.useContext(SessionRightSidebarContext);
    if (!model) throw new Error('Session right sidebar requires its scope provider');
    return model;
}

function useSessionRightSidebarModel(props: SessionRightPanelProps & SessionRightSidebarRuntimeProps) {
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability(props.paneSurfaceScope?.serverId ?? parseSessionPaneScopeId(props.scopeId)?.address?.serverId);
    // The Board tab is decided by the EXACT Session's Home, carried by the route
    // or pane scope — never by the ambient preferred/main Home selection.
    const boardFeatureServerId = props.paneSurfaceScope?.serverId
        ?? parseSessionPaneScopeId(props.scopeId)?.address?.serverId
        ?? null;
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(boardFeatureServerId);
    const { sessionAddress, pluginRuntime } = props;
    const collaborationAddress = props.paneSurfaceScope
        ? props.paneSurfaceScope.sessionId === props.sessionId
            ? normalizeSessionAddress(props.paneSurfaceScope.serverId, props.sessionId)
            : null
        : sessionAddress;
    const mountedBoard = useMountedSessionBoardController(collaborationAddress);
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(collaborationAddress?.serverId ?? '');
    const sessionSharingAvailable = collaborationAddress !== null && collaborationAdmitted;
    const session = useSessionViewShellSession(props.sessionId, pluginRuntime.serverId);
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: pluginRuntime.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, pluginRuntime.platform]);
    const pluginRightSidebarPlacements = React.useMemo(() => (
        pluginRuntime.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginRuntime.pluginUiProjection, 'session')
            : []
    ), [pluginRuntime.pluginUiProjection]);
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({
            projection: pluginRuntime.pluginUiProjection,
            locale: pluginLocale,
        }),
        [pluginLocale, pluginRuntime.pluginUiProjection],
    );
    const appTabInputs = useAppRightSidebarTabInputs();
    // A no-folder session shows Git only once its private folder is a repository.
    const withoutFolder = readSessionDirectoryKind(session ? readSessionOwnerMetadataView(session) : null) === 'managed';
    const folderIsRepo = useSessionProjectScmIsRepo(withoutFolder ? props.sessionId : null, pluginRuntime.serverId);
    const sourceControlTabAvailable = !withoutFolder || folderIsRepo === true;
    // The Session's accepted Project checkout, when it works in one: Scripts beside the transcript (lab `s-agent` PANE).
    const projectCheckout = useSessionProjectCheckout(session, pluginRuntime.serverId);
    const rightPanelTabs = React.useMemo(() => resolveSessionRightSidebarTabs({
        ...appTabInputs,
        sessionSharingAvailable,
        sourceControlTabAvailable,
        sessionProjectCheckoutAvailable: projectCheckout !== null,
        terminalTabAvailable,
        boardFeatureEnabled,
        presentation: props.presentation === 'screen' ? 'mobile' : 'desktop',
        pluginPlacements: pluginRightSidebarPlacements,
        projectionGeneration: pluginRuntime.pluginUiProjection?.generation ?? null,
        runtimeAdmission,
        localize: localizePluginText,
    }), [
        appTabInputs,
        sessionSharingAvailable,
        boardFeatureEnabled,
        localizePluginText,
        pluginRuntime.pluginUiProjection?.generation,
        pluginRightSidebarPlacements,
        props.presentation,
        runtimeAdmission,
        sourceControlTabAvailable,
        projectCheckout,
        terminalTabAvailable,
    ]);
    const rightTabSelection = React.useMemo(() => resolveRightSidebarTabSelection<RightTabId>({
        activeTabId: scopeState?.right.activeTabId,
        selectedDestination: scopeState?.right.selectedDestination,
        tabs: rightPanelTabs,
        projectionPhase: pluginRuntime.phase,
    }), [
        pluginRuntime.phase,
        rightPanelTabs,
        scopeState?.right.activeTabId,
        scopeState?.right.selectedDestination,
    ]);
    const activeTab = rightTabSelection.kind === 'available'
        ? rightTabSelection.tab.id
        : null;
    const resolveBoardPrimaryHost = props.resolveBoardPrimaryHost ?? NO_BOARD_PRIMARY_MOUNT;
    const callerHostedHtmlRuntime = mountedBoard?.callerHostedHtmlRuntime ?? null;
    const activePluginPlacement = rightTabSelection.kind === 'available'
        && rightTabSelection.tab.owner === 'plugin'
        ? rightTabSelection.tab.placement
        : null;
    const activeInstanceKey = scopeState?.right.selectedDestination?.kind === 'plugin'
        ? scopeState.right.selectedDestination.instanceKey
        : undefined;
    const paneLaunchScope = usePluginSurfacePaneLaunchScope();
    if (!paneLaunchScope) {
        // The wrapper above always supplies the scope. Do not create an
        // unbound Session-local input owner if that invariant is broken.
        return null;
    }
    const { accountLifetime, store: paneLaunchStore } = paneLaunchScope;
    const scopedLaunchFacts = React.useMemo(() => Object.freeze({
        serverId: pluginRuntime.serverId ?? null,
        machineId: pluginRuntime.machineId ?? null,
        generation: pluginRuntime.pluginUiProjection?.generation ?? null,
        interactionEnabled: pluginRuntime.phase === 'current'
            && pluginRuntime.interactionEnabled === true,
    }), [
        pluginRuntime.interactionEnabled,
        pluginRuntime.phase,
        pluginRuntime.machineId,
        pluginRuntime.pluginUiProjection?.generation,
        pluginRuntime.serverId,
    ]);
    const activePaneLaunch = usePluginSurfacePaneLaunch({
        store: paneLaunchStore,
        placement: activePluginPlacement,
        targetKind: 'session',
        container: 'rightSidebarTab',
        accountLifetime,
        scopedLaunchFacts,
        destination: activePluginPlacement?.binding.destination ?? EMPTY_PLUGIN_DESTINATION,
        ...(activeInstanceKey === undefined ? {} : { instanceKey: activeInstanceKey }),
    });

    const setActiveTab = React.useCallback((tabId: RightTabId) => {
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
        pane.openRight({ tabId });
        paneLaunchStore.retire();
    }, [pane, paneLaunchStore, rightPanelTabs]);

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
    const inheritedNavigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const targetNavigationBinding = inheritedNavigationBinding?.targetKind === 'session'
        ? inheritedNavigationBinding
        : null;
    const fallbackNavigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: pluginRuntime.pluginUiProjection
            ? selectPluginDestinationSurfacePlacements(pluginRuntime.pluginUiProjection)
            : [],
        targetKind: 'session',
        accountLifetime,
        scopedLaunchFacts,
        runtimeAdmission,
        enclosingOpenSurface: inheritedNavigationBinding?.openSurface,
    });
    const navigationBinding = targetNavigationBinding ?? fallbackNavigationBinding;
    const sidebarOwner = React.useMemo(() => ({
        container: 'rightSidebarTab' as const,
        handler: openRightSidebarTab,
    }), [openRightSidebarTab]);
    // The session shell remains the target-scope right-sidebar owner while it
    // is mounted, including before this pane is selected. A standalone screen
    // has no shell binding, so it registers this incumbent owner against its
    // own fallback binding instead. Registering both would make ownership
    // ambiguous once the sidebar mounts.
    useRegisterPluginSurfaceDestinationNavigationOwner(
        targetNavigationBinding ? null : sidebarOwner,
        navigationBinding,
    );
    const openSurface = navigationBinding.openSurface;
    const pluginBinding = React.useMemo<BoundPluginSurfaceBinding>(() => ({ openSurface }), [openSurface]);

    const { openFileInDetails, openFileInDetailsPinned } = useSessionFileDetailsOpener(props.scopeId);
    const availableTabIds = React.useMemo(() => new Set(rightPanelTabs.map((tab) => tab.id)), [rightPanelTabs]);
    const openBoardItemInDetails = React.useCallback((itemId: string) => {
        pane.openDetailsTab(createSessionBoardDetailsTab({ kind: 'item', itemId }), { intent: 'pinned' });
    }, [pane]);
    const openBoardInDetails = React.useCallback(() => {
        pane.openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' });
    }, [pane]);

    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: 'sessionDetails',
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        sessionId: props.sessionId,
    });

    return {
        scopeId: props.scopeId,
        sessionId: props.sessionId,
        pane,
        scopeState,
        rightPanelTabs,
        rightTabSelection,
        activeTab,
        collaborationAddress,
        pluginRuntime,
        activePaneLaunch,
        activeInstanceKey,
        pluginBinding,
        availableTabIds,
        resolveBoardPrimaryHost,
        callerHostedHtmlRuntime,
        session,
        projectCheckout,
        openBoardItemInDetails,
        openBoardInDetails,
        openServiceInBrowser,
        openFileInDetails,
        openFileInDetailsPinned,
        setActiveTab,
    };
}

export const SessionRightPanel = React.memo((props: SessionRightPanelProps) => (
    <SessionRightSidebarProvider {...props}>
        <SessionRightPanelContent {...props} />
    </SessionRightSidebarProvider>
));

const SessionRightPanelContent = React.memo((props: SessionRightPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const headerPaddingTop = 10;
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const closeButtonAtStart = props.presentation === 'screen' && Platform.OS !== 'web';
    const externalRail = usePaneActionRail() && props.presentation !== 'screen';
    const headerSafeAreaTop = closeButtonAtStart ? 0 : insets.top;
    const deviceType = useDeviceType();
    const stateSize = props.presentation === 'screen' && deviceType === 'phone' ? 'phone' : 'pane';
    const { pane, scopeState, rightPanelTabs, rightTabSelection, activeTab, collaborationAddress, pluginRuntime, activePaneLaunch, activeInstanceKey, pluginBinding, availableTabIds, resolveBoardPrimaryHost, callerHostedHtmlRuntime, session, projectCheckout, openBoardItemInDetails, openBoardInDetails, openServiceInBrowser, openFileInDetails, openFileInDetailsPinned, setActiveTab } = useSessionRightSidebar();
    const closeNavigationPane = props.onRequestClose ?? pane.closeRight;
    // A pane can be kept in the Companion as one link row (lab WC3); the header's ⋯ offers it.
    const paneCompanionActions = usePaneCompanionActions({
        sessionId: props.sessionId,
        serverId: pluginRuntime.serverId,
        paneId: activeTab,
    });
    // On `screen` presentation this panel IS a route of its own and the transcript lives on
    // another one, so a navigation jump has to bring the transcript back before it can land.
    // Beside a mounted transcript (the desktop pane) there is nothing to reveal, and closing
    // the pane on every jump would throw the reader's navigation list away.
    const revealTranscriptForNavigationJump = props.presentation === 'screen'
        ? closeNavigationPane
        : undefined;

    const closeButton = (
        <IconButton
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-close')}
            onPress={props.onRequestClose ?? pane.closeRight}
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('common.close')}
            variant="plain"
            size={resolveTouchTargetFloorPx() ?? 36}
            iconName={closeButtonAtStart ? (Platform.OS === 'ios' ? 'caret-left' : 'arrow-left') : 'x'}
            iconSize={closeButtonAtStart ? 24 : 16}
        />
    );

    return (
        <PaneHeaderSlotProvider>
        <View testID="session-right-panel-root" style={styles.container}>
            {!externalRail ? <View style={[styles.header, { paddingTop: headerPaddingTop + headerSafeAreaTop }]}>
                {closeButtonAtStart ? closeButton : null}
                <View style={styles.tabBarContainer}>
                    <RightSidebarIconTabBar
                        tabs={rightPanelTabs}
                        activeTabId={activeTab ?? ''}
                        onSelectTab={setActiveTab}
                        testIDPrefix={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-tab') ?? undefined}
                    />
                </View>
                {closeButtonAtStart ? null : closeButton}
            </View> : null}
            <RightSidebarPaneHeader
                tabs={rightPanelTabs}
                activeTabId={activeTab}
                menuActions={paneCompanionActions}
                testID="session-rightpanel-header"
            />
            <View style={styles.body}>
                {/* Pane-states lab 0: every state inside the pane takes the pane's size (phone: its own step). */}
                <SurfaceStateSizeProvider size={stateSize}>
                {rightTabSelection.kind === 'unresolved' ? (
                    <PaneLoadingFallback />
                ) : rightTabSelection.kind === 'unavailable' ? (
                    <PluginReactNativeUnavailable diagnostics={[rightTabSelection.reason]} />
                ) : (
                    <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                        <SessionRetainedPane
                            tabId="git"
                            isActive={activeTab === 'git'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-git')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <SessionGitSurface sessionId={props.sessionId} scopeId={props.scopeId} serverId={props.paneSurfaceScope?.serverId ?? parseSessionPaneScopeId(props.scopeId)?.address?.serverId} />
                            </React.Suspense>
                        </SessionRetainedPane>
                        <SessionRetainedPane
                            tabId="files"
                            isActive={activeTab === 'files'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-files')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <SessionBrowseFilesSurface
                                    scopeId={props.scopeId}
                                    sessionId={props.sessionId}
                                    serverId={props.paneSurfaceScope?.serverId ?? parseSessionPaneScopeId(props.scopeId)?.address?.serverId}
                                    onOpenFile={openFileInDetails}
                                    onOpenFilePinned={openFileInDetailsPinned}
                                />
                            </React.Suspense>
                        </SessionRetainedPane>
                        <SessionRetainedPane
                            tabId="agents"
                            isActive={activeTab === 'agents'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-agents')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <SessionWorkViewWithTriggers
                                    sessionId={props.sessionId}
                                    scopeId={props.scopeId}
                                    serverId={props.paneSurfaceScope?.serverId ?? parseSessionPaneScopeId(props.scopeId)?.address?.serverId}
                                />
                            </React.Suspense>
                        </SessionRetainedPane>
                        <SessionRetainedPane
                            tabId="navigation"
                            isActive={activeTab === 'navigation'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-navigation')}
                        >
                            <SessionTranscriptNavigationPane
                                onRequestClose={closeNavigationPane}
                                onRevealTranscript={revealTranscriptForNavigationJump}
                                sessionId={props.sessionId}
                                testIDPrefix="session-transcript-navigation"
                            />
                        </SessionRetainedPane>
                        {availableTabIds.has('collaboration') && collaborationAddress ? (
                            <SessionRetainedPane
                                tabId="collaboration"
                                isActive={activeTab === 'collaboration'}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-collaboration')}
                            >
                                <SessionPaneLazyLoader
                                    key={sessionAddressKey(collaborationAddress)}
                                    testID="session-collaboration-loading"
                                    load={loadSessionCollaborationSurface}
                                    props={{ target: collaborationAddress }}
                                />
                            </SessionRetainedPane>
                        ) : null}
                        {availableTabIds.has('board') && session && (
                            <SessionRetainedPane
                                tabId="board"
                                isActive={activeTab === 'board'}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-board')}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback />}>
                                    <SessionBoardPane
                                        sessionId={props.sessionId}
                                        session={session}
                                        serverId={pluginRuntime.serverId}
                                        host="sidebar"
                                        resolvePrimaryHost={resolveBoardPrimaryHost}
                                        density="compact"
                                        layout="single"
                                        interaction="navigation"
                                        onOpenItemHere={openBoardItemInDetails}
                                        onOpenBoardDetails={openBoardInDetails}
                                        pluginRuntime={pluginRuntime}
                                        {...(callerHostedHtmlRuntime ? { callerHostedHtmlRuntime } : {})}
                                    />
                                </React.Suspense>
                            </SessionRetainedPane>
                        )}
                        {availableTabIds.has('terminal') && (
                            <SessionRetainedPane
                                tabId="terminal"
                                isActive={activeTab === 'terminal'}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-terminal')}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback />}>
                                    <SessionTerminalSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                                </React.Suspense>
                            </SessionRetainedPane>
                        )}
                        {availableTabIds.has('browser') && (
                            <SessionRetainedPane
                                tabId="browser"
                                isActive={activeTab === 'browser'}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-browser')}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback />}>
                                    <SessionRightPanelBrowserView
                                        sessionId={props.sessionId}
                                        pluginProjection={pluginRuntime}
                                    />
                                </React.Suspense>
                            </SessionRetainedPane>
                        )}
                        {availableTabIds.has('scripts') && projectCheckout ? (
                            <SessionRetainedPane
                                tabId="scripts"
                                isActive={activeTab === 'scripts'}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-scripts')}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback />}>
                                    <SessionRightPanelScriptsView checkout={projectCheckout} outputScopeId={props.scopeId} />
                                </React.Suspense>
                            </SessionRetainedPane>
                        ) : null}
                        {availableTabIds.has('services') && (
                            <SessionRetainedPane
                                tabId="services"
                                isActive={activeTab === 'services'}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-services')}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback />}>
                                    <SessionRightPanelServicesView
                                        sessionId={props.sessionId}
                                        pluginUiProjection={pluginRuntime.pluginUiProjection}
                                        projectionInteractionEnabled={pluginRuntime.phase === 'current'
                                            && pluginRuntime.interactionEnabled === true}
                                        platform={pluginRuntime.platform}
                                        machineId={pluginRuntime.machineId}
                                        serverId={pluginRuntime.serverId}
                                        onOpenServiceInBrowser={openServiceInBrowser}
                                    />
                                </React.Suspense>
                            </SessionRetainedPane>
                        )}
                        {rightPanelTabs
                            .filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin')
                            .map((tab) => tab.disabledReason ? null : (
                                <SessionRetainedPane
                                    key={tab.retentionKey}
                                    tabId={tab.id}
                                    isActive={activeTab === tab.id}
                                    mode="absolute-overlay"
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-rightpanel-surface-${tab.id}`)}
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
                                            machineId={pluginRuntime.machineId}
                                            serverId={pluginRuntime.serverId}
                                            sessionId={props.sessionId}
                                            pluginUiProjection={pluginRuntime.pluginUiProjection}
                                            projectionInteractionEnabled={pluginRuntime.phase === 'current'
                                                && pluginRuntime.interactionEnabled === true}
                                            platform={pluginRuntime.platform}
                                            binding={activeTab === tab.id ? pluginBinding : undefined}
                                            launchInput={activeTab === tab.id ? activePaneLaunch?.input : undefined}
                                            mountInstanceKey={activeTab === tab.id ? activeInstanceKey : undefined}
                                        />}
                                    </React.Suspense>
                                </SessionRetainedPane>
                            ))}
                    </View>
                )}
                </SurfaceStateSizeProvider>
            </View>
        </View>
        </PaneHeaderSlotProvider>
    );
});

export const SessionActionRail = React.memo(() => {
    const model = useSessionRightSidebar();
    const terminal = useSessionTerminalAction({ sessionId: model.sessionId, scopeId: model.scopeId, serverId: model.pluginRuntime.serverId });
    // The Work tab's badge is the Work projection's outstanding count (D-S4): the same number the
    // header strip shows, read from the one owner the Session host mounted — never a second count.
    const workProjection = useSessionWorkSources()?.projection;
    const runningCount = workProjection?.summary.outstanding ?? 0;
    // Scripts counts this Session's own finite runs that are still working (the same Work operations).
    const runningScripts = workProjection?.projectCommands.filter((item) => item.status.bucket === 'working').length ?? 0;
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    // The rail reads only the one summary bit; the dot itself subscribes in its own leaf.
    const collaborationMentioned = useSessionConversationMentioned(model.collaborationAddress);
    const actions: RightSidebarRailAction[] = [];
    for (const tab of model.rightPanelTabs) {
        // One terminal action owns all dock locations; the catalog retains its sidebar admission.
        if (tab.id === 'terminal') continue;
        const badgeCount = tab.id === 'agents' ? runningCount : tab.id === 'scripts' ? runningScripts : undefined;
        actions.push({
            id: tab.id,
            label: badgeCount && badgeCount > 0
                ? tab.id === 'scripts'
                    ? t('projects.scripts.tabRunning', { count: String(badgeCount) })
                    : t('session.subagents.panel.tabWithRunningCount', { count: badgeCount })
                : tab.id === 'collaboration' && collaborationMentioned
                    ? `${getRightSidebarTabLabel(tab)}. ${t('session.collaboration.discussion.mentioned')}`
                    : getRightSidebarTabLabel(tab),
            icon: tab.icon,
            // Plugin tabs sit after the built-in groups, behind their own hairline.
            group: tab.owner === 'builtin' ? tab.railGroup : 'plugins',
            active: Boolean(model.scopeState?.right.isOpen && !rightPaneHiddenByDetails && model.activeTab === tab.id),
            disabled: Boolean(tab.disabledReason),
            badgeCount,
            badge: tab.id === 'git' ? <SessionGitActionRailBadge sessionId={model.sessionId} serverId={model.pluginRuntime.serverId} />
                : tab.id === 'collaboration' && model.collaborationAddress ? <SessionCollaborationRailBadge target={model.collaborationAddress} />
                    : undefined,
            tooltipContent: tab.id === 'git' ? <SessionGitActionRailTooltip sessionId={model.sessionId} serverId={model.pluginRuntime.serverId} /> : undefined,
            onPress: () => toggleRightSidebarTab(model.pane, tab.id, model.activeTab, model.setActiveTab, rightPaneHiddenByDetails),
        });
        if (tab.id === 'git') actions.push({
            id: 'review', label: t('files.toolbar.review'), icon: 'file-diff', group: 'code',
            active: Boolean(model.scopeState?.details.isOpen && model.scopeState.details.activeTabKey === SESSION_DETAILS_SCM_REVIEW_TAB_KEY),
            onPress: () => toggleSessionReview(model.pane),
        });
    }
    if (terminal.available) {
        // The terminal closes the machine group, ahead of any plugin tabs.
        const firstPlugin = actions.findIndex((action) => action.group === 'plugins');
        actions.splice(firstPlugin === -1 ? actions.length : firstPlugin, 0, {
            id: 'terminal', label: t('settings.terminal'), icon: 'terminal', group: 'machine', active: terminal.active, onPress: terminal.onPress,
            badge: terminal.active ? undefined : <SessionTerminalRailBadge sessionId={model.sessionId} serverId={model.pluginRuntime.serverId ?? null} />,
        });
    }
    return <RightSidebarActionRail surfaceId="sessionRail" actions={actions} testID="session-action-rail" testIDPrefix="session-action-rail" />;
});
