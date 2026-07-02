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
import {
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitChromeRegistration,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';

import { MainAppTabBar } from './bars/MainAppTabBar';
import { ProjectCockpitTabBar } from './bars/ProjectCockpitTabBar';
import { SessionCockpitTabBar } from './bars/SessionCockpitTabBar';
import { useMainAppTabState } from './MainAppTabStateProvider';
import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

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

type PendingSessionSurfaceSwitch = Readonly<{
    sourceDetailsPathname: string;
    targetHref: string;
}>;

type BottomChromeItem = Readonly<{
    key: string;
    signature: string;
    node: React.ReactElement;
}>;

const BOTTOM_CHROME_TRANSITION_TRANSLATE_Y = 10;

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

    const handleMainAppTabPress = React.useCallback((tab: typeof activeTab) => {
        if (tab === activeTab) {
            return;
        }
        void setActiveTab(tab);
    }, [activeTab, setActiveTab]);

    const persistSessionSurface = React.useCallback((sessionId: string, surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(sessionId, surface);
    }, [persistSessionLastMobileSurface]);

    const handleSessionCockpitSurfacePress = React.useCallback((sessionId: string, surface: SessionMobileSurface) => {
        const matchingRegistration =
            cockpitRegistration?.sessionId === sessionId
                ? cockpitRegistration
                : null;
        if (matchingRegistration) {
            matchingRegistration.switchSurface(surface);
            return;
        }

        persistSessionSurface(sessionId, surface);
        router.replace(resolveSessionRoutePathForSurface(sessionId, surface, { serverId: routeServerId }));
    }, [cockpitRegistration, persistSessionSurface, routeServerId, router]);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (model.kind === 'mainAppTabs') {
            if (deviceType !== 'phone') {
                return null;
            }
            return {
                key: 'mainAppTabs',
                signature: `mainAppTabs:${activeTab}`,
                node: (
                    <MainAppTabBar
                        activeTab={activeTab}
                        onTabPress={handleMainAppTabPress}
                    />
                ),
            };
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
            const matchingRegistration =
                cockpitRegistration?.sessionId === sessionCockpitModel.sessionId
                    ? cockpitRegistration
                    : null;
            const activeSurface = matchingRegistration?.activeSurface ?? sessionCockpitModel.surface;
            const terminalTabAvailable = matchingRegistration?.terminalTabAvailable ?? sessionCockpitModel.terminalTabAvailable;

            return {
                key: `session:${sessionCockpitModel.sessionId}`,
                signature: `session:${sessionCockpitModel.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}:${routeServerId ?? 'default-server'}`,
                node: (
                    <SessionCockpitTabBar
                        sessionId={sessionCockpitModel.sessionId}
                        activeSurface={activeSurface}
                        terminalTabAvailable={terminalTabAvailable}
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
                            }));
                        }}
                    />
                ),
            };
        }

        return null;
    }, [
        activeTab,
        cockpitRegistration,
        deviceType,
        handleSessionCockpitSurfacePress,
        mobileWorkspaceExperience,
        model,
        params.worktreeId,
        persistProjectLastMobileSurface,
        router,
        routeServerId,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
        handleMainAppTabPress,
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
            setRenderedChromeState({ current: resolvedChrome, previous: null });
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

    const currentStyle = {
        opacity: progress,
        transform: [
            {
                translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [BOTTOM_CHROME_TRANSITION_TRANSLATE_Y, 0],
                }),
            },
        ],
    } as const;
    const previousStyle = {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
        }),
        transform: [
            {
                translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, BOTTOM_CHROME_TRANSITION_TRANSLATE_Y],
                }),
            },
        ],
    } as const;

    return (
        <View onLayout={handleChromeLayout} style={{ position: 'relative' }}>
            <Animated.View style={currentStyle}>
                {renderedChrome.current.node}
            </Animated.View>
            {renderedChrome.previous ? (
                <Animated.View pointerEvents="none" style={previousStyle}>
                    {renderedChrome.previous.node}
                </Animated.View>
            ) : null}
        </View>
    );
});
