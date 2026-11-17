import { installDesktopDeepLinks } from '@/desktop/deepLinks/installDesktopDeepLinks';
import { router } from 'expo-router';
import { useCurrentRouteParamsSelector, useCurrentRoutePathname, useCurrentRouteSegments } from '@/components/appShell/workspace/currentRouteLocation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { focusTerminalConnectTarget, terminalConnectResumeHref } from '@/auth/terminal/terminalConnectContinuation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { useWebInitialRouteReconcile } from '@/hooks/ui/useWebInitialRouteReconcile';
import { consumeLegacySessionDeepLinkFromWebLocation } from '@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { useNotificationResponseRouting } from '@/activity/notifications/runtime/useNotificationResponseRouting';
import { desktopHostKind, invokeDesktopHost, isDesktopHost } from '@/utils/platform/desktopHost';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol/crypto/publicShareCapabilityUrl';
import { usePluginPageExplicitNavigation } from '@/components/plugins/pages/pluginPageNavigation';
import { matchWorkspaceDestinationRoute, workspacePluginAppPageRouteKey } from '@/components/appShell/workspace/workspaceRoutes';
import { getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';

/**
 * Owns every navigation/auth-driven side effect from the app root layout.
 *
 * It subscribes to `usePathname()` / `useCurrentRouteSegments()` and re-renders on each navigation, but it
 * renders nothing (or only the web-only, invisible debug pathname readout), so its re-renders are
 * cheap and never touch the Stack subtree. Mounted as a sibling of the shell so the shell subscribes
 * to nothing that changes per navigation.
 */
export function RootLayoutNavigationEffects(): React.ReactElement | null {
    const context = resolveDesktopWindowContext();
    if (context.role === 'presenter') return null;
    return <>
        {context.role === 'primary' ? <PrimaryRootLayoutNavigationEffects /> : null}
        <LocalRootLayoutNavigationEffects />
    </>;
}

function PrimaryRootLayoutNavigationEffects(): React.ReactElement | null {
    const navigateExplicit = usePluginPageExplicitNavigation();
    React.useEffect(() => {
        if (Platform.OS === 'web' && desktopHostKind() === 'tauri') {
            return installDesktopDeepLinks(navigateExplicit);
        }
    }, [navigateExplicit]);
    const auth = useAuth();
    const isDesktopShell = isDesktopHost();

    React.useEffect(() => {
        if (!isDesktopShell) return;
        void invokeDesktopHost('desktop_set_window_mode', { mode: 'main' });
    }, [isDesktopShell]);

    useNotificationResponseRouting({
        enabled: auth.isAuthenticated,
        refreshAuth: auth.refreshFromActiveServer,
    });
    return null;
}

const selectRouteServerId = (params: Readonly<Record<string, string | string[] | undefined>>) => params.serverId;

function LocalRootLayoutNavigationEffects(): React.ReactElement | null {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const refreshAuth = auth.refreshFromActiveServer;
    const segments: readonly string[] = useCurrentRouteSegments();
    const pathname = useCurrentRoutePathname();
    const routerServerId = useCurrentRouteParamsSelector(selectRouteServerId);
    const debugRouterEnabled = process.env.EXPO_PUBLIC_DEBUG === '1';
    const activeServerAccountScope = useActiveServerAccountScope();
    const route = matchWorkspaceDestinationRoute(pathname);
    const inStore = route !== null && (route.routeKey === 'plugins' || route.routeKey.startsWith('plugins/'))
        && workspacePluginAppPageRouteKey(route.routeKey) === null;
    const wasInStore = React.useRef(inStore);
    React.useEffect(() => {
        if (wasInStore.current && !inStore) getThemeTryOnOwner().leaveStore();
        wasInStore.current = inStore;
    }, [inStore]);

    useWebInitialRouteReconcile({ routerPathname: pathname, routerServerId });

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
            // The route reads existing scoped custody; never put the pairing secret back in a URL.
            if (segments.includes('terminal')) return;
            pendingTerminalHandledRef.current = true;
            fireAndForget((async () => {
                try {
                    const focused = await focusTerminalConnectTarget({
                        request: pendingTerminalConnect, serverUrl: pendingTerminalConnect.serverUrl, refreshAuth,
                    });
                    if (focused) router.replace(terminalConnectResumeHref());
                } catch (error) {
                    Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
                }
            })(), { tag: 'RootLayout.pendingTerminalConnect' });
            return;
        }

        pendingTerminalHandledRef.current = false;
    }, [activeServerAccountScope, isAuthenticated, refreshAuth, segments]);

    if (debugRouterEnabled && Platform.OS === 'web') {
        return (
            <View
                testID="debug-router-pathname"
                // A QA probe, not content: never announced, and never carrying a capability link's bearer.
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
            >
                <Text>{redactPublicShareCapabilityUrl(pathname)}</Text>
            </View>
        );
    }
    return null;
}
