import * as React from 'react';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { usePresentedDetailNavigationChrome, type PresentedDetailNavigationModel } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { Animated, Platform, View, type LayoutChangeEvent } from 'react-native';
import { useGlobalSearchParams, useOpenAppSection, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceSectionPathname } from '@/components/appShell/workspace/WorkspaceNavigationContext';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SessionSwitcherBand } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionSwitcherBand';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import {
    useSetting,
    useLocalSetting,
} from '@/sync/domains/state/storage';
import {
    isOverlaySurfaceRoutePathname,
    useSurfaceAnchorPathname,
} from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';
import { useDeviceType } from '@/utils/platform/responsive';
import { useWindowFoldMetrics } from '@/utils/platform/useWindowFoldMetrics';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { TabBarNewSessionButton, TabBarPageCreateButton } from '@/components/ui/navigation/TabBarNewSessionButton';
import {
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitChromeRegistration,
    useSessionCockpitDismissingSessionId,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    isSessionRootRoutePath,
    resolveSessionPaneIntentSurface,
    resolveSessionRoutePathForSurface,
    shouldRouteSessionCockpitSurfacePressThroughUrl,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { parseSessionPaneUrlState, serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';

import { PhoneMainAppTabBar, usePhoneLauncherDestinationPinned } from '@/components/appShell/destinations/PhoneDestinationsMenu';
import { isAppDestinationRootPath, isCompactAppDestinationVisible, resolveCurrentAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useCompactAppDestinations } from '@/components/appShell/destinations/useCompactAppDestinations';
import { PHONE_HOME_ROUTE } from '@/components/navigation/shell/PhoneHomeLogoButton';
import { useMainAppTabState } from './MainAppTabStateProvider';
import { isWorkflowsTabRoutePathname, resolveMainTabPressRoute, resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';
import { usePageBarFoldsChrome } from './pageBarChromeFold';
import { resolveMobileBottomChromePresenter } from './resolveMobileBottomChromePresenter';
import { systemTabBarAvailable } from './SystemTabBar';
import { SystemMobileBottomChrome, type SystemMobileBottomChromeModel } from './SystemMobileBottomChrome';
import { usePublishPresentedBottomChrome } from './presentedBottomChrome';

const MAIN_TAB_DEFAULT_ROUTES = {
    inbox: '/',
    sessions: '/',
    projects: '/',
    workflows: '/workflows',
} as const satisfies Record<TabType, string>;

function createInitialMainTabRoutes(): Record<TabType, string> {
    return { ...MAIN_TAB_DEFAULT_ROUTES };
}

function normalizeRouteParam(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value)) {
        return normalizeRouteParam(value[0]);
    }
    return null;
}

function resolveRouteSessionId(pathname: string | null | undefined): string | null {
    const match = /^\/session\/([^/?#]+?)(?:\/|$)/.exec(typeof pathname === 'string' ? pathname : '');
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** The Workflows tab is its route (owner Q4); the other tabs share the home route. */
function resolveRouteOwnedMainTab(pathname: string | null | undefined): TabType | null {
    return typeof pathname === 'string' && isWorkflowsTabRoutePathname(pathname) ? 'workflows' : null;
}

function resolveRememberedMainTabRoute(
    tab: TabType,
    rememberedRoute: string | undefined,
): string {
    if (
        typeof rememberedRoute === 'string'
        && resolveRouteOwnedMainTab(rememberedRoute) === tab
    ) {
        return rememberedRoute;
    }
    return MAIN_TAB_DEFAULT_ROUTES[tab];
}

type BottomChromeItem = Readonly<{
    key: string;
    signature: string;
    node: React.ReactElement;
    systemModel: SystemMobileBottomChromeModel;
    /** Set only for session cockpit chrome — the one answer to "whose band is this". */
    cockpitSessionId?: string;
    /** The presented catalog can change without changing this page's route. */
    detailNavigation?: PresentedDetailNavigationModel;
    chromeRevision?: PresentedDetailNavigationModel['chromeRevision'];
}>;

function isSameBottomChromeItem(left: BottomChromeItem | null, right: BottomChromeItem | null): boolean {
    if (!left || !right) {
        return left === right;
    }
    return left.key === right.key && left.signature === right.signature
        && left.detailNavigation === right.detailNavigation && left.chromeRevision === right.chromeRevision;
}

function isBottomChromeStateSettled(
    state: Readonly<{ current: BottomChromeItem | null; previous: BottomChromeItem | null }>,
    resolvedChrome: BottomChromeItem | null,
): boolean {
    return state.previous === null && isSameBottomChromeItem(state.current, resolvedChrome);
}

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost() {
    const pathname = usePathname();
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const router = useRouter();
    const params = useGlobalSearchParams<Record<string, string | string[]>>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const foldMetrics = useWindowFoldMetrics();
    const systemTabBarEnabled = useLocalSetting('systemTabBarEnabled');
    const presenter = resolveMobileBottomChromePresenter({
        platform: Platform.OS, bridgeAvailable: systemTabBarAvailable,
        verticalBarEdge: foldMetrics?.verticalBarEdge ?? null, enabled: systemTabBarEnabled, deviceType,
    });
    const reduceMotion = useReducedMotionPreference();
    const { activeTab, setActiveTab } = useMainAppTabState();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const routeSessionId = resolveRouteSessionId(pathname);
    const routeServerId = normalizeRouteParam(params.serverId);
    const detailNavigation = usePresentedDetailNavigationChrome();
    const executeDetailNavigation = useMountedScopeActionCommand(detailNavigation?.scope ?? null);
    const setBottomChromeHeight = useSessionCockpitBottomChromeHeightSetter();
    const cockpitRegistration = useSessionCockpitChromeRegistration();
    const dismissingSessionId = useSessionCockpitDismissingSessionId();
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const paneUrlState = React.useMemo(() => parseSessionPaneUrlState(params), [params]);
    const paneRouteQuery = React.useMemo(() => serializeSessionPaneUrlState(paneUrlState ?? {}), [paneUrlState]);
    // Which section or More destination owns this page: the destination catalog's one answer, plus Home,
    // which More opens from its own row outside the catalog.
    const destinationCatalog = useCompactAppDestinations();
    const routeDestination = React.useMemo(() => (typeof anchorPathname === 'string' && anchorPathname !== PHONE_HOME_ROUTE
        ? resolveCurrentAppDestination(destinationCatalog, anchorPathname) : null), [anchorPathname, destinationCatalog]);
    const destinationPinned = usePhoneLauncherDestinationPinned(routeDestination);
    // Settings' pushed pages keep their own Back and no bar unless Settings is pinned; its own page is a main screen
    // like the others (owner 11-10), decided by the catalog's one root answer. A hidden destination is a flow catalogued
    // only for its route (Personalize, a Team's setup): no section or More entry claims it, so its steps own the bottom.
    const sectionPage = anchorPathname === PHONE_HOME_ROUTE
        || (routeDestination !== null && isCompactAppDestinationVisible(routeDestination) && (routeDestination.kind !== 'builtin' || routeDestination.column !== 'settings' || destinationPinned
            || (typeof anchorPathname === 'string' && isAppDestinationRootPath(destinationCatalog, anchorPathname))));
    // The root route is shared by the tabs, so the remembered tab answers there; any other page is its own destination,
    // and on one that isn't on the bar (More's Home included) no tab claims to be here.
    const selectedDestinationId = anchorPathname === '/' ? null : routeDestination?.id ?? (sectionPage ? PHONE_HOME_ROUTE : null);
    const model = resolveMobileBottomChromeModel({
        isAuthenticated: auth.isAuthenticated,
        pathname: anchorPathname,
        mobileWorkspaceExperience,
        mountedDetail: detailNavigation ? { pageKind: detailNavigation.pageKind, identity: detailNavigation.identity,
            activeId: detailNavigation.activeId } : null,
        rootHostedDetail: detailNavigation?.rootHosted,
        explicitMobileSurfaceHint,
        sessionDetailsKind: paneUrlState?.details?.kind ?? null,
        sectionPage,
    });
    const sectionPathname = useWorkspaceSectionPathname();
    const openSection = useOpenAppSection();
    const routeOwnedMainTab = resolveRouteOwnedMainTab(sectionPathname ?? pathname);
    const visibleMainTab = routeOwnedMainTab ?? activeTab;
    const mainTabRoutesRef = React.useRef<Record<TabType, string>>(createInitialMainTabRoutes());
    if (routeOwnedMainTab && typeof pathname === 'string') {
        mainTabRoutesRef.current[routeOwnedMainTab] = pathname;
    }

    // Remember the most recent main tab so a session dismiss can cross-fade to the
    // bar it will actually land on, before the route commits.
    const lastMainTabRef = React.useRef<TabType>(visibleMainTab);
    if (model.kind === 'mainAppTabs') {
        lastMainTabRef.current = visibleMainTab;
    }

    const handleMainAppTabPress = React.useCallback((tab: TabType) => {
        const currentMainTab = routeOwnedMainTab ?? activeTab;
        // From a pushed page or a More destination, a press returns to the tab's own page.
        if (tab === currentMainTab) {
            const rootRoute = resolveMainTabPressRoute({ pathname, targetRoute: MAIN_TAB_DEFAULT_ROUTES[tab] });
            if (rootRoute) openSection(rootRoute);
            return;
        }

        const targetRoute = resolveMainTabPressRoute({ pathname,
            targetRoute: resolveRememberedMainTabRoute(tab, mainTabRoutesRef.current[tab]) });
        if (targetRoute) {
            openSection(targetRoute);
        }
        if (tab !== 'workflows') {
            void setActiveTab(tab);
        }
    }, [activeTab, openSection, pathname, routeOwnedMainTab, setActiveTab]);

    // The nested tab navigator is the source of truth for history/native Back.
    // This outer route owner observes its already-registered active surface and
    // mirrors only a post-initial transition into the route. It does not add a
    // second selection store or write path: the navigator's state-change owner
    // persists the qualified value before this route hint is replaced.
    const observedCockpitSurfaceRef = React.useRef<Readonly<{
        sessionId: string;
        surface: SessionMobileSurface;
    }> | null>(null);
    React.useEffect(() => {
        const registration = cockpitRegistration;
        if (!routeSessionId || !registration || registration.sessionId !== routeSessionId) {
            observedCockpitSurfaceRef.current = null;
            return;
        }

        const next = {
            sessionId: registration.sessionId,
            surface: registration.activeSurface,
        } as const;
        const previous = observedCockpitSurfaceRef.current;
        observedCockpitSurfaceRef.current = next;
        // Registration is populated after the navigator's initial route has
        // mounted. Do not rewrite a restored deep link merely because its
        // chrome registered; subsequent actual state changes are authoritative.
        if (!previous || previous.sessionId !== next.sessionId || previous.surface === next.surface) {
            return;
        }
        // The navigator consuming the root URL's own pane intent (a window narrowed to a phone shows the open
        // Details page on Tabs) is presentation. Projecting it onto `/session/<id>/details?details=…` would make the
        // workspace tab a Details link tab, which it would stay when the window widens again.
        if (isSessionRootRoutePath(pathname, next.sessionId)
            && resolveSessionPaneIntentSurface(paneUrlState, registration.terminalTabAvailable, explicitMobileSurfaceHint) === next.surface) {
            return;
        }

        if (!shouldRouteSessionCockpitSurfacePressThroughUrl({
            pathname,
            sessionId: next.sessionId,
            surface: next.surface,
            terminalTabAvailable: registration.terminalTabAvailable,
            explicitRootSurfaceHint: explicitMobileSurfaceHint,
            paneUrlState,
        })) {
            return;
        }
        // A cockpit tab is a peer view of the Session route (owner 2026-11-17). On a native stack, already on that
        // route, only its query moves: a navigation, even a replace, gives the route's Slot a new child route and
        // rebuilds the whole retained cockpit. Web routes are workspace-hosted, so their URL moves through replace.
        if (Platform.OS !== 'web' && isSessionRootRoutePath(pathname, next.sessionId)) {
            router.setParams({ mobileSurface: next.surface });
            return;
        }
        router.replace(resolveSessionRoutePathForSurface(next.sessionId, next.surface, {
            serverId: routeServerId,
            query: next.surface === 'tabs' ? paneRouteQuery : undefined,
        }));
    }, [
        cockpitRegistration,
        explicitMobileSurfaceHint,
        pathname,
        paneRouteQuery,
        paneUrlState,
        routeServerId,
        routeSessionId,
        router,
    ]);

    const buildMainChrome = React.useCallback((tab: TabType): BottomChromeItem => {
        const node: React.ReactElement<React.ComponentProps<typeof PhoneMainAppTabBar>> = (
            <PhoneMainAppTabBar
                activeTab={tab}
                selectedDestinationId={selectedDestinationId}
                onTabPress={handleMainAppTabPress}
                // Session creation belongs to the sessions surface; any other main screen lends the "+" its own
                // create action (owner 11-10), and a page without one leaves the cell empty.
                trailingAccessory={tab === 'sessions' && (selectedDestinationId === null || selectedDestinationId === 'sessions') ? <TabBarNewSessionButton /> : <TabBarPageCreateButton />}
            />
        );
        return {
            key: 'mainAppTabs',
            signature: `mainAppTabs:${tab}:${selectedDestinationId ?? ''}`,
            node,
            systemModel: { kind: 'mainAppTabs', props: node.props },
        };
    }, [handleMainAppTabPress, selectedDestinationId]);

    // An overlay route (`/new`, the zen modals, …) is presented OVER the current screen rather than
    // replacing it, so it should not change which bar the chrome host is showing — it simply covers
    // it. Recomputing here resolved "no tab, no session" for `/new` and tore the bar down, so
    // closing the composer had to build it back afterwards and the two read as a sequence instead of
    // one surface lifting away. Freezing the last real chrome keeps the bar mounted underneath.
    const overlayRouteActive = typeof pathname === 'string' && isOverlaySurfaceRoutePathname(pathname);
    const frozenChromeRef = React.useRef<BottomChromeItem | null>(null);

    const pageBarFolds = usePageBarFoldsChrome();
    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (overlayRouteActive && frozenChromeRef.current) {
            return frozenChromeRef.current;
        }

        // One bottom chrome at a time (FIN N4): a page's own bottom bar wins while it is on screen.
        if (pageBarFolds) {
            return null;
        }

        if (model.kind === 'mainAppTabs') {
            if (deviceType !== 'phone') {
                return null;
            }
            return buildMainChrome(visibleMainTab);
        }

        if (model.kind === 'detail'
            && detailNavigation
            && isMobileWorkspaceCockpitEnabled({ deviceType, mobileWorkspaceExperience })) {
            // Dismiss-start: the session is sliding out but the route hasn't
            // committed yet. Cross-fade to the destination main bar now (the band
            // dissolves with the outgoing cockpit chrome) instead of at slide-end.
            // The in-flow reservation is route-keyed below, so this is visual-only
            // and a cancelled gesture (`closing:false`) reverts here.
            if (detailNavigation.sessionId && dismissingSessionId === detailNavigation.sessionId) {
                return buildMainChrome(lastMainTabRef.current);
            }
            const chrome = detailNavigation.phoneChrome(executeDetailNavigation);
            if (!chrome) return null;
            return {
                key: `${model.pageKind}:${model.identity}`,
                signature: JSON.stringify([model.pageKind, model.identity, model.activeId]),
                detailNavigation,
                chromeRevision: detailNavigation.chromeRevision,
                cockpitSessionId: detailNavigation.sessionId,
                ...chrome,
            };
        }

        return null;
    }, [
        overlayRouteActive,
        buildMainChrome,
        detailNavigation,
        executeDetailNavigation,
        deviceType,
        dismissingSessionId,
        mobileWorkspaceExperience,
        model,
        pageBarFolds,
        visibleMainTab,
    ]);

    if (!overlayRouteActive) {
        frozenChromeRef.current = resolvedChrome;
    }

    // Hardware/pref eligibility owns the container lifetime, never route visibility or keyboard focus.
    const lastSystemChromeRef = React.useRef<BottomChromeItem | null>(null);
    if (presenter !== 'system') lastSystemChromeRef.current = null;
    else if (resolvedChrome) lastSystemChromeRef.current = resolvedChrome;
    const systemChrome = resolvedChrome ?? lastSystemChromeRef.current;
    // The one answer to "which bar is on screen" for headers that lend controls only where no bar holds them.
    usePublishPresentedBottomChrome(resolvedChrome
        ? resolvedChrome.detailNavigation ? { kind: 'detail', pageKind: resolvedChrome.detailNavigation.pageKind } : { kind: 'main' }
        : null);

    const [renderedChrome, setRenderedChrome] = React.useState<Readonly<{
        current: BottomChromeItem | null;
        previous: BottomChromeItem | null;
    }>>({
        current: resolvedChrome,
        previous: null,
    });
    const renderedChromeRef = React.useRef(renderedChrome);
    const progress = React.useRef(new Animated.Value(1)).current;
    const activeChromeAnimationRef = React.useRef<Animated.CompositeAnimation | null>(null);
    // Latest desired chrome, tracked so the cross-fade completion always settles on
    // the freshest node even if the signature changed mid-transition.
    const latestResolvedChromeRef = React.useRef(resolvedChrome);
    latestResolvedChromeRef.current = resolvedChrome;

    const setRenderedChromeState = React.useCallback((nextChrome: typeof renderedChrome) => {
        renderedChromeRef.current = nextChrome;
        setRenderedChrome(nextChrome);
    }, []);

    const stopChromeAnimation = React.useCallback(() => {
        activeChromeAnimationRef.current?.stop();
        activeChromeAnimationRef.current = null;
        (progress as Animated.Value & { stopAnimation?: () => void }).stopAnimation?.();
    }, [progress]);

    const handleChromeLayout = React.useCallback((event: LayoutChangeEvent) => {
        setBottomChromeHeight(event.nativeEvent.layout.height);
    }, [setBottomChromeHeight]);

    React.useLayoutEffect(() => {
        const currentRenderedState = renderedChromeRef.current;
        const currentRenderedChrome = currentRenderedState.current;

        if (presenter === 'system') {
            stopChromeAnimation();
            if (currentRenderedState.current || currentRenderedState.previous) {
                setRenderedChromeState({ current: null, previous: null });
            }
            progress.setValue(1);
            return;
        }

        if (reduceMotion) {
            stopChromeAnimation();
            if (isBottomChromeStateSettled(currentRenderedState, resolvedChrome)) {
                return;
            }
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            progress.setValue(1);
            return;
        }

        if (!resolvedChrome) {
            if (isBottomChromeStateSettled(currentRenderedState, null)) {
                return;
            }
            if (!currentRenderedChrome) {
                // Nothing on screen to dissolve — either the first frame on a chrome-less route, or
                // a fade already in flight whose `previous` the completion below will clear.
                stopChromeAnimation();
                setRenderedChromeState({ current: null, previous: null });
                progress.setValue(1);
                return;
            }

            // Chrome going away used to be the one transition this host cut rather than animated:
            // every bar-to-bar change cross-fades, but bar-to-nothing snapped. That path is taken
            // whenever an overlay route opens (`/new`), so the abrupt frame sat in one of the
            // most-repeated flows in the app. The bar now leaves the way it arrives — dissolving in
            // place — only faster, because attention is already moving on.
            stopChromeAnimation();
            setRenderedChromeState({ current: null, previous: currentRenderedChrome });
            progress.setValue(0);
            const exitAnimation = Animated.timing(progress, {
                toValue: 1,
                duration: motionTokens.overlay.modal.exitMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: Platform.OS !== 'web',
            });
            activeChromeAnimationRef.current = exitAnimation;
            exitAnimation.start(({ finished }) => {
                if (activeChromeAnimationRef.current !== exitAnimation) {
                    return;
                }
                activeChromeAnimationRef.current = null;
                if (!finished) {
                    return;
                }
                progress.setValue(1);
                setRenderedChromeState({ current: null, previous: null });
            });
            return;
        }

        if (!currentRenderedChrome) {
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        if (currentRenderedChrome.key === resolvedChrome.key) {
            if (isSameBottomChromeItem(currentRenderedChrome, resolvedChrome)) {
                return;
            }
            // Same bar, content changed (badge/surface/etc.). If a cross-fade is
            // in flight, just swap the node and let the animation finish instead of
            // snapping to the final frame (which reads as a flicker).
            if (activeChromeAnimationRef.current) {
                setRenderedChromeState({ current: resolvedChrome, previous: renderedChromeRef.current.previous });
                return;
            }
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        stopChromeAnimation();
        setRenderedChromeState({
            current: resolvedChrome,
            previous: currentRenderedChrome,
        });
        progress.setValue(0);
        const animation = Animated.timing(progress, {
            toValue: 1,
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        activeChromeAnimationRef.current = animation;
        animation.start(({ finished }) => {
            if (activeChromeAnimationRef.current !== animation) {
                return;
            }
            activeChromeAnimationRef.current = null;
            if (!finished) {
                return;
            }
            progress.setValue(1);
            setRenderedChromeState({ current: latestResolvedChromeRef.current ?? resolvedChrome, previous: null });
        });
    }, [presenter, progress, reduceMotion, resolvedChrome, setRenderedChromeState, stopChromeAnimation]);

    React.useLayoutEffect(() => () => {
        stopChromeAnimation();
    }, [stopChromeAnimation]);

    React.useLayoutEffect(() => {
        if (presenter === 'system' || !renderedChrome.current) {
            setBottomChromeHeight(0);
        }
    }, [presenter, renderedChrome.current, setBottomChromeHeight]);

    if (presenter === 'system') {
        return systemChrome ? <SystemMobileBottomChrome model={systemChrome.systemModel} hidden={resolvedChrome === null} /> : null;
    }

    // `previous` outlives `current` while the bar dissolves on its way out, so the host keeps
    // rendering until BOTH are gone. The published chrome height already dropped to 0 above, so the
    // surfaces that pad by it reclaim their space immediately rather than waiting for the fade.
    if (!renderedChrome.current && !renderedChrome.previous) {
        return null;
    }

    // Incoming bar stays fully opaque and remains the top hit-test layer. The
    // outgoing bar dissolves as an inert presentation layer so stale tab presses
    // cannot leak through during route-swap animation on web.
    const currentStyle = {
        position: 'relative',
        zIndex: 1,
    } as const;
    const previousStyle = {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 0,
        opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
        }),
    } as const;

    // Both the main and cockpit bars float over content as a pure overlay: the bar
    // never reserves in-flow space. Each surface clears the bar itself — lists via
    // `ItemList`'s `bottomChromeHeight` padding, the chat composer via the session-
    // owned reservation in `AgentContentView`. Because the reservation lives inside
    // the session screen, it slides away with the session on dismiss, so the window
    // canvas behind the chrome is never exposed as a lingering bottom band.
    // Full-screen and transparent to touches (`box-none`), with the bar at its foot: the switcher
    // a session's bar opens rises above the bar, and Android only delivers touches to children
    // inside their parent's bounds. The published chrome height is the bar's own (measured on it
    // below), never this frame's.
    const wrapperStyle = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' } as const;

    // On a session the bar is wrapped by the switcher band, which owns the bar's gestures and the
    // switcher they open. The band keeps the same element type for the whole session, so the bar
    // never remounts when a gesture setting or the keyboard changes.
    // Animation state owns visual identity, not callback or projection freshness.
    // A registration can arrive without changing the bar's signature.
    const currentChrome = isSameBottomChromeItem(renderedChrome.current, resolvedChrome)
        ? resolvedChrome
        : renderedChrome.current;
    const currentChromeContent = currentChrome ? (
        currentChrome.cockpitSessionId ? (
            <SessionSwitcherBand sessionId={currentChrome.cockpitSessionId} serverId={routeServerId}>
                {currentChrome.node}
            </SessionSwitcherBand>
        ) : currentChrome.node
    ) : null;

    return (
        <View pointerEvents="box-none" style={wrapperStyle}>
            {currentChromeContent ? (
                <View onLayout={handleChromeLayout} pointerEvents="box-none" style={currentStyle}>
                    {currentChromeContent}
                </View>
            ) : null}
            {renderedChrome.previous ? (
                <Animated.View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    pointerEvents="none"
                    style={previousStyle}
                >
                    {renderedChrome.previous.node}
                </Animated.View>
            ) : null}
        </View>
    );
});
