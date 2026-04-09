import { Stack, router, usePathname, useSegments } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { bootstrapActiveServerFromWebLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { buildTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { shouldHoldAuthenticatedShellForWebServerOverride } from '@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride';
import { consumeLegacySessionDeepLinkFromWebLocation } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { resolveAuthenticatedWebServerUrlOverrideAction } from '@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction';
import {
    createFriendsStackScreenOptions,
    createInboxStackScreenOptions,
} from '@/utils/navigation/createSocialStackScreenOptions';
import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { ActivitySurfacesRuntime } from '@/activity/adapters/ios/runtime/ActivitySurfacesRuntime';
import { ActivityLocalNotificationRuntime } from '@/activity/notifications/runtime/ActivityLocalNotificationRuntime';
import { DesktopActivityOverlayRuntime } from '@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { DesktopTrayRuntime } from '@/desktop/tray/DesktopTrayRuntime';
import { DesktopTrayDaemonLifecycleRuntime } from '@/desktop/tray/DesktopTrayDaemonLifecycleRuntime';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { isTauriDesktop } from '@/utils/platform/tauri';

const bootstrappedWebServerOverride = bootstrapActiveServerFromWebLocation({ scope: 'device' });

export default function RootLayout() {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const refreshAuth = auth.refreshFromActiveServer;
    const segments = useSegments();
    const pathname = usePathname();
    const { theme } = useUnistyles();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const happierVoiceSupported = useHappierVoiceSupport();
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const isTauriDesktopHost = isTauriDesktop();
    const isTerminalConnectRoute = pathname === '/terminal/connect';

    useWebInitialRouteReconcile({ routerPathname: pathname });

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
            try {
                window.history.replaceState(null, '', overrideAction.cleanedRelativeUrl);
            } catch {
                // ignore
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

        try {
            window.history.replaceState(null, '', overrideAction.cleanedRelativeUrl);
        } catch {
            // ignore
        }
    }, [isAuthenticated, refreshAuth]);

    const legacySessionDeepLinkHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (legacySessionDeepLinkHandledRef.current) return;
        const didConsume = consumeLegacySessionDeepLinkFromWebLocation({
            isAuthenticated,
            replaceRelativeUrl: (nextRelativeUrl) => {
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

    const shouldRedirect = !isAuthenticated && !isPublicRouteForUnauthenticated(segments);
    const pendingTerminalHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (!shouldRedirect) return;
        router.replace('/');
    }, [shouldRedirect]);

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
            if (target && target !== active) {
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
                    router.push(route);
                })(), { tag: 'RootLayout.pendingTerminalConnect' });
                return;
            }

            pendingTerminalHandledRef.current = true;
            router.push(route);
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

    // Avoid rendering protected screens for a frame during redirect.
    if (shouldRedirect || isApplyingWebServerOverride) {
        return null;
    }

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';

    return (
        <>
            {!isDesktopOverlayWindow && !isTerminalConnectRoute ? (
                <>
                    <ActivityBadgeRuntime />
                    <ActivitySurfacesRuntime />
                    <ActivityLocalNotificationRuntime />
                    {isTauriDesktopHost ? (
                        <>
                            <DesktopTrayRuntime />
                            <DesktopTrayDaemonLifecycleRuntime />
                            <DesktopActivityOverlayRuntime />
                        </>
                    ) : null}
                </>
            ) : null}
            {debugRouterEnabled && Platform.OS === 'web' ? (
                <View
                    testID="debug-router-pathname"
                    style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
                >
                    <Text>{pathname}</Text>
                </View>
            ) : null}
            <Stack
                screenOptions={{
                    header: shouldUseCustomHeader ? createHeader : undefined,
                    headerBackTitle: t('common.back'),
                    headerShadowVisible: false,
                    contentStyle: {
                        backgroundColor: theme.colors.surface,
                    },
                    headerStyle: {
                        backgroundColor: theme.colors.header.background,
                    },
                    headerTintColor: theme.colors.header.tint,
                    headerTitleStyle: {
                        color: theme.colors.header.tint,
                        ...Typography.default('semiBold'),
                    },

                }}
            >
            <Stack.Screen
                name="index"
                options={{
                    headerShown: false,
                    headerTitle: ''
                }}
            />
            <Stack.Screen
                name="inbox/index"
                options={createInboxStackScreenOptions(t)}
            />
            <Stack.Screen
                name="friends/index"
                options={createFriendsStackScreenOptions(t)}
            />
            <Stack.Screen
                name="oauth/[provider]"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="settings"
                options={{
                    // Nested navigator; per-settings-screen headers are configured in `settings/_layout.tsx`.
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="desktop/activity-overlay"
                options={{
                    headerShown: false,
                    contentStyle: {
                        backgroundColor: 'transparent',
                    },
                }}
            />
            <Stack.Screen
                name="automations/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.automations'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="automations/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.automation'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="automations/new"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.newAutomation'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/info"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs"
                options={{
                    headerShown: true,
                    headerTitle: t('runs.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs/new"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/runs/[runId]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/files"
                options={{
                    // The Files/SCM mobile route renders the exact same surface as the desktop right panel,
                    // including its own header (tabs + close button). Avoid double headers.
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="session/[id]/details"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="session/[id]/terminal"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="session/[id]/index"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="terminal/index"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="scan/terminal"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="scan/account"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="restore/show-qr"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="restore/manual"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="restore/lost-access"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.whatsNew'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/index"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="artifacts/[id]"
                options={{
                    headerShown: false, // We'll set header dynamically
                }}
            />
            <Stack.Screen
                name="artifacts/new"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.new'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="artifacts/edit/[id]"
                options={{
                    headerShown: true,
                    headerTitle: t('artifacts.edit'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="friends/manage"
                options={({ navigation }) => ({
                    headerShown: true,
                    headerTitle: t('navigation.friends'),
                    headerBackTitle: t('common.back'),
                    headerRight: () =>
                        (
                            <TouchableOpacity
                                onPress={() => navigation.navigate('friends/search' as never)}
                                style={{ paddingHorizontal: 16, opacity: friendsIdentityReady ? 1 : 0.5 }}
                                disabled={!friendsIdentityReady}
                                accessibilityState={{ disabled: !friendsIdentityReady }}
                            >
                                <Text style={{ color: theme.colors.button.primary.tint, fontSize: 16 }}>
                                    {t('friends.addFriend')}
                                </Text>
                            </TouchableOpacity>
                        ),
                })}
            />
            <Stack.Screen
                name="friends/search"
                options={{
                    headerShown: true,
                    headerTitle: t('friends.addFriend'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="user/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="dev/index"
                options={{
                    headerTitle: t('navigation.developerTools'),
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: t('navigation.listComponentsDemo'),
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: t('navigation.typography'),
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: t('navigation.colors'),
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: t('navigation.toolViewsDemo'),
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: t('navigation.shimmerViewDemo'),
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: t('navigation.multiTextInput'),
                }}
            />
            <Stack.Screen
                name="new/pick/machine"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/path"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/server"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/profile-edit"
                options={{
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="new/pick/secret-requirement"
                options={{
                    headerShown: false,
                    // /new is presented modally on iOS. Ensure this overlay screen is too,
                    // otherwise it can end up pushed "behind" the modal (invisible but on the back stack).
                    presentation: Platform.OS === 'ios' ? 'containedModal' : 'modal',
                }}
            />
            <Stack.Screen
                name="new/index"
                options={{
                    headerTitle: t('newSession.title'),
                    headerShown: true,
                    headerBackTitle: t('common.cancel'),
                    presentation: 'modal',
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                    // Swipe-to-dismiss is not consistently available across platforms; always provide a close button.
                    headerBackVisible: false,
                    headerLeft: () => null,
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => router.back()}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            style={{ paddingHorizontal: 12, paddingVertical: 6 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                        >
                            <Ionicons name="close" size={22} color={theme.colors.header.tint} />
                        </TouchableOpacity>
                    ),
                }}
            />
            <Stack.Screen
                name="direct/browse"
                options={{
                    headerTitle: t('directSessions.browseTitle'),
                    headerShown: true,
                    headerBackTitle: t('common.cancel'),
                    presentation: 'modal',
                    gestureEnabled: true,
                    fullScreenGestureEnabled: true,
                    headerBackVisible: false,
                    headerLeft: () => null,
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() => router.back()}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            style={{ paddingHorizontal: 12, paddingVertical: 6 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.cancel')}
                        >
                            <Ionicons name="close" size={22} color={theme.colors.header.tint} />
                        </TouchableOpacity>
                    ),
                }}
            />
            <Stack.Screen
                name="zen/index"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="zen/new"
                options={{
                    presentation: 'modal',
                    headerTitle: t('navigation.zenNewTask'),
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="zen/view"
                options={{
                    presentation: 'modal',
                    headerTitle: t('navigation.zenTaskDetails'),
                    headerBackTitle: t('common.back'),
                }}
            />
            </Stack>
        </>
    );
}
