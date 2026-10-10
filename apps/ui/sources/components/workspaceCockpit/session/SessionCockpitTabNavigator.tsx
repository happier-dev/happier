import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import * as React from 'react';
import {
    createBottomTabNavigator,
    type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import {
    NavigationContainer,
    NavigationIndependentTree,
    useIsFocused,
    useTheme,
} from '@react-navigation/native';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import {
    useActiveServerAccountScope,
    usePersistSessionLastMobileSurface,
} from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { PluginSurfacePaneLaunchScope } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDeviceType } from '@/utils/platform/responsive';

import {
    isSessionPluginMobileSurface,
    normalizeSessionMobileSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';
import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileNavigatorSurfaces,
} from './sessionCockpitMobileCatalog';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    SessionCockpitSurfaceScreen,
    type SessionCockpitSurfaceScreenProps,
} from './SessionCockpitSurfaceScreen';
import { SessionBoardControllerProvider } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

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

type SessionCockpitTabNavigatorProps = Omit<SessionCockpitSurfaceScreenProps, 'surface' | 'openWorkStateRequestKey' | 'onRequestOpenWorkState'> & Readonly<{
    initialSurface: SessionMobileSurface;
}>;

type RetainedPluginSurfaceSelection = Readonly<{
    sessionId: string;
    serverId: string | null;
    accountRealmKey: string | null;
    surface: SessionMobileSurface;
}>;

function retainedPluginSelectionMatchesRealm(
    selection: RetainedPluginSurfaceSelection | null,
    realm: Readonly<{
        sessionId: string;
        serverId: string | null;
        accountRealmKey: string | null;
    }>,
): selection is RetainedPluginSurfaceSelection {
    return selection?.sessionId === realm.sessionId
        && selection.serverId === realm.serverId
        && selection.accountRealmKey === realm.accountRealmKey;
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

function isNavigationStateRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

/**
 * `NavigationContainer` is the sole source of truth for a native/history tab
 * transition. Follow its selected child rather than inferring a surface from a
 * press callback, which does not run for Android/iOS Back.
 */
export function resolveSessionCockpitSurfaceFromNavigationState(state: unknown): SessionMobileSurface | null {
    let currentState: unknown = state;
    let resolvedSurface: SessionMobileSurface | null = null;
    while (isNavigationStateRecord(currentState)) {
        const routes = Array.isArray(currentState.routes) ? currentState.routes : [];
        const rawIndex = currentState.index;
        const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex)
            ? rawIndex
            : 0;
        const route = routes[index];
        if (!isNavigationStateRecord(route)) break;

        const surface = normalizeSessionMobileSurface(
            typeof route.name === 'string' ? route.name : null,
        );
        if (surface) {
            resolvedSurface = surface;
        }
        currentState = route.state;
    }
    return resolvedSurface;
}

export const SessionCockpitTabNavigator = React.memo((props: SessionCockpitTabNavigatorProps) => {
    // An independent navigation tree starts from the library's light default theme, whose scene
    // background would paint every surface light under a dark app. Read the app's navigation theme
    // (the root layout owns it) outside the tree and hand it to the nested container.
    const navigationTheme = useTheme();
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const deviceType = useDeviceType();
    const activeServerAccountScope = useActiveServerAccountScope();
    const persistenceAccountRealmKey = activeServerAccountScope
        ? serverAccountScopeKeySuffix(activeServerAccountScope)
        : null;
    // Navigation/catalog admission follows the exact routed Session address;
    // an ambient preferred Home is not evidence that this Session belongs there.
    const sessionServerId = props.routeServerId?.trim()
        || props.routeHydrationState?.serverId?.trim()
        || null;
    const sessionAddress = React.useMemo(
        () => normalizeSessionAddress(sessionServerId, props.sessionId),
        [props.sessionId, sessionServerId],
    );
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(sessionServerId ?? '');
    const sessionSharingAvailable = Boolean(sessionServerId) && collaborationAdmitted;
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(sessionServerId);
    const retentionRealm = React.useMemo(() => Object.freeze({
        sessionId: props.sessionId,
        serverId: sessionServerId ?? null,
        accountRealmKey: persistenceAccountRealmKey,
    }), [persistenceAccountRealmKey, props.sessionId, sessionServerId]);
    const boardPluginRuntime = useSessionPluginRuntime({ address: sessionAddress });
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: boardPluginRuntime.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [boardPluginRuntime.platform, deviceType]);
    const pluginPlacements = React.useMemo(() => (
        boardPluginRuntime.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(boardPluginRuntime.pluginUiProjection, 'session')
            : []
    ), [boardPluginRuntime.pluginUiProjection]);
    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({
        sessionSharingAvailable,
        boardFeatureEnabled,
        terminalTabAvailable,
        pluginPlacements,
        projectionGeneration: boardPluginRuntime.pluginUiProjection?.generation ?? null,
        runtimeAdmission,
    }), [
        boardFeatureEnabled,
        sessionSharingAvailable,
        pluginPlacements,
        boardPluginRuntime.pluginUiProjection?.generation,
        runtimeAdmission,
        terminalTabAvailable,
    ]);
    const projectedSurfaces = React.useMemo(() => resolveSessionCockpitMobileNavigatorSurfaces({ catalog }), [catalog]);
    const [retainedPluginSelection, setRetainedPluginSelection] = React.useState<RetainedPluginSurfaceSelection | null>(() => (
        isSessionPluginMobileSurface(props.initialSurface) && projectedSurfaces.includes(props.initialSurface)
            ? Object.freeze({ ...retentionRealm, surface: props.initialSurface })
            : null
    ));
    const retainedPluginSurface = retainedPluginSelectionMatchesRealm(retainedPluginSelection, retentionRealm)
        ? retainedPluginSelection.surface
        : null;
    React.useEffect(() => {
        // A null projection is still establishing, so keep the incumbent bridge
        // behavior that waits for a current plugin screen. Once the projection
        // has settled, retain the exact restored identity even when it no longer
        // resolves: the existing screen owner will render its typed tombstone
        // instead of silently replacing the user's destination with Chat.
        if (!isSessionPluginMobileSurface(props.initialSurface) || !boardPluginRuntime.pluginUiProjection) {
            return;
        }
        setRetainedPluginSelection((current) => (
            retainedPluginSelectionMatchesRealm(current, retentionRealm)
                ? current
                : Object.freeze({ ...retentionRealm, surface: props.initialSurface })
        ));
    }, [boardPluginRuntime.pluginUiProjection, props.initialSurface, retentionRealm]);
    const surfaces = React.useMemo(() => resolveSessionCockpitMobileNavigatorSurfaces({
        catalog,
        retainedPluginSurface,
    }), [catalog, retainedPluginSurface]);
    const initialSurface = resolveInitialSurface(props.initialSurface, surfaces);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    const lastCommittedNavigationSurfaceRef = React.useRef<Readonly<{
        sessionId: string;
        serverId: string | null;
        accountRealmKey: string | null;
        surface: SessionMobileSurface;
    }> | null>(null);
    const commitNavigatorSurface = React.useCallback((surface: SessionMobileSurface) => {
        const persistenceServerId = sessionServerId ?? null;
        const alreadyCommittedForCurrentRealm = lastCommittedNavigationSurfaceRef.current?.sessionId === props.sessionId
            && lastCommittedNavigationSurfaceRef.current?.serverId === persistenceServerId
            && lastCommittedNavigationSurfaceRef.current?.accountRealmKey === persistenceAccountRealmKey
            && lastCommittedNavigationSurfaceRef.current?.surface === surface;
        if (!surfaces.includes(surface) || alreadyCommittedForCurrentRealm) {
            return;
        }
        lastCommittedNavigationSurfaceRef.current = {
            sessionId: props.sessionId,
            serverId: persistenceServerId,
            accountRealmKey: persistenceAccountRealmKey,
            surface,
        };
        setRetainedPluginSelection(isSessionPluginMobileSurface(surface)
            ? Object.freeze({ ...retentionRealm, surface })
            : null);
        persistSessionLastMobileSurface(props.sessionId, surface, persistenceServerId);
    }, [persistSessionLastMobileSurface, props.sessionId, retentionRealm, sessionServerId, surfaces]);
    const handleNavigatorStateChange = React.useCallback((state: unknown) => {
        const surface = resolveSessionCockpitSurfaceFromNavigationState(state);
        if (!surface) return;
        commitNavigatorSurface(surface);
    }, [commitNavigatorSurface]);
    const [openWorkStateRequestKey, setOpenWorkStateRequestKey] = React.useState<number | null>(null);
    const requestOpenWorkState = React.useCallback(() => {
        setOpenWorkStateRequestKey((current) => (current ?? 0) + 1);
    }, []);
    React.useEffect(() => {
        // The request key is an ephemeral reveal intent for one exact Session
        // address. Retained tab scenes can survive route updates, so retire the
        // old intent when either the Session or its Home/account realm changes;
        // a new Companion reveal then starts from a fresh sequence.
        setOpenWorkStateRequestKey(null);
    }, [retentionRealm]);

    return (
        <SessionBoardControllerProvider
            sessionId={props.sessionId}
            serverId={sessionServerId}
            pluginRuntime={boardPluginRuntime}
        >
            <NavigationIndependentTree>
                <NavigationContainer
                    theme={navigationTheme}
                    linking={DISABLED_NAVIGATION_LINKING}
                    onStateChange={handleNavigatorStateChange}
                >
                    <PluginSurfacePaneLaunchScope>
                        <Tab.Navigator
                            backBehavior="history"
                            initialRouteName={initialSurface}
                            screenOptions={SESSION_COCKPIT_TAB_SCREEN_OPTIONS}
                            tabBar={(tabBarProps) => (
                                <SessionCockpitNavigatorInitialSurfaceBridge
                                    {...tabBarProps}
                                    fallbackInitialSurface={isSessionPluginMobileSurface(props.initialSurface) ? 'chat' : initialSurface}
                                    requestedInitialSurface={props.initialSurface}
                                />
                            )}
                        >
                            {surfaces.map((surface) => (
                                <Tab.Screen key={surface} name={surface}>
                                    {({ navigation }) => (
                                        <SessionCockpitSceneActivityBoundary surface={surface}>
                                            <SessionCockpitSurfaceNavigationProvider
                                                value={{
                                                    returnToPreviousSurface: () => {
                                                        if (navigation.canGoBack()) {
                                                            navigation.goBack();
                                                        } else {
                                                            navigation.navigate('chat');
                                                        }
                                                    },
                                                    switchSurface: (targetSurface) => {
                                                        navigation.navigate(targetSurface);
                                                        commitNavigatorSurface(targetSurface);
                                                    },
                                                }}
                                            >
                                                <SessionCockpitSurfaceScreen
                                                    {...props}
                                                    surface={surface}
                                                    openWorkStateRequestKey={surface === 'chat' ? openWorkStateRequestKey : null}
                                                    onRequestOpenWorkState={requestOpenWorkState}
                                                />
                                            </SessionCockpitSurfaceNavigationProvider>
                                        </SessionCockpitSceneActivityBoundary>
                                    )}
                                </Tab.Screen>
                            ))}
                        </Tab.Navigator>
                    </PluginSurfacePaneLaunchScope>
                </NavigationContainer>
            </NavigationIndependentTree>
        </SessionBoardControllerProvider>
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
            <PluginSurfaceFocusEligibilityProvider active={isFocused}>
                {props.children}
            </PluginSurfaceFocusEligibilityProvider>
        </WebInertView>
    );
});

const SessionCockpitNavigatorInitialSurfaceBridge = React.memo((props: BottomTabBarProps & Readonly<{
    fallbackInitialSurface: SessionMobileSurface;
    requestedInitialSurface: SessionMobileSurface;
}>) => {
    const activeSurface = normalizeSessionMobileSurface(props.state.routes[props.state.index]?.name) ?? 'chat';

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
    }, [
        activeSurface,
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
