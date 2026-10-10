import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import * as React from 'react';
import { BackHandler, Platform, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import {
    SessionCockpitBottomChromeHeightContext,
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitChromeRegister,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { BrowserMobileSurfaceScreen } from '@/components/browser/surfaces/BrowserMobileSurfaceScreen';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDetailsTabCount } from '@/components/appShell/panes/hooks/useDetailsTabCount';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import {
    createPluginSurfaceDestinationOpenSurfaceHandler,
    PluginSurfacePaneLaunchScope,
    stagePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import {
    createSessionCommitDetailsTab,
    createSessionFileDetailsTab,
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
import { SessionBrowseFilesSurface } from '@/components/sessions/panes/surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from '@/components/sessions/panes/surfaces/SessionGitSurface';
import { SessionTerminalSurface } from '@/components/sessions/panes/surfaces/SessionTerminalSurface';
import {
    type SessionPaneUrlDetailsTarget,
    type SessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { SessionBoardPane } from '@/components/sessions/board/SessionBoardPane';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionBoardPrimaryMountResolver } from '@/components/sessions/board/useSessionBoardPrimaryMountHost';
import { SessionCompanionScreen } from '@/components/sessions/companion/SessionCompanionScreen';
import { SessionPresentedSurfacePresentationTarget } from '@/components/sessions/companion/presentation/SessionPresentedSurfacePresentationTarget';
import { SessionCompanionRevealPortProvider } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } from '@/components/appShell/panes/paneHeaderSlot';
import { PaneHeaderActions } from '@/components/appShell/panes/PaneHeaderActions';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
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
import { resolveSessionCockpitMobileCatalog } from './sessionCockpitMobileCatalog';
import { SessionServicesSurfaceScreen } from './SessionServicesSurfaceScreen';
import { useSessionCockpitSurfaceNavigation } from './SessionCockpitSurfaceNavigation';

// The one Work tab host the desktop sidebar mounts too: the Work view with FIN's Triggers section in its slot.
const SessionWorkViewWithTriggers = React.lazy(() => import('@/components/workflows/triggers/SessionWorkViewWithTriggers').then((module) => ({ default: module.SessionWorkViewWithTriggers })));
const SessionCollaborationSurface = React.lazy(() => import('@/components/sessions/collaboration/SessionCollaborationSurface').then((module) => ({ default: module.SessionCollaborationSurface })));

export type SessionCockpitSurfaceScreenProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
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

const SessionCockpitSurfaceScreenContent = React.memo((props: SessionCockpitSurfaceScreenProps) => {
    const router = useRouter();
    const deviceType = useDeviceType();
    // This native focus belongs to the cockpit's independent scene navigator,
    // not the outer Expo route. Both owners must admit effects for a hosted scene.
    const sceneFocused = useIsFocused();
    const instanceKey = useDestinationInstanceKey();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is fixed for this mounted body.
    const destinationFocused = instanceKey === null ? true : useDestinationFocus();
    const isFocused = sceneFocused && destinationFocused;
    const pane = useAppPaneScope(props.scopeId);
    const surfaceNavigation = useSessionCockpitSurfaceNavigation();
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
    const session = useSessionViewShellSession(props.sessionId, servicesServerId);
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(servicesServerId ?? '');
    const sessionSharingAvailable = Boolean(servicesServerId) && collaborationAdmitted;
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(servicesServerId);
    const switchToBrowserSurface = React.useCallback(() => {
        surfaceNavigation?.switchSurface('browser');
    }, [surfaceNavigation]);
    // The mobile browser is a separate full-screen surface with its own pane scope; open a service
    // into that browser workspace, then switch the cockpit to it (only after a mappable target).
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: `${props.scopeId}:browser`,
        scope: 'sessionMobile',
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: servicesServerId,
        sessionId: props.sessionId,
        onAfterOpen: switchToBrowserSurface,
    });
    const activeRightTabId = pane.scopeState?.right?.activeTabId ?? null;
    const rightIsOpen = pane.scopeState?.right?.isOpen ?? false;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    // One Session-shell derivation, shared with Details, the sidebar and the
    // Companion, so two hosts can never both believe they are primary.
    const resolveBoardPrimaryHost = useSessionBoardPrimaryMountResolver({
        address: sessionAddress,
        paneScopeId: props.scopeId,
        presented: isFocused,
        mobileSurface: props.surface === 'board' || props.surface === 'companion' ? props.surface : null,
    });
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const closeDetails = pane.closeDetails;
    const selectRightDestination = pane.selectRightDestination;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const hasDeepLinkedDetailsTarget = props.paneUrlState?.details != null;
    const pluginProjection = useSessionPluginRuntime({ address: sessionAddress });
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: pluginProjection.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, pluginProjection.platform]);
    const pluginPlacements = React.useMemo(() => (
        pluginProjection.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginProjection.pluginUiProjection, 'session')
            : []
    ), [pluginProjection.pluginUiProjection]);
    const mobileCatalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({
        sessionSharingAvailable,
        boardFeatureEnabled,
        terminalTabAvailable,
        pluginPlacements,
        projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
        runtimeAdmission,
    }), [
        boardFeatureEnabled,
        sessionSharingAvailable,
        pluginPlacements,
        pluginProjection.pluginUiProjection?.generation,
        runtimeAdmission,
        terminalTabAvailable,
    ]);
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
    React.useEffect(() => {
        if (props.surface !== 'board' || !focusedBoardItemId) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setFocusedBoardItemId?.(null);
            return true;
        });
        return () => subscription.remove();
    }, [focusedBoardItemId, props.surface, setFocusedBoardItemId]);
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
    const selectedRightPluginDestination = pane.scopeState?.right.selectedDestination?.kind === 'plugin'
        ? pane.scopeState.right.selectedDestination
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
    }), [
        accountLifetime,
        openPluginMobileTab,
        pluginProjection.pluginUiProjection,
        runtimeAdmission,
        scopedLaunchFacts,
    ]);
    const pluginBinding = React.useMemo<BoundPluginSurfaceBinding>(() => ({ openSurface }), [openSurface]);

    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        surfaceNavigationRef.current?.switchSurface(surface);
    }, []);
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

    React.useEffect(() => {
        if (!isFocused || !surfaceNavigation) return;
        return registerCockpitChrome({
            sessionId: props.sessionId,
            serverId: servicesServerId,
            activeSurface: props.surface,
            terminalTabAvailable,
            openDetailsTabCount,
            pluginPlacements,
            projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
            switchSurface,
        });
    }, [
        isFocused,
        openDetailsTabCount,
        pluginPlacements,
        pluginProjection.pluginUiProjection?.generation,
        props.sessionId,
        servicesServerId,
        props.surface,
        registerCockpitChrome,
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
        if (rightIsOpen === true && activeRightTabId === targetRightTabId) return;

        openRight({ tabId: targetRightTabId });
        if (activeRightTabId !== targetRightTabId) {
            setRightTab(targetRightTabId);
        }
    }, [
        activeRightTabId,
        isFocused,
        hasSelectedPluginMobileTab,
        openRight,
        pluginMobileTab,
        rightIsOpen,
        selectRightDestination,
        setRightTab,
        targetRightTabId,
    ]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (props.surface !== 'chat') return;
        if (rightIsOpen !== true) return;

        closeRight();
    }, [closeRight, isFocused, props.surface, rightIsOpen]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (props.surface !== 'chat') return;
        if (detailsIsOpen !== true) return;
        if (hasDeepLinkedDetailsTarget) return;

        closeDetails();
    }, [closeDetails, detailsIsOpen, hasDeepLinkedDetailsTarget, isFocused, props.surface]);

    const openDetailsSurface = React.useCallback(() => {
        surfaceNavigation?.switchSurface('tabs');
    }, [surfaceNavigation]);

    const openDetailsRoute = React.useCallback((
        target: Extract<SessionPaneUrlDetailsTarget, { kind: 'file' | 'commit' | 'scmReview' }>,
        intent?: { intent: 'pinned' },
    ) => {
        deferOnWeb(() => {
            if (target.kind === 'file') {
                pane.openDetailsTab(createSessionFileDetailsTab(target.path), intent);
                openDetailsSurface();
                return;
            }

            if (target.kind === 'commit') {
                const tab = createSessionCommitDetailsTab(target.sha);
                if (!tab) return;

                pane.openDetailsTab(tab, intent);
                openDetailsSurface();
                return;
            }

            pane.openDetailsTab(createSessionScmReviewDetailsTab(), intent);
            openDetailsSurface();
        });
    }, [openDetailsSurface, pane]);

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
            openDetailsSurface();
        });
    }, [openDetailsSurface, pane]);

    const safeAreaTopMode = 'internal';
    const headerSafeAreaTopMode = 'internal';
    const renderSessionChrome = React.useCallback((contentOverride?: React.ReactNode) => (
        <SessionView
            id={props.sessionId}
            routeServerId={props.routeServerId ?? undefined}
            routeHydrationState={props.routeHydrationState}
            jumpToSeq={props.jumpToSeq}
            paneUrlState={props.paneUrlState ?? undefined}
            initialAttachmentDrafts={props.initialAttachmentDrafts}
            routeAnchorOverride={Platform.OS === 'web' ? undefined : true}
            contentOverride={contentOverride}
            safeAreaTopMode={safeAreaTopMode}
            headerSafeAreaTopMode={headerSafeAreaTopMode}
            chatBottomSpacing="none"
            openWorkStateRequestKey={openWorkStateRequestKey}
            resolveBoardPrimaryHost={resolveBoardPrimaryHost}
            sessionPluginRuntime={boardPluginRuntime}
        />
    ), [
        headerSafeAreaTopMode,
        props.initialAttachmentDrafts,
        props.jumpToSeq,
        props.paneUrlState,
        props.routeServerId,
        props.routeHydrationState,
        props.sessionId,
        safeAreaTopMode,
        openWorkStateRequestKey,
        resolveBoardPrimaryHost,
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
                            resolvePrimaryHost={resolveBoardPrimaryHost}
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
                    <SessionCompanionScreen
                        sessionId={props.sessionId}
                        address={sessionAddress}
                        onRevealBoardItem={revealMobileBoardItem}
                        onRequestClose={revealChatSurface}
                        summaryDestinations={companionSummaryDestinations}
                        resolvePrimaryHost={resolveBoardPrimaryHost}
                    />
                </>) : <PaneLoadingFallback />}
            </SessionCockpitFullscreenSurface>,
        );
    }

    // The one Work surface (ORC §3.8, lab `session-P`): the same view the desktop sidebar mounts,
    // titled and given its "+" by the surface header.
    if (props.surface === 'agents') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-agents-screen" safeAreaPadding={false} header={surfaceHeader}>
                <SurfaceStateSizeProvider size="phone">
                    <React.Suspense fallback={<PaneLoadingFallback />}>
                        <SessionWorkViewWithTriggers
                            sessionId={props.sessionId}
                            scopeId={props.scopeId}
                            serverId={servicesServerId}
                        />
                    </React.Suspense>
                </SurfaceStateSizeProvider>
            </SessionCockpitFullscreenSurface>,
        );
    }

    // A retained or deep-linked Collaboration destination can outlive its Home's
    // support for named access. Like every other unsupported surface here, it then
    // falls through to the Session surface host rather than holding an empty shell.
    if (props.surface === 'collaboration' && sessionSharingAvailable && servicesServerId) {
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
                        </PluginSurfaceFocusEligibilityProvider>
                    </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    return renderSessionChrome(
        <View testID="session-details-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SessionDetailsPanel
                sessionId={props.sessionId}
                scopeId={props.scopeId}
                presentation={props.safeAreaPadding === false ? 'screen' : undefined}
                showHeaderActions={false}
                resolveBoardPrimaryHost={resolveBoardPrimaryHost}
            />
        </View>,
    );
});


const SessionCockpitFullscreenSurface = React.memo((props: Readonly<{
    screenTestID: string;
    safeAreaPadding?: boolean;
    /**
     * The surface's large title, with the live line and next step its body publishes through the
     * pane header slot (the same content the desktop sidebar's header shows for that tab).
     */
    header?: Readonly<{ slotKey: string; title: string }> | null;
    children: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const safeAreaPaddingEnabled = props.safeAreaPadding !== false;

    // Cockpit fullscreen surfaces (files/git/terminal/details) sit under the
    // floating overlay bar, so reserve its height at the screen level — this keeps
    // fixed footers/buttons above the bar (scroll content alone self-pads, but
    // fixed elements don't). The reserved area is part of the session screen, so it
    // slides away on dismiss. Then zero the height for descendants so nested scroll
    // content doesn't reserve it a second time. `bottomChromeHeight` is 0 when the
    // bar is hidden, collapsing the reservation.
    const content = props.header ? (
        <PaneHeaderSlotProvider>
            <SessionCockpitSurfaceHeader slotKey={props.header.slotKey} title={props.header.title} testID={`${props.screenTestID}:header`} />
            <PaneHeaderSlotScope slotKey={props.header.slotKey}>
                <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{props.children}</View>
            </PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    ) : props.children;
    const body = safeAreaPaddingEnabled ? content : (
        <SessionCockpitBottomChromeHeightContext.Provider value={0}>
            {content}
        </SessionCockpitBottomChromeHeightContext.Provider>
    );

    return (
        <View
            testID={props.screenTestID}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                backgroundColor: theme.colors.surface.base,
                paddingTop: safeAreaPaddingEnabled ? safeArea.top : 0,
                paddingBottom: safeAreaPaddingEnabled ? safeArea.bottom : bottomChromeHeight,
            }}
        >
            {body}
        </View>
    );
});

function SessionCockpitSurfaceHeader(props: Readonly<{ slotKey: string; title: string; testID: string }>) {
    const published = usePublishedPaneHeaderContent(props.slotKey);
    return (
        <PaneHeader
            size="large"
            testID={props.testID}
            title={props.title}
            line={published?.line ?? null}
            actions={<PaneHeaderActions published={published} title={props.title} testID={props.testID} />}
        />
    );
}
