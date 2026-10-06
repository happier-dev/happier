import { installDesktopDeepLinks } from '@/desktop/deepLinks/installDesktopDeepLinks';
import { router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerUrl, resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { clearPendingTerminalConnect, getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { buildTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { consumeLegacySessionDeepLinkFromWebLocation } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { shouldSwitchToServerUrl } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { desktopHostKind, invokeDesktopHost, isDesktopHost } from '@/utils/platform/desktopHost';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

/**
 * Owns every navigation/auth-driven side effect from the app root layout.
 *
 * It subscribes to `usePathname()` / `useSegments()` and re-renders on each navigation, but it
 * renders nothing (or only the web-only, invisible debug pathname readout), so its re-renders are
 * cheap and never touch the Stack subtree. Mounted as a sibling of the shell so the shell subscribes
 * to nothing that changes per navigation.
 */
export function RootLayoutNavigationEffects(): React.ReactElement | null {
    React.useEffect(() => {
        if (Platform.OS === 'web' && desktopHostKind() === 'tauri') {
            return installDesktopDeepLinks((href) => router.push(href));
        }
    }, []);
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const refreshAuth = auth.refreshFromActiveServer;
    const segments = useSegments();
    const pathname = usePathname();
    const { serverId: routerServerId } = useGlobalSearchParams<{ serverId?: string | string[] }>();
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const isDesktopOverlayWindow = isDesktopActivityOverlayWindowContext();
    const isDesktopShell = isDesktopHost();
    const activeServerAccountScope = useActiveServerAccountScope();

    useWebInitialRouteReconcile({ routerPathname: pathname, routerServerId });

    React.useEffect(() => {
        if (!isDesktopShell) return;
        void invokeDesktopHost('desktop_set_window_mode', { mode: 'main' });
    }, [isDesktopShell]);

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
        if (!activeServerAccountScope) {
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
                serverIdentityId: pendingTerminalConnect.serverIdentityId,
                ...(pendingTerminalConnect.pairing ? { pairing: pendingTerminalConnect.pairing } : {}),
                ...(pendingTerminalConnect.supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                ...(pendingTerminalConnect.homeConnectionDescriptor
                    ? { homeConnectionDescriptor: pendingTerminalConnect.homeConnectionDescriptor }
                    : {}),
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
                        let profile = resolveUniqueServerProfileByUrl(pendingTerminalConnect.serverUrl);
                        if (!profile) {
                            const connected = await connectHomeAtAddress({
                                serverUrl: pendingTerminalConnect.serverUrl,
                                source: 'url',
                                confirmInsecureHttp: confirmInsecureHomeHttp,
                                confirmCanonicalUrl: confirmCanonicalHomeUrl,
                            });
                            if (connected.kind === 'declined') {
                                clearPendingTerminalConnect();
                                return;
                            }
                            if (connected.kind !== 'connected') {
                                Modal.alert(t('common.error'), homeConnectFailureMessage(connected) ?? t('common.error'));
                                return;
                            }
                            profile = connected.profile;
                        }
                        const switched = await setActiveServerAndSwitch({
                            serverId: profile.id,
                            scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                            refreshAuth,
                        });
                        if (switched === 'blocked') return;
                        router.replace(route);
                    } catch (error) {
                        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
                    }
                })(), { tag: 'RootLayout.pendingTerminalConnect' });
                return;
            }

            pendingTerminalHandledRef.current = true;
            router.replace(route);
            return;
        }

        pendingTerminalHandledRef.current = false;
    }, [activeServerAccountScope, isAuthenticated, refreshAuth, segments]);

    if (debugRouterEnabled && Platform.OS === 'web') {
        return (
            <View
                testID="debug-router-pathname"
                style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
            >
                <Text>{pathname}</Text>
            </View>
        );
    }
    return null;
}
