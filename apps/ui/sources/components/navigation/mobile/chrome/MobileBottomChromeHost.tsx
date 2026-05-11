import * as React from 'react';
import { Animated, Platform } from 'react-native';
import { useGlobalSearchParams, useNavigation, usePathname, useRouter } from 'expo-router';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import { useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import {
    collapseSessionDetailsRouteBeforeSurfaceSwitch,
    resolveSessionCockpitSurfaceSwitchPlan,
} from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';
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

export const MobileBottomChromeHost = React.memo(() => {
    const pathname = usePathname();
    const router = useRouter();
    const navigation = useNavigation();
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
    const sessionLastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const projectLastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setSessionLastMobileSurfaceBySessionId] = useLocalSettingMutable('sessionLastMobileSurfaceBySessionId');
    const [, setProjectLastMobileSurfaceByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileSurfaceByWorkspaceRefId');
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const routeServerId = normalizeRouteParam(params.serverId);
    const currentDetailsSourceSurface = normalizeRouteParam(params.sourceSurface);
    const [pendingSessionSurfaceSwitch, setPendingSessionSurfaceSwitch] = React.useState<PendingSessionSurfaceSwitch | null>(null);

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

    React.useEffect(() => {
        if (!pendingSessionSurfaceSwitch) {
            return;
        }

        const currentPathname = typeof pathname === 'string' ? pathname.trim() : '';
        if (!currentPathname || currentPathname === pendingSessionSurfaceSwitch.sourceDetailsPathname) {
            return;
        }

        const targetHref = pendingSessionSurfaceSwitch.targetHref;
        setPendingSessionSurfaceSwitch(null);
        router.replace(targetHref);
    }, [pathname, pendingSessionSurfaceSwitch, router]);

    const resolvedChrome = React.useMemo((): Readonly<{
        key: string;
        signature: string;
        node: React.ReactElement;
    }> | null => {
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
            return {
                key: `session:${model.sessionId}`,
                signature: `session:${model.sessionId}:${model.surface}:${model.terminalTabAvailable ? 'terminal' : 'no-terminal'}:${routeServerId ?? 'default-server'}`,
                node: (
                    <SessionCockpitTabBar
                        sessionId={model.sessionId}
                        activeSurface={model.surface}
                        terminalTabAvailable={model.terminalTabAvailable}
                        onSurfacePress={(surface) => {
                            setSessionLastMobileSurfaceBySessionId({
                                ...(sessionLastMobileSurfaceBySessionId ?? {}),
                                [model.sessionId]: surface,
                            });
                            const switchPlan = resolveSessionCockpitSurfaceSwitchPlan({
                                sessionId: model.sessionId,
                                targetSurface: surface,
                                serverId: routeServerId,
                                currentPathname: pathname,
                                currentDetailsSourceSurface,
                            });
                            prepareMobileSurfaceTransition({
                                currentPathname: pathname,
                                targetHref: switchPlan.targetHref,
                                operation: 'replace',
                            });
                            if (switchPlan.kind === 'replace') {
                                setPendingSessionSurfaceSwitch(null);
                                router.replace(switchPlan.targetHref);
                                return;
                            }

                            setPendingSessionSurfaceSwitch({
                                sourceDetailsPathname: switchPlan.sourceDetailsPathname,
                                targetHref: switchPlan.targetHref,
                            });
                            const collapseStarted = collapseSessionDetailsRouteBeforeSurfaceSwitch({
                                router,
                                navigation,
                            });
                            if (!collapseStarted) {
                                setPendingSessionSurfaceSwitch(null);
                                router.replace(switchPlan.targetHref);
                            }
                        }}
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
        deviceType,
        mobileWorkspaceExperience,
        model,
        pathname,
        routeServerId,
        currentDetailsSourceSurface,
        navigation,
        params.worktreeId,
        router,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        setProjectLastMobileSurfaceByWorkspaceRefId,
        setSessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
        handleMainAppTabPress,
    ]);
    const [renderedChrome, setRenderedChrome] = React.useState(resolvedChrome);
    const renderedChromeRef = React.useRef(renderedChrome);
    const progress = React.useRef(new Animated.Value(resolvedChrome ? 1 : 0)).current;
    const activeChromeAnimationRef = React.useRef<Animated.CompositeAnimation | null>(null);

    const setRenderedChromeState = React.useCallback((nextChrome: typeof resolvedChrome) => {
        renderedChromeRef.current = nextChrome;
        setRenderedChrome(nextChrome);
    }, []);

    const stopChromeAnimation = React.useCallback(() => {
        activeChromeAnimationRef.current?.stop();
        activeChromeAnimationRef.current = null;
        (progress as Animated.Value & { stopAnimation?: () => void }).stopAnimation?.();
    }, [progress]);

    React.useLayoutEffect(() => {
        const currentRenderedChrome = renderedChromeRef.current;

        if (reduceMotion) {
            stopChromeAnimation();
            setRenderedChromeState(resolvedChrome);
            progress.setValue(resolvedChrome ? 1 : 0);
            return;
        }

        if (!resolvedChrome) {
            stopChromeAnimation();
            setRenderedChromeState(null);
            progress.setValue(0);
            return;
        }

        if ((currentRenderedChrome?.key ?? null) === (resolvedChrome?.key ?? null)) {
            if ((currentRenderedChrome?.signature ?? null) !== (resolvedChrome?.signature ?? null)) {
                setRenderedChromeState(resolvedChrome);
            }
            return;
        }

        const animateIn = (nextChrome: typeof resolvedChrome) => {
            stopChromeAnimation();
            setRenderedChromeState(nextChrome);
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
            });
        };

        if (!currentRenderedChrome) {
            animateIn(resolvedChrome);
            return;
        }

        animateIn(resolvedChrome);
    }, [progress, reduceMotion, resolvedChrome, setRenderedChromeState, stopChromeAnimation]);

    React.useLayoutEffect(() => () => {
        stopChromeAnimation();
    }, [stopChromeAnimation]);

    if (!resolvedChrome) {
        return null;
    }

    const chromeToRender =
        (renderedChrome?.key ?? null) === (resolvedChrome?.key ?? null)
            ? (resolvedChrome ?? renderedChrome)
            : renderedChrome;

    if (!chromeToRender) {
        return null;
    }

    const animatedStyle = {
        opacity: progress,
        transform: [
            {
                translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [10, 0],
                }),
            },
            {
                scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.99, 1],
                }),
            },
        ],
    } as const;

    return (
        <Animated.View style={animatedStyle}>
            {chromeToRender.node}
        </Animated.View>
    );
});
