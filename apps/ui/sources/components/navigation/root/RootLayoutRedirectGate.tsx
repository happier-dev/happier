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
import { resolveWebServerUrlOverrideAction } from '@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction';
import {
    commitWebServerUrlOverride,
} from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import {
    doesOnboardingJourneyOwnTransientDemoServer,
    useOnboardingJourneySessionActive,
} from '@/components/onboarding/tour/state/journeySession';

class HomeConnectRequiresDraft extends Error {}

const WebServerOverrideNavigationContext = React.createContext<Readonly<{
    draftHref: string | null;
    consumeDraft: () => void;
}> | null>(null);

/**
 * Single navigation-subscribing render owner for the app root layout.
 *
 * It subscribes to `useSegments()` / `usePathname()` / `useGlobalSearchParams()` (which change per
 * navigation) plus the connectivity/server signals that drive the unauthenticated redirect and the
 * session-route auth-recovery hold. It is the
 * ONLY navigation-subscribing owner in the root-layout render path: when no redirect/hold applies it
 * returns its `children` unchanged. Because the parent (`RootLayout`) never re-renders on navigation,
 * the child element reference is stable and React skips re-rendering the entire Stack subtree — this
 * is what stops every navigation from re-rendering all mounted SceneViews.
 */
export function RootLayoutRedirectGate({ children }: { children: React.ReactNode }): React.ReactElement | null {
    const auth = useAuth();
    const isAuthenticated = auth.isAuthenticated;
    const segments = useSegments();
    const pathname = usePathname();
    const globalSearchParams = useGlobalSearchParams();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const activeServerSnapshot = useActiveServerSnapshot();
    const suppliedHomeNavigation = React.useContext(WebServerOverrideNavigationContext);
    React.useEffect(() => {
        if (!suppliedHomeNavigation?.draftHref) return;
        router.replace(suppliedHomeNavigation.draftHref as never);
        suppliedHomeNavigation.consumeDraft();
    }, [suppliedHomeNavigation]);
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

    React.useEffect(() => {
        if (suppliedHomeNavigation?.draftHref) return;
        if (!shouldNormalizeSessionRouteForAuthRecovery) return;
        if (!sessionRouteAuthRecovery.baseHref) return;
        router.replace(sessionRouteAuthRecovery.baseHref);
    }, [sessionRouteAuthRecovery.baseHref, shouldNormalizeSessionRouteForAuthRecovery, suppliedHomeNavigation?.draftHref]);

    const shouldRedirect =
        !isAuthenticated
        && !isPublicRouteForUnauthenticated(segments)
        && !shouldHoldProtectedRouteForAuthRecovery;

    // Avoid rendering protected screens for a frame during redirect.
    if (suppliedHomeNavigation?.draftHref) {
        return null;
    }
    if (shouldRedirect) {
        return <Redirect href="/" />;
    }

    return <>{children}</>;
}

/** Admit a supplied Home below modal ownership and before shell or cache consumers mount. */
export function WebServerOverrideGate({ children }: { children: React.ReactNode }): React.ReactElement | null {
    const { refreshFromActiveServer: refreshAuth } = useAuth();
    const activeServerSnapshot = useActiveServerSnapshot();
    const bootstrappedServerUrlRef = React.useRef(activeServerSnapshot.serverUrl ?? null);
    const onboardingJourneyActive = useOnboardingJourneySessionActive();
    const onboardingJourneyOwnsTransientDemoServer = doesOnboardingJourneyOwnTransientDemoServer(onboardingJourneyActive);
    const [isApplyingWebServerOverride, setIsApplyingWebServerOverride] = React.useState(() =>
        !onboardingJourneyOwnsTransientDemoServer
        && resolveWebServerUrlOverrideAction({ bootstrappedServerUrl: bootstrappedServerUrlRef.current }).kind === 'switch_server',
    );
    const webServerOverrideHandledRef = React.useRef(false);
    const [draftHref, setDraftHref] = React.useState<string | null>(null);
    const consumeDraft = React.useCallback(() => { setDraftHref(null); }, []);
    const navigation = React.useMemo(() => ({ draftHref, consumeDraft }), [draftHref, consumeDraft]);
    React.useEffect(() => {
        if (onboardingJourneyOwnsTransientDemoServer) {
            // The journey's seeded relay is presentation-only. Keep both the override
            // action and the root hold pending until that temporary ownership ends.
            setIsApplyingWebServerOverride(false);
            return;
        }
        if (webServerOverrideHandledRef.current) return;
        const overrideAction = resolveWebServerUrlOverrideAction({
            bootstrappedServerUrl:
                bootstrappedServerUrlRef.current,
        });
        if (overrideAction.kind === 'none') {
            setIsApplyingWebServerOverride(false);
            return;
        }
        // Same-server refresh/URL cleanup must not unmount a still-live journey after
        // its demo act tears down. Only a real cross-server switch owns a root hold.
        setIsApplyingWebServerOverride(overrideAction.kind === 'switch_server');
        const suppliedNewHome = overrideAction.kind === 'switch_server'
            && !resolveUniqueServerProfileByUrl(overrideAction.serverUrl);
        let cancelled = false;
        const controller = new AbortController();
        fireAndForget((async () => {
            const openUnsavedHomeDraft = () => {
                if (!suppliedNewHome || overrideAction.kind !== 'switch_server') return;
                setDraftHref(`/settings/server/add?address=${encodeURIComponent(overrideAction.serverUrl)}&source=url`);
            };
            while (true) {
                try {
                    await commitWebServerUrlOverride({
                        action: overrideAction,
                        switchServer: async ({ serverUrl, refreshAuth: refreshAfterSwitch }) => {
                            const saved = resolveUniqueServerProfileByUrl(serverUrl);
                            const profile = saved ?? await (async () => {
                                const connected = await connectHomeAtAddress({
                                    serverUrl,
                                    source: 'url',
                                    signal: controller.signal,
                                    confirmInsecureHttp: confirmInsecureHomeHttp,
                                    confirmCanonicalUrl: confirmCanonicalHomeUrl,
                                });
                                if (connected.kind === 'connected') return connected.profile;
                                if (connected.kind === 'declined') throw new HomeConnectRequiresDraft();
                                throw new Error(homeConnectFailureMessage(connected) ?? t('common.error'));
                            })();
                            const switched = await setActiveServerAndSwitch({
                                serverId: profile.id,
                                scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                                refreshAuth: refreshAfterSwitch,
                            });
                            if (switched === 'blocked') throw new Error(t('common.error'));
                        },
                        refreshAuth,
                        replaceRelativeUrl: (nextRelativeUrl) => {
                            if (Platform.OS !== 'web' || typeof window === 'undefined') return;
                            window.history.replaceState(null, '', nextRelativeUrl);
                        },
                    });
                    if (cancelled) return;
                    webServerOverrideHandledRef.current = true;
                    setIsApplyingWebServerOverride(false);
                    return;
                } catch (error) {
                    if (cancelled) return;
                    const dismissOverride = async () => {
                        if (Platform.OS === 'web' && typeof window !== 'undefined') {
                            window.history.replaceState(null, '', overrideAction.cleanedRelativeUrl);
                        }
                        webServerOverrideHandledRef.current = true;
                        openUnsavedHomeDraft();
                        try {
                            await refreshAuth();
                        } finally {
                            if (!cancelled) setIsApplyingWebServerOverride(false);
                        }
                    };
                    if (error instanceof HomeConnectRequiresDraft) {
                        await dismissOverride();
                        return;
                    }
                    const shouldRetry = await Modal.confirm(
                        t('common.error'),
                        error instanceof Error ? error.message : t('common.error'),
                        {
                            cancelText: t('common.cancel'),
                            confirmText: t('common.retry'),
                        },
                    );
                    if (cancelled) return;
                    if (shouldRetry) continue;
                    await dismissOverride();
                    return;
                }
            }
        })(), { tag: 'WebServerOverrideGate' });
        return () => { cancelled = true; controller.abort(); };
    }, [onboardingJourneyOwnsTransientDemoServer, refreshAuth]);

    if (isApplyingWebServerOverride && !onboardingJourneyOwnsTransientDemoServer) {
        return null;
    }

    return <WebServerOverrideNavigationContext.Provider value={navigation}>{children}</WebServerOverrideNavigationContext.Provider>;
}
