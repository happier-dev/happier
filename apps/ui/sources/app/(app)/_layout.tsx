import { Redirect, Stack, router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Platform, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useUnistyles } from 'react-native-unistyles';
import { getPreferredLanguage, t } from '@/text';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { useAuth } from '@/auth/context/AuthContext';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { bootstrapActiveServerFromWebLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { buildTerminalConnectWebHref, isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { shouldHoldAuthenticatedShellForWebServerOverride } from '@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride';
import { consumeLegacySessionDeepLinkFromWebLocation } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { resolveAuthenticatedWebServerUrlOverrideAction } from '@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction';
import { shouldSwitchToServerUrl } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import {
    createFriendsStackScreenOptions,
    createInboxStackScreenOptions,
} from '@/utils/navigation/createSocialStackScreenOptions';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { MobileBottomChromeHost } from '@/components/navigation/mobile/chrome/MobileBottomChromeHost';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { AuthenticatedAppRuntimeMounts } from '@/components/appShell/runtime/AuthenticatedAppRuntimeMounts';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useEndpointConnectivity, useSyncError } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    isSessionRouteInAuthRecoverySubtree,
    resolveSessionRouteAuthRecoveryState,
    shouldNormalizeSessionRouteToAuthRecoveryBase,
} from '@/hooks/session/sessionRouteAuthRecovery';

const bootstrappedWebServerOverride = bootstrapActiveServerFromWebLocation({ scope: 'device' });

type StackScreenProps = React.ComponentProps<typeof Stack.Screen>;
type StackScreenOptions = NonNullable<StackScreenProps['options']>;

const MAIN_TAB_STACK_SCREEN_OPTIONS = { animation: 'none' } as const;

export default function RootLayout() {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const refreshAuth = auth.refreshFromActiveServer;
    const segments = useSegments();
    const pathname = usePathname();
    const globalSearchParams = useGlobalSearchParams();
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const happierVoiceSupported = useHappierVoiceSupport();
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const isTauriDesktopHost = isTauriDesktop();
    const isTerminalConnectRoute = isTerminalConnectWebPathname(pathname);
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const activeServerSnapshot = useActiveServerSnapshot();
    const stackContentStyle = React.useMemo(
        () => ({
            backgroundColor: isDesktopOverlayWindow ? 'transparent' : theme.colors.surface.base,
        }),
        [isDesktopOverlayWindow, theme.colors.surface.base],
    );
    const sessionRouteAuthRecovery = React.useMemo(
        () => resolveSessionRouteAuthRecoveryState({
            routeParams: globalSearchParams,
            activeServerId: activeServerSnapshot.serverId,
            endpointStatus: endpointConnectivity.status,
            syncError,
        }),
        [activeServerSnapshot.serverId, endpointConnectivity.status, globalSearchParams, syncError],
    );
    const shouldHoldProtectedRouteForAuthRecovery = React.useMemo(
        () => isSessionRouteInAuthRecoverySubtree({
            pathname,
            authRecovery: sessionRouteAuthRecovery,
        }),
        [pathname, sessionRouteAuthRecovery],
    );
    const shouldNormalizeSessionRouteForAuthRecovery = React.useMemo(
        () => !isAuthenticated && shouldNormalizeSessionRouteToAuthRecoveryBase({
            pathname,
            authRecovery: sessionRouteAuthRecovery,
        }),
        [isAuthenticated, pathname, sessionRouteAuthRecovery],
    );

    useWebInitialRouteReconcile({ routerPathname: pathname });

    React.useEffect(() => {
        if (!isTauriDesktopHost) return;
        void invokeTauri('desktop_set_window_mode', { mode: 'main' });
    }, [isTauriDesktopHost]);

    const [isApplyingWebServerOverride, setIsApplyingWebServerOverride] = React.useState(() =>
        shouldHoldAuthenticatedShellForWebServerOverride(isAuthenticated),
    );
    const webServerOverrideHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (!isAuthenticated) {
            setIsApplyingWebServerOverride(false);
            return;
        }
        if (webServerOverrideHandledRef.current) return;
        const overrideAction = resolveAuthenticatedWebServerUrlOverrideAction({
            isAuthenticated,
            bootstrappedServerUrl: bootstrappedWebServerOverride?.serverUrl ?? null,
        });
        if (overrideAction.kind === 'none') {
            setIsApplyingWebServerOverride(false);
            return;
        }
        webServerOverrideHandledRef.current = true;

        if (overrideAction.kind === 'cleanup_only' || overrideAction.kind === 'refresh_auth') {
            if (overrideAction.kind === 'refresh_auth') {
                fireAndForget(refreshAuth(), { tag: 'RootLayout.webServerOverrideBootstrapped.refreshAuth' });
            }
            setIsApplyingWebServerOverride(false);
            if (Platform.OS === 'web' && typeof window !== 'undefined') {
                try {
                    window.history.replaceState(null, '', overrideAction.cleanedRelativeUrl);
                } catch {
                    // ignore
                }
            }
            return;
        }

        setIsApplyingWebServerOverride(true);
        fireAndForget((async () => {
            try {
                await upsertActivateAndSwitchServer({
                    serverUrl: overrideAction.serverUrl,
                    source: 'url',
                    scope: 'device',
                    refreshAuth,
                });
            } catch {
                // keep URL normalization best-effort; server switch can still be repaired elsewhere
            } finally {
                setIsApplyingWebServerOverride(false);
            }
        })(), { tag: 'RootLayout.webServerOverride' });

        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            try {
                window.history.replaceState(null, '', overrideAction.cleanedRelativeUrl);
            } catch {
                // ignore
            }
        }
    }, [isAuthenticated, refreshAuth]);

    const legacySessionDeepLinkHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (legacySessionDeepLinkHandledRef.current) return;
        const didConsume = consumeLegacySessionDeepLinkFromWebLocation({
            isAuthenticated,
            replaceRelativeUrl: (nextRelativeUrl) => {
                if (Platform.OS !== 'web' || typeof window === 'undefined') return;
                try {
                    window.history.replaceState(null, '', nextRelativeUrl);
                } catch {
                    // ignore
                }
            },
            navigateToRoute: (route) => {
                router.replace(route);
            },
        });
        if (!didConsume) return;
        legacySessionDeepLinkHandledRef.current = true;
    }, [isAuthenticated]);

    const shouldRedirect =
        !isAuthenticated
        && !isPublicRouteForUnauthenticated(segments)
        && !shouldHoldProtectedRouteForAuthRecovery;
    const pendingTerminalHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (!shouldNormalizeSessionRouteForAuthRecovery) return;
        if (!sessionRouteAuthRecovery.baseHref) return;
        router.replace(sessionRouteAuthRecovery.baseHref);
    }, [sessionRouteAuthRecovery.baseHref, shouldNormalizeSessionRouteForAuthRecovery]);

    useNotificationResponseRouting({
        enabled: auth.isAuthenticated && !isDesktopOverlayWindow,
        refreshAuth: auth.refreshFromActiveServer,
    });

    React.useEffect(() => {
        if (!isAuthenticated) {
            pendingTerminalHandledRef.current = false;
            return;
        }

        const pendingTerminalConnect = getPendingTerminalConnect();
        if (pendingTerminalConnect) {
            if (pendingTerminalHandledRef.current) return;
            // Avoid leaking the terminal connect key via query params; use hash params on the dedicated
            // `/terminal/connect` route instead.
            const route = buildTerminalConnectWebHref({
                publicKeyB64Url: pendingTerminalConnect.publicKeyB64Url,
                serverUrl: pendingTerminalConnect.serverUrl,
            });

            // If we are already on the terminal-connect page (which persists a pending connect while
            // clearing the URL hash for safety), do not navigate away.
            if (segments.includes('terminal') && segments.includes('connect')) return;

            const active = normalizeServerUrl(getActiveServerUrl());
            const target = normalizeServerUrl(pendingTerminalConnect.serverUrl);
            if (shouldSwitchToServerUrl({ targetServerUrl: target, activeServerUrl: active })) {
                pendingTerminalHandledRef.current = true;
                fireAndForget((async () => {
                    try {
                        await upsertActivateAndSwitchServer({
                            serverUrl: pendingTerminalConnect.serverUrl,
                            source: 'url',
                            scope: 'device',
                            refreshAuth,
                        });
                    } catch {
                        // keep navigation best-effort; terminal flow can still recover with explicit server param
                    }
                    router.replace(route);
                })(), { tag: 'RootLayout.pendingTerminalConnect' });
                return;
            }

            pendingTerminalHandledRef.current = true;
            router.replace(route);
            return;
        }

        pendingTerminalHandledRef.current = false;
    }, [isAuthenticated, refreshAuth, segments]);

    // Server capability gating: if the server doesn't support Happier Voice (misconfigured/disabled),
    // default the user's voice mode to off (they can still choose BYO ElevenLabs in settings).
    React.useEffect(() => {
        if (!isAuthenticated) return;
        if (happierVoiceSupported !== false) return;
        let cancelled = false;
        fireAndForget((async () => {
            try {
                // Defer loading sync/storage modules until needed to keep module evaluation light.
                const [{ storage }, { sync }] = await Promise.all([
                    import('@/sync/domains/state/storage'),
                    import('@/sync/sync'),
                ]);

                if (cancelled) return;
                const voice = (storage.getState().settings as any)?.voice ?? null;
                const providerId = voice?.providerId ?? 'off';
                const billingMode = voice?.adapters?.realtime_elevenlabs?.billingMode ?? 'happier';
                if (providerId !== 'realtime_elevenlabs') return;
                if (billingMode !== 'happier') return;
                sync.applySettings({ voice: { ...voice, providerId: 'off' } }, { source: 'system' });
            } catch {
                // Non-fatal: feature gating should never crash the root layout.
            }
        })(), { tag: 'RootLayout.happierVoiceGate' });
        return () => {
            cancelled = true;
        };
    }, [happierVoiceSupported, isAuthenticated]);

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const rootStackScreenOptions = React.useMemo(() => createAppStackScreenOptions({
        contentStyle: stackContentStyle,
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [
        shouldUseCustomHeader,
        stackContentStyle,
        preferredLanguage,
        theme.colors.chrome.header.background,
        theme.colors.chrome.header.foreground,
    ]);
    const rootStackRouteOptions = React.useMemo(() => {
        const back = t('common.back');
        const cancel = t('common.cancel');
        const hiddenHeader: StackScreenOptions = { headerShown: false };
        const blankBack: StackScreenOptions = {
            headerTitle: '',
            headerBackTitle: back,
        };
        const visibleBlankBack: StackScreenOptions = {
            headerShown: true,
            headerTitle: '',
            headerBackTitle: back,
        };
        const visibleSessionHistory: StackScreenOptions = {
            headerShown: true,
            headerTitle: t('sessionHistory.title'),
            headerBackTitle: back,
        };

        return {
            index: {
                headerShown: false,
                headerTitle: '',
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            inboxIndex: {
                ...createInboxStackScreenOptions(t),
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            friendsIndex: {
                ...createFriendsStackScreenOptions(t),
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            hiddenHeader,
            settings: {
                // Nested navigator; per-settings-screen headers are configured in `settings/_layout.tsx`.
                headerShown: false,
                ...MAIN_TAB_STACK_SCREEN_OPTIONS,
            },
            desktopActivityOverlay: {
                headerShown: false,
                contentStyle: {
                    backgroundColor: 'transparent',
                },
            },
            automationsIndex: {
                headerShown: true,
                headerTitle: t('navigation.automations'),
                headerBackTitle: back,
            },
            automationsId: {
                headerShown: true,
                headerTitle: t('navigation.automation'),
                headerBackTitle: back,
            },
            automationsNew: {
                headerShown: true,
                headerTitle: t('navigation.newAutomation'),
                headerBackTitle: back,
            },
            visibleBlankBack,
            sessionRuns: {
                headerShown: true,
                headerTitle: t('runs.title'),
                headerBackTitle: back,
            },
            files: hiddenHeader,
            sessionRecent: visibleSessionHistory,
            sessionArchived: visibleSessionHistory,
            terminalIndex: {
                headerTitle: t('navigation.connectTerminal'),
            },
            changelog: {
                headerShown: true,
                headerTitle: t('navigation.whatsNew'),
                headerBackTitle: back,
            },
            artifactsIndex: {
                headerShown: true,
                headerTitle: t('artifacts.title'),
                headerBackTitle: back,
            },
            artifactsId: {
                headerShown: false,
            },
            artifactsNew: {
                headerShown: true,
                headerTitle: t('artifacts.new'),
                headerBackTitle: cancel,
            },
            artifactsEdit: {
                headerShown: true,
                headerTitle: t('artifacts.edit'),
                headerBackTitle: cancel,
            },
            friendsSearch: {
                headerShown: true,
                headerTitle: t('friends.addFriend'),
                headerBackTitle: back,
            },
            userId: visibleBlankBack,
            devIndex: {
                headerTitle: t('navigation.developerTools'),
            },
            devListDemo: {
                headerTitle: t('navigation.listComponentsDemo'),
            },
            devTypography: {
                headerTitle: t('navigation.typography'),
            },
            devColors: {
                headerTitle: t('navigation.colors'),
            },
            devTools2: {
                headerTitle: t('navigation.toolViewsDemo'),
            },
            devShimmerDemo: {
                headerTitle: t('navigation.shimmerViewDemo'),
            },
            devMultiTextInput: {
                headerTitle: t('navigation.multiTextInput'),
            },
            blankBack,
            newPickSecretRequirement: {
                headerShown: false,
                // /new is presented modally on iOS. Ensure this overlay screen is too,
                // otherwise it can end up pushed "behind" the modal (invisible but on the back stack).
                presentation: Platform.OS === 'ios' ? 'containedModal' : 'modal',
            },
            zenIndex: hiddenHeader,
            zenNew: {
                presentation: 'modal',
                headerTitle: t('navigation.zenNewTask'),
                headerBackTitle: cancel,
            },
            zenView: {
                presentation: 'modal',
                headerTitle: t('navigation.zenTaskDetails'),
                headerBackTitle: back,
            },
        } satisfies Record<string, StackScreenOptions>;
    }, [preferredLanguage]);
    const friendsManageScreenOptions = React.useCallback((args: { navigation: { navigate: (route: never) => void } }) => ({
        headerShown: true,
        headerTitle: t('navigation.friends'),
        headerBackTitle: t('common.back'),
        headerRight: () =>
            (
                <TouchableOpacity
                    onPress={() => args.navigation.navigate('friends/search' as never)}
                    style={{ paddingHorizontal: 16, opacity: friendsIdentityReady ? 1 : 0.5 }}
                    disabled={!friendsIdentityReady}
                    accessibilityState={{ disabled: !friendsIdentityReady }}
                >
                    <Text style={{ color: theme.colors.button.primary.tint, fontSize: 16 }}>
                        {t('friends.addFriend')}
                    </Text>
                </TouchableOpacity>
            ),
    }), [friendsIdentityReady, preferredLanguage, theme.colors.button.primary.tint]);
    const newSessionScreenOptions = React.useMemo<StackScreenOptions>(() => ({
        headerTitle: t('newSession.title'),
        headerShown: true,
        headerBackTitle: t('common.cancel'),
        presentation: 'modal',
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        // Swipe-to-dismiss is not consistently available across platforms; always provide a close button.
        headerBackVisible: false,
        headerLeft: () => null,
    }), [preferredLanguage]);
    const externalSessionBrowseScreenOptions = React.useMemo<StackScreenOptions>(() => ({
        headerTitle: t('externalSessions.browseTitle'),
        headerShown: true,
        headerBackTitle: t('common.cancel'),
        presentation: 'modal',
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        headerBackVisible: false,
        headerLeft: () => null,
    }), [preferredLanguage]);

    // Avoid rendering protected screens for a frame during redirect.
    if (shouldRedirect) {
        return <Redirect href="/" />;
    }

    if (isApplyingWebServerOverride) {
        return null;
    }

    return (
        <SessionCockpitChromeRegistryProvider>
            {!isDesktopOverlayWindow && !isTerminalConnectRoute ? (
                <AuthenticatedAppRuntimeMounts
                    isAuthenticated={isAuthenticated}
                    isTauriDesktopHost={isTauriDesktopHost}
                />
            ) : null}
            {debugRouterEnabled && Platform.OS === 'web' ? (
                <View
                    testID="debug-router-pathname"
                    style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
                >
                    <Text>{pathname}</Text>
                </View>
            ) : null}
            <Stack screenOptions={rootStackScreenOptions}>
                <Stack.Screen
                    name="index"
                    options={rootStackRouteOptions.index}
                />
                <Stack.Screen
                    name="inbox/index"
                    options={rootStackRouteOptions.inboxIndex}
                />
                <Stack.Screen
                    name="friends/index"
                    options={rootStackRouteOptions.friendsIndex}
                />
                <Stack.Screen
                    name="oauth/[provider]"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="settings"
                    options={rootStackRouteOptions.settings}
                />
                <Stack.Screen
                    name="desktop/activity-overlay"
                    options={rootStackRouteOptions.desktopActivityOverlay}
                />
                <Stack.Screen
                    name="automations/index"
                    options={rootStackRouteOptions.automationsIndex}
                />
                <Stack.Screen
                    name="automations/[id]"
                    options={rootStackRouteOptions.automationsId}
                />
                <Stack.Screen
                    name="automations/new"
                    options={rootStackRouteOptions.automationsNew}
                />
                <Stack.Screen
                    name="session/[id]/info"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/[id]/runs"
                    options={rootStackRouteOptions.sessionRuns}
                />
                <Stack.Screen
                    name="session/[id]/runs/new"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/[id]/runs/[runId]"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/[id]/files"
                    options={rootStackRouteOptions.files}
                />
                <Stack.Screen
                    name="session/[id]/git"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="session/[id]/details"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="session/[id]/terminal"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/terminal"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/files"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/git"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="projects/[workspaceRefId]/details"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="session/[id]/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="session/[id]/message/[messageId]"
                    options={rootStackRouteOptions.visibleBlankBack}
                />
                <Stack.Screen
                    name="session/recent"
                    options={rootStackRouteOptions.sessionRecent}
                />
                <Stack.Screen
                    name="session/archived"
                    options={rootStackRouteOptions.sessionArchived}
                />
                <Stack.Screen
                    name="terminal/connect"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="terminal/index"
                    options={rootStackRouteOptions.terminalIndex}
                />
                <Stack.Screen
                    name="scan/terminal"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="scan/account"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/index"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/show-qr"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/manual"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="restore/lost-access"
                    options={rootStackRouteOptions.hiddenHeader}
                />
                <Stack.Screen
                    name="changelog"
                    options={rootStackRouteOptions.changelog}
                />
                <Stack.Screen
                    name="artifacts/index"
                    options={rootStackRouteOptions.artifactsIndex}
                />
                <Stack.Screen
                    name="artifacts/[id]"
                    options={rootStackRouteOptions.artifactsId}
                />
                <Stack.Screen
                    name="artifacts/new"
                    options={rootStackRouteOptions.artifactsNew}
                />
                <Stack.Screen
                    name="artifacts/edit/[id]"
                    options={rootStackRouteOptions.artifactsEdit}
                />
                <Stack.Screen
                    name="friends/manage"
                    options={friendsManageScreenOptions}
                />
                <Stack.Screen
                    name="friends/search"
                    options={rootStackRouteOptions.friendsSearch}
                />
                <Stack.Screen
                    name="user/[id]"
                    options={rootStackRouteOptions.userId}
                />
                <Stack.Screen
                    name="dev/index"
                    options={rootStackRouteOptions.devIndex}
                />
                <Stack.Screen
                    name="dev/list-demo"
                    options={rootStackRouteOptions.devListDemo}
                />
                <Stack.Screen
                    name="dev/typography"
                    options={rootStackRouteOptions.devTypography}
                />
                <Stack.Screen
                    name="dev/colors"
                    options={rootStackRouteOptions.devColors}
                />
                <Stack.Screen
                    name="dev/tools2"
                    options={rootStackRouteOptions.devTools2}
                />
                <Stack.Screen
                    name="dev/shimmer-demo"
                    options={rootStackRouteOptions.devShimmerDemo}
                />
                <Stack.Screen
                    name="dev/multi-text-input"
                    options={rootStackRouteOptions.devMultiTextInput}
                />
                <Stack.Screen
                    name="new/pick/machine"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/path"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/profile"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/server"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/profile-edit"
                    options={rootStackRouteOptions.blankBack}
                />
                <Stack.Screen
                    name="new/pick/secret-requirement"
                    options={rootStackRouteOptions.newPickSecretRequirement}
                />
                <Stack.Screen
                    name="new/index"
                    options={({ navigation }) => ({
                        ...newSessionScreenOptions,
                        headerRight: Platform.OS === 'web'
                            ? undefined
                            : () => <AppHeaderCloseButton testID="new-session-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                    })}
                />
                <Stack.Screen
                    name="direct/browse"
                    options={({ navigation }) => ({
                        ...externalSessionBrowseScreenOptions,
                        headerRight: () => <AppHeaderCloseButton testID="direct-session-browse-cancel" onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/' })} />,
                    })}
                />
                <Stack.Screen
                    name="zen/index"
                    options={rootStackRouteOptions.zenIndex}
                />
                <Stack.Screen
                    name="zen/new"
                    options={rootStackRouteOptions.zenNew}
                />
                <Stack.Screen
                    name="zen/view"
                    options={rootStackRouteOptions.zenView}
                />
            </Stack>
            <MobileBottomChromeHost />
        </SessionCockpitChromeRegistryProvider>
    );
}
