import { router, usePathname, useSegments } from 'expo-router';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { buildTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { consumeLegacySessionDeepLinkFromWebLocation } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { shouldSwitchToServerUrl } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

/**
 * Owns every navigation/auth-driven side effect from the app root layout.
 *
 * It subscribes to `usePathname()` / `useSegments()` and re-renders on each navigation, but it
 * renders nothing (or only the web-only, invisible debug pathname readout), so its re-renders are
 * cheap and never touch the Stack subtree. Mounted as a sibling of the shell so the shell subscribes
 * to nothing that changes per navigation.
 */
export function RootLayoutNavigationEffects(): React.ReactElement | null {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const refreshAuth = auth.refreshFromActiveServer;
    const segments = useSegments();
    const pathname = usePathname();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const isTauriDesktopHost = isTauriDesktop();

    useWebInitialRouteReconcile({ routerPathname: pathname });

    React.useEffect(() => {
        if (!isTauriDesktopHost) return;
        void invokeTauri('desktop_set_window_mode', { mode: 'main' });
    }, [isTauriDesktopHost]);

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

    useNotificationResponseRouting({
        enabled: isAuthenticated && !isDesktopOverlayWindow,
        refreshAuth,
    });

    const pendingTerminalHandledRef = React.useRef(false);
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

    if (debugRouterEnabled && Platform.OS === 'web') {
        return (
            <View
                testID="debug-router-pathname"
                style={{ position: 'absolute', top: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
            >
                <Text>{pathname}</Text>
            </View>
        );
    }
    return null;
}
