import * as React from 'react';
import {
    createBottomTabNavigator,
    type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import {
    NavigationContainer,
    NavigationIndependentTree,
    useIsFocused,
} from '@react-navigation/native';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { usePersistSessionLastMobileSurface } from '@/sync/domains/state/storage';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import {
    resolveSessionRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import {
    resolveRightSidebarMobileProjection,
} from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

import {
    isSessionPluginMobileSurface,
    normalizeSessionMobileSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';
import {
    SessionCockpitSurfaceScreen,
    type SessionCockpitSurfaceScreenProps,
} from './SessionCockpitSurfaceScreen';

type SessionCockpitTabParamList = {
    [key: string]: undefined;
    chat: undefined;
    browse: undefined;
    git: undefined;
    navigation: undefined;
    tabs: undefined;
    browser: undefined;
    services: undefined;
    terminal: undefined;
};

const Tab = createBottomTabNavigator<SessionCockpitTabParamList>();

const DISABLED_NAVIGATION_LINKING = { enabled: false, prefixes: [] };
const SESSION_COCKPIT_TAB_SCREEN_OPTIONS = {
    headerShown: false,
    animation: 'none',
    lazy: true,
    freezeOnBlur: true,
    tabBarHideOnKeyboard: false,
} as const;
const WebInertView = View as React.ComponentType<ViewProps & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>>;

type SessionCockpitTabNavigatorProps = Omit<SessionCockpitSurfaceScreenProps, 'surface'> & Readonly<{
    initialSurface: SessionMobileSurface;
}>;

function resolveAvailableSurfaces(input: Readonly<{
    terminalTabAvailable: boolean;
    pluginProjection: ReturnType<typeof useScopedPluginUiProjection>;
}>): readonly SessionMobileSurface[] {
    const pluginPlacements = input.pluginProjection.pluginUiProjection
        ? selectPluginRightSidebarTabPlacements(input.pluginProjection.pluginUiProjection, 'session')
        : [];
    const projectedSurfaces = resolveRightSidebarMobileProjection({
        scope: 'session',
        tabs: resolveSessionRightSidebarTabs({
            presentation: 'mobile',
            terminalTabAvailable: input.terminalTabAvailable,
            pluginPlacements,
            projectionGeneration: input.pluginProjection.pluginUiProjection?.generation ?? null,
        }),
    })
        .map((entry): SessionMobileSurface => (
            entry.owner === 'plugin'
                ? entry.tabId as SessionMobileSurface
                : entry.surface as SessionMobileSurface
        ));
    const projectedSet = new Set(projectedSurfaces);
    return Object.freeze([
        'chat',
        ...(projectedSet.has('browse') ? ['browse' as const] : []),
        ...(projectedSet.has('git') ? ['git' as const] : []),
        'tabs',
        ...projectedSurfaces.filter((surface) => (
            surface !== 'browse'
            && surface !== 'git'
            && surface !== 'terminal'
        )),
        ...(projectedSet.has('terminal') ? ['terminal' as const] : []),
    ]);
}

function resolveInitialSurface(
    initialSurface: SessionMobileSurface,
    surfaces: readonly SessionMobileSurface[],
): SessionMobileSurface {
    if (!surfaces.includes(initialSurface)) {
        return 'chat';
    }
    return initialSurface;
}

export const SessionCockpitTabNavigator = React.memo((props: SessionCockpitTabNavigatorProps) => {
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const sessionMachineTarget = useSessionMachineTarget(props.sessionId);
    const sessionServerId = usePreferredServerIdForSession(props.sessionId, props.routeServerId);
    const pluginProjection = useScopedPluginUiProjection({
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: sessionServerId,
    });
    const surfaces = resolveAvailableSurfaces({ terminalTabAvailable, pluginProjection });
    const initialSurface = resolveInitialSurface(props.initialSurface, surfaces);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const persistSessionSurface = React.useCallback((surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(props.sessionId, surface);
    }, [persistSessionLastMobileSurface, props.sessionId]);

    return (
        <NavigationIndependentTree>
            <NavigationContainer linking={DISABLED_NAVIGATION_LINKING}>
                <Tab.Navigator
                    backBehavior="history"
                    initialRouteName={initialSurface}
                    screenOptions={SESSION_COCKPIT_TAB_SCREEN_OPTIONS}
                    tabBar={(tabBarProps) => (
                        <SessionCockpitNavigatorInitialSurfaceBridge
                            {...tabBarProps}
                            fallbackInitialSurface={isSessionPluginMobileSurface(props.initialSurface) ? 'chat' : initialSurface}
                            requestedInitialSurface={props.initialSurface}
                            sessionId={props.sessionId}
                        />
                    )}
                >
                    {surfaces.map((surface) => (
                        <Tab.Screen key={surface} name={surface}>
                            {({ navigation }) => (
                                <SessionCockpitSceneActivityBoundary surface={surface}>
                                    <SessionCockpitSurfaceNavigationProvider
                                        value={{
                                            switchSurface: (targetSurface) => {
                                                navigation.navigate(targetSurface);
                                                persistSessionSurface(targetSurface);
                                            },
                                        }}
                                    >
                                        <SessionCockpitSurfaceScreen {...props} surface={surface} />
                                    </SessionCockpitSurfaceNavigationProvider>
                                </SessionCockpitSceneActivityBoundary>
                            )}
                        </Tab.Screen>
                    ))}
                </Tab.Navigator>
            </NavigationContainer>
        </NavigationIndependentTree>
    );
});

const SessionCockpitSceneActivityBoundary = React.memo((props: Readonly<{
    children: React.ReactNode;
    surface: SessionMobileSurface;
}>) => {
    const isFocused = useIsFocused();
    const isWeb = Platform.OS === 'web';

    return (
        <WebInertView
            testID={`session-cockpit-scene:${props.surface}`}
            style={styles.scene}
            collapsable={false}
            inert={isWeb && !isFocused ? true : undefined}
            aria-hidden={isWeb && !isFocused ? true : undefined}
            accessibilityElementsHidden={isWeb ? undefined : !isFocused}
            importantForAccessibility={isWeb ? undefined : (isFocused ? 'auto' : 'no-hide-descendants')}
            pointerEvents={isFocused ? 'auto' : 'none'}
        >
            {props.children}
        </WebInertView>
    );
});

const SessionCockpitNavigatorInitialSurfaceBridge = React.memo((props: BottomTabBarProps & Readonly<{
    fallbackInitialSurface: SessionMobileSurface;
    requestedInitialSurface: SessionMobileSurface;
    sessionId: string;
}>) => {
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const activeSurface = normalizeSessionMobileSurface(props.state.routes[props.state.index]?.name) ?? 'chat';

    const persistSessionSurface = React.useCallback((surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(props.sessionId, surface);
    }, [persistSessionLastMobileSurface, props.sessionId]);

    const restoredInitialPluginSurfaceRef = React.useRef<SessionMobileSurface | null>(null);
    React.useEffect(() => {
        const requestedSurface = props.requestedInitialSurface;
        if (!isSessionPluginMobileSurface(requestedSurface)) {
            restoredInitialPluginSurfaceRef.current = null;
            return;
        }
        if (activeSurface !== props.fallbackInitialSurface || activeSurface === requestedSurface) {
            return;
        }

        const route = props.state.routes.find((candidate) => candidate.name === requestedSurface);
        if (!route || restoredInitialPluginSurfaceRef.current === requestedSurface) {
            return;
        }

        const event = props.navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
        });
        if (event.defaultPrevented) return;

        restoredInitialPluginSurfaceRef.current = requestedSurface;
        props.navigation.navigate(route.name);
        persistSessionSurface(requestedSurface);
    }, [
        activeSurface,
        persistSessionSurface,
        props.fallbackInitialSurface,
        props.navigation,
        props.requestedInitialSurface,
        props.state.routes,
    ]);

    return null;
});

const styles = StyleSheet.create({
    scene: {
        flex: 1,
        minHeight: 0,
    },
});
