import * as React from 'react';
import {
    createBottomTabNavigator,
} from '@react-navigation/bottom-tabs';
import { NavigationContainer, NavigationIndependentTree, useIsFocused } from '@react-navigation/native';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { usePersistSessionLastMobileSurface } from '@/sync/domains/state/storage';

import {
    type SessionMobileSurface,
} from './sessionCockpitState';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';
import {
    SessionCockpitSurfaceScreen,
    type SessionCockpitSurfaceScreenProps,
} from './SessionCockpitSurfaceScreen';

type SessionCockpitTabParamList = {
    chat: undefined;
    browse: undefined;
    git: undefined;
    navigation: undefined;
    tabs: undefined;
    terminal: undefined;
};

const Tab = createBottomTabNavigator<SessionCockpitTabParamList>();

const SESSION_COCKPIT_SURFACES_WITH_TERMINAL: readonly SessionMobileSurface[] = ['chat', 'browse', 'git', 'navigation', 'tabs', 'terminal'];
const SESSION_COCKPIT_SURFACES_WITHOUT_TERMINAL: readonly SessionMobileSurface[] = ['chat', 'browse', 'git', 'navigation', 'tabs'];
const DISABLED_NAVIGATION_LINKING = { enabled: false, prefixes: [] };
const SESSION_COCKPIT_TAB_SCREEN_OPTIONS = {
    headerShown: false,
    animation: 'none',
    lazy: true,
    freezeOnBlur: true,
    tabBarHideOnKeyboard: false,
} as const;
const renderHiddenTabBar = () => null;
const WebInertView = View as React.ComponentType<ViewProps & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>>;

type SessionCockpitTabNavigatorProps = Omit<SessionCockpitSurfaceScreenProps, 'surface'> & Readonly<{
    initialSurface: SessionMobileSurface;
}>;

function resolveAvailableSurfaces(terminalTabAvailable: boolean): readonly SessionMobileSurface[] {
    return terminalTabAvailable
        ? SESSION_COCKPIT_SURFACES_WITH_TERMINAL
        : SESSION_COCKPIT_SURFACES_WITHOUT_TERMINAL;
}

function resolveInitialSurface(
    initialSurface: SessionMobileSurface,
    terminalTabAvailable: boolean,
): SessionMobileSurface {
    if (initialSurface === 'terminal' && !terminalTabAvailable) {
        return 'chat';
    }
    return initialSurface;
}

export const SessionCockpitTabNavigator = React.memo((props: SessionCockpitTabNavigatorProps) => {
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const initialSurface = resolveInitialSurface(props.initialSurface, terminalTabAvailable);
    const surfaces = resolveAvailableSurfaces(terminalTabAvailable);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const persistSessionSurface = React.useCallback((surface: SessionMobileSurface) => {
        persistSessionLastMobileSurface(props.sessionId, surface);
    }, [persistSessionLastMobileSurface, props.sessionId]);

    // The session route is navigated singularly (`useNavigateToSession` reuses the route key),
    // so a session -> session move never remounts this screen. Without keying, the nested
    // navigator keeps the previous session's state: `initialRouteName` is honoured only at mount,
    // so session B would open on session A's surface, and `backBehavior="history"` would inherit
    // session A's tab history. Keying on the session makes the navigator's identity match the
    // session its state belongs to. It also *reduces* mounted work: only the destination surface
    // mounts, instead of every surface session A had lazily mounted re-rendering with B's props.
    return (
        <NavigationIndependentTree key={props.sessionId}>
            <NavigationContainer linking={DISABLED_NAVIGATION_LINKING}>
                <Tab.Navigator
                    backBehavior="history"
                    initialRouteName={initialSurface}
                    screenOptions={SESSION_COCKPIT_TAB_SCREEN_OPTIONS}
                    tabBar={renderHiddenTabBar}
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

const styles = StyleSheet.create({
    scene: {
        flex: 1,
        minHeight: 0,
    },
});
