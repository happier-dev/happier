import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import { useLocalSetting, useLocalSettingMutable, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import {
    useSessionCockpitChromeRegistration,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { SessionCockpitModeSwipeGesture } from '@/components/workspaceCockpit/session/SessionCockpitModeSwipeGesture';
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
    const keyboardHeight = useKeyboardHeight();
    const reduceMotion = useReducedMotionPreference();
    const { activeTab, setActiveTab } = useMainAppTabState();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const { sidebarTabAvailable: sessionTerminalTabAvailable } = useSessionTerminalAvailability();
    const sessionLastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const projectLastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setSessionLastMobileSurfaceBySessionId] = useLocalSettingMutable('sessionLastMobileSurfaceBySessionId');
    const [, setProjectLastMobileSurfaceByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setMobileWorkspaceExperience] = useSettingMutable('mobileWorkspaceExperienceV1');
    const cockpitRegistration = useSessionCockpitChromeRegistration();
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const routeServerId = normalizeRouteParam(params.serverId);
    const softwareKeyboardVisible = deviceType === 'phone' && keyboardHeight > 0;

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
        setSessionLastMobileSurfaceBySessionId({
            ...(sessionLastMobileSurfaceBySessionId ?? {}),
            [sessionId]: surface,
        });
    }, [sessionLastMobileSurfaceBySessionId, setSessionLastMobileSurfaceBySessionId]);

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

    const handleCloseMobileWorkspaceCockpit = React.useCallback((sessionId: string) => {
        const matchingRegistration =
            cockpitRegistration?.sessionId === sessionId
                ? cockpitRegistration
                : null;
        if (matchingRegistration) {
            matchingRegistration.closeCockpit();
            return;
        }
        setMobileWorkspaceExperience('classic');
    }, [cockpitRegistration, setMobileWorkspaceExperience]);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (softwareKeyboardVisible) {
            return null;
        }

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

        if (
            model.kind === 'sessionCockpit'
            && isMobileWorkspaceCockpitEnabled({
                deviceType,
                mobileWorkspaceExperience,
            })
        ) {
            const matchingRegistration =
                cockpitRegistration?.sessionId === model.sessionId
                    ? cockpitRegistration
                    : null;
            const activeSurface = matchingRegistration?.activeSurface ?? model.surface;
            const terminalTabAvailable = matchingRegistration?.terminalTabAvailable ?? model.terminalTabAvailable;

            return {
                key: `session:${model.sessionId}`,
                signature: `session:${model.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}:${routeServerId ?? 'default-server'}`,
                node: (
                    <SessionCockpitModeSwipeGesture
                        direction="close"
                        enabled={deviceType === 'phone'}
                        onIntent={() => handleCloseMobileWorkspaceCockpit(model.sessionId)}
                        testID={`session-cockpit-close-swipe-${model.sessionId}`}
                    >
                        <SessionCockpitTabBar
                            sessionId={model.sessionId}
                            activeSurface={activeSurface}
                            terminalTabAvailable={terminalTabAvailable}
                            onSurfacePress={(surface) => handleSessionCockpitSurfacePress(model.sessionId, surface)}
                        />
                    </SessionCockpitModeSwipeGesture>
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
                            setProjectLastMobileSurfaceByWorkspaceRefId({
                                ...(projectLastMobileSurfaceByWorkspaceRefId ?? {}),
                                [model.workspaceRefId]: surface,
                            });
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
        handleCloseMobileWorkspaceCockpit,
        handleSessionCockpitSurfacePress,
        mobileWorkspaceExperience,
        model,
        params.worktreeId,
        router,
        routeServerId,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        setProjectLastMobileSurfaceByWorkspaceRefId,
        projectLastMobileSurfaceByWorkspaceRefId,
        handleMainAppTabPress,
        softwareKeyboardVisible,
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
        <View style={{ position: 'relative' }}>
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
