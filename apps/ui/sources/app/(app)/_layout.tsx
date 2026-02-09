import { Stack, router, useSegments } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import * as Notifications from 'expo-notifications';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { isRunningOnMac } from '@/utils/platform';
import { coerceRelativeRoute } from '@/utils/routeUtils';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useAuth } from '@/auth/AuthContext';
import { isPublicRouteForUnauthenticated } from '@/auth/authRouting';
import { useFriendsIdentityReadiness } from '@/hooks/useFriendsIdentityReadiness';
import { VOICE_PROVIDER_IDS } from '@/voice/voiceProviders';
import { getActiveServerUrl } from '@/sync/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/activeServerSwitch';
import { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } from '@/sync/pendingNotificationNav';
import { getPendingTerminalConnect } from '@/sync/pendingTerminalConnect';

export const unstable_settings = {
    initialRouteName: 'index',
};

function extractServerUrlFromNotificationData(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const rec = data as Record<string, unknown>;
    const serverUrl = typeof rec.serverUrl === 'string' ? rec.serverUrl : typeof rec.server === 'string' ? rec.server : '';
    const normalized = normalizeServerUrl(serverUrl);
    return normalized ? normalized : null;
}

function readServerUrlOverrideFromWebLocation(): Readonly<{ serverUrl: string; cleanedRelativeUrl: string }> | null {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        const rawServer = (current.searchParams.get('server') ?? '').trim();
        const rawLegacyUrl = (current.searchParams.get('url') ?? '').trim();
        const rawLegacyAuto = (current.searchParams.get('auto') ?? '').trim().toLowerCase();
        const legacyAutoEnabled = rawLegacyAuto === '1' || rawLegacyAuto === 'true' || rawLegacyAuto === 'yes' || rawLegacyAuto === 'on';

        const serverUrl = normalizeServerUrl(rawServer) || (legacyAutoEnabled ? normalizeServerUrl(rawLegacyUrl) : null);
        if (!serverUrl) return null;

        current.searchParams.delete('server');
        current.searchParams.delete('url');
        current.searchParams.delete('auto');
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return { serverUrl, cleanedRelativeUrl };
    } catch {
        return null;
    }
}

export default function RootLayout() {
    const auth = useAuth();
    const segments = useSegments();
    const { theme } = useUnistyles();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;

    const webServerOverrideHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (webServerOverrideHandledRef.current) return;
        const override = readServerUrlOverrideFromWebLocation();
        if (!override) return;
        webServerOverrideHandledRef.current = true;

        const desired = normalizeServerUrl(override.serverUrl);
        if (!desired) return;

        const current = normalizeServerUrl(getActiveServerUrl());
        if (desired === current) {
            try {
                window.history.replaceState(null, '', override.cleanedRelativeUrl);
            } catch {
                // ignore
            }
            return;
        }

        void (async () => {
            try {
                await upsertActivateAndSwitchServer({
                    serverUrl: desired,
                    source: 'url',
                    scope: 'device',
                    refreshAuth: auth.refreshFromActiveServer,
                });
            } catch {
                // keep URL normalization best-effort; server switch can still be repaired elsewhere
            }
        })();

        try {
            window.history.replaceState(null, '', override.cleanedRelativeUrl);
        } catch {
            // ignore
        }
    }, [auth]);

    const shouldRedirect = !auth.isAuthenticated && !isPublicRouteForUnauthenticated(segments);
    const pendingTerminalHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (!shouldRedirect) return;
        router.replace('/');
    }, [shouldRedirect]);

    React.useEffect(() => {
        if (!auth.isAuthenticated) {
            pendingTerminalHandledRef.current = false;
            return;
        }

        const pendingTerminalConnect = getPendingTerminalConnect();
        if (pendingTerminalConnect) {
            if (pendingTerminalHandledRef.current) return;
            const route = `/terminal/index?key=${encodeURIComponent(pendingTerminalConnect.publicKeyB64Url)}&server=${encodeURIComponent(pendingTerminalConnect.serverUrl)}`;

            const active = normalizeServerUrl(getActiveServerUrl());
            const target = normalizeServerUrl(pendingTerminalConnect.serverUrl);
            if (target && target !== active) {
                pendingTerminalHandledRef.current = true;
                void (async () => {
                    try {
                        await upsertActivateAndSwitchServer({
                            serverUrl: pendingTerminalConnect.serverUrl,
                            source: 'url',
                            scope: 'device',
                            refreshAuth: auth.refreshFromActiveServer,
                        });
                    } catch {
                        // keep navigation best-effort; terminal flow can still recover with explicit server param
                    }
                    router.push(route);
                })();
                return;
            }

            pendingTerminalHandledRef.current = true;
            router.push(route);
            return;
        }

        pendingTerminalHandledRef.current = false;
        if (Platform.OS === 'web') return;

        const pending = getPendingNotificationNav();
        if (pending) {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pending.serverUrl) === active) {
                clearPendingNotificationNav();
                router.push(pending.route);
                return;
            }
        }

        const toRoute = (data: unknown): string | null => {
            if (!data || typeof data !== 'object') return null;
            const rec = data as Record<string, unknown>;
            if (typeof rec.url === 'string' && rec.url.trim()) {
                return coerceRelativeRoute(rec.url);
            }
            if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) {
                return `/session/${encodeURIComponent(rec.sessionId)}`;
            }
            return null;
        };

        const maybeRedirectFromResponse = (response: any) => {
            if (!response || typeof response !== 'object') return;
            if (response.actionIdentifier && response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
                return;
            }
            const notification = response.notification;
            const data = notification?.request?.content?.data;
            const route = toRoute(data);
            if (route) {
                const serverUrl = extractServerUrlFromNotificationData(data);
                if (serverUrl) {
                    const active = normalizeServerUrl(getActiveServerUrl());
                    if (serverUrl !== active) {
                        setPendingNotificationNav({ serverUrl, route });
                        void (async () => {
                            try {
                                await upsertActivateAndSwitchServer({
                                    serverUrl,
                                    source: 'notification',
                                    scope: 'device',
                                    refreshAuth: auth.refreshFromActiveServer,
                                });
                                clearPendingNotificationNav();
                                router.push(route);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })();
                        return;
                    }
                }
                router.push(route);
            }
        };

        void Notifications.getLastNotificationResponseAsync()
            .then(maybeRedirectFromResponse)
            .catch(() => {});

        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            maybeRedirectFromResponse(response);
        });

        return () => {
            subscription.remove();
        };
    }, [auth.isAuthenticated]);

    // Server capability gating: if the server doesn't support Happier Voice (misconfigured/disabled),
    // default the user's voice mode to off (they can still choose BYO ElevenLabs in settings).
    React.useEffect(() => {
        if (!auth.isAuthenticated) return;
        let cancelled = false;
        void (async () => {
            try {
                // Defer loading sync/storage modules until needed to keep module evaluation light
                // (important for test environments and faster route transitions).
                const [{ getServerFeatures }, { storage }, { sync }] = await Promise.all([
                    import('@/sync/apiFeatures'),
                    import('@/sync/storage'),
                    import('@/sync/sync'),
                ]);

                const features = await getServerFeatures();
                if (cancelled) return;
                if (!features) return;
                if (features.features.voice.enabled !== false) return;
                const currentProviderId =
                    storage.getState().settings.voiceProviderId ?? VOICE_PROVIDER_IDS.HAPPIER_ELEVENLABS_AGENTS;
                if (currentProviderId !== VOICE_PROVIDER_IDS.HAPPIER_ELEVENLABS_AGENTS) return;
                sync.applySettings({ voiceProviderId: VOICE_PROVIDER_IDS.OFF });
            } catch {
                // Non-fatal: feature gating should never crash the root layout.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [auth.isAuthenticated]);

    // Avoid rendering protected screens for a frame during redirect.
    if (shouldRedirect) {
        return null;
    }

    // Use custom header on Android and Mac Catalyst, native header on iOS (non-Catalyst)
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';

    return (
        <Stack
            initialRouteName='index'
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
                options={{
                    headerShown: false,
                    headerTitle: t('tabs.inbox'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="friends/index"
                options={{
                    headerShown: false,
                    headerTitle: t('tabs.inbox'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="oauth/[provider]"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="settings/index"
                options={{
                    headerShown: true,
                    headerTitle: t('settings.title'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="session/[id]/message/[messageId]"
                options={{
                    headerShown: true,
                    headerBackTitle: t('common.back'),
                    headerTitle: t('common.message')
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
                name="session/[id]/files"
                options={{
                    headerShown: true,
                    headerTitle: t('common.files'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/file"
                options={{
                    headerShown: true,
                    headerTitle: t('common.fileViewer'),
                    headerBackTitle: t('common.files'),
                }}
            />
            <Stack.Screen
                name="session/[id]/sharing"
                options={{
                    headerShown: true,
                    headerTitle: t('session.sharing.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/account"
                options={{
                    headerTitle: t('settings.account'),
                }}
            />
            <Stack.Screen
                name="settings/appearance"
                options={{
                    headerTitle: t('settings.appearance'),
                }}
            />
            <Stack.Screen
                name="settings/features"
                options={{
                    headerTitle: t('settings.features'),
                }}
            />
            <Stack.Screen
                name="settings/profiles"
                options={{
                    headerTitle: t('settingsFeatures.profiles'),
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="terminal/index"
                options={{
                    headerTitle: t('navigation.connectTerminal'),
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.linkNewDevice'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="restore/manual"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.restoreWithSecretKey'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="restore/lost-access"
                options={{
                    headerShown: true,
                    headerTitle: t('connect.lostAccessTitle'),
                    headerBackTitle: t('common.back'),
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
                name="text-selection"
                options={{
                    headerShown: true,
                    headerTitle: t('textSelection.title'),
                    headerBackTitle: t('common.back'),
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
                    headerTitle: 'Developer Tools',
                }}
            />

            <Stack.Screen
                name="dev/list-demo"
                options={{
                    headerTitle: 'List Components Demo',
                }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{
                    headerTitle: 'Typography',
                }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{
                    headerTitle: 'Colors',
                }}
            />
            <Stack.Screen
                name="dev/tools2"
                options={{
                    headerTitle: 'Tool Views Demo',
                }}
            />
            <Stack.Screen
                name="dev/masked-progress"
                options={{
                    headerTitle: 'Masked Progress',
                }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{
                    headerTitle: 'Shimmer View Demo',
                }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{
                    headerTitle: 'Multi Text Input',
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
                name="settings/connect/claude"
                options={{
                    headerShown: true,
                    headerTitle: 'Connect to Claude',
                    headerBackTitle: t('common.back'),
                    // headerStyle: {
                    //     backgroundColor: Platform.OS === 'web' ? theme.colors.header.background : '#1F1E1C',
                    // },
                    // headerTintColor: Platform.OS === 'web' ? theme.colors.header.tint : '#FFFFFF',
                    // headerTitleStyle: {
                    //     color: Platform.OS === 'web' ? theme.colors.header.tint : '#FFFFFF',
                    // },
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
                name="zen/index"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="zen/new"
                options={{
                    presentation: 'modal',
                    headerTitle: 'New Task',
                    headerBackTitle: t('common.cancel'),
                }}
            />
            <Stack.Screen
                name="zen/view"
                options={{
                    presentation: 'modal',
                    headerTitle: 'Task Details',
                    headerBackTitle: t('common.back'),
                }}
            />
        </Stack>
    );
}
