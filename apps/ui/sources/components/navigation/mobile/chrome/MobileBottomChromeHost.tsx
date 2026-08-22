import * as React from 'react';
import { Animated, Keyboard, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, type WithSpringConfig } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { slideTransitionTokens } from '@/components/ui/motion/slideTransitionTokens';
import { hapticsLight, hapticsSelection } from '@/components/ui/theme/haptics';
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
import {
    useSessionLateralSwipe,
    type SessionLateralSwipePickerState,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import {
    usePersistProjectLastMobileSurface,
    usePersistSessionLastMobileSurface,
    useProjectLastMobileSurface,
    useSessionLastMobileSurface,
    useSetting,
} from '@/sync/domains/state/storage';
import { isOverlaySurfaceRoutePathname } from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { TabBarNewSessionButton } from '@/components/ui/navigation/TabBarNewSessionButton';
import {
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitChromeRegistration,
    useSessionCockpitDismissingSessionId,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    resolveSessionRoutePathForSurface,
    shouldRouteSessionCockpitSurfacePressThroughUrl,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';

import { MainAppTabBar } from './bars/MainAppTabBar';
import { ProjectCockpitTabBar } from './bars/ProjectCockpitTabBar';
import { SessionCockpitTabBar } from './bars/SessionCockpitTabBar';
import { useMainAppTabState } from './MainAppTabStateProvider';
import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

const MAIN_TAB_DEFAULT_ROUTES = {
    inbox: '/',
    sessions: '/',
    projects: '/',
    friends: '/',
    settings: '/settings',
} satisfies Record<TabType, string>;

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

function resolveRouteWorkspaceRefId(pathname: string | null | undefined): string | null {
    const match = /^\/projects\/([^/?#]+?)(?:\/|$)/.exec(typeof pathname === 'string' ? pathname : '');
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function resolveRouteOwnedMainTab(pathname: string | null | undefined): TabType | null {
    if (typeof pathname !== 'string') return null;
    if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
    return null;
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

type PendingSessionSurfaceSwitch = Readonly<{
    sourceDetailsPathname: string;
    targetHref: string;
}>;

type BottomChromeItem = Readonly<{
    key: string;
    signature: string;
    node: React.ReactElement;
    /** Set only for session cockpit chrome — the one answer to "whose band is this". */
    cockpitSessionId?: string;
}>;

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



function isSameBottomChromeItem(left: BottomChromeItem | null, right: BottomChromeItem | null): boolean {
    if (!left || !right) {
        return left === right;
    }
    return left.key === right.key && left.signature === right.signature;
}

function isBottomChromeStateSettled(
    state: Readonly<{ current: BottomChromeItem | null; previous: BottomChromeItem | null }>,
    resolvedChrome: BottomChromeItem | null,
): boolean {
    return state.previous === null && isSameBottomChromeItem(state.current, resolvedChrome);
}

export const MobileBottomChromeHost = React.memo(() => {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<{
        mobileSurface?: string | string[];
        serverId?: string | string[];
        worktreeId?: string | string[];
        activeRootPath?: string | string[];
        sourceSurface?: string | string[];
    }>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const reduceMotion = useReducedMotionPreference();
    const { activeTab, setActiveTab } = useMainAppTabState();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const { sidebarTabAvailable: sessionTerminalTabAvailable } = useSessionTerminalAvailability();
    const routeSessionId = resolveRouteSessionId(pathname);
    const routeWorkspaceRefId = resolveRouteWorkspaceRefId(pathname);
    const routeServerId = normalizeRouteParam(params.serverId);
    const sessionLastMobileSurface = useSessionLastMobileSurface(routeSessionId, routeServerId);
    const projectLastMobileSurface = useProjectLastMobileSurface(routeWorkspaceRefId);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const persistProjectLastMobileSurface = usePersistProjectLastMobileSurface();
    const setBottomChromeHeight = useSessionCockpitBottomChromeHeightSetter();
    const cockpitRegistration = useSessionCockpitChromeRegistration();
    const dismissingSessionId = useSessionCockpitDismissingSessionId();
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const sessionLastMobileSurfaceBySessionId = React.useMemo(() => (
        routeSessionId && sessionLastMobileSurface
            ? { [routeSessionId]: sessionLastMobileSurface }
            : null
    ), [routeSessionId, sessionLastMobileSurface]);
    const projectLastMobileSurfaceByWorkspaceRefId = React.useMemo(() => (
        routeWorkspaceRefId && projectLastMobileSurface
            ? { [routeWorkspaceRefId]: projectLastMobileSurface }
            : null
    ), [routeWorkspaceRefId, projectLastMobileSurface]);

    const model = resolveMobileBottomChromeModel({
        isAuthenticated: auth.isAuthenticated,
        pathname,
        mobileWorkspaceExperience,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
        explicitMobileSurfaceHint,
    });
    const routeOwnedMainTab = resolveRouteOwnedMainTab(pathname);
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
        if (tab === currentMainTab) {
            const rootRoute = MAIN_TAB_DEFAULT_ROUTES[tab];
            if (rootRoute !== '/' && typeof pathname === 'string' && pathname !== rootRoute) {
                router.navigate(rootRoute);
            }
            return;
        }

        const targetRoute = resolveRememberedMainTabRoute(tab, mainTabRoutesRef.current[tab]);
        if (targetRoute !== '/' || routeOwnedMainTab) {
            router.navigate(targetRoute);
        }
        if (tab !== 'settings') {
            void setActiveTab(tab);
        }
    }, [activeTab, pathname, routeOwnedMainTab, router, setActiveTab]);

    const persistSessionSurface = React.useCallback((sessionId: string, surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(sessionId, surface, routeServerId);
    }, [persistSessionLastMobileSurface, routeServerId]);

    const handleSessionCockpitSurfacePress = React.useCallback((sessionId: string, surface: SessionMobileSurface) => {
        const matchingRegistration =
            cockpitRegistration?.sessionId === sessionId
                ? cockpitRegistration
                : null;
        const shouldCanonicalizeRoute = shouldRouteSessionCockpitSurfacePressThroughUrl({
            pathname,
            sessionId,
            surface,
            terminalTabAvailable: matchingRegistration?.terminalTabAvailable ?? sessionTerminalTabAvailable,
            explicitRootSurfaceHint: explicitMobileSurfaceHint,
        });
        if (matchingRegistration) {
            matchingRegistration.switchSurface(surface);
            if (!shouldCanonicalizeRoute) {
                return;
            }
        }

        persistSessionSurface(sessionId, surface);
        router.replace(resolveSessionRoutePathForSurface(sessionId, surface, { serverId: routeServerId }));
    }, [
        cockpitRegistration,
        explicitMobileSurfaceHint,
        pathname,
        persistSessionSurface,
        routeServerId,
        router,
        sessionTerminalTabAvailable,
    ]);

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

        if (!shouldRouteSessionCockpitSurfacePressThroughUrl({
            pathname,
            sessionId: next.sessionId,
            surface: next.surface,
            terminalTabAvailable: registration.terminalTabAvailable,
            explicitRootSurfaceHint: explicitMobileSurfaceHint,
        })) {
            return;
        }
        router.replace(resolveSessionRoutePathForSurface(next.sessionId, next.surface, {
            serverId: routeServerId,
        }));
    }, [
        cockpitRegistration,
        explicitMobileSurfaceHint,
        pathname,
        routeServerId,
        routeSessionId,
        router,
    ]);

    const buildMainChrome = React.useCallback((tab: TabType): BottomChromeItem => ({
        key: 'mainAppTabs',
        signature: `mainAppTabs:${tab}`,
        node: (
            <MainAppTabBar
                activeTab={tab}
                onTabPress={handleMainAppTabPress}
                // Session creation belongs to the sessions surface; the other tabs keep the bar as
                // a pure navigation control.
                trailingAccessory={tab === 'sessions' ? <TabBarNewSessionButton /> : undefined}
            />
        ),
    }), [handleMainAppTabPress]);

    // An overlay route (`/new`, the zen modals, …) is presented OVER the current screen rather than
    // replacing it, so it should not change which bar the chrome host is showing — it simply covers
    // it. Recomputing here resolved "no tab, no session" for `/new` and tore the bar down, so
    // closing the composer had to build it back afterwards and the two read as a sequence instead of
    // one surface lifting away. Freezing the last real chrome keeps the bar mounted underneath.
    const overlayRouteActive = typeof pathname === 'string' && isOverlaySurfaceRoutePathname(pathname);
    const frozenChromeRef = React.useRef<BottomChromeItem | null>(null);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (overlayRouteActive) {
            return frozenChromeRef.current;
        }

        if (model.kind === 'mainAppTabs') {
            if (deviceType !== 'phone') {
                return null;
            }
            return buildMainChrome(visibleMainTab);
        }

        const sessionCockpitModel = model.kind === 'sessionCockpit'
            ? model
            : model.kind === 'hidden' && cockpitRegistration
                ? {
                    kind: 'sessionCockpit' as const,
                    sessionId: cockpitRegistration.sessionId,
                    surface: cockpitRegistration.activeSurface,
                    terminalTabAvailable: cockpitRegistration.terminalTabAvailable,
                }
                : null;

        if (
            sessionCockpitModel
            && isMobileWorkspaceCockpitEnabled({
                deviceType,
                mobileWorkspaceExperience,
            })
        ) {
            // Dismiss-start: the session is sliding out but the route hasn't
            // committed yet. Cross-fade to the destination main bar now (the band
            // dissolves with the outgoing cockpit chrome) instead of at slide-end.
            // The in-flow reservation is route-keyed below, so this is visual-only
            // and a cancelled gesture (`closing:false`) reverts here.
            if (dismissingSessionId === sessionCockpitModel.sessionId) {
                return buildMainChrome(lastMainTabRef.current);
            }

            const matchingRegistration =
                cockpitRegistration?.sessionId === sessionCockpitModel.sessionId
                    ? cockpitRegistration
                    : null;
            const activeSurface = matchingRegistration?.activeSurface ?? sessionCockpitModel.surface;
            const terminalTabAvailable = matchingRegistration?.terminalTabAvailable ?? sessionCockpitModel.terminalTabAvailable;
            const openDetailsTabCount = matchingRegistration?.openDetailsTabCount ?? 0;

            return {
                key: `session:${sessionCockpitModel.sessionId}`,
                cockpitSessionId: sessionCockpitModel.sessionId,
                signature: `session:${sessionCockpitModel.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}:${routeServerId ?? 'default-server'}:tabs${openDetailsTabCount}`,
                node: (
                    <SessionCockpitTabBar
                        sessionId={sessionCockpitModel.sessionId}
                        serverId={routeServerId}
                        activeSurface={activeSurface}
                        terminalTabAvailable={terminalTabAvailable}
                        openDetailsTabCount={openDetailsTabCount}
                        pluginPlacements={matchingRegistration?.pluginPlacements}
                        projectionGeneration={matchingRegistration?.projectionGeneration}
                        onSurfacePress={(surface) => handleSessionCockpitSurfacePress(sessionCockpitModel.sessionId, surface)}
                    />
                ),
            };
        }

        if (
            model.kind === 'projectCockpit'
            && isMobileWorkspaceCockpitEnabled({
                deviceType,
                mobileWorkspaceExperience,
            })
        ) {
            const rawWorktreeId = typeof params.worktreeId === 'string'
                ? params.worktreeId
                : Array.isArray(params.worktreeId)
                    ? params.worktreeId[0] ?? null
                    : null;
            const rawActiveRootPath = typeof params.activeRootPath === 'string'
                ? params.activeRootPath
                : Array.isArray(params.activeRootPath)
                    ? params.activeRootPath[0] ?? null
                    : null;
            return {
                key: `project:${model.workspaceRefId}`,
                signature: `project:${model.workspaceRefId}:${model.surface}`,
                node: (
                    <ProjectCockpitTabBar
                        workspaceRefId={model.workspaceRefId}
                        activeSurface={model.surface}
                        onSurfacePress={(surface) => {
                            persistProjectLastMobileSurface(model.workspaceRefId, surface);
                            router.replace(resolveProjectRoutePathForSurface({
                                workspaceRefId: model.workspaceRefId,
                                surface,
                                rawWorktreeId,
                                rawActiveRootPath,
                            }));
                        }}
                    />
                ),
            };
        }

        return null;
    }, [
        overlayRouteActive,
        activeTab,
        buildMainChrome,
        cockpitRegistration,
        deviceType,
        dismissingSessionId,
        handleSessionCockpitSurfacePress,
        mobileWorkspaceExperience,
        model,
        params.activeRootPath,
        params.worktreeId,
        persistProjectLastMobileSurface,
        router,
        routeServerId,
        visibleMainTab,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
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
    const lateralNavigation = useSessionCockpitLateralNavigation({ sessionId: cockpitSessionId, serverId: routeServerId });
    const lateralSwipeSettingEnabled = useSetting('sessionCockpitSwipeNavigationEnabled');
    const lateralNavigate = lateralNavigation.navigate;
    const canStepPrevious = lateralNavigation.previous !== null;
    const canStepNext = lateralNavigation.next !== null;

    // Passive settled keyboard height. The swipe must not arm over a raised keyboard:
    // the band sits directly above it and the horizontal room belongs to text editing.
    const [keyboardVisible, setKeyboardVisible] = React.useState(false);
    React.useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const shown = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
        const hidden = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
        return () => {
            shown.remove();
            hidden.remove();
        };
    }, []);

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
    // Single-flight: a commit already travelling must ignore re-entrant releases.
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
        void hapticsLight();
    }, [cockpitSessionId, lateralNavigate]);

    // Dev's slide presets carry their spring physics inline; reduced motion is applied
    // by the call sites below rather than baked into the config.
    const lateralSpring = React.useMemo<WithSpringConfig>(
        () => ({ ...slideTransitionTokens.soft.spring }),
        [],
    );
    const lateralSwipeProgress = lateralSwipe.progress;
    const lateralSwipeActive = lateralSwipe.isActive;
    const lateralPicker = lateralSwipe.picker;
    const lateralPanGesture = React.useMemo(() => {
        // Absent rather than inert: when the shortcut cannot apply the recognizer must
        // not exist at all, so it never enters arbitration with a tab press.
        if (!lateralNavigationAvailable) return null;
        if (keyboardVisible) return null;
        if (!canStepPrevious && !canStepNext) return null;

        return Gesture.Pan()
            .withTestId(SESSION_LATERAL_SWIPE_GESTURE_TEST_ID)
            // Wider than the carousel's 10px on purpose: the tabs carry `hitSlop: 8`,
            // so a slightly sloppy tap must never arm the pan.
            .activeOffsetX([-SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX, SESSION_LATERAL_SWIPE_ACTIVATION_OFFSET_PX])
            // Deliberately NO `failOffsetY`. Activation stays horizontal-only — which is
            // what keeps tab taps and vertical intent behaving exactly as they did — but
            // once the pan owns the touch, BOTH axes are its own: the upward movement
            // that opens the picker is the movement a vertical failure bound cancelled on.
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
                // dedupe is inherent and no frame can double-fire.
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
        keyboardVisible,
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
    const lateralTravelStyle = useAnimatedStyle(() => ({
        transform: [{
            translateX: lateralSwipeProgress.value * SESSION_LATERAL_SWIPE_COMMIT_DISTANCE_PX * lateralTravelGain,
        }],
    }), [lateralSwipeProgress, lateralTravelGain]);
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
            if (currentRenderedChrome.signature === resolvedChrome.signature) {
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
            easing: motionTokens.easing.emphasized,
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
    const wrapperStyle = { position: 'absolute', left: 0, right: 0, bottom: 0 } as const;

    // The band's only hit-testable pixels, and they exist ONLY while the lateral pan
    // does: without the pan the band stays exactly as transparent to touches as before.
    const currentChromeContent = renderedChrome.current ? (
        <Reanimated.View pointerEvents="box-none" style={lateralTravelStyle}>
            {lateralPanGesture ? (
                <SessionCockpitLateralPicker sessionId={cockpitSessionId} serverId={routeServerId} />
            ) : null}
            {lateralPanGesture ? (
                <View style={StyleSheet.absoluteFill} testID={SESSION_LATERAL_SWIPE_HIT_TARGET_TEST_ID} />
            ) : null}
            {renderedChrome.current.node}
        </Reanimated.View>
    ) : null;

    return (
        <View onLayout={handleChromeLayout} pointerEvents="box-none" style={wrapperStyle}>
            {currentChromeContent ? (
                <View pointerEvents="box-none" style={currentStyle}>
                    {lateralPanGesture
                        ? <GestureDetector gesture={lateralPanGesture}>{currentChromeContent}</GestureDetector>
                        : currentChromeContent}
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
