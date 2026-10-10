import * as React from 'react';
import { Animated, Platform, View, type LayoutChangeEvent } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SessionSwitcherBand } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionSwitcherBand';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import {
    usePersistProjectLastMobileSurface,
    usePersistSessionLastMobileSurface,
    useProjectLastMobileSurface,
    useSessionLastMobileSurface,
    useSetting,
    useLocalSetting,
    useWorkspaceRefs,
    useActiveServerAccountScope,
    useProjectAccountRows,
} from '@/sync/domains/state/storage';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { readProjectRouteCheckoutRootPath } from '@/components/projects/detail/projectRouteState';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import {
    isOverlaySurfaceRoutePathname,
    normalizeSurfaceRoutePathname,
} from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';
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
import { normalizeProjectPage, resolveProjectCockpitRouteFromPathname, resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
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

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost(props: Readonly<{
    /** Canonical pre-push presentation decision from the app stack owner. */
    newSessionRendersFloatingComposer?: boolean;
}>) {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<Record<string, string | string[] | undefined>>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const reduceMotion = useReducedMotionPreference();
    const { activeTab, setActiveTab } = useMainAppTabState();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const routeSessionId = resolveRouteSessionId(pathname);
    const routeWorkspaceRefId = resolveRouteWorkspaceRefId(pathname);
    const routeServerId = normalizeRouteParam(params.serverId);
    const projectRef = useWorkspaceRefById(routeWorkspaceRefId ?? '', routeServerId);
    const workspaceRefs = useWorkspaceRefs();
    const projectLastRootPaths = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const projectLastWorktreeIds = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const projectCheckout = React.useMemo(() => {
        if (!projectRef) return null;
        const keys = resolveProjectSelectionPreferenceKeys(workspaceRefs, projectRef);
        const selectedRoot = readProjectRouteCheckoutRootPath({
            rawWorktreeId: params.worktreeId, rawLegacyActiveRootPath: params.activeRootPath,
            defaultRootPath: projectRef.rootPath,
            persistedActiveRootPath: readProjectSelectionPreference(projectLastRootPaths, keys),
            persistedWorktreeId: readProjectSelectionPreference(projectLastWorktreeIds, keys),
        });
        return selectedRoot === null ? null : resolveProjectCheckoutWorkspaceRef(workspaceRefs, projectRef, selectedRoot);
    }, [params.activeRootPath, params.worktreeId, projectLastRootPaths, projectLastWorktreeIds, projectRef, workspaceRefs]);
    const projectPage = resolveProjectCockpitRouteFromPathname(pathname)?.page ?? 'overview';
    const projectViewerScope = useActiveServerAccountScope(projectRef?.serverId ?? routeServerId);
    const projectRowsStatus = useProjectAccountRows()?.status;
    const projectTerminalTabAvailable = React.useMemo(() => projectRef !== null && projectCheckout !== null
        && resolveProjectTerminalScope(buildProjectPaneScopeId(projectRef.id, projectRef.serverId), workspaceAddressFromRefV1(projectCheckout)) !== null,
    [projectCheckout, projectRef, projectRowsStatus, projectViewerScope]);
    const { sidebarTabAvailable: sessionTerminalTabAvailable } = useSessionTerminalAvailability(routeServerId);
    const sessionLastMobileSurface = useSessionLastMobileSurface(routeSessionId, routeServerId);
    const projectLastMobileSurface = useProjectLastMobileSurface(routeWorkspaceRefId, routeServerId);
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
    const androidFloatingNewSessionActive = Platform.OS === 'android'
        && normalizeSurfaceRoutePathname(pathname) === '/new'
        && props.newSessionRendersFloatingComposer === true;
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
                signature: JSON.stringify(['project', model.workspaceRefId, model.surface, projectPage,
                    projectRef?.serverId ?? routeServerId, projectTerminalTabAvailable,
                    projectViewerScope?.accountId ?? null,
                    projectCheckout?.id ?? null, projectCheckout?.rootPath ?? null, rawWorktreeId, rawActiveRootPath]),
                node: (
                    <ProjectCockpitTabBar
                        workspaceRefId={model.workspaceRefId}
                        activeSurface={model.surface}
                        activePage={projectPage}
                        terminalTabAvailable={projectTerminalTabAvailable}
                        onSurfacePress={(surface) => {
                            const page = normalizeProjectPage(surface) ?? resolveProjectCockpitRouteFromPathname(pathname)?.page ?? 'overview';
                            persistProjectLastMobileSurface(model.workspaceRefId, page, routeServerId);
                            router.replace(resolveProjectRoutePathForSurface({
                                workspaceRefId: model.workspaceRefId,
                                page,
                                surface,
                                serverId: routeServerId,
                                routeParams: params,
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
        params,
        pathname,
        persistProjectLastMobileSurface,
        router,
        routeServerId,
        projectPage,
        projectRef?.serverId,
        projectViewerScope?.accountId,
        projectTerminalTabAvailable,
        projectCheckout,
        visibleMainTab,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
    ]);

    if (!overlayRouteActive) {
        frozenChromeRef.current = resolvedChrome;
    }

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

    // Android's transparent native-stack screen and this global chrome host are sibling native
    // views. The host is mounted after the Stack, so keeping its pixels rendered places them above
    // the composer's app-painted scrim even though its frozen model is conceptually "under" the
    // modal. Keep that model intact for an immediate return, but contribute no sibling pixels while
    // the floating composer is active. Other presentations keep the normal frozen-underlay path.
    if (androidFloatingNewSessionActive) {
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
