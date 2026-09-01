import * as React from 'react';
import { Animated, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, type WithSpringConfig } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { router as expoRouter, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { SessionCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/SessionCockpitTabBar';
import {
    resolveSessionLateralPickerCommit,
    resolveSessionLateralPickerFrame,
} from '@/components/navigation/mobile/chrome/lateralSwipe/sessionLateralPickerState';
import { SessionCockpitLateralPicker } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionCockpitLateralPicker';
import {
    SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX,
    SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX,
    SESSION_LATERAL_SWIPE_TRAVEL_GAIN,
    resolveSessionLateralSwipeEdgeHitSlop,
    resolveSessionLateralSwipeProgress,
} from '@/components/navigation/mobile/chrome/lateralSwipe/sessionLateralSwipeMotion';
import { useSessionCockpitLateralNavigation } from '@/components/navigation/mobile/chrome/lateralSwipe/useSessionCockpitLateralNavigation';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import {
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitChromeRegistration,
    useSessionCockpitDismissingSessionId,
    useSessionLateralSwipe,
    type SessionLateralSwipePickerState,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    resolveSessionCockpitRouteFromPathname,
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveSlideTransitionSpring } from '@/components/ui/motion/slideTransitionTokens';
import { hapticsLight, hapticsSelection } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { TabBar, type TabType } from '@/components/ui/navigation/TabBar';
import { TabBarNewSessionButton } from '@/components/ui/navigation/TabBarNewSessionButton';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useTabState } from '@/hooks/ui/useTabState';
import {
    isOverlaySurfaceRoutePathname,
    normalizeSurfaceRoutePathname,
} from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';
import { usePersistSessionLastMobileSurface, useSessionLastMobileSurface, useSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

type TabRouteHref = Parameters<typeof expoRouter.replace>[0];

const TAB_ROUTES = {
    inbox: '/inbox',
    sessions: '/',
    friends: '/friends',
    settings: '/settings',
} satisfies Record<TabType, TabRouteHref>;

function createInitialMainTabRoutes(): Record<TabType, TabRouteHref> {
    return { ...TAB_ROUTES };
}

export function resolveMobileBottomChromeActiveTab(pathname: string): TabType | null {
    if (pathname === '/') return 'sessions';
    if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
    if (pathname === '/inbox' || pathname.startsWith('/inbox/')) return 'inbox';
    if (pathname === '/friends' || pathname.startsWith('/friends/')) return 'friends';
    return null;
}

function resolveRememberedMainTabRoute(
    tab: TabType,
    rememberedRoute: TabRouteHref | undefined,
): TabRouteHref {
    if (
        typeof rememberedRoute === 'string'
        && resolveMobileBottomChromeActiveTab(rememberedRoute) === tab
    ) {
        return rememberedRoute as TabRouteHref;
    }
    return TAB_ROUTES[tab];
}

function normalizeRouteParam(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    if (Array.isArray(value)) {
        return normalizeRouteParam(value[0]);
    }
    return null;
}

type BottomChromeItem = Readonly<{
    key: string;
    signature: string;
    node: React.ReactElement;
    /** Set only for session cockpit chrome — the one answer to "whose band is this". */
    cockpitSessionId?: string;
}>;

function buildSessionCockpitChromeKey(sessionId: string): string {
    return `sessionCockpitTabs:${sessionId}`;
}

/**
 * Puts the gesture's second axis back at rest.
 *
 * Module scope, not a `useCallback` worklet: the gesture handlers call it on the UI
 * thread, and a helper that is not reliably workletized throws there and surfaces
 * somewhere else entirely. It closes over nothing and takes what it needs.
 *
 * `settle` is the difference between a release and a reset. On release the frost and the
 * rows fade out IN PLACE — the row positions are deliberately left frozen so the exit does
 * not slide against the capsule's own travel, and the capsule keeps naming the destination
 * while the switch lands. A reset (a new touch, or the destination having arrived) also
 * drops the selection itself, which is what guarantees every gesture re-resolves its rows
 * instead of reusing the list the last one cached.
 */
function closeSessionLateralPicker(params: Readonly<{
    picker: SessionLateralSwipePickerState;
    settle: boolean;
    spring: WithSpringConfig;
    reducedMotion: boolean;
}>): void {
    'worklet';
    params.picker.browseProgress.value = params.settle && !params.reducedMotion
        ? withSpring(0, params.spring)
        : 0;
    if (params.settle) return;
    params.picker.direction.value = null;
    params.picker.rowOffset.value = 0;
    params.picker.index.value = 0;
}

export const SESSION_LATERAL_SWIPE_GESTURE_TEST_ID = 'session-cockpit-lateral-swipe';
export const SESSION_LATERAL_SWIPE_HIT_TARGET_TEST_ID = 'session-cockpit-band-hit-target';

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost(props: Readonly<{
    /** Canonical pre-push presentation decision from the app stack owner. */
    newSessionRendersFloatingComposer?: boolean;
}>) {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<{ mobileSurface?: string | string[]; serverId?: string | string[] }>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    // Passive settled keyboard height, for chrome suppression and for keeping the lateral
    // swipe out of the rows the keyboard occupies. Composer positioning must use the
    // keyboard scaffold instead of this React-state path.
    const keyboardHeightPx = useKeyboardHeight();
    const softwareKeyboardVisible = deviceType === 'phone' && keyboardHeightPx > 0;
    const setBottomChromeHeight = useSessionCockpitBottomChromeHeightSetter();
    const reduceMotion = useReducedMotionPreference();
    const { setActiveTab } = useTabState();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const cockpitRegistration = useSessionCockpitChromeRegistration();
    const dismissingSessionId = useSessionCockpitDismissingSessionId();
    const activeTab = auth.isAuthenticated === true && typeof pathname === 'string'
        ? resolveMobileBottomChromeActiveTab(pathname)
        : null;
    const mainTabRoutesRef = React.useRef<Record<TabType, TabRouteHref>>(createInitialMainTabRoutes());
    if (activeTab && typeof pathname === 'string') {
        mainTabRoutesRef.current[activeTab] = pathname as TabRouteHref;
    }
    // Remember the most recent main tab so a session dismiss can cross-fade to the
    // bar it will actually land on, before the route commits.
    const lastMainTabRef = React.useRef<TabType>('sessions');
    if (activeTab) {
        lastMainTabRef.current = activeTab;
    }
    const sessionRouteMatch = React.useMemo(() => {
        const match = /^\/session\/([^/?#]+?)(?:\/|$)/.exec(typeof pathname === 'string' ? pathname : '');
        return match?.[1] ? decodeURIComponent(match[1]) : null;
    }, [pathname]);
    const persistedMobileSurface = useSessionLastMobileSurface(sessionRouteMatch);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const serverId = normalizeRouteParam(params.serverId);
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const terminalAvailability = useSessionTerminalAvailability({
        sessionId: sessionRouteMatch ?? undefined,
        serverId,
    });
    const cockpitRoute = React.useMemo(() => {
        if (!sessionRouteMatch) return null;
        return resolveSessionCockpitRouteFromPathname(
            pathname,
            persistedMobileSurface,
            terminalAvailability.sidebarTabAvailable,
            explicitMobileSurfaceHint,
        );
    }, [
        explicitMobileSurfaceHint,
        pathname,
        persistedMobileSurface,
        sessionRouteMatch,
        terminalAvailability.sidebarTabAvailable,
    ]);

    const handleTabPress = React.useCallback((tab: TabType) => {
        const targetRoute = resolveRememberedMainTabRoute(tab, mainTabRoutesRef.current[tab]);
        if (activeTab === tab) {
            if (typeof pathname === 'string' && pathname !== TAB_ROUTES[tab]) {
                router.navigate(TAB_ROUTES[tab]);
            }
            return;
        }

        router.navigate(targetRoute);
        if (tab !== 'settings') {
            fireAndForget(setActiveTab(tab));
        }
    }, [activeTab, pathname, router, setActiveTab]);

    const persistSessionSurface = React.useCallback((sessionId: string, surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(sessionId, surface);
    }, [persistSessionLastMobileSurface]);

    const handleCockpitSurfacePress = React.useCallback((surface: SessionMobileSurface) => {
        const sessionId = cockpitRoute?.sessionId ?? cockpitRegistration?.sessionId ?? null;
        if (!sessionId) return;

        const matchingRegistration =
            cockpitRegistration?.sessionId === sessionId
                ? cockpitRegistration
                : null;
        if (matchingRegistration) {
            matchingRegistration.switchSurface(surface);
            return;
        }

        persistSessionSurface(sessionId, surface);
        router.replace(resolveSessionRoutePathForSurface(sessionId, surface, { serverId }));
    }, [cockpitRegistration, cockpitRoute?.sessionId, persistSessionSurface, router, serverId]);

    const buildMainChrome = React.useCallback((tab: TabType): BottomChromeItem => ({
        key: 'mainAppTabs',
        signature: `mainAppTabs:${tab}`,
        node: (
            <TabBar
                activeTab={tab}
                onTabPress={handleTabPress}
                // Session creation belongs to the sessions surface; settings, inbox
                // and friends keep the bar as a pure navigation control.
                trailingAccessory={tab === 'sessions' ? <TabBarNewSessionButton /> : undefined}
            />
        ),
    }), [handleTabPress]);

    // An overlay route (`/new`, the zen modals, …) is presented OVER the current screen rather than
    // replacing it, so it should not change which bar the chrome host is showing — it simply covers
    // it. Recomputing here treated `/new` as "no tab, no session" and tore the bar down, so closing
    // the composer had to build it back afterwards and the two reads as a sequence instead of one
    // surface lifting away. Freezing the last real chrome keeps the bar mounted and untouched
    // underneath, which is also why it can come back with no animation at all.
    const overlayRouteActive = typeof pathname === 'string' && isOverlaySurfaceRoutePathname(pathname);
    const androidFloatingNewSessionActive = Platform.OS === 'android'
        && normalizeSurfaceRoutePathname(pathname) === '/new'
        && props.newSessionRendersFloatingComposer === true;
    const frozenChromeRef = React.useRef<BottomChromeItem | null>(null);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (deviceType !== 'phone') {
            return null;
        }

        if (overlayRouteActive) {
            return frozenChromeRef.current;
        }

        if (activeTab) {
            if (softwareKeyboardVisible) {
                return null;
            }

            return buildMainChrome(activeTab);
        }

        const registeredCockpitRoute = cockpitRegistration
            ? {
                sessionId: cockpitRegistration.sessionId,
                surface: cockpitRegistration.activeSurface,
            }
            : null;
        const activeCockpitRoute = cockpitRoute ?? registeredCockpitRoute;

        if (
            activeCockpitRoute
            && isMobileWorkspaceCockpitEnabled({ deviceType, mobileWorkspaceExperience })
        ) {
            // Dismiss-start: the session is sliding out but the route hasn't
            // committed yet. Cross-fade to the destination main bar now (the band
            // dissolves with the outgoing cockpit chrome) instead of at slide-end.
            // The in-flow reservation is route-keyed below, so this is visual-only
            // and a cancelled gesture (`closing:false`) reverts here.
            if (dismissingSessionId === activeCockpitRoute.sessionId) {
                return buildMainChrome(lastMainTabRef.current);
            }

            const matchingRegistration =
                cockpitRegistration?.sessionId === activeCockpitRoute.sessionId
                    ? cockpitRegistration
                    : null;
            const activeSurface = matchingRegistration?.activeSurface ?? activeCockpitRoute.surface;
            const terminalTabAvailable = matchingRegistration?.terminalTabAvailable ?? terminalAvailability.sidebarTabAvailable;
            const openDetailsTabCount = matchingRegistration?.openDetailsTabCount ?? 0;

            return {
                key: buildSessionCockpitChromeKey(activeCockpitRoute.sessionId),
                signature: `sessionCockpitTabs:${activeCockpitRoute.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}:tabs${openDetailsTabCount}`,
                cockpitSessionId: activeCockpitRoute.sessionId,
                node: (
                    <SessionCockpitTabBar
                        sessionId={activeCockpitRoute.sessionId}
                        activeSurface={activeSurface}
                        terminalTabAvailable={terminalTabAvailable}
                        openDetailsTabCount={openDetailsTabCount}
                        onSurfacePress={handleCockpitSurfacePress}
                    />
                ),
            };
        }

        return null;
    }, [
        activeTab,
        buildMainChrome,
        overlayRouteActive,
        cockpitRegistration,
        cockpitRoute,
        deviceType,
        dismissingSessionId,
        handleCockpitSurfacePress,
        mobileWorkspaceExperience,
        softwareKeyboardVisible,
        terminalAvailability.sidebarTabAvailable,
    ]);

    if (!overlayRouteActive) {
        frozenChromeRef.current = resolvedChrome;
    }

    // ---------------------------------------------------------------------------
    // Lateral session swipe.
    //
    // The band is the only chrome that spans the full width on a session route, and
    // it is otherwise empty pixels, so it carries the power-user shortcut for moving
    // through the session order the user last saw. There is deliberately NO resting
    // affordance: the capsule itself becomes the readout while the finger is down.
    // ---------------------------------------------------------------------------
    const cockpitSessionId = resolvedChrome?.cockpitSessionId ?? null;
    const lateralSwipe = useSessionLateralSwipe();
    const lateralNavigation = useSessionCockpitLateralNavigation({ sessionId: cockpitSessionId, serverId });
    const lateralSwipeSettingEnabled = useSetting('sessionCockpitSwipeNavigationEnabled');
    const lateralNavigate = lateralNavigation.navigate;
    const canStepPrevious = lateralNavigation.previous !== null;
    const canStepNext = lateralNavigation.next !== null;
    // Native phones only: this is a touch shortcut for the mobile cockpit, and on
    // mobile web the browser owns horizontal edge gestures.
    const lateralNavigationAvailable = Platform.OS !== 'web'
        && deviceType === 'phone'
        && cockpitSessionId !== null
        && lateralSwipeSettingEnabled === true;

    const canStepPreviousSV = useSharedValue(false);
    const canStepNextSV = useSharedValue(false);
    // How many sessions lie each way, capped at the picker's reach. The gesture needs
    // both before it knows which one the finger will lock, so they are published up
    // front rather than resolved mid-worklet.
    const availablePreviousSV = useSharedValue(0);
    const availableNextSV = useSharedValue(0);
    // Single-flight: a commit already travelling must ignore re-entrant releases, the
    // way `StoryDeckSlideTransition` guards its own commit spring.
    const lateralCommitInFlightSV = useSharedValue(false);
    const lateralAvailableCount = lateralNavigation.availableCount;
    React.useEffect(() => {
        canStepPreviousSV.value = canStepPrevious;
        canStepNextSV.value = canStepNext;
        availablePreviousSV.value = lateralAvailableCount('previous');
        availableNextSV.value = lateralAvailableCount('next');
    }, [
        availableNextSV,
        availablePreviousSV,
        canStepNext,
        canStepNextSV,
        canStepPrevious,
        canStepPreviousSV,
        lateralAvailableCount,
    ]);

    // A lateral switch changes the chrome key, which normally cross-fades the bar.
    // Suppress that for exactly the switch we caused: the capsule is under the
    // finger, and dissolving the surface being dragged is the one thing that would
    // make the gesture feel broken. Same shape as the `dismissingSessionId` flag.
    const lateralSwitchSourceSessionIdRef = React.useRef<string | null>(null);
    const commitLateralStep = React.useCallback((direction: SessionNavigationDirection, index: number) => {
        lateralSwitchSourceSessionIdRef.current = cockpitSessionId;
        if (!lateralNavigate(direction, index)) {
            lateralSwitchSourceSessionIdRef.current = null;
            return;
        }
        // Aligned with the threshold crossing at release — the causal moment — rather
        // than with the end of the settle animation. Fired after the step so a device
        // that cannot vibrate cannot swallow the navigation.
        hapticsLight();
    }, [cockpitSessionId, lateralNavigate]);

    const lateralSpring = resolveSlideTransitionSpring('soft', { reducedMotion: reduceMotion });
    const lateralSwipeProgress = lateralSwipe.progress;
    const lateralSwipeActive = lateralSwipe.isActive;
    const lateralPicker = lateralSwipe.picker;
    const lateralPanGesture = React.useMemo(() => {
        // Absent rather than inert: when the shortcut cannot apply the recognizer must
        // not exist at all, so it never enters arbitration with a tab press.
        if (!lateralNavigationAvailable) return null;
        if (keyboardHeightPx > 0) return null;
        if (!canStepPrevious && !canStepNext) return null;

        return Gesture.Pan()
            .withTestId(SESSION_LATERAL_SWIPE_GESTURE_TEST_ID)
            // Wider than the carousel's 10px on purpose: the tabs carry `hitSlop: 8`,
            // so a slightly sloppy tap must never arm the pan.
            .activeOffsetX([-SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX, SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX])
            // Deliberately NO `failOffsetY`. Activation stays horizontal-only — which is
            // what keeps tab taps and vertical intent behaving exactly as they did — but
            // once the pan owns the touch, BOTH axes are its own: the upward movement
            // that opens the picker is the movement a vertical failure bound cancelled
            // on. Nothing under the band wants the vertical anyway: every cockpit
            // surface reserves `bottomChromeHeight`, so the band rectangle is background,
            // and the full-bleed hit target below already consumed these touches.
            .hitSlop(resolveSessionLateralSwipeEdgeHitSlop(Platform.OS))
            .cancelsTouchesInView(true)
            .onBegin(() => {
                'worklet';
                lateralSwipeActive.value = true;
                closeSessionLateralPicker({
                    picker: lateralPicker,
                    settle: false,
                    spring: lateralSpring,
                    reducedMotion: reduceMotion,
                });
            })
            .onUpdate((event: { translationX?: number; translationY?: number }) => {
                'worklet';
                if (lateralCommitInFlightSV.value) return;
                lateralSwipeProgress.value = resolveSessionLateralSwipeProgress({
                    translationX: event.translationX ?? 0,
                    canStepPrevious: canStepPreviousSV.value,
                    canStepNext: canStepNextSV.value,
                });
                const resolved = resolveSessionLateralPickerFrame({
                    translationX: event.translationX ?? 0,
                    translationY: event.translationY ?? 0,
                    availablePrevious: availablePreviousSV.value,
                    availableNext: availableNextSV.value,
                    lockedDirection: lateralPicker.direction.value,
                });
                // One tick per row crossed, fired from the compare-before-write rather
                // than from a reaction: the gesture already knows the old index, so the
                // dedupe is inherent and no frame can double-fire. The direction lock
                // itself (0 -> 1) is not a selection change and stays silent, the way
                // the shipped horizontal step does.
                const previousIndex = lateralPicker.index.value;
                if (resolved.index !== previousIndex && previousIndex >= 1 && resolved.index >= 1) {
                    scheduleOnRN(hapticsSelection);
                }
                lateralPicker.direction.value = resolved.direction;
                lateralPicker.browseProgress.value = resolved.browseProgress;
                lateralPicker.rowOffset.value = resolved.rowOffset;
                lateralPicker.index.value = resolved.index;
            })
            .onEnd((event: { translationX?: number; translationY?: number; velocityX?: number }, success?: boolean) => {
                'worklet';
                if (lateralCommitInFlightSV.value) return;
                const commit = resolveSessionLateralPickerCommit({
                    // Resolved from the release frame rather than read back from the
                    // shared values, so a flick that ends before it ever updates commits
                    // exactly the way the shipped gesture does.
                    state: resolveSessionLateralPickerFrame({
                        translationX: event.translationX ?? 0,
                        translationY: event.translationY ?? 0,
                        availablePrevious: availablePreviousSV.value,
                        availableNext: availableNextSV.value,
                        lockedDirection: lateralPicker.direction.value,
                    }),
                    translationX: event.translationX ?? 0,
                    velocityX: event.velocityX ?? 0,
                    // RNGH reports a gesture the system took away as an unsuccessful end.
                    cancelled: success === false,
                });
                if (!commit) {
                    // Below threshold, rubber-banding against an end of the order, or
                    // taken away: settle back with no commit and no haptic.
                    lateralSwipeProgress.value = reduceMotion ? 0 : withSpring(0, lateralSpring);
                    lateralSwipeActive.value = false;
                    closeSessionLateralPicker({
                        picker: lateralPicker,
                        settle: true,
                        spring: lateralSpring,
                        reducedMotion: reduceMotion,
                    });
                    return;
                }
                lateralCommitInFlightSV.value = true;
                // Commit here, not from the spring's completion callback: the release IS
                // the decision, and the settle only carries the eye to the destination.
                scheduleOnRN(commitLateralStep, commit.direction, commit.index);
                // The picker dissolves at the release, leaving the capsule — which is
                // already showing the destination — to carry the switch on its own.
                closeSessionLateralPicker({
                    picker: lateralPicker,
                    settle: true,
                    spring: lateralSpring,
                    reducedMotion: reduceMotion,
                });
                // Reduced motion snap-commits and still navigates.
                lateralSwipeProgress.value = reduceMotion
                    ? 0
                    : withSpring(commit.direction === 'previous' ? 1 : -1, lateralSpring);
            })
            .onFinalize(() => {
                'worklet';
                if (lateralCommitInFlightSV.value) return;
                // Android claims its edge strips AFTER the app has already received the
                // touch down, so a pan can begin and then be cancelled. That is a
                // snap-back, never a commit.
                lateralSwipeProgress.value = reduceMotion ? 0 : withSpring(0, lateralSpring);
                lateralSwipeActive.value = false;
                closeSessionLateralPicker({
                    picker: lateralPicker,
                    settle: true,
                    spring: lateralSpring,
                    reducedMotion: reduceMotion,
                });
            });
    }, [
        availableNextSV,
        availablePreviousSV,
        canStepNext,
        canStepNextSV,
        canStepPrevious,
        canStepPreviousSV,
        commitLateralStep,
        keyboardHeightPx,
        lateralCommitInFlightSV,
        lateralNavigationAvailable,
        lateralPicker,
        lateralSpring,
        lateralSwipeActive,
        lateralSwipeProgress,
        reduceMotion,
    ]);

    // The capsule follows the finger at reduced gain; reduced motion keeps the readout
    // but drops the travel.
    const lateralTravelGain = reduceMotion ? 0 : SESSION_LATERAL_SWIPE_TRAVEL_GAIN;
    const bandTravelStyle = useAnimatedStyle(() => ({
        transform: [{
            translateX: lateralSwipeProgress.value * SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * lateralTravelGain,
        }],
    }), [lateralSwipeProgress, lateralTravelGain]);

    // The destination has painted: land the capsule — and the session content, which
    // reads the same progress — back at rest, and release the single-flight guard.
    // Resetting from the spring callback instead would land before React paints the new
    // bar and flash the outgoing session.
    //
    // The return SETTLES rather than snaps: the destination mounts while progress is
    // still at its extreme, so the inward travel is what covers the session remount.
    // Unconditional on purpose — an arrival that was not a swipe is already at rest, and
    // springing a value to where it already sits costs a frame and no movement, which is
    // cheaper than a second flag mirroring the gesture's own single-flight guard across
    // the JS/UI thread boundary. Reduced motion lands instantly, like every other branch.
    React.useLayoutEffect(() => {
        lateralSwipeProgress.value = reduceMotion ? 0 : withSpring(0, lateralSpring);
        lateralSwipeActive.value = false;
        lateralCommitInFlightSV.value = false;
        // A hard reset: the destination has painted, so the previous session's selection
        // must not survive into the next gesture.
        closeSessionLateralPicker({
            picker: lateralPicker,
            settle: false,
            spring: lateralSpring,
            reducedMotion: reduceMotion,
        });
    }, [
        cockpitSessionId,
        lateralPicker,
        lateralCommitInFlightSV,
        lateralSpring,
        lateralSwipeActive,
        lateralSwipeProgress,
        reduceMotion,
    ]);


    const [renderedChrome, setRenderedChrome] = React.useState<Readonly<{
        current: BottomChromeItem | null;
        previous: BottomChromeItem | null;
    }>>({
        current: resolvedChrome,
        previous: null,
    });
    const renderedChromeRef = React.useRef(renderedChrome);
    const progress = React.useRef(new Animated.Value(1)).current;
    const activeAnimationRef = React.useRef<Animated.CompositeAnimation | null>(null);
    // Latest desired chrome, tracked so the cross-fade completion always settles on
    // the freshest node even if the signature changed mid-transition.
    const latestResolvedChromeRef = React.useRef(resolvedChrome);
    latestResolvedChromeRef.current = resolvedChrome;

    const setRenderedChromeState = React.useCallback((nextChrome: typeof renderedChrome) => {
        renderedChromeRef.current = nextChrome;
        setRenderedChrome(nextChrome);
    }, []);

    const stopChromeAnimation = React.useCallback(() => {
        activeAnimationRef.current?.stop();
        activeAnimationRef.current = null;
        (progress as Animated.Value & { stopAnimation?: () => void }).stopAnimation?.();
    }, [progress]);

    const handleChromeLayout = React.useCallback((event: LayoutChangeEvent) => {
        setBottomChromeHeight(event.nativeEvent.layout.height);
    }, [setBottomChromeHeight]);

    React.useLayoutEffect(() => {
        const currentRenderedChrome = renderedChromeRef.current.current;

        if (!resolvedChrome) {
            if (!currentRenderedChrome) {
                stopChromeAnimation();
                progress.setValue(1);
                setRenderedChromeState({ current: null, previous: null });
                return;
            }

            // Chrome going away used to be the one transition this host cut rather than animated:
            // every bar-to-bar change cross-faded, but bar-to-nothing snapped. That path is taken
            // whenever an overlay route opens (`/new`) or the keyboard comes up, so the abrupt
            // frame was in the most-repeated flows in the app. The bar leaves the same way it
            // arrives — dissolving in place — only faster, because attention is already moving on.
            stopChromeAnimation();
            setRenderedChromeState({ current: null, previous: currentRenderedChrome });

            if (reduceMotion) {
                progress.setValue(1);
                setRenderedChromeState({ current: null, previous: null });
                return;
            }

            progress.setValue(0);
            const exitAnimation = Animated.timing(progress, {
                toValue: 1,
                duration: motionTokens.overlay.modal.exitMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: Platform.OS !== 'web',
            });
            activeAnimationRef.current = exitAnimation;
            exitAnimation.start(({ finished }) => {
                if (activeAnimationRef.current !== exitAnimation) {
                    return;
                }
                activeAnimationRef.current = null;
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
            if (currentRenderedChrome.signature === resolvedChrome.signature) {
                return;
            }
            // Same bar, content changed (badge/surface/etc.). If a cross-fade is
            // in flight, just swap the node and let the animation finish instead of
            // snapping to the final frame (which reads as a flicker).
            if (activeAnimationRef.current) {
                setRenderedChromeState({ current: resolvedChrome, previous: renderedChromeRef.current.previous });
                return;
            }
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        // A lateral switch we just committed: the capsule is mid-morph and settling
        // toward the destination, so the bar must NOT dissolve underneath it. Consume
        // the flag on the first key change either way, so a switch that never landed
        // cannot suppress an unrelated cross-fade later.
        const lateralSwitchSourceSessionId = lateralSwitchSourceSessionIdRef.current;
        lateralSwitchSourceSessionIdRef.current = null;
        if (
            lateralSwitchSourceSessionId !== null
            && currentRenderedChrome.key === buildSessionCockpitChromeKey(lateralSwitchSourceSessionId)
            && resolvedChrome.cockpitSessionId !== undefined
        ) {
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

        if (reduceMotion) {
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        progress.setValue(0);
        const animation = Animated.timing(progress, {
            toValue: 1,
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        activeAnimationRef.current = animation;
        animation.start(({ finished }) => {
            if (activeAnimationRef.current !== animation) {
                return;
            }
            activeAnimationRef.current = null;
            if (!finished) {
                return;
            }
            progress.setValue(1);
            setRenderedChromeState({ current: latestResolvedChromeRef.current ?? resolvedChrome, previous: null });
        });
    }, [progress, reduceMotion, resolvedChrome, setRenderedChromeState, stopChromeAnimation]);

    React.useLayoutEffect(() => () => {
        stopChromeAnimation();
    }, [stopChromeAnimation]);

    React.useLayoutEffect(() => {
        if (!renderedChrome.current) {
            setBottomChromeHeight(0);
        }
    }, [renderedChrome.current, setBottomChromeHeight]);

    // `previous` outlives `current` while the bar dissolves on its way out, so the host keeps
    // rendering until BOTH are gone. The published chrome height already dropped to 0 above, so
    // the surfaces that pad by it reclaim their space immediately rather than waiting for the fade.
    if (!renderedChrome.current && !renderedChrome.previous) {
        return null;
    }

    // Android's transparent native-stack screen and this global chrome host are sibling native
    // views. The host is mounted after the Stack, so keeping its pixels rendered places them above
    // the composer's app-painted scrim even though its frozen model is conceptually "under" the
    // modal. Keep that model intact for an immediate return, but contribute no sibling pixels while
    // the floating composer is active. Other presentations keep the normal frozen-underlay path.
    if (androidFloatingNewSessionActive) {
        return null;
    }

    // Incoming bar stays fully opaque; the outgoing bar dissolves over it. This
    // avoids two translucent glass layers cross-fading at once (their backgrounds
    // would compound at the midpoint, which reads as a flicker).
    const previousStyle = {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
        }),
    } as const;

    // The band's only hit-testable pixels, and they exist ONLY while the lateral pan
    // does — i.e. only for cockpit chrome. On the main tabs the list scrolls under the
    // band, so a full-bleed target there would eat those touches. The pan is attached
    // to the wrapper ABOVE the bar, so it also sees touches that start on a tab (an
    // ancestor is always in the touch path) while the tab keeps its own press.
    const bandContent = (
        <Reanimated.View pointerEvents="box-none" style={bandTravelStyle}>
            {/* Rendered BEFORE the bar so the bar paints over the scrim's ground, and
                inside the travelling wrapper so the column stays attached to the capsule
                it feeds. Mounted exactly where the pan exists — the picker is the pan's
                second axis, not a surface of its own. */}
            {lateralPanGesture ? (
                <SessionCockpitLateralPicker sessionId={cockpitSessionId} serverId={serverId} />
            ) : null}
            {lateralPanGesture ? (
                <View style={StyleSheet.absoluteFill} testID={SESSION_LATERAL_SWIPE_HIT_TARGET_TEST_ID} />
            ) : null}
            {renderedChrome.current?.node ?? null}
        </Reanimated.View>
    );

    // Both the main and cockpit bars float over content as a pure overlay: the bar
    // never reserves in-flow space. Each surface clears the bar itself — lists via
    // `ItemList`'s `bottomChromeHeight` padding, the chat composer via the session-
    // owned reservation in `AgentContentView`. Because the reservation lives inside
    // the session screen, it slides away with the session on dismiss, so the window
    // canvas behind the chrome is never exposed as a lingering bottom band.
    return (
        // No accessibility actions here: this container is `box-none` and is not an
        // accessibility element, so a screen reader can never focus it and actions placed
        // on it would never reach the VoiceOver rotor or the TalkBack context menu. They
        // ride the cockpit tabs instead, which are focusable — see `SessionCockpitTabBar`.
        <View
            onLayout={handleChromeLayout}
            pointerEvents="box-none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
            {renderedChrome.current ? (
                lateralPanGesture
                    ? <GestureDetector gesture={lateralPanGesture}>{bandContent}</GestureDetector>
                    : bandContent
            ) : null}
            {renderedChrome.previous ? (
                <Animated.View pointerEvents="none" style={previousStyle}>
                    {renderedChrome.previous.node}
                </Animated.View>
            ) : null}
        </View>
    );
});
