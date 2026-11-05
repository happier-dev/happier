import { useSessionCollaborationDestinationAdmitted } from '@/hooks/session/useSessionCollaborationAvailability';
import { useSessionBoardFeatureEnabled } from '@/components/sessions/board/useSessionBoardFeatureEnabled';
import * as React from 'react';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
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
import { useAppRightSidebarTabInputs } from '@/components/appShell/rightSidebar/appRightSidebarTabs';
import { PanePresentationProvider, usePanePresentation, type PanePresentation } from '@/components/appShell/panes/panePresentation';
import { buildActiveDetailsRouteParams, buildSessionDetailsTabHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useOptionalWorkspaceNavigation, type WorkspacePhoneControls } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { useDestinationPathname, useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useSessionViewerPresentingReader } from '@/components/sessions/viewer/SessionViewerDestinationScope';

import {
    isSessionPluginMobileSurface,
    normalizeSessionMobileSurface,
    resolveSessionCockpitLandingSurface,
    resolveSessionCockpitRouteFromPathname,
    resolveSessionMobileSurfaceIntent,
    type SessionMobileSurface,
} from './sessionCockpitState';
import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileNavigatorSurfaces,
    type SessionCockpitMobileCatalogEntry,
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
import { PhoneAskSheetProvider, usePhoneAskSheet, usePhoneAskSheetState } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';
import { PhoneAskSheetFrame } from '@/components/sessions/composer/phoneAsk/PhoneAskSheetFrame';
import { createSessionCockpitTabNavigator } from './sessionCockpitTabs';

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

const Tab = createSessionCockpitTabNavigator<SessionCockpitTabParamList>();

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
    const cockpit = props.experience !== 'classic';
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
    // Decided once, as the cockpit mounts: a presented viewer docks into Chat, so it must not open
    // behind a retained projection. Later presentation changes never re-route the person.
    const readViewerPresenting = useSessionViewerPresentingReader(props.sessionId, sessionServerId);
    const [viewerPresentingAtMount] = React.useState(readViewerPresenting);
    const requestedInitialSurface = resolveSessionCockpitLandingSurface(props.initialSurface, viewerPresentingAtMount);
    const collaborationAdmitted = useSessionCollaborationDestinationAdmitted(sessionServerId ?? '');
    const sessionSharingAvailable = Boolean(sessionServerId) && collaborationAdmitted;
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(sessionServerId);
    const retentionRealm = React.useMemo(() => Object.freeze({
        sessionId: props.sessionId,
        serverId: sessionServerId ?? null,
        accountRealmKey: persistenceAccountRealmKey,
    }), [persistenceAccountRealmKey, props.sessionId, sessionServerId]);
    const boardPluginRuntime = useSessionPluginRuntime({ address: sessionAddress });
    const appTabInputs = useAppRightSidebarTabInputs();
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
        ...appTabInputs,
        sessionSharingAvailable,
        boardFeatureEnabled,
        terminalTabAvailable,
        pluginPlacements,
        runtimeAdmission,
    }), [
        appTabInputs,
        boardFeatureEnabled,
        sessionSharingAvailable,
        pluginPlacements,
        runtimeAdmission,
        terminalTabAvailable,
    ]);
    const projectedSurfaces = React.useMemo(() => resolveSessionCockpitMobileNavigatorSurfaces({ catalog }), [catalog]);
    const [retainedPluginSelection, setRetainedPluginSelection] = React.useState<RetainedPluginSurfaceSelection | null>(() => (
        isSessionPluginMobileSurface(requestedInitialSurface) && projectedSurfaces.includes(requestedInitialSurface)
            ? Object.freeze({ ...retentionRealm, surface: requestedInitialSurface })
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
        if (!isSessionPluginMobileSurface(requestedInitialSurface) || !boardPluginRuntime.pluginUiProjection) {
            return;
        }
        setRetainedPluginSelection((current) => (
            retainedPluginSelectionMatchesRealm(current, retentionRealm)
                ? current
                : Object.freeze({ ...retentionRealm, surface: requestedInitialSurface })
        ));
    }, [boardPluginRuntime.pluginUiProjection, requestedInitialSurface, retentionRealm]);
    const surfaces = React.useMemo(() => resolveSessionCockpitMobileNavigatorSurfaces({
        catalog,
        retainedPluginSurface,
    }), [catalog, retainedPluginSurface]);
    const initialSurface = resolveInitialSurface(cockpit ? requestedInitialSurface : 'chat', surfaces);
    const persistSessionLastMobileSurface = usePersistSessionLastMobileSurface();
    // Phone Ask (P5 §3.9, D-4): the cockpit is the common parent of the File page and the Chat scene that mounts
    // the one Session composer. It hosts the Chat scene itself, so Ask can raise that scene, composer and draft
    // intact, as a bottom sheet over the File scene (web and native alike).
    const phoneAsk = usePhoneAskSheetState(cockpit && deviceType === 'phone');
    const raisedChatScene = React.useMemo(() => ({
        routeName: 'chat',
        raised: phoneAsk?.phase === 'open',
        Frame: PhoneAskSheetFrame,
    }), [phoneAsk?.phase]);
    const lastCommittedNavigationSurfaceRef = React.useRef<Readonly<{
        sessionId: string;
        serverId: string | null;
        accountRealmKey: string | null;
        surface: SessionMobileSurface;
    }> | null>(null);
    const commitNavigatorSurface = React.useCallback((surface: SessionMobileSurface) => {
        if (!cockpit) return;
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
    }, [cockpit, persistSessionLastMobileSurface, props.sessionId, retentionRealm, sessionServerId, surfaces]);
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
            <PhoneAskSheetProvider value={phoneAsk}>
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
                            raisedScene={raisedChatScene}
                            tabBar={(tabBarProps) => (
                                <SessionCockpitNavigatorInitialSurfaceBridge
                                    {...tabBarProps}
                                    cockpit={cockpit}
                                    readViewerPresenting={readViewerPresenting}
                                    fallbackInitialSurface={isSessionPluginMobileSurface(requestedInitialSurface) ? 'chat' : initialSurface}
                                    requestedInitialSurface={requestedInitialSurface}
                                    paneUrlState={props.paneUrlState}
                                    terminalTabAvailable={terminalTabAvailable}
                                />
                            )}
                        >
                            {surfaces.map((surface) => (
                                <Tab.Screen key={surface} name={surface}>
                                    {({ navigation }) => (
                                        <SessionCockpitSceneActivityBoundary surface={surface}>
                                            <SessionCockpitSceneNavigationBoundary
                                                cockpit={cockpit}
                                                navigation={navigation}
                                                commitSurface={commitNavigatorSurface}
                                            >
                                                <SessionCockpitPanePresentationBoundary
                                                    scopeId={props.scopeId}
                                                    cockpit={cockpit}
                                                    sessionId={props.sessionId}
                                                    serverId={sessionServerId}
                                                    catalog={catalog}
                                                    navigate={navigation.navigate}
                                                    commitSurface={commitNavigatorSurface}
                                                >
                                                    <SessionCockpitSurfaceScreen
                                                        {...props}
                                                        surface={surface}
                                                        openWorkStateRequestKey={surface === 'chat' ? openWorkStateRequestKey : null}
                                                        onRequestOpenWorkState={requestOpenWorkState}
                                                    />
                                                </SessionCockpitPanePresentationBoundary>
                                            </SessionCockpitSceneNavigationBoundary>
                                        </SessionCockpitSceneActivityBoundary>
                                    )}
                                </Tab.Screen>
                            ))}
                        </Tab.Navigator>
                    </PluginSurfacePaneLaunchScope>
                </NavigationContainer>
            </NavigationIndependentTree>
            </PhoneAskSheetProvider>
        </SessionBoardControllerProvider>
    );
});

function SessionCockpitSceneNavigationBoundary({ cockpit, navigation, commitSurface, children }: React.PropsWithChildren<Readonly<{
    cockpit: boolean;
    navigation: Pick<BottomTabBarProps['navigation'], 'navigate' | 'canGoBack' | 'goBack'>;
    commitSurface: (surface: SessionMobileSurface) => void;
}>>) {
    const { navigate, canGoBack, goBack } = navigation;
    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        navigate(surface);
        commitSurface(surface);
    }, [commitSurface, navigate]);
    const returnToPreviousSurface = React.useCallback(() => {
        if (canGoBack()) goBack();
        else navigate('chat');
    }, [canGoBack, goBack, navigate]);
    const value = React.useMemo(() => cockpit ? { switchSurface, returnToPreviousSurface } : null,
        [cockpit, returnToPreviousSurface, switchSurface]);
    return <SessionCockpitSurfaceNavigationProvider value={value}>{children}</SessionCockpitSurfaceNavigationProvider>;
}

export function SessionCockpitPanePresentationBoundary(props: React.PropsWithChildren<Readonly<{
    cockpit: boolean;
    scopeId: string;
    sessionId: string;
    serverId: string | null;
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    navigate: (surface: SessionMobileSurface) => void;
    commitSurface: (surface: SessionMobileSurface) => void;
}>>) {
    const enclosingPresentation = usePanePresentation();
    const router = useDestinationRouter();
    // Read when a page opens, so workspace edits never re-create this presenter for every pane opener.
    const workspacePhone = React.useRef<WorkspacePhoneControls | null>(null);
    workspacePhone.current = useOptionalWorkspaceNavigation()?.phone ?? null;
    const presentPane = React.useCallback<PanePresentation>((intent) => {
        if (intent.scopeId !== props.scopeId) return;
        if (intent.pane === 'details' && intent.start) return;
        if (intent.pane === 'details') {
            // Every linkable Details page opened on a phone uses the same rail owner, whether opened from
            // the Session, another Details page, or the Tabs button. It owns reuse and close-to-source.
            const href = buildSessionDetailsTabHref({ sessionId: props.sessionId, serverId: props.serverId, tab: intent.tab });
            const phone = workspacePhone.current;
            if (href && phone) return phone.openHref(href, 'preview') ? 'ownTab' : undefined;
            if (intent.fromDetails) return;
            const query = buildActiveDetailsRouteParams([intent.tab], intent.tab.key);
            if (query.details) {
                // Publish the accepted target before switching scenes. Waiting
                // for pane hydration lets the outer chrome emit an empty URL.
                router.replace({ pathname: '/session/[id]/details', params: {
                    id: props.sessionId,
                    ...(props.serverId ? { serverId: props.serverId } : {}),
                    ...query,
                } });
            }
        }
        const entry = intent.pane === 'right' ? props.catalog.find((candidate) => candidate.owner === 'rightSidebar' && (
            intent.destination?.kind === 'plugin'
                ? candidate.tab.owner === 'plugin'
                    && candidate.tab.placement.binding.destination.pluginId === intent.destination.destination.pluginId
                    && candidate.tab.placement.binding.destination.localId === intent.destination.destination.localId
                : intent.destination?.kind === 'builtin' && candidate.tab.id === intent.destination.id
        )) : null;
        const target = intent.pane === 'details' ? 'tabs' : entry?.id;
        if (!target) return;
        props.navigate(target);
        props.commitSurface(target);
    }, [props.catalog, props.commitSurface, props.navigate, props.scopeId, props.serverId, props.sessionId, router]);
    return <PanePresentationProvider value={props.cockpit ? presentPane : enclosingPresentation}>{props.children}</PanePresentationProvider>;
}

const SessionCockpitSceneActivityBoundary = React.memo((props: Readonly<{
    children: React.ReactNode;
    surface: SessionMobileSurface;
}>) => {
    // Chat raised as the Ask sheet over another scene is live there: its composer takes the caret and the taps.
    const askRaised = usePhoneAskSheet()?.phase === 'open' && props.surface === 'chat';
    const isFocused = useIsFocused() || askRaised;
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
    cockpit: boolean;
    readViewerPresenting: () => boolean;
    fallbackInitialSurface: SessionMobileSurface;
    requestedInitialSurface: SessionMobileSurface;
    paneUrlState?: SessionCockpitSurfaceScreenProps['paneUrlState'];
    terminalTabAvailable: boolean;
}>) => {
    const activeSurface = normalizeSessionMobileSurface(props.state.routes[props.state.index]?.name) ?? 'chat';
    const routeSurface = resolveSessionCockpitRouteFromPathname(useDestinationPathname())?.surface;
    const presentsDetails = routeSurface === 'tabs';

    // The navigator is also Chat's stable parent on wide screens. Save its
    // actual phone state (including Back history), temporarily present Chat,
    // and restore that state when the surrounding cockpit returns.
    const previousCockpit = React.useRef(props.cockpit);
    const phoneState = React.useRef<BottomTabBarProps['state'] | null>(null);
    React.useLayoutEffect(() => {
        const wasCockpit = previousCockpit.current;
        previousCockpit.current = props.cockpit;
        if (!props.cockpit) {
            if (wasCockpit) phoneState.current = props.state;
            if (activeSurface !== 'chat') props.navigation.navigate('chat');
        } else if (!wasCockpit) {
            if (props.readViewerPresenting()) props.navigation.navigate('chat');
            else if (phoneState.current) {
                // Catalog admission can change while wide. Keep the current navigator's
                // inventory and identity, restoring saved routes only where still admitted.
                const saved = phoneState.current;
                const selectedName = saved.routes[saved.index]?.name;
                const savedRoutes = new Map(saved.routes.map(route => [route.name, route]));
                const routes = props.state.routes.map(route => savedRoutes.get(route.name) ?? route);
                const selectedIndex = routes.findIndex(route => route.name === selectedName);
                const routeKeys = new Set(routes.map(route => route.key));
                props.navigation.reset({ ...props.state, routes,
                    index: selectedIndex >= 0 ? selectedIndex : routes.findIndex(route => route.name === 'chat'),
                    history: saved.history.filter(entry => routeKeys.has(entry.key)),
                });
            }
            else props.navigation.navigate(props.requestedInitialSurface);
        }
    }, [activeSurface, props.cockpit, props.navigation, props.readViewerPresenting, props.requestedInitialSurface, props.state]);

    const restoredInitialPluginSurfaceRef = React.useRef<SessionMobileSurface | null>(null);
    const requestedRouteIntent = JSON.stringify([props.requestedInitialSurface,
        presentsDetails ? props.paneUrlState?.details ?? null : props.paneUrlState ?? null, presentsDetails]);
    const consumedRouteIntentRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!props.cockpit) return;
        const hasPaneIntent = presentsDetails || Boolean(props.paneUrlState?.details || props.paneUrlState?.rightTabId);
        // A Details route presents retained/contributed tabs even when its URL still carries a sidebar.
        const requestedSurface = presentsDetails ? 'tabs' : hasPaneIntent ? resolveSessionMobileSurfaceIntent({
            routeKind: 'index',
            detailsTargetPresent: props.paneUrlState?.details !== undefined,
            activeRightTabId: props.paneUrlState?.details ? null : props.paneUrlState?.rightTabId,
            terminalTabAvailable: props.terminalTabAvailable,
        }) : props.requestedInitialSurface;
        if (consumedRouteIntentRef.current === requestedRouteIntent) return;
        // Consume external route intent once. Native/history Back owns the
        // next transition; an unchanged retained URL must not trap the user.
        const route = props.state.routes.find((candidate) => candidate.name === requestedSurface);
        if (hasPaneIntent) {
            if (!route) return;
            consumedRouteIntentRef.current = requestedRouteIntent;
            restoredInitialPluginSurfaceRef.current = null;
            if (activeSurface !== requestedSurface) props.navigation.navigate(route.name);
            return;
        }
        // The non-plugin initial surface can also be derived from retained
        // pane state. It is a mount hint, not a live navigation command.
        if (!isSessionPluginMobileSurface(requestedSurface)) {
            consumedRouteIntentRef.current = requestedRouteIntent;
            return;
        }
        if (route && activeSurface === requestedSurface) {
            consumedRouteIntentRef.current = requestedRouteIntent;
            return;
        }
        if (activeSurface !== props.fallbackInitialSurface || activeSurface === requestedSurface) {
            return;
        }

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
        consumedRouteIntentRef.current = requestedRouteIntent;
        props.navigation.navigate(route.name);
    }, [
        activeSurface,
        props.cockpit,
        props.fallbackInitialSurface,
        props.navigation,
        props.requestedInitialSurface,
        props.paneUrlState,
        props.terminalTabAvailable,
        requestedRouteIntent,
        props.state.routes,
        presentsDetails,
    ]);

    return null;
});

const styles = StyleSheet.create({
    scene: {
        flex: 1,
        minHeight: 0,
    },
});
