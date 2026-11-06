import { DetailNavigationItemsContext, useDetailNavigationItems } from '@/components/appShell/rightSidebar/useDetailNavigationItems';
import { isSessionRailCompanion, resolveSessionNavigationCustomizerProps, sessionPageDefaultPlacement } from './sessionNavigationCustomizer';
import type { DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { SessionTerminalRailBadge } from '@/components/sessions/terminal/strip/SessionTerminalRailBadge';
import { SessionGitActionRailBadge, SessionGitActionRailTooltip } from './SessionGitActionRailBadge';
import { SessionCollaborationRailBadge, useSessionConversationMentioned } from '@/components/sessions/collaboration/sessionConversationAttention';
import { parseSessionPaneScopeId } from './sessionPaneScopeId';
import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import * as React from 'react';
import { Platform, View } from 'react-native';

import { PopoverScope } from '@/components/ui/popover';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { useReportRightPanePlacement, type RightPaneSurface } from '@/components/appShell/panes/rightPanePlacement';
import { usePaneActionRail, usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { RightSidebarActionRail, type RightSidebarRailAction } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { openRightSidebarBuiltinTab, usePublishRightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
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
    resolveRightSidebarTabSelection,
    resolveRightSidebarTabPlacement,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
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
import { SessionWorkView } from '@/components/sessions/work/SessionWorkView';
import { useSessionWorkSources } from '@/components/sessions/work/sessionWorkSources';
import { readWorkSummaryPresentation } from '@/components/sessions/work/workProjection';
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
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
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
import { useSessionSourceControlAvailability } from '@/hooks/session/sourceControl/sessionSourceControlAvailability';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { CodeIntelligencePaneTab } from '@/components/workspaces/files/intelligence/CodeIntelligencePaneTab';
import { useCodeIntelligencePaneProducer } from '@/components/workspaces/files/intelligence/codeIntelligencePaneStore';
import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';
import { retainShallow } from '@/sync/domains/state/structuralSharing';

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
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
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

const SessionBodyTabContext = React.createContext<string | null>(null);

function SessionRetainedPane({ tabId, ...props }: React.ComponentProps<typeof RetainedPanelSurface> & Readonly<{ tabId: string }>) {
    const bodyTabId = React.useContext(SessionBodyTabContext);
    if (bodyTabId !== null && bodyTabId !== tabId) return null;
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
    // Each keyed body stays under one PaneColumn when its presentation moves. The pane reducer owns
    // both selections; neither changing a companion nor adapting the layout replaces the main page.
    const surfaces = React.useMemo<readonly RightPaneSurface[]>(() => model.bodyTabs.map(tab => {
        const placement = tab.id === model.mainTabId ? 'main' as const
            : model.scopeState?.right.isOpen && tab.id === model.activeTab ? 'side' as const : 'hidden' as const;
        return { id: tab.id, placement, content: (
            <RetainedPanelSurface isActive={placement !== 'hidden'}>
                <SessionRightPanelContent sessionId={props.sessionId} scopeId={props.scopeId}
                    paneSurfaceScope={props.paneSurfaceScope} bodyTabId={tab.id} surfacePlacement={placement} />
            </RetainedPanelSurface>
        ) };
    }), [model.activeTab, model.bodyTabs, model.mainTabId, model.scopeState?.right.isOpen,
        props.paneSurfaceScope, props.scopeId, props.sessionId]);
    const presentation = React.useMemo(() => model.hasMainPages ? {
        surfaces,
        sideVisible: model.scopeState?.right.isOpen === true && model.activeTab !== model.mainTabId,
        onCloseMainSurface: model.backToTranscript,
    } : 'side' as const, [model.activeTab, model.backToTranscript, model.hasMainPages, model.mainTabId, model.scopeState?.right.isOpen, surfaces]);
    useReportRightPanePlacement(presentation);
    return <SessionRightSidebarContext.Provider value={model}>{props.children}</SessionRightSidebarContext.Provider>;
}

function useSessionRightSidebar() {
    const model = React.useContext(SessionRightSidebarContext);
    if (!model) throw new Error('Session right sidebar requires its scope provider');
    return model;
}

/** A bundle of stable members keeps one identity until a member changes, so context consumers wake only for real changes. */
function useRetainedShallow<T extends object>(value: T): T {
    const ref = React.useRef<T | undefined>(undefined);
    const retained = retainShallow(ref.current, value);
    ref.current = retained;
    return retained;
}

function useSessionRightSidebarModel(props: SessionRightPanelProps & SessionRightSidebarRuntimeProps) {
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const layout = useOptionalAppPaneScopeLayout();
    const mainColumn = usePaneMainColumn();
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const placementContext = React.useMemo(() => ({
        scope: 'session' as const,
        arrangement: layout?.arrangement ?? 'session',
        presentation: props.presentation === 'screen' || deviceType === 'phone' ? 'mobile' as const : 'desktop' as const,
    }), [deviceType, layout?.arrangement, props.presentation]);
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
    const sourceControlTabAvailable = useSessionSourceControlAvailability(props.sessionId, pluginRuntime.serverId);
    // The Session's accepted Project checkout, when it works in one: Scripts beside the transcript (lab `s-agent` PANE).
    const projectCheckout = useSessionProjectCheckout(session, pluginRuntime.serverId);
    const terminal = useSessionTerminalAction({ sessionId: props.sessionId, scopeId: props.scopeId, serverId: pluginRuntime.serverId });
    const computer = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: pluginRuntime.serverId });
    const codeIntelligenceAvailable = useCodeIntelligencePaneProducer(props.scopeId) !== null;
    const enclosingNavigation = React.useContext(DetailNavigationItemsContext);
    const detailInput = useRetainedShallow({
        scope: 'session' as const,
        ...appTabInputs,
        codeIntelligenceAvailable,
        sessionSharingAvailable,
        sourceControlTabAvailable,
        sessionProjectCheckoutAvailable: projectCheckout !== null,
        terminalTabAvailable: placementContext.presentation === 'mobile' ? terminalTabAvailable : terminal.available,
        computerAvailable: computer !== null,
        computerDisabledReason: computer?.disabledReason ?? undefined,
        arrangement: placementContext.arrangement,
        boardFeatureEnabled,
        presentation: placementContext.presentation,
        pluginPlacements: pluginRightSidebarPlacements,
        runtimeAdmission,
        localize: localizePluginText,
    });
    const rightPanelTabs = useDetailNavigationItems(detailInput, enclosingNavigation?.scopeId === props.scopeId ? enclosingNavigation : undefined);
    // Page-only entries and external presenters never select this retained sidebar body.
    const bodyTabs = React.useMemo(() => rightPanelTabs.filter(tab => tab.navigation.kind !== 'page'
        && tab.id !== 'companion' && tab.id !== 'review' && tab.id !== 'computer'), [rightPanelTabs]);
    const rightTabSelection = React.useMemo(() => resolveRightSidebarTabSelection<RightTabId>({
        activeTabId: scopeState?.right.activeTabId,
        selectedDestination: scopeState?.right.selectedDestination,
        tabs: bodyTabs,
        projectionPhase: pluginRuntime.phase,
    }), [
        pluginRuntime.phase,
        bodyTabs,
        scopeState?.right.activeTabId,
        scopeState?.right.selectedDestination,
    ]);
    const activeTab = rightTabSelection.kind === 'available'
        ? rightTabSelection.tab.id
        : null;
    const hasMainPages = placementContext.presentation === 'desktop' && placementContext.arrangement === 'editor';
    const mainTabId = hasMainPages ? scopeState?.mainTabId ?? null : null;
    const setMainHidden = mainColumn?.setHidden;
    const showMain = React.useCallback(() => setMainHidden?.(false), [setMainHidden]);
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
        throw new Error('Session right sidebar requires its pane launch scope');
    }
    const { accountLifetime, store: paneLaunchStore } = paneLaunchScope;
    const scopedLaunchFacts = React.useMemo(() => Object.freeze({
        serverId: pluginRuntime.serverId ?? null,
        machineId: pluginRuntime.machineId ?? null,
        interactionEnabled: pluginRuntime.phase === 'current'
            && pluginRuntime.interactionEnabled === true,
    }), [
        pluginRuntime.interactionEnabled,
        pluginRuntime.phase,
        pluginRuntime.machineId,
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

    const setActiveTab = React.useCallback((tabId: RightTabId, column?: 'main' | 'side') => {
        const tab = rightPanelTabs.find((candidate) => candidate.id === tabId) ?? null;
        if (!tab || tab.disabledReason) {
            return;
        }
        const placement = column ?? resolveRightSidebarTabPlacement(tab, placementContext);
        if (placement === 'main') {
            if (tab.id === 'chat') { pane.setMainTab(null); return; }
            if (tab.navigation.kind !== 'companion' && tab.navigation.desktop !== 'none') {
                if (tab.owner === 'builtin') openRightSidebarBuiltinTab(pane, tab, placementContext, showMain, placement);
            }
            return;
        }
        if (tab.id === 'review') { toggleSessionReview(pane); return; }
        if (tab.id === 'terminal') { terminal.onPress(); return; }
        if (tab.id === 'computer') { computer?.open(); return; }
        if (tab.owner === 'plugin') {
            pane.selectRightDestination({
                kind: 'plugin',
                destination: tab.placement.binding.destination,
            });
            paneLaunchStore.retire();
            return;
        }
        openRightSidebarBuiltinTab(pane, tab, placementContext, showMain, placement);
        paneLaunchStore.retire();
    }, [pane, paneLaunchStore, placementContext, rightPanelTabs, showMain, terminal.onPress, computer]);

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

    const { open: openWorkspaceFile } = useWorkspaceFileOpener();
    const openFileInDetails = React.useCallback((path: string) => {
        if (!sessionAddress) return;
        void openWorkspaceFile({ kind: 'session', ...sessionAddress, path });
    }, [openWorkspaceFile, sessionAddress]);
    const openFileInDetailsPinned = React.useCallback((path: string) => {
        if (!sessionAddress) return;
        void openWorkspaceFile({ kind: 'session', ...sessionAddress, path }, { intent: 'pinned' });
    }, [openWorkspaceFile, sessionAddress]);
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
        accountLifetime: pluginRuntime.accountLifetime,
        machineId: pluginRuntime.machineId,
        serverId: pluginRuntime.serverId,
        sessionId: props.sessionId,
    });

    const navigationItems = React.useMemo<readonly DetailPageNavigationItem[]>(() => rightPanelTabs.map(tab => ({
        id: tab.id, title: getRightSidebarTabLabel(tab), icon: tab.icon, disabledReason: tab.disabledReason ?? null,
        navigation: tab.navigation, phonePlacement: tab.phonePlacement, phoneOrder: tab.phoneOrder,
        defaultPlacement: sessionPageDefaultPlacement(tab), allowedPlacements: tab.allowedPlacements,
    })), [rightPanelTabs]);
    const companionItems = React.useMemo(() => navigationItems.filter(item => {
        const tab = rightPanelTabs.find(tab => tab.id === item.id)!;
        return isSessionRailCompanion(tab) && !tab.hiddenInLauncher;
    }), [navigationItems, rightPanelTabs]);
    const mainControls = React.useRef(mainColumn);
    mainControls.current = mainColumn;
    const navigationScope = useActiveServerAccountScope(sessionAddress?.serverId ?? null);
    const chromeRevision = React.useMemo(() => ({ hidden: mainColumn?.hidden, mainTabId, activeTab,
        rightOpen: scopeState?.right.isOpen, rightPaneHiddenByDetails }),
    [mainColumn?.hidden, mainTabId, activeTab, scopeState?.right.isOpen, rightPaneHiddenByDetails]);
    const navigation = useRetainedShallow(usePresentedDetailNavigation({ pageKind: 'session',
        identity: sessionAddress ? sessionAddressKey(sessionAddress) : props.scopeId,
        sessionId: props.sessionId, scope: navigationScope, title: t('navigationPlacement.contextSession'),
        items: navigationItems, activeId: mainTabId ?? 'chat', phone: false,
        presented: placementContext.presentation === 'desktop', mainControls, chromeRevision,
        selectPage: id => setActiveTab(id, 'main'),
        companion: { items: companionItems, activeId: activeTab,
            select: id => {
                if (rightPaneHiddenByDetails === true && id !== 'review' && id !== 'terminal' && id !== 'computer') pane.closeDetails();
                setActiveTab(id, 'side');
            }, close: () => pane.closeRight() },
        columnState: column => column === 'main'
            ? { visible: !mainColumn?.hidden, activeTab: mainTabId ?? 'chat', setVisible: visible => mainColumn?.setHidden(!visible) }
            : { visible: scopeState?.right.isOpen === true && activeTab !== mainTabId,
                activeTab: activeTab ?? undefined, setVisible: visible => { if (visible) pane.openRight(); else pane.closeRight(); } },
        customizer: device => resolveSessionNavigationCustomizerProps({ device, detailInput,
            arrangement: placementContext.arrangement, desktopItems: rightPanelTabs,
            phonePageTabs: storage.getState().settings.mobileWorkspaceExperienceV1 !== 'classic' }),
    }));

    const executeNavigation = useMountedScopeActionCommand(navigationScope);
    const selectTab = React.useCallback((tabId: RightTabId, column?: 'main' | 'side') => {
        const tab = column ? null : rightPanelTabs.find(candidate => candidate.id === tabId);
        const target = column ?? (tab ? resolveRightSidebarTabPlacement(tab, placementContext) : null);
        if (!target) return;
        void executeNavigation('shell.column.set', { column: target, visible: true, tab: tabId },
            { kind: 'shell.column', column: target, read: () => navigation.readColumn(target) });
    }, [executeNavigation, navigation.readColumn, placementContext, rightPanelTabs]);
    const backToTranscript = React.useCallback(() => selectTab('chat', 'main'), [selectTab]);
    const closeRight = React.useCallback(() => {
        void executeNavigation('shell.column.set', { column: 'side', visible: false },
            { kind: 'shell.column', column: 'side', read: () => navigation.readColumn('side') });
    }, [executeNavigation, navigation.readColumn]);

    return useRetainedShallow({
        scopeId: props.scopeId,
        sessionId: props.sessionId,
        pane,
        terminal,
        computer,
        scopeState,
        rightPanelTabs,
        /** Read when Customize opens: each device's list resolves through the same owner. */
        detailInput,
        bodyTabs,
        rightTabSelection,
        activeTab,
        mainTabId,
        hasMainPages,
        backToTranscript,
        placementContext,
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
        selectTab,
        closeRight,
        executeNavigation,
        navigation,
    });
}

/** UI consumes the canonical selected tab; Back closes its presentation without replacing selection. */
export function useSessionRightSidebarPresentation() {
    const model = useSessionRightSidebar();
    return {
        placement: model.mainTabId ? 'main' as const : 'side' as const,
        sessionColumnTab: model.rightPanelTabs.find(tab => tab.id === model.mainTabId) ?? null,
        backToTranscript: model.backToTranscript,
        selectTab: model.selectTab,
    };
}

/**
 * The Session column's page tabs (desktop Editor first, plan T U1): Chat, then the pages kept on the
 * strip. Null when Chat is the only page, so a single-view Session draws no strip.
 */
function useSessionPageStrip(model: ReturnType<typeof useSessionRightSidebarModel> | null) {
    const placements = model?.navigation.desktop;
    return React.useMemo(() => {
        if (!model?.hasMainPages || !placements) return null;
        const pinned = placements.pinned.filter(item => item.id !== 'chat');
        const overflow = placements.overflow.filter(item => item.id !== 'chat');
        return pinned.length + overflow.length > 0
            ? { ...placements, pinned, overflow, ordered: placements.ordered.filter(item => item.id !== 'chat') } : null;
    }, [model?.hasMainPages, placements]);
}

/** Desktop top tabs: they switch the Session column between Chat and its pages; the rail opens companions beside it. */
export const SessionPageTabs = React.memo(function SessionPageTabs() {
    const model = React.useContext(SessionRightSidebarContext);
    const strip = useSessionPageStrip(model);
    const { theme } = useUnistyles();
    if (!model || !strip) return null;
    const glyphColor = theme.colors.text.secondary;
    const toTab = (tab: DetailPageNavigationItem) => ({
        id: tab.id, label: tab.title, icon: <Icon name={tab.icon} size={ICON_SIZE.sm} color={glyphColor} />,
        disabled: Boolean(tab.disabledReason), ...(tab.disabledReason ? { unavailableReason: tab.disabledReason } : {}),
    });
    const activeTabId = model.mainTabId ?? 'chat';
    // A page opened from elsewhere (an Action, a link) while hidden from the strip still shows as the selected tab.
    const activeHidden = model.mainTabId !== null && !strip.ordered.some(entry => entry.id === model.mainTabId && strip.effectivePlacements[entry.id] !== 'hidden')
        ? model.navigation.model.items.find(tab => tab.id === model.mainTabId) ?? null : null;
    const chat = { id: 'chat', label: t('phoneNav.rail.chatPane'), icon: <Icon name="chat-circle" size={ICON_SIZE.sm} color={glyphColor} /> };
    const customize = () => { void model.navigation.openNavigationCustomizer(); };
    return <View testID="session-page-tabs" style={[pageTabStyles.strip, { borderBottomColor: theme.colors.border.subtle }]}>
        <SegmentedTabBar
            presentation="plain"
            iconPlacement="leading"
            segmentSizing="content"
            tabs={[chat, ...strip.pinned.filter(entry => entry.id !== 'chat').map(toTab)]}
            overflow={{ label: t('common.more'), testID: 'session-page-tabs.more',
                items: [...strip.overflow.filter(entry => entry.id !== 'chat'), ...(activeHidden ? [activeHidden] : [])].map(toTab),
                orderedIds: ['chat', ...strip.ordered.map(tab => tab.id)],
                actions: [{ id: 'customize', label: t('navigationPlacement.customizeTabs'),
                    icon: <Icon name="sliders-horizontal" size={ICON_SIZE.sm} color={glyphColor} />,
                    testID: 'session-page-tabs.more.customize', onPress: customize }] }}
            activeTabId={activeTabId}
            onSelectTab={id => model.selectTab(id, 'main')}
            accessibilityLabel={t('navigationPlacement.topTabs')}
            testIDPrefix="session-page-tabs"
        />
    </View>;
});

const pageTabStyles = StyleSheet.create(theme => ({
    // The Session header's second row (as the Project header's two-row band): the tabs on the band's
    // edge, one hairline under them where the page or the transcript begins.
    strip: {
        flexDirection: 'row',
        minWidth: 0,
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s4,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
}));

export const SessionRightPanel = React.memo((props: SessionRightPanelProps) => (
    <SessionRightSidebarProvider {...props}>
        <SessionRightPanelContent {...props} />
    </SessionRightSidebarProvider>
));

const SessionRightPanelContent = React.memo((props: SessionRightPanelProps & Readonly<{
    bodyTabId?: string;
    surfacePlacement?: RightPaneSurface['placement'];
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    // The pane (header and body) is the boundary its menus and Add surfaces float inside.
    const paneBoundaryRef = React.useRef<View>(null);
    const insets = useChromeSafeAreaInsets();
    const headerPaddingTop = 10;
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const closeButtonAtStart = props.presentation === 'screen' && Platform.OS !== 'web';
    const externalRail = usePaneActionRail() && props.presentation !== 'screen';
    const headerSafeAreaTop = closeButtonAtStart ? 0 : insets.top;
    const deviceType = useDeviceType();
    const stateSize = props.presentation === 'screen' && deviceType === 'phone' ? 'phone' : 'pane';
    const model = useSessionRightSidebar();
    const { pane, scopeState, rightPanelTabs, bodyTabs, collaborationAddress, pluginRuntime, activePaneLaunch, activeInstanceKey, pluginBinding, availableTabIds, resolveBoardPrimaryHost, callerHostedHtmlRuntime, session, projectCheckout, openBoardItemInDetails, openBoardInDetails, openServiceInBrowser, openFileInDetails, openFileInDetailsPinned } = model;
    const bodyTab = props.bodyTabId ? bodyTabs.find(tab => tab.id === props.bodyTabId) : null;
    const rightTabSelection = bodyTab ? { kind: 'available' as const, tab: bodyTab } : model.rightTabSelection;
    const activeTab = props.bodyTabId ? props.surfacePlacement === 'hidden' ? null : props.bodyTabId : model.activeTab;
    const inSessionColumn = props.surfacePlacement === 'main';
    const closeNavigationPane = props.onRequestClose ?? (inSessionColumn ? model.backToTranscript : model.closeRight);
    const selectTab = (tabId: string) => model.selectTab(tabId, inSessionColumn ? 'main' : 'side');
    // Presented inside the session column (Editor first, lab AR1 EFv): a sub-page of the session, with
    // Back to its transcript and the session's own mark and name in the band it covers.
    const presentation = useSessionRightSidebarPresentation();
    const pageStrip = useSessionPageStrip(inSessionColumn ? model : null);
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
            onPress={closeNavigationPane}
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('common.close')}
            variant="plain"
            size={36}
                        minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
            iconName={closeButtonAtStart ? (Platform.OS === 'ios' ? 'caret-left' : 'arrow-left') : 'x'}
            iconSize={closeButtonAtStart ? 24 : 16}
        />
    );

    return (
        <SessionBodyTabContext.Provider value={props.bodyTabId ?? null}>
        <PaneHeaderSlotProvider>
        <View ref={paneBoundaryRef} testID="session-right-panel-root" style={styles.container}>
        <PopoverScope boundaryRef={paneBoundaryRef}>
            {!externalRail ? <View style={[styles.header, { paddingTop: headerPaddingTop + headerSafeAreaTop }]}>
                {closeButtonAtStart ? closeButton : null}
                <View style={styles.tabBarContainer}>
                    <RightSidebarIconTabBar
                        tabs={bodyTabs}
                        activeTabId={activeTab ?? ''}
                        onSelectTab={selectTab}
                        testIDPrefix={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-tab') ?? undefined}
                    />
                </View>
                {closeButtonAtStart ? null : closeButton}
            </View> : null}
            <RightSidebarPaneHeader
                scopeId={props.scopeId}
                tabs={bodyTabs}
                activeTabId={activeTab}
                menuActions={paneCompanionActions}
                // The Session header and its page tabs stay above a page in the column (plan T U1): Chat
                // is the way back when the strip is drawn; without it, Back returns to the transcript.
                onBack={inSessionColumn && !pageStrip ? presentation.backToTranscript : undefined}
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
                        {availableTabIds.has('problems') ? (
                            <SessionRetainedPane tabId="problems" isActive={activeTab === 'problems'} mode="absolute-overlay">
                                <CodeIntelligencePaneTab scopeId={props.scopeId} kind="problems" active={activeTab === 'problems'} />
                            </SessionRetainedPane>
                        ) : null}
                        {availableTabIds.has('references') ? (
                            <SessionRetainedPane tabId="references" isActive={activeTab === 'references'} mode="absolute-overlay">
                                <CodeIntelligencePaneTab scopeId={props.scopeId} kind="references" active={activeTab === 'references'} />
                            </SessionRetainedPane>
                        ) : null}
                        <SessionRetainedPane
                            tabId="agents"
                            isActive={activeTab === 'agents'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-agents')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback />}>
                                <SessionWorkView
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
                            .filter((tab) => tab.owner === 'plugin')
                            .map((tab) => tab.disabledReason ? null : (
                                <SessionRetainedPane
                                    key={tab.id}
                                    tabId={tab.id}
                                    isActive={activeTab === tab.id}
                                    mode="absolute-overlay"
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-rightpanel-surface-${tab.id}`)}
                                >
                                    <React.Suspense fallback={<PaneLoadingFallback />}>
                                        {tab.placement.binding.targetKind === 'app' ? (
                                            <AppRightSidebarTabSurface
                                                placement={tab.placement}
                                                executionTarget={pluginRuntime.serverId && pluginRuntime.machineId
                                                    ? { serverId: pluginRuntime.serverId, machineId: pluginRuntime.machineId } : null}
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
        </PopoverScope>
        </View>
        </PaneHeaderSlotProvider>
        </SessionBodyTabContext.Provider>
    );
});

export const SessionActionRail = React.memo(() => {
    const model = useSessionRightSidebar();
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const side = model.navigation.readColumn('side');
    const main = model.navigation.readColumn('main');
    const sideActions = {
        tabs: side.tabs ?? [], items: side.items, activeTab: side.activeTab,
        selectTab: (id: string) => model.selectTab(id, 'side'),
        main: { tabs: main.tabs ?? [], items: main.items, activeTab: main.activeTab,
            selectTab: (id: string) => model.selectTab(id, 'main') },
    };
    usePublishRightSidebarActions(sideActions);
    const executeNavigation = model.executeNavigation;
    const { terminal, computer } = model;
    // The Work tab's badge is the Work projection's outstanding count (D-S4): the same number the
    // header strip shows, read from the one owner the Session host mounted — never a second count.
    const workProjection = useSessionWorkSources()?.projection;
    const outstandingCount = workProjection?.summary.outstanding ?? 0;
    const workStatus = workProjection ? readWorkSummaryPresentation(workProjection.summary) : null;
    const workLabel = workStatus && workStatus.count > 0 ? t('sessionWork.strip.a11y', { summary:
        workStatus.bucket === 'needs_you' ? t('sessionWork.strip.needsYou', { count: workStatus.count })
            : workStatus.bucket === 'working' ? t('sessionWork.strip.stillWorking', { count: workStatus.count })
                : `${workStatus.count} · ${t('status.offline')}`,
    }) : t('sessionWork.title');
    // Scripts counts this Session's own finite runs that are still working (the same Work operations).
    const runningScripts = workProjection?.projectCommands.filter((item) => item.status.bucket === 'working').length ?? 0;
    // The rail reads only the one summary bit; the dot itself subscribes in its own leaf.
    const collaborationMentioned = useSessionConversationMentioned(model.collaborationAddress);
    const actions: RightSidebarRailAction[] = [];
    for (const tab of model.rightPanelTabs) {
        if (tab.navigation?.kind === 'page' || tab.id === 'companion' || tab.hiddenInLauncher || tab.id === model.mainTabId) continue;
        const badgeCount = tab.id === 'agents' ? outstandingCount : tab.id === 'scripts' ? runningScripts : undefined;
        const active = Boolean(model.scopeState?.right.isOpen && !rightPaneHiddenByDetails && model.activeTab === tab.id);
        actions.push({
            id: tab.id,
            label: tab.id === 'agents' ? workLabel : badgeCount && badgeCount > 0
                ? t('projects.scripts.tabRunning', { count: String(badgeCount) })
                : tab.id === 'collaboration' && collaborationMentioned
                    ? `${getRightSidebarTabLabel(tab)}. ${t('session.collaboration.discussion.mentioned')}`
                    : getRightSidebarTabLabel(tab),
            icon: tab.icon,
            // Plugin tabs sit after the built-in groups, behind their own hairline.
            group: tab.owner === 'builtin' ? tab.railGroup : 'plugins',
            active: tab.id === 'review' ? Boolean(model.scopeState?.details.isOpen && model.scopeState.details.activeTabKey === SESSION_DETAILS_SCM_REVIEW_TAB_KEY)
                : tab.id === 'terminal' ? terminal.active : active,
            disabled: Boolean(tab.disabledReason),
            disabledReason: tab.disabledReason,
            ...(tab.id === 'computer' && computer?.machineName && !computer.disabledReason ? { detail: computer.machineName } : {}),
            defaultPlacement: tab.defaultPlacement ?? (tab.owner === 'plugin' ? 'overflow' : undefined),
            allowedPlacements: tab.allowedPlacements,
            badgeCount,
            badge: tab.id === 'git' ? <SessionGitActionRailBadge sessionId={model.sessionId} serverId={model.pluginRuntime.serverId} />
                : tab.id === 'collaboration' && model.collaborationAddress ? <SessionCollaborationRailBadge target={model.collaborationAddress} />
                    : undefined,
            tooltipContent: tab.id === 'git' ? <SessionGitActionRailTooltip sessionId={model.sessionId} serverId={model.pluginRuntime.serverId} /> : undefined,
            onPress: () => {
                const togglesPresenter = tab.id === 'terminal' || tab.id === 'review' || tab.id === 'computer';
                void executeNavigation('shell.column.set', { column: 'side', visible: !active,
                    ...(!active || togglesPresenter ? { tab: tab.id } : {}),
                }, { kind: 'shell.column', column: 'side', read: () => model.navigation.readColumn('side') });
            },
        });
    }
    const openCustomizer = () => { void model.navigation.openNavigationCustomizer(); };
    return <RightSidebarActionRail surfaceId="sessionRail" actions={actions} testID="session-action-rail" testIDPrefix="session-action-rail"
        onOpenCustomizer={openCustomizer} />;
});
