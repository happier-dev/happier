import * as React from 'react';
import { Animated, Platform, View, type LayoutChangeEvent } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import {
    usePersistProjectLastMobileSurface,
    usePersistSessionLastMobileSurface,
    useProjectLastMobileSurface,
    useSessionLastMobileSurface,
    useSetting,
} from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import type { TabType } from '@/components/ui/navigation/tabTypes';
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
}>;



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
    const sessionLastMobileSurface = useSessionLastMobileSurface(routeSessionId);
    const projectLastMobileSurface = useProjectLastMobileSurface(routeWorkspaceRefId);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const persistProjectLastMobileSurface = usePersistProjectLastMobileSurface();
    const setBottomChromeHeight = useSessionCockpitBottomChromeHeightSetter();
    const cockpitRegistration = useSessionCockpitChromeRegistration();
    const dismissingSessionId = useSessionCockpitDismissingSessionId();
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const routeServerId = normalizeRouteParam(params.serverId);
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
        persistSessionLastMobileSurface(sessionId, surface);
    }, [persistSessionLastMobileSurface]);

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

    const buildMainChrome = React.useCallback((tab: TabType): BottomChromeItem => ({
        key: 'mainAppTabs',
        signature: `mainAppTabs:${tab}`,
        node: (
            <MainAppTabBar
                activeTab={tab}
                onTabPress={handleMainAppTabPress}
            />
        ),
    }), [handleMainAppTabPress]);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
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
                signature: `session:${sessionCockpitModel.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}:${routeServerId ?? 'default-server'}:tabs${openDetailsTabCount}`,
                node: (
                    <SessionCockpitTabBar
                        sessionId={sessionCockpitModel.sessionId}
                        activeSurface={activeSurface}
                        terminalTabAvailable={terminalTabAvailable}
                        openDetailsTabCount={openDetailsTabCount}
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
            stopChromeAnimation();
            setRenderedChromeState({ current: null, previous: null });
            progress.setValue(1);
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

    if (!renderedChrome.current) {
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

    return (
        <View onLayout={handleChromeLayout} pointerEvents="box-none" style={wrapperStyle}>
            <View pointerEvents="box-none" style={currentStyle}>
                {renderedChrome.current.node}
            </View>
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
