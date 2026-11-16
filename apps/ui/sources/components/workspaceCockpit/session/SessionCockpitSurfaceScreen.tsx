import { SessionCockpitFullscreenSurface } from './SessionCockpitFullscreenSurface';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import * as React from 'react';
import { BackHandler, Platform, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDestinationFocusSignal, useDestinationInstance, type DestinationInstanceContextValue } from '@/components/appShell/workspace/destinationInstanceContext';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import {
    useSessionCockpitChromeRegister,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { selectSessionCockpitSurface } from '@/components/navigation/mobile/chrome/cockpitSelection';
import { SessionCockpitTabBar, SessionPhonePageStrip } from '@/components/navigation/mobile/chrome/bars/SessionCockpitTabBar';
import { usePresentedDetailNavigation, type DetailPhoneChrome } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import type { DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { resolveSessionNavigationCustomizerProps } from '@/components/sessions/panes/sessionNavigationCustomizer';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { BrowserMobileSurfaceScreen } from '@/components/browser/surfaces/BrowserMobileSurfaceScreen';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useDetailsTabCount } from '@/components/appShell/panes/hooks/useDetailsTabCount';
import { usePanePresentation } from '@/components/appShell/panes/panePresentation';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import {
    createPluginSurfaceDestinationOpenSurfaceHandler,
    PluginSurfacePaneLaunchScope,
    stagePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
    usePluginSurfaceDestinationNavigationBinding,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import type { TranscriptExperience } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanelHost';
import { PaneRegionProvider } from '@/components/appShell/panes/paneRegion';
import {
    createSessionCommitDetailsTab,
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
import { SessionBrowseFilesSurface } from '@/components/sessions/panes/surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from '@/components/sessions/panes/surfaces/SessionGitSurface';
import { SessionTerminalSurface } from '@/components/sessions/panes/surfaces/SessionTerminalSurface';
import { parseSessionPaneUrlState, type SessionPaneUrlDetailsTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionPaneUrlFact } from '@/components/sessions/panes/url/useSessionPaneUrlState';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import type { PaneScopeState } from '@/components/appShell/panes/model/appPaneReducer';
import { SessionView } from '@/components/sessions/shell/SessionViewHost';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { SessionBoardPane } from '@/components/sessions/board/SessionBoardPane';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { SessionCompanionScreen } from '@/components/sessions/companion/SessionCompanionScreen';
import { SessionPresentedSurfacePresentationTarget } from '@/components/sessions/companion/presentation/SessionPresentedSurfacePresentationTarget';
import { SessionCompanionRevealPortProvider } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { usePublishedPaneHeaderContent } from '@/components/appShell/panes/paneHeaderSlot';
import { PaneHeaderActions } from '@/components/appShell/panes/PaneHeaderActions';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { DetailNavigationItemsContext } from '@/components/appShell/rightSidebar/useDetailNavigationItems';
import { AppRightSidebarTabSurface } from '@/components/appShell/rightSidebar/appRightSidebarTabs';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    selectPluginDestinationSurfacePlacements,
    selectPluginRightSidebarTabPlacements,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useOpenApprovalArtifactsForSession } from '@/sync/store/hooks';

import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionBoardContinuity } from '@/components/sessions/board/SessionBoardContinuity';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import {
    resolveSessionRightTabIdForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';
import { resolveSessionCockpitPhoneItems, type SessionCockpitMobileCatalogEntry } from './sessionCockpitMobileCatalog';
import { SessionServicesSurfaceScreen } from './SessionServicesSurfaceScreen';
import { useSessionCockpitSurfaceNavigation } from './SessionCockpitSurfaceNavigation';
import { PhoneWorkingCapsule } from '@/components/sessions/composer/phoneAsk/PhoneWorkingCapsule';
import { PageBottomBarSeatProvider } from '@/components/ui/layout/useFloatingChromeClearance';
import { usePhoneAskSheet } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';
import { resolveSessionCockpitComposerRenderer } from './sessionCockpitComposerRenderer';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

// The one Work tab the desktop sidebar mounts too.
const SessionWorkView = retryableLazy<React.ComponentProps<typeof import('@/components/sessions/work/SessionWorkView')['SessionWorkView']>>(
    () => import('@/components/sessions/work/SessionWorkView').then((module) => ({ default: module.SessionWorkView })),
);
const SessionCollaborationSurface = retryableLazy<React.ComponentProps<typeof import('@/components/sessions/collaboration/SessionCollaborationSurface')['SessionCollaborationSurface']>>(
    () => import('@/components/sessions/collaboration/SessionCollaborationSurface').then((module) => ({ default: module.SessionCollaborationSurface })),
);
const SessionSkillsPane = retryableLazy<React.ComponentProps<typeof import('@/components/sessions/capabilities/SessionSkillsPane')['SessionSkillsPane']>>(
    () => import('@/components/sessions/capabilities/SessionSkillsPane').then((module) => ({ default: module.SessionSkillsPane })),
);

export type SessionCockpitSurfaceScreenProps = Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    experience?: TranscriptExperience;
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    jumpToMessageId?: string | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeServerId?: string | null;
    routeHydrationState?: SessionRouteHydrationState | null;
    openWorkStateRequestKey?: number | null;
    onRequestOpenWorkState?: () => void;
}>;

const EMPTY_PLUGIN_DESTINATION: PluginUiDestinationReferenceV1 = Object.freeze({
    pluginId: '',
    localId: '',
});

/**
 * The tab navigator supplies one cockpit-wide handoff owner. Keep the
 * standalone screen route viable through that same generic owner rather than
 * creating a cockpit-local navigation store.
 */
export const SessionCockpitSurfaceScreen = React.memo((props: SessionCockpitSurfaceScreenProps) => {
    const inheritedPaneLaunchScope = usePluginSurfacePaneLaunchScope();
    return inheritedPaneLaunchScope
        ? <SessionCockpitSurfaceScreenContent {...props} />
        : (
            <PluginSurfacePaneLaunchScope>
                <SessionCockpitSurfaceScreenContent {...props} />
            </PluginSurfacePaneLaunchScope>
        );
});

/** The pane facts the cockpit renders from; a Details tab or bottom-panel edit keeps the same value. */
function selectCockpitPaneFacts(scope: PaneScopeState | null) {
    return {
        activeRightTabId: scope?.right.activeTabId ?? null,
        rightIsOpen: scope?.right.isOpen ?? false,
        detailsIsOpen: scope?.details.isOpen ?? false,
        selectedRightDestination: scope?.right.selectedDestination ?? null,
    };
}
const readHasDeepLinkedDetailsTarget = (params: Readonly<Record<string, string | string[] | undefined>>) =>
    parseSessionPaneUrlState(params)?.details != null;

const SessionCockpitSurfaceScreenContent = React.memo((props: SessionCockpitSurfaceScreenProps) => {
    const router = useRouter();
    const { open: openWorkspaceFile } = useWorkspaceFileOpener();
    const deviceType = useDeviceType();
    // This native focus belongs to the cockpit's independent scene navigator,
    // not the outer Expo route. Both owners must admit effects for a hosted scene.
    const sceneFocused = useIsFocused();
    const cockpit = props.experience !== 'classic';
    const hosted = useDestinationInstanceKey() !== null;
    // Only a cockpit scene acts on its tab's focus here; the Session view's own readers follow it
    // themselves, so a classic tab's switch does not render this screen.
    const selectDestinationActive = React.useCallback((instance: DestinationInstanceContextValue | null) =>
        cockpit && instance !== null && instance.focused && instance.visible, [cockpit]);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is fixed for this mounted body.
    const destinationActive = hosted ? useDestinationInstance(selectDestinationActive, Object.is) : useDestinationFocus();
    const isFocused = cockpit && sceneFocused && destinationActive;
    const pane = useAppPaneScope(props.scopeId, selectCockpitPaneFacts);
    const surfaceNavigation = useSessionCockpitSurfaceNavigation();
    // Phone Ask (P5 D-4): the Session screen keeps the one composer and seats it in the Ask sheet over the File page.
    const phoneAsk = usePhoneAskSheet();
    const phoneAskComposerHost = phoneAsk !== null && props.surface === 'chat';
    const askSheetOpen = phoneAskComposerHost && phoneAsk?.phase === 'open';
    const renderPhoneAskComposer = resolveSessionCockpitComposerRenderer(props.surface);
    const enclosingNavigation = usePluginSurfaceDestinationNavigationBinding();
    const registerCockpitChrome = useSessionCockpitChromeRegister();
    const openDetailsTabCount = useDetailsTabCount(props.scopeId);
    const surfaceNavigationRef = React.useRef(surfaceNavigation);
    surfaceNavigationRef.current = surfaceNavigation;
    // A Session route may hydrate after the first render, but it must never borrow
    // an ambient preferred Home while that exact address is still unknown.
    const servicesServerId = props.routeServerId?.trim()
        || props.routeHydrationState?.serverId?.trim()
        || null;
    const sessionAddress = React.useMemo(
        () => normalizeSessionAddress(servicesServerId, props.sessionId),
        [props.sessionId, servicesServerId],
    );
    const sessionMachineTarget = useSessionMachineTarget(sessionAddress);
    const pluginProjection = useSessionPluginRuntime({ address: sessionAddress });
    const session = useSessionViewShellSession(props.sessionId, servicesServerId);
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(servicesServerId);
    const switchToBrowserSurface = React.useCallback(() => {
        surfaceNavigation?.switchSurface('browser');
    }, [surfaceNavigation]);
    // The mobile browser is a separate full-screen surface with its own pane scope; open a service
    // into that browser workspace, then switch the cockpit to it (only after a mappable target).
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: `${props.scopeId}:browser`,
        scope: 'sessionMobile',
        accountLifetime: pluginProjection.accountLifetime,
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: servicesServerId,
        sessionId: props.sessionId,
        onAfterOpen: switchToBrowserSurface,
    });
    const { activeRightTabId, rightIsOpen, detailsIsOpen } = pane.scopeState;
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const closeDetails = pane.closeDetails;
    const selectRightDestination = pane.selectRightDestination;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const { dispatchPane, readPaneState, startIsPresented } = useAppPaneContext(value => ({
        dispatchPane: value.dispatch,
        readPaneState: value.getReadState,
        startIsPresented: value.detailsStartScopeId === props.scopeId,
    }));
    const terminalPageActive = isFocused && props.surface === 'terminal' && terminalTabAvailable;
    React.useLayoutEffect(() => {
        if (!terminalPageActive) return;
        dispatchPane({ type: 'setTerminalPageActive', scopeId: props.scopeId, active: true });
        return () => dispatchPane({ type: 'setTerminalPageActive', scopeId: props.scopeId, active: false });
    }, [dispatchPane, props.scopeId, terminalPageActive]);
    const hasDeepLinkedDetailsTarget = useSessionPaneUrlFact(readHasDeepLinkedDetailsTarget);
    const presentPane = usePanePresentation();
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: pluginProjection.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, pluginProjection.platform]);
    const pluginPlacements = React.useMemo(() => (
        pluginProjection.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginProjection.pluginUiProjection, 'session')
            : []
    ), [pluginProjection.pluginUiProjection]);
    const mobileCatalog = props.catalog;
    const detailInput = React.useContext(DetailNavigationItemsContext)?.input;
    const pluginMobileTab = React.useMemo(() => {
        if (!props.surface.startsWith('plugin:')) {
            return null;
        }
        const entry = mobileCatalog.find((candidate) => candidate.id === props.surface);
        return entry?.owner === 'rightSidebar' && entry.tab.owner === 'plugin'
            ? entry.tab
            : null;
    }, [mobileCatalog, props.surface]);
    // A sidebar surface is titled from the tab registry (the desktop header's own label). A plugin tab
    // gets the same large title; its "+" and live line arrive through plugin-ui `PaneHeaderContent`.
    const surfaceHeader = React.useMemo(() => {
        const entry = mobileCatalog.find((candidate) => candidate.id === props.surface);
        return entry?.owner === 'rightSidebar'
            ? { slotKey: props.surface, title: getRightSidebarTabLabel(entry.tab) }
            : null;
    }, [mobileCatalog, props.surface]);
    // Companion is a host destination, not a sidebar tab, so it is titled here; its body publishes the
    // live line and menu (session-tabs lab Cp).
    const companionSurfaceHeader = React.useMemo(
        () => ({ slotKey: 'companion', title: t('sessionBoard.companion.title') }),
        [],
    );
    const boardPluginRuntime = pluginProjection;
    const boardContinuity = useSessionBoardContinuity(sessionAddress);
    const focusedBoardItemId = boardContinuity?.focusedItemId[0] ?? null;
    const setFocusedBoardItemId = boardContinuity?.focusedItemId[1];
    const openFocusedBoardItem = React.useCallback((itemId: string) => {
        setFocusedBoardItemId?.(itemId);
    }, [setFocusedBoardItemId]);
    // A retained Session the phone is not showing leaves Back to the one on screen.
    const destinationFocus = useDestinationFocusSignal();
    React.useEffect(() => {
        if (Platform.OS !== 'android' || props.surface !== 'board' || !focusedBoardItemId) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!destinationFocus.get()) return false;
            setFocusedBoardItemId?.(null);
            return true;
        });
        return () => subscription.remove();
    }, [destinationFocus, focusedBoardItemId, props.surface, setFocusedBoardItemId]);
    const findPluginMobileTab = React.useCallback((placementId: string) => {
        const entry = mobileCatalog.find((candidate) => (
            candidate.owner === 'rightSidebar'
            && candidate.tab.owner === 'plugin'
            && candidate.tab.placement.id === placementId
        ));
        return entry?.owner === 'rightSidebar' && entry.tab.owner === 'plugin'
            ? entry.tab
            : null;
    }, [mobileCatalog]);
    const paneLaunchScope = usePluginSurfacePaneLaunchScope();
    if (!paneLaunchScope) {
        // The wrapper above always supplies this generic host owner. Do not
        // invent a cockpit-local launch store if that invariant is broken.
        return null;
    }
    const { accountLifetime, store: paneLaunchStore } = paneLaunchScope;
    const scopedLaunchFacts = React.useMemo<PluginSurfaceScopedLaunchFacts>(() => Object.freeze({
        serverId: pluginProjection.serverId ?? null,
        machineId: pluginProjection.machineId ?? null,
        interactionEnabled: pluginProjection.interactionEnabled === true,
    }), [
        pluginProjection.interactionEnabled,
        pluginProjection.machineId,
        pluginProjection.serverId,
    ]);
    const selectedRightPluginDestination = pane.scopeState.selectedRightDestination?.kind === 'plugin'
        ? pane.scopeState.selectedRightDestination
        : null;
    const activeInstanceKey = selectedRightPluginDestination
        && pluginMobileTab
        && selectedRightPluginDestination.destination.pluginId === pluginMobileTab.placement.binding.destination.pluginId
        && selectedRightPluginDestination.destination.localId === pluginMobileTab.placement.binding.destination.localId
        ? selectedRightPluginDestination.instanceKey
        : undefined;
    const hasSelectedPluginMobileTab = selectedRightPluginDestination !== null
        && pluginMobileTab !== null
        && selectedRightPluginDestination.destination.pluginId === pluginMobileTab.placement.binding.destination.pluginId
        && selectedRightPluginDestination.destination.localId === pluginMobileTab.placement.binding.destination.localId;
    const activePaneLaunch = usePluginSurfacePaneLaunch({
        store: paneLaunchStore,
        placement: pluginMobileTab?.placement ?? null,
        targetKind: 'session',
        container: 'rightSidebarTab',
        accountLifetime,
        scopedLaunchFacts,
        destination: pluginMobileTab?.placement.binding.destination ?? EMPTY_PLUGIN_DESTINATION,
        ...(activeInstanceKey === undefined ? {} : { instanceKey: activeInstanceKey }),
    });
    const openPluginMobileTab = React.useCallback((resolution: Parameters<typeof stagePluginSurfacePaneLaunch>[0]['resolution']) => {
        const targetTab = findPluginMobileTab(resolution.placement.id);
        if (!targetTab || !surfaceNavigation) {
            return {
                ok: false as const,
                code: 'unavailable' as const,
                reason: 'plugin_surface_open_destination_owner_unavailable',
            };
        }
        if (!stagePluginSurfacePaneLaunch({ store: paneLaunchStore, resolution })) {
            return {
                ok: false as const,
                code: 'unavailable' as const,
                reason: 'plugin_surface_open_origin_unavailable',
            };
        }
        // The AppPane selection is the only durable destination identity. Keep
        // the admitted instance key there so this exact mobile mount can
        // consume the private handoff; input itself remains only in the shared
        // ephemeral launch store.
        selectRightDestination({
            kind: 'plugin',
            destination: resolution.placement.binding.destination,
            ...(resolution.request.instanceKey === undefined
                ? {}
                : { instanceKey: resolution.request.instanceKey }),
        });
        surfaceNavigation.switchSurface(targetTab.id as SessionMobileSurface);
        return { ok: true as const };
    }, [findPluginMobileTab, paneLaunchStore, selectRightDestination, surfaceNavigation]);
    const openSurface = React.useMemo(() => createPluginSurfaceDestinationOpenSurfaceHandler({
        placements: pluginProjection.pluginUiProjection
            ? selectPluginDestinationSurfacePlacements(pluginProjection.pluginUiProjection)
            : [],
        targetKind: 'session',
        accountLifetime,
        scopedLaunchFacts,
        runtimeAdmission,
        handlers: { rightSidebarTab: openPluginMobileTab },
        enclosingOpenSurface: enclosingNavigation?.openSurface,
    }), [
        accountLifetime,
        enclosingNavigation,
        openPluginMobileTab,
        pluginProjection.pluginUiProjection,
        runtimeAdmission,
        scopedLaunchFacts,
    ]);
    const pluginBinding = React.useMemo<BoundPluginSurfaceBinding>(() => ({ openSurface }), [openSurface]);

    const switchSurface = React.useCallback((surface: SessionMobileSurface): 'ownTab' | void => {
        // Tabs on a phone (owner ruling 2026-10-31) opens or focuses the pane's page as its own rail tab, through the
        // layout's own-tab presentation; the Session tab keeps its scene and route. Without one, Tabs is a scene.
        if (surface === 'tabs') {
            // Read when Tabs is pressed, so pane edits never re-register the cockpit chrome.
            const scope = readPaneState().scopes[props.scopeId];
            const details = scope ? buildDetailsWorkspaceStateView(scope.details) : null;
            const tab = details?.tabs.find(item => item.key === details.activeTabKey);
            if (tab && presentPane?.({ scopeId: props.scopeId, pane: 'details', tab, fromDetails: true }) === 'ownTab') {
                return 'ownTab';
            }
        }
        // On a phone the right tab only follows the surface. It moves with the press, before the route does:
        // left behind, the URL sync writes it back and the navigator reads that as a request to return to it.
        const nextRightTabId = surface === 'browser' || surface === 'services' || surface.startsWith('plugin:')
            ? undefined : resolveSessionRightTabIdForSurface(surface, terminalTabAvailable);
        if (nextRightTabId) openRight({ tabId: nextRightTabId });
        else if (nextRightTabId === null) closeRight();
        // Leaving the File scene retires its presentation before the route changes, as Chat would on focus: the
        // Session the route returns to must not publish the open Details again and present the File scene.
        if (props.surface === 'tabs' && surface !== 'tabs' && !hasDeepLinkedDetailsTarget) {
            closeDetails();
            if (surface === 'chat') closeRight();
        }
        surfaceNavigationRef.current?.switchSurface(surface);
    }, [closeDetails, closeRight, hasDeepLinkedDetailsTarget, openRight, presentPane, props.scopeId, props.surface, readPaneState, terminalTabAvailable]);
    const requestCloseDetails = React.useCallback(() => {
        closeDetails();
        surfaceNavigationRef.current?.returnToPreviousSurface();
    }, [closeDetails]);
    const openMobileCompanion = React.useCallback(() => {
        switchSurface('companion');
    }, [switchSurface]);
    const revealMobileBoardItem = React.useCallback((itemId: string) => {
        setFocusedBoardItemId?.(itemId);
        switchSurface('board');
    }, [setFocusedBoardItemId, switchSurface]);

    const openWorkStateRequestKey = props.openWorkStateRequestKey ?? null;

    // A full-screen Board or Companion is presented without Chat's composer, so it
    // publishes its own current-UI presentation target. Its ports are this Cockpit's
    // own surface navigation: an Agent's `chat.return` really returns to Chat here.
    const presentBoardSurface = React.useCallback(() => {
        if (props.surface === 'board') return { status: 'unchanged' as const };
        switchSurface('board');
        return { status: 'applied' as const };
    }, [props.surface, switchSurface]);
    const presentBoardItemSurface = React.useCallback((itemId: string) => {
        revealMobileBoardItem(itemId);
        return { status: 'applied' as const };
    }, [revealMobileBoardItem]);
    const presentChatSurface = React.useCallback(() => {
        switchSurface('chat');
        return { status: 'applied' as const };
    }, [switchSurface]);
    const presentCompanionSurface = React.useCallback(() => {
        if (props.surface === 'companion') return { status: 'unchanged' as const };
        openMobileCompanion();
        return { status: 'applied' as const };
    }, [openMobileCompanion, props.surface]);
    const presentedSurfaceTarget = sessionAddress ? (
        <SessionPresentedSurfacePresentationTarget
            sessionId={props.sessionId}
            serverId={sessionAddress.serverId}
            presented={isFocused}
            openBoard={presentBoardSurface}
            revealBoardItem={presentBoardItemSurface}
            returnToChat={presentChatSurface}
            openFullSurface={presentCompanionSurface}
        />
    ) : null;

    // The cockpit's only exit from a fullscreen surface back to the transcript. The
    // navigation surface uses it both as its close affordance (button / Escape) and as the
    // reveal that must precede a jump, since jumping into a hidden scene moves a viewport
    // the reader cannot see.
    const revealChatSurface = React.useCallback(() => {
        switchSurface('chat');
    }, [switchSurface]);
    // Escape closes the full Companion back to Chat, where the person came from (owner ruling 2026-11-09).
    useEscapeLayer({
        enabled: Platform.OS === 'web' && isFocused && props.surface === 'companion',
        priority: ESCAPE_LAYER_PRIORITIES.pane,
        onEscape: () => { revealChatSurface(); return true; },
    });
    const revealWorkState = React.useCallback(() => {
        props.onRequestOpenWorkState?.();
        revealChatSurface();
    }, [props.onRequestOpenWorkState, revealChatSurface]);
    const approvalRequests = useOpenApprovalArtifactsForSession(servicesServerId
        ? { serverId: servicesServerId, sessionId: props.sessionId }
        : null);
    const openSessionApproval = React.useCallback(() => {
        const approvalId = approvalRequests[0]?.artifact.id;
        if (!approvalId || !servicesServerId) return;
        router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(servicesServerId)}` as never);
    }, [approvalRequests, router, servicesServerId]);
    const companionSummaryDestinations = React.useMemo(() => ({
        sessionInfo: () => router.push(buildScopedSessionRouteHref({
            sessionId: props.sessionId,
            serverId: servicesServerId,
            suffix: '/info',
        }) as never),
        approvals: openSessionApproval,
        work: revealWorkState,
        // Everything the Session leads is one surface: the Work screen beside this one.
        workTab: () => switchSurface('agents'),
        git: () => switchSurface('git'),
        usage: () => router.push(buildScopedSessionRouteHref({
            sessionId: props.sessionId,
            serverId: servicesServerId,
            suffix: '/usage',
        }) as never),
    }), [openSessionApproval, props.sessionId, revealWorkState, router, servicesServerId, switchSurface]);

    const navigationItems = React.useMemo<readonly DetailPageNavigationItem[]>(() => resolveSessionCockpitPhoneItems(mobileCatalog)
        .map((entry, phoneOrder) => ({ ...entry, title: getRightSidebarTabLabel(entry.tab), icon: entry.tab.icon,
            disabledReason: entry.tab.disabledReason ?? null, phoneOrder,
            navigation: entry.tab.navigation ?? { kind: 'companion', companion: entry.id } })), [mobileCatalog]);
    const navigationScope = useActiveServerAccountScope(servicesServerId);
    const executeNavigation = useMountedScopeActionCommand(navigationScope);
    const chromeProps = React.useMemo(() => ({ sessionId: props.sessionId, serverId: servicesServerId,
        activeSurface: props.surface, terminalTabAvailable, openDetailsTabCount, pluginPlacements,
        catalog: mobileCatalog, ...(detailInput ? { detailInput } : {}) }),
    [props.sessionId, servicesServerId, props.surface, terminalTabAvailable, openDetailsTabCount, pluginPlacements, mobileCatalog, detailInput]);
    const navigation: ReturnType<typeof usePresentedDetailNavigation> = usePresentedDetailNavigation({ pageKind: 'session',
        identity: sessionAddress ? sessionAddressKey(sessionAddress) : props.scopeId,
        sessionId: props.sessionId, scope: navigationScope, items: navigationItems,
        title: t('navigationPlacement.contextSession'), activeId: props.surface,
        phone: deviceType === 'phone', presented: isFocused && surfaceNavigation !== null,
        selectPage: id => switchSurface(id as SessionMobileSurface),
        companion: { activeId: props.surface, select: id => switchSurface(id as SessionMobileSurface), close: () => switchSurface('chat') },
        columnState: column => ({ visible: navigationItems.some(item => item.id === props.surface
            && (column === 'main' ? item.navigation.kind !== 'companion' : item.navigation.kind !== 'page')),
            activeTab: props.surface, setVisible: visible => { if (!visible && column === 'side') switchSurface('chat'); } }),
        customizer: device => resolveSessionNavigationCustomizerProps({ device,
            detailInput: detailInput ?? { scope: 'session', presentation: 'mobile', terminalTabAvailable, pluginPlacements },
            arrangement: storage.getState().localSettings.paneArrangement === 'editor' ? 'editor' : 'session',
            phoneCatalog: mobileCatalog, phonePageTabs: true }),
        chromeRevision: chromeProps,
        phoneChrome: (execute): DetailPhoneChrome => {
            const barProps = { ...chromeProps, onSurfacePress: (surface: SessionMobileSurface) =>
                selectSessionCockpitSurface(execute, { catalog: mobileCatalog, readColumn: navigation.readColumn }, surface),
                onCustomize: navigation.openNavigationCustomizer };
            return { node: <SessionCockpitTabBar {...barProps} />, systemModel: { kind: 'sessionCockpit', props: barProps } };
        },
    });
    const readColumn = navigation.readColumn;

    React.useLayoutEffect(() => {
        if (!isFocused || !surfaceNavigation) return;
        return registerCockpitChrome({
            sessionId: props.sessionId,
            serverId: servicesServerId,
            activeSurface: props.surface,
            terminalTabAvailable,
            openDetailsTabCount,
            pluginPlacements,
            catalog: mobileCatalog,
            ...(detailInput ? { detailInput } : {}),
            readColumn,
            switchSurface,
        });
    }, [
        isFocused,
        openDetailsTabCount,
        pluginPlacements,
        props.sessionId,
        servicesServerId,
        props.surface,
        registerCockpitChrome,
        readColumn,
        mobileCatalog,
        detailInput,
        surfaceNavigation,
        switchSurface,
        terminalTabAvailable,
    ]);


    const previousDetails = React.useRef({ scopeId: props.scopeId, count: openDetailsTabCount });
    React.useEffect(() => {
        const previous = previousDetails.current;
        previousDetails.current = { scopeId: props.scopeId, count: openDetailsTabCount };
        if (isFocused && props.surface === 'tabs' && previous.scopeId === props.scopeId
            && previous.count > 0 && openDetailsTabCount === 0) {
            surfaceNavigationRef.current?.returnToPreviousSurface();
        }
    }, [isFocused, openDetailsTabCount, props.scopeId, props.surface]);

    const targetRightTabId = pluginMobileTab || props.surface.startsWith('plugin:')
        ? null
        : (
            props.surface === 'browser' || props.surface === 'services'
                ? null
                : resolveSessionRightTabIdForSurface(props.surface, terminalTabAvailable)
        );
    // Read on focus, not subscribed: every openRight presents its tab, so re-asserting this scene's tab whenever
    // the pane moved pulled the person back to it while the URL sync was closing it behind them.
    const rightStateRef = React.useRef({ rightIsOpen, activeRightTabId });
    rightStateRef.current = { rightIsOpen, activeRightTabId };
    React.useEffect(() => {
        if (!isFocused) return;
        if (pluginMobileTab) {
            // A direct cockpit selection has no launch instance. Do not rewrite
            // a current `openSurface` selection just after it supplied the
            // exact multiple-instance identity needed by the AppPane mount.
            if (!hasSelectedPluginMobileTab) {
                selectRightDestination({
                    kind: 'plugin',
                    destination: pluginMobileTab.placement.binding.destination,
                });
            }
            return;
        }
        if (!targetRightTabId) return;
        const right = rightStateRef.current;
        if (right.rightIsOpen === true && right.activeRightTabId === targetRightTabId) return;

        openRight({ tabId: targetRightTabId });
        if (right.activeRightTabId !== targetRightTabId) {
            setRightTab(targetRightTabId);
        }
    }, [
        isFocused,
        hasSelectedPluginMobileTab,
        openRight,
        pluginMobileTab,
        selectRightDestination,
        setRightTab,
        targetRightTabId,
    ]);

    const previousCockpitRef = React.useRef(cockpit);
    React.useEffect(() => {
        const resumingCockpit = cockpit && !previousCockpitRef.current;
        previousCockpitRef.current = cockpit;
        // Wide mode temporarily focuses Chat. Returning to the cockpit restores
        // its navigation state; that intermediate focus is not a request to close panes.
        if (resumingCockpit) return;
        if (!isFocused) return;
        if (props.surface !== 'chat') return;
        if (rightIsOpen) closeRight();
        // Start borrows Details over Chat; its presenter owns dismissal while Chat stays focused.
        if (detailsIsOpen && !hasDeepLinkedDetailsTarget && !startIsPresented) closeDetails();
    }, [closeDetails, closeRight, cockpit, detailsIsOpen, hasDeepLinkedDetailsTarget, isFocused, props.surface, rightIsOpen, startIsPresented]);

    const openDetailsRoute = React.useCallback((
        target: Extract<SessionPaneUrlDetailsTarget, { kind: 'file' | 'commit' | 'scmReview' }>,
        intent?: { intent: 'pinned' },
    ) => {
        if (target.kind === 'file') {
            if (!sessionAddress) return;
            void openWorkspaceFile({ kind: 'session', ...sessionAddress, path: target.path },
                { intent: intent?.intent ?? 'preview', ...(props.surface === 'git' ? { view: 'changes' } : {}),
                    ...(target.anchor ? { anchor: target.anchor } : {}), ...(target.anchorSource ? { anchorSource: target.anchorSource } : {}) });
            return;
        }
        deferOnWeb(() => {
            if (target.kind === 'commit') {
                const tab = createSessionCommitDetailsTab(target.sha);
                if (!tab) return;

                pane.openDetailsTab(tab, intent);
                return;
            }

            pane.openDetailsTab(createSessionScmReviewDetailsTab(), intent);
        });
    }, [openWorkspaceFile, pane, props.surface, sessionAddress]);

    const openFileInDetails = React.useCallback((fullPath: string) => {
        openDetailsRoute({ kind: 'file', path: fullPath });
    }, [openDetailsRoute]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        openDetailsRoute({ kind: 'file', path: fullPath }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const normalizedSha = sha.trim().split(/\s+/)[0] ?? '';
        if (!normalizedSha) return;

        openDetailsRoute({ kind: 'commit', sha: normalizedSha });
    }, [openDetailsRoute]);

    const openReviewAllChanges = React.useCallback(() => {
        openDetailsRoute({ kind: 'scmReview' }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const openStashDetails = React.useCallback(() => {
        deferOnWeb(() => {
            const tab = createSessionScmStashDetailsTab();
            pane.openDetailsTab(tab, { intent: 'pinned' });
        });
    }, [pane]);

    const safeAreaTopMode = cockpit ? 'internal' : undefined;
    const headerSafeAreaTopMode = cockpit ? 'internal' : undefined;
    // Cockpit phones may keep page tabs at the top: one strip under the Session header on every surface.
    const selectPage = React.useCallback((surface: SessionMobileSurface) => selectSessionCockpitSurface(executeNavigation,
        { catalog: mobileCatalog, readColumn }, surface), [executeNavigation, mobileCatalog, readColumn]);
    const pageStrip = React.useMemo(() => cockpit ? <SessionPhonePageStrip sessionId={props.sessionId} serverId={servicesServerId}
        catalog={mobileCatalog} activeSurface={props.surface} openDetailsTabCount={openDetailsTabCount}
        onSurfacePress={selectPage} /> : undefined, [cockpit, mobileCatalog, openDetailsTabCount, props.sessionId, props.surface, selectPage, servicesServerId]);
    const renderSessionChrome = React.useCallback((contentOverride?: React.ReactNode) => (
        <SessionView
            id={props.sessionId}
            routeServerId={props.routeServerId ?? undefined}
            routeHydrationState={props.routeHydrationState}
            jumpToSeq={props.jumpToSeq}
            jumpToMessageId={props.jumpToMessageId}
            initialAttachmentDrafts={props.initialAttachmentDrafts}
            surfaceSceneActive={cockpit ? sceneFocused || askSheetOpen : true}
            routeAnchorOverride={cockpit ? Platform.OS === 'web' ? undefined : true : 'surface'}
            contentOverride={contentOverride}
            headerAccessory={pageStrip}
            safeAreaTopMode={safeAreaTopMode}
            headerSafeAreaTopMode={headerSafeAreaTopMode}
            chatBottomSpacing={cockpit ? 'none' : undefined}
            openWorkStateRequestKey={openWorkStateRequestKey}
            sessionPluginRuntime={boardPluginRuntime}
            renderComposer={renderPhoneAskComposer}
        />
    ), [
        askSheetOpen,
        pageStrip,
        renderPhoneAskComposer,
        headerSafeAreaTopMode,
        cockpit,
        sceneFocused,
        props.initialAttachmentDrafts,
        props.jumpToSeq,
        props.jumpToMessageId,
        props.routeServerId,
        props.routeHydrationState,
        props.sessionId,
        safeAreaTopMode,
        openWorkStateRequestKey,
        boardPluginRuntime,
    ]);

    if (props.surface === 'chat') {
        return renderSessionChrome();
    }

    if (props.surface === 'browse') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-files-screen" safeAreaPadding={false} header={surfaceHeader}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <SessionBrowseFilesSurface
                        scopeId={props.scopeId}
                        sessionId={props.sessionId}
                        serverId={props.routeHydrationState?.serverId ?? props.routeServerId}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'git') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-git-screen" safeAreaPadding={false} header={surfaceHeader}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <SessionGitSurface
                        sessionId={props.sessionId}
                        serverId={servicesServerId ?? undefined}
                        scopeId={props.scopeId}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                        onOpenCommit={openCommitInDetails}
                        onOpenReviewAllChanges={openReviewAllChanges}
                        onOpenStashDetails={openStashDetails}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'skills') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-skills-screen" safeAreaPadding={false} header={surfaceHeader}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <SessionSkillsPane sessionId={props.sessionId} serverId={servicesServerId} />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'navigation') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-transcript-navigation-screen" safeAreaPadding={false} header={surfaceHeader}>
                <SessionTranscriptNavigationPane
                    onRequestClose={revealChatSurface}
                    onRevealTranscript={revealChatSurface}
                    sessionId={props.sessionId}
                />
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'board' && boardFeatureEnabled) {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-board-screen" safeAreaPadding={false} header={surfaceHeader}>
                {sessionAddress ? (
                    <SessionCompanionRevealPortProvider
                        address={sessionAddress}
                        openFullSurface={openMobileCompanion}
                        revealAfterMutation={openMobileCompanion}
                        revealBoardItem={revealMobileBoardItem}
                    >
                        {presentedSurfaceTarget}
                        <SessionBoardPane
                            sessionId={props.sessionId}
                            {...(session ? { session } : {})}
                            serverId={servicesServerId}
                            host="mobileCockpit"
                            density="full"
                            layout="single"
                            focusedItemId={focusedBoardItemId}
                            onReadFullItem={openFocusedBoardItem}
                            onLeaveFocusedItem={() => setFocusedBoardItemId?.(null)}
                        />
                    </SessionCompanionRevealPortProvider>
                ) : <PaneLoadingFallback />}
            </SessionCockpitFullscreenSurface>,
        );
    }

    // Companion is not a Board placement gate: its first-party Session Summary
    // is composed from Session facts alone, so it is admitted by the exact
    // qualified Session address below. Only the Board content it can present
    // follows the Home's `sessions.board` decision at the Board owner.
    if (props.surface === 'companion') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-companion-screen" safeAreaPadding={false} header={companionSurfaceHeader}>
                {sessionAddress ? (<>
                    {presentedSurfaceTarget}
                    <SessionViewerSourceAccountScopeProvider accountLifetime={pluginProjection.accountLifetime}>
                        <SessionCompanionScreen
                            sessionId={props.sessionId}
                            address={sessionAddress}
                            onRevealBoardItem={revealMobileBoardItem}
                            onRequestClose={revealChatSurface}
                            summaryDestinations={companionSummaryDestinations}
                        />
                    </SessionViewerSourceAccountScopeProvider>
                </>) : <PaneLoadingFallback />}
            </SessionCockpitFullscreenSurface>,
        );
    }

    // The one Work surface (ORC §3.8, lab `session-P`): the same view the desktop sidebar mounts,
    // titled and given its "+" by the surface header.
    if (props.surface === 'agents') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-agents-screen" safeAreaPadding={false} header={surfaceHeader}>
                {presentedSurfaceTarget}
                <SurfaceStateSizeProvider size="phone">
                    <React.Suspense fallback={<PaneLoadingFallback />}>
                        <SessionWorkView
                            sessionId={props.sessionId}
                            scopeId={props.scopeId}
                            serverId={servicesServerId}
                        />
                    </React.Suspense>
                </SurfaceStateSizeProvider>
            </SessionCockpitFullscreenSurface>,
        );
    }

    // Discovery fails closed through the catalog projection above. A retained or
    // deep-linked Collaboration destination stays mounted so its three-state owner
    // can present loading and settled refusal without retracting the destination.
    if (props.surface === 'collaboration' && servicesServerId) {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-collaboration-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <SessionCollaborationSurface
                        key={sessionAddressKey({ serverId: servicesServerId, sessionId: props.sessionId })}
                        target={{ serverId: servicesServerId, sessionId: props.sessionId }}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'terminal' && terminalTabAvailable) {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-terminal-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <SessionTerminalSurface
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        presentation="page"
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'browser') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-browser-screen" safeAreaPadding={false} header={surfaceHeader}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <BrowserMobileSurfaceScreen
                        sessionId={props.sessionId}
                        scopeId={`${props.scopeId}:browser`}
                        pluginProjection={pluginProjection}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'services') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-services-screen" safeAreaPadding={false} header={surfaceHeader}>
                <SurfaceStateSizeProvider size="phone">
                    <React.Suspense fallback={<PaneLoadingFallback />}>
                        <SessionServicesSurfaceScreen
                            sessionId={props.sessionId}
                            serverId={props.routeServerId}
                            onOpenServiceInBrowser={openServiceInBrowser}
                        />
                    </React.Suspense>
                </SurfaceStateSizeProvider>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface.startsWith('plugin:')) {
        if (!pluginMobileTab) {
            const projectionEstablishing = pluginProjection.phase === 'establishing';
            return renderSessionChrome(
                <SessionCockpitFullscreenSurface screenTestID="session-plugin-screen-unavailable" safeAreaPadding={false}>
                    {projectionEstablishing
                        ? <PaneLoadingFallback />
                        : <PluginReactNativeUnavailable diagnostics={['plugin_destination_unavailable']} />}
                </SessionCockpitFullscreenSurface>,
            );
        }
        return renderSessionChrome(
                <SessionCockpitFullscreenSurface screenTestID={`session-plugin-screen-${pluginMobileTab.id}`} safeAreaPadding={false} header={surfaceHeader}>
                    <React.Suspense fallback={<PaneLoadingFallback />}>
                        <PluginSurfaceFocusEligibilityProvider active={isFocused}>
                            {pluginMobileTab.placement.binding.targetKind === 'app' ? (
                                <AppRightSidebarTabSurface
                                    placement={pluginMobileTab.placement}
                                    executionTarget={pluginProjection.serverId && pluginProjection.machineId
                                        ? { serverId: pluginProjection.serverId, machineId: pluginProjection.machineId } : null}
                                    binding={enclosingNavigation ? { openSurface: enclosingNavigation.openSurface } : undefined}
                                    mountInstanceKey={activeInstanceKey}
                                />
                            ) : (
                                <PluginSurfacePlacementHost
                                    placement={pluginMobileTab.placement}
                                    machineId={pluginProjection.machineId}
                                    serverId={pluginProjection.serverId}
                                    sessionId={props.sessionId}
                                    pluginUiProjection={pluginProjection.pluginUiProjection}
                                    projectionInteractionEnabled={pluginProjection.interactionEnabled}
                                    platform={pluginProjection.platform}
                                    binding={pluginBinding}
                                    launchInput={activePaneLaunch?.input}
                                    mountInstanceKey={activeInstanceKey}
                                />
                            )}
                        </PluginSurfaceFocusEligibilityProvider>
                    </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    return renderSessionChrome(
        <View testID="session-details-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {/* The working capsule floats over the File page, so it reads which bottom bar the page keeps. */}
            <PageBottomBarSeatProvider>
            {/* The File scene is this Session's Details: a page opened from it is a Details opener, which a
                phone shows as its own tab in the rail rather than a second tab inside this pane. */}
            <PaneRegionProvider region="details">
                <SessionDetailsPanel
                    sessionId={props.sessionId}
                    scopeId={props.scopeId}
                    presentation={props.safeAreaPadding === false ? 'screen' : undefined}
                    showHeaderActions={false}
                    onRequestClose={requestCloseDetails}
                />
            </PaneRegionProvider>
            <PhoneWorkingCapsule
                sessionId={props.sessionId}
                serverId={servicesServerId ?? null}
                onView={() => surfaceNavigation?.switchSurface('chat')}
            />
            </PageBottomBarSeatProvider>
        </View>,
    );
});
