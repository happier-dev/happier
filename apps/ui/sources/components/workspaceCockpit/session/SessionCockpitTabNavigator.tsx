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

import {
    useActiveServerAccountScope,
    usePersistSessionLastMobileSurface,
} from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
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
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
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
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const deviceType = useDeviceType();
    const activeServerAccountScope = useActiveServerAccountScope();
    const persistenceAccountRealmKey = activeServerAccountScope
        ? serverAccountScopeKeySuffix(activeServerAccountScope)
        : null;
    const sessionMachineTarget = useSessionMachineTarget(props.sessionId);
    const sessionServerId = usePreferredServerIdForSession(props.sessionId, props.routeServerId);
    const retentionRealm = React.useMemo(() => Object.freeze({
        sessionId: props.sessionId,
        serverId: sessionServerId ?? null,
        accountRealmKey: persistenceAccountRealmKey,
    }), [persistenceAccountRealmKey, props.sessionId, sessionServerId]);
    const pluginProjection = useScopedPluginUiProjection({
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: sessionServerId,
    });
    const runtimeAdmission = React.useMemo(() => Object.freeze({
        platform: pluginProjection.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, pluginProjection.platform]);
    const pluginPlacements = React.useMemo(() => (
        pluginProjection.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginProjection.pluginUiProjection, 'session')
            : []
    ), [pluginProjection.pluginUiProjection]);
    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({
        terminalTabAvailable,
        pluginPlacements,
        projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
        runtimeAdmission,
    }), [
        pluginPlacements,
        pluginProjection.pluginUiProjection?.generation,
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
        if (!isSessionPluginMobileSurface(props.initialSurface) || !pluginProjection.pluginUiProjection) {
            return;
        }
        setRetainedPluginSelection((current) => (
            retainedPluginSelectionMatchesRealm(current, retentionRealm)
                ? current
                : Object.freeze({ ...retentionRealm, surface: props.initialSurface })
        ));
    }, [pluginProjection.pluginUiProjection, props.initialSurface, retentionRealm]);
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

    return (
        <NavigationIndependentTree>
            <NavigationContainer
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
                                                switchSurface: (targetSurface) => {
                                                    navigation.navigate(targetSurface);
                                                    commitNavigatorSurface(targetSurface);
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
                </PluginSurfacePaneLaunchScope>
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
