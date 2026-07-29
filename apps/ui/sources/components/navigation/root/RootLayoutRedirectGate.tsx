import { Redirect, router, useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import * as React from 'react';
import { Platform } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import {
    isSessionRouteInAuthRecoverySubtree,
    resolveSessionRouteAuthRecoveryState,
    shouldNormalizeSessionRouteToAuthRecoveryBase,
} from '@/hooks/session/sessionRouteAuthRecovery';
import { useEndpointConnectivity, useSyncError } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { shouldHoldAuthenticatedShellForWebServerOverride } from '@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride';
import { resolveAuthenticatedWebServerUrlOverrideAction } from '@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction';
import {
    bootstrapActiveServerFromWebLocation,
    commitWebServerUrlOverride,
} from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    doesOnboardingJourneyOwnTransientDemoServer,
    useOnboardingJourneySessionActive,
} from '@/components/onboarding/tour/state/journeySession';

const bootstrappedWebServerOverride = bootstrapActiveServerFromWebLocation({ scope: 'device' });

/**
 * Single navigation-subscribing render owner for the app root layout.
 *
 * It subscribes to `useSegments()` / `usePathname()` / `useGlobalSearchParams()` (which change per
 * navigation) plus the connectivity/server signals that drive the unauthenticated redirect and the
 * session-route auth-recovery hold, and it owns the web-server-override "applying" hold. It is the
 * ONLY navigation-subscribing owner in the root-layout render path: when no redirect/hold applies it
 * returns its `children` unchanged. Because the parent (`RootLayout`) never re-renders on navigation,
 * the child element reference is stable and React skips re-rendering the entire Stack subtree — this
 * is what stops every navigation from re-rendering all mounted SceneViews.
 */
export function RootLayoutRedirectGate({ children }: { children: React.ReactNode }): React.ReactElement | null {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const refreshAuth = auth.refreshFromActiveServer;
    const segments = useSegments();
    const pathname = usePathname();
    const globalSearchParams = useGlobalSearchParams();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const activeServerSnapshot = useActiveServerSnapshot();
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    const onboardingJourneyOwnsTransientDemoServer =
        doesOnboardingJourneyOwnTransientDemoServer(onboardingJourneyActive);

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

    const [isApplyingWebServerOverride, setIsApplyingWebServerOverride] = React.useState(() =>
        !onboardingJourneyOwnsTransientDemoServer
        && shouldHoldAuthenticatedShellForWebServerOverride(isAuthenticated),
    );
    const webServerOverrideHandledRef = React.useRef(false);
    React.useEffect(() => {
        if (!isAuthenticated) {
            setIsApplyingWebServerOverride(false);
            return;
        }
        if (onboardingJourneyOwnsTransientDemoServer) {
            // The journey's seeded relay is presentation-only. Keep both the override
            // action and the root hold pending until that temporary ownership ends.
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
        // Same-server refresh/URL cleanup must not unmount a still-live journey after
        // its demo act tears down. Only a real cross-server switch owns a root hold.
        setIsApplyingWebServerOverride(overrideAction.kind === 'switch_server');
        fireAndForget((async () => {
            while (true) {
                try {
                    await commitWebServerUrlOverride({
                        action: overrideAction,
                        switchServer: async ({ serverUrl, refreshAuth: refreshAfterSwitch }) => {
                            await upsertActivateAndSwitchServer({
                                serverUrl,
                                source: 'url',
                                scope: 'device',
                                refreshAuth: refreshAfterSwitch,
                            });
                        },
                        refreshAuth,
                        replaceRelativeUrl: (nextRelativeUrl) => {
                            if (Platform.OS !== 'web' || typeof window === 'undefined') return;
                            window.history.replaceState(null, '', nextRelativeUrl);
                        },
                    });
                    webServerOverrideHandledRef.current = true;
                    setIsApplyingWebServerOverride(false);
                    return;
                } catch (error) {
                    const shouldRetry = await Modal.confirm(
                        t('common.error'),
                        error instanceof Error ? error.message : t('common.error'),
                        {
                            cancelText: t('common.cancel'),
                            confirmText: t('common.retry'),
                        },
                    );
                    if (shouldRetry) continue;
                    webServerOverrideHandledRef.current = true;
                    setIsApplyingWebServerOverride(false);
                    return;
                }
            }
        })(), { tag: 'RootLayout.webServerOverride' });
    }, [isAuthenticated, onboardingJourneyOwnsTransientDemoServer, refreshAuth]);

    React.useEffect(() => {
        if (!shouldNormalizeSessionRouteForAuthRecovery) return;
        if (!sessionRouteAuthRecovery.baseHref) return;
        router.replace(sessionRouteAuthRecovery.baseHref);
    }, [sessionRouteAuthRecovery.baseHref, shouldNormalizeSessionRouteForAuthRecovery]);

    const shouldRedirect =
        !isAuthenticated
        && !isPublicRouteForUnauthenticated(segments)
        && !shouldHoldProtectedRouteForAuthRecovery;

    // Avoid rendering protected screens for a frame during redirect.
    if (shouldRedirect) {
        return <Redirect href="/" />;
    }

    if (isApplyingWebServerOverride && !onboardingJourneyOwnsTransientDemoServer) {
        return null;
    }

    return <>{children}</>;
}
