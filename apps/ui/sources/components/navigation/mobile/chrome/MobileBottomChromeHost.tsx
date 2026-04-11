import * as React from 'react';
import { Animated, Platform } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useAuth } from '@/auth/context/AuthContext';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';

import { MainAppTabBar } from './bars/MainAppTabBar';
import { ProjectCockpitTabBar } from './bars/ProjectCockpitTabBar';
import { SessionCockpitTabBar } from './bars/SessionCockpitTabBar';
import { useMainAppTabState } from './MainAppTabStateProvider';
import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

export const MobileBottomChromeHost = React.memo(() => {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<{ mobileSurface?: string | string[]; worktreeId?: string | string[] }>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const reduceMotion = useReducedMotionPreference();
    const { activeTab, setActiveTab } = useMainAppTabState();
    const mobileWorkspaceExperience = useLocalSetting('mobileWorkspaceExperienceV1');
    const { sidebarTabAvailable: sessionTerminalTabAvailable } = useSessionTerminalAvailability();
    const sessionLastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const projectLastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setSessionLastMobileSurfaceBySessionId] = useLocalSettingMutable('sessionLastMobileSurfaceBySessionId');
    const [, setProjectLastMobileSurfaceByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileSurfaceByWorkspaceRefId');
    const explicitMobileSurfaceHint = typeof params.mobileSurface === 'string'
        ? params.mobileSurface
        : Array.isArray(params.mobileSurface)
            ? params.mobileSurface[0] ?? null
            : null;

    const model = resolveMobileBottomChromeModel({
        isAuthenticated: auth.isAuthenticated,
        pathname,
        mobileWorkspaceExperience,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
        explicitMobileSurfaceHint,
    });

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
                        onTabPress={setActiveTab}
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
                signature: `session:${model.sessionId}:${model.surface}:${model.terminalTabAvailable ? 'terminal' : 'no-terminal'}`,
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
                            router.replace(resolveSessionRoutePathForSurface(model.sessionId, surface));
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
        params.worktreeId,
        router,
        sessionTerminalTabAvailable,
        sessionLastMobileSurfaceBySessionId,
        setProjectLastMobileSurfaceByWorkspaceRefId,
        setSessionLastMobileSurfaceBySessionId,
        projectLastMobileSurfaceByWorkspaceRefId,
        setActiveTab,
    ]);
    const [renderedChrome, setRenderedChrome] = React.useState(resolvedChrome);
    const progress = React.useRef(new Animated.Value(resolvedChrome ? 1 : 0)).current;
    const transitionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        if (transitionTimeoutRef.current) {
            clearTimeout(transitionTimeoutRef.current);
            transitionTimeoutRef.current = null;
        }

        if (reduceMotion) {
            setRenderedChrome(resolvedChrome);
            progress.setValue(resolvedChrome ? 1 : 0);
            return;
        }

        if ((renderedChrome?.key ?? null) === (resolvedChrome?.key ?? null)) {
            if ((renderedChrome?.signature ?? null) !== (resolvedChrome?.signature ?? null)) {
                setRenderedChrome(resolvedChrome);
            }
            return;
        }

        const animateIn = (nextChrome: typeof resolvedChrome) => {
            setRenderedChrome(nextChrome);
            if (!nextChrome) {
                progress.setValue(0);
                return;
            }
            progress.setValue(0);
            Animated.timing(progress, {
                toValue: 1,
                duration: motionTokens.durationMs.base,
                easing: motionTokens.easing.emphasized,
                useNativeDriver: Platform.OS !== 'web',
            }).start();
        };

        if (!renderedChrome) {
            animateIn(resolvedChrome);
            return;
        }

        Animated.timing(progress, {
            toValue: 0,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        }).start();

        transitionTimeoutRef.current = setTimeout(() => {
            transitionTimeoutRef.current = null;
            animateIn(resolvedChrome);
        }, motionTokens.durationMs.fast);

        return () => {
            if (transitionTimeoutRef.current) {
                clearTimeout(transitionTimeoutRef.current);
                transitionTimeoutRef.current = null;
            }
        };
    }, [progress, reduceMotion, renderedChrome, resolvedChrome]);

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
