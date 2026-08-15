import * as React from 'react';
import { Animated, Platform, View, type LayoutChangeEvent } from 'react-native';
import { router as expoRouter, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { SessionCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/SessionCockpitTabBar';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import {
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitChromeRegistration,
    useSessionCockpitDismissingSessionId,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    resolveSessionCockpitRouteFromPathname,
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { TabBar, type TabType } from '@/components/ui/navigation/TabBar';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useTabState } from '@/hooks/ui/useTabState';
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
}>;

/**
 * Passive settled keyboard visibility for chrome suppression only.
 * Composer positioning must use the keyboard scaffold instead of this React-state path.
 */
function usePassiveSoftwareKeyboardVisibleForBottomChrome(deviceType: ReturnType<typeof useDeviceType>): boolean {
    const keyboardHeightPx = useKeyboardHeight();
    return deviceType === 'phone' && keyboardHeightPx > 0;
}

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost() {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<{ mobileSurface?: string | string[]; serverId?: string | string[] }>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const softwareKeyboardVisible = usePassiveSoftwareKeyboardVisibleForBottomChrome(deviceType);
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
        node: <TabBar activeTab={tab} onTabPress={handleTabPress} />,
    }), [handleTabPress]);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (deviceType !== 'phone') {
            return null;
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
                key: `sessionCockpitTabs:${activeCockpitRoute.sessionId}`,
                signature: `sessionCockpitTabs:${activeCockpitRoute.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}:tabs${openDetailsTabCount}`,
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
        cockpitRegistration,
        cockpitRoute,
        deviceType,
        dismissingSessionId,
        handleCockpitSurfacePress,
        mobileWorkspaceExperience,
        softwareKeyboardVisible,
        terminalAvailability.sidebarTabAvailable,
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
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: null, previous: null });
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

    if (!renderedChrome.current) {
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

    // Both the main and cockpit bars float over content as a pure overlay: the bar
    // never reserves in-flow space. Each surface clears the bar itself — lists via
    // `ItemList`'s `bottomChromeHeight` padding, the chat composer via the session-
    // owned reservation in `AgentContentView`. Because the reservation lives inside
    // the session screen, it slides away with the session on dismiss, so the window
    // canvas behind the chrome is never exposed as a lingering bottom band.
    return (
        <View
            onLayout={handleChromeLayout}
            pointerEvents="box-none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
            <View pointerEvents="box-none">
                {renderedChrome.current.node}
            </View>
            {renderedChrome.previous ? (
                <Animated.View pointerEvents="none" style={previousStyle}>
                    {renderedChrome.previous.node}
                </Animated.View>
            ) : null}
        </View>
    );
});
