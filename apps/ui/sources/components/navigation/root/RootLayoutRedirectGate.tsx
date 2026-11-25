import { Redirect, router } from 'expo-router';
import { useCurrentRouteParams, useCurrentRoutePathname, useCurrentRouteSegments } from '@/components/appShell/workspace/currentRouteLocation';
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
    consumeWebServerUrlOverrideFromLocation,
    readWebDestinationServerIdFromLocation,
    resolveWebServerEntrySignInRoute,
} from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { KnownHomeGate } from '@/components/sessions/access/KnownHomeGate';
import { areServerProfileIdentifiersEquivalent, resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { WizardAuthReturnRouteContext } from '@/components/onboarding/state/wizardResume';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { admitOpaqueInternalReturnPath, tryAdmitInternalRouteHref, withInternalRouteQueryParams } from '@/utils/path/routeUtils';
import { parseToken } from '@/utils/auth/parseToken';
import { SignedOutRecoveryWorkflow } from '@/components/onboarding/preAuth/SignedOutRecoveryWorkflow';
import { firstRouteParam } from '@/components/settings/teams/teamRouteParams';

class HomeConnectRequiresDraft extends Error {}

const PROTECTED_DESTINATION_PARAM = 'onboardingDestination';

function matchesSignedInAccount(expectedAccountId: string | null, token: string | undefined): boolean {
    if (expectedAccountId === null) return true;
    try {
        return Boolean(token && parseToken(token) === expectedAccountId);
    } catch {
        return false;
    }
}

function admitProtectedPath(value: unknown): string | null {
    const path = admitOpaqueInternalReturnPath(value);
    if (!path || path === '/' || path.includes('?') || path.includes('#')) return null;
    return path;
}

function readProtectedDestination(value: string): Readonly<{
    path: string;
    homeId: string;
    explicitHome: boolean;
    accountId: string | null;
}> | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length !== 4) return null;
        const [rawPath, homeId, explicitHome, accountId]: unknown[] = parsed;
        const path = admitProtectedPath(rawPath);
        if (!path || typeof homeId !== 'string' || !homeId || typeof explicitHome !== 'boolean') return null;
        if (accountId !== null && (typeof accountId !== 'string' || !accountId)) return null;
        return { path, homeId, explicitHome, accountId };
    } catch {
        return null;
    }
}

const WebServerOverrideNavigationContext = React.createContext<Readonly<{
    draftHref: string | null;
    consumeDraft: () => void;
}> | null>(null);

/**
 * Single navigation-subscribing render owner for the app root layout.
 *
 * It subscribes to `useCurrentRouteSegments()` / `usePathname()` / `useGlobalSearchParams()` (which change per
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
    const segments = useCurrentRouteSegments();
    const pathname = useCurrentRoutePathname();
    const globalSearchParams = useCurrentRouteParams();
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
        && !isPublicRouteForUnauthenticated([...segments])
        && !shouldHoldProtectedRouteForAuthRecovery;

    const pending = pathname === '/' ? firstRouteParam(globalSearchParams[PROTECTED_DESTINATION_PARAM]) : '';
    const destination = React.useMemo(() => pending ? readProtectedDestination(pending) : null, [pending]);
    const signInEntry = React.useMemo(() => {
        if (!destination) return null;
        const entry = resolveWebServerEntrySignInRoute();
        return {
            returnTo: withInternalRouteQueryParams(entry, { [PROTECTED_DESTINATION_PARAM]: pending }),
            abandon: () => router.replace(entry),
        };
    }, [destination, pending]);
    const finishSignIn = isAuthenticated && Boolean(pending) && !suppliedHomeNavigation?.draftHref;
    React.useLayoutEffect(() => {
        if (!finishSignIn) return;
        if (!destination || !areServerProfileIdentifiersEquivalent(destination.homeId, activeServerSnapshot.serverId)
            || !matchesSignedInAccount(destination.accountId, auth.credentials?.token)) {
            router.replace('/');
            return;
        }
        const path = destination.explicitHome
            ? withInternalRouteQueryParams(destination.path, { serverId: destination.homeId })
            : destination.path;
        const continuation = tryAdmitInternalRouteHref(path);
        if (continuation) resolvePostAuthLanding({ replace: router.replace, continuation });
        else router.replace('/');
    }, [activeServerSnapshot.serverId, auth.credentials?.token, destination, finishSignIn]);

    // Avoid rendering protected screens for a frame during redirect.
    if (suppliedHomeNavigation?.draftHref || finishSignIn) {
        return null;
    }
    if (shouldRedirect) {
        const homeIdInPath = segments.includes('[serverId]');
        const routeHomeId = firstRouteParam(globalSearchParams.serverId) || null;
        const queryHomeId = Platform.OS === 'web'
            ? readWebDestinationServerIdFromLocation()
            : homeIdInPath ? null : routeHomeId;
        const accountId = segments.includes('[accountId]') ? null : firstRouteParam(globalSearchParams.accountId) || null;
        const path = admitProtectedPath(pathname);
        const homeId = queryHomeId ?? (homeIdInPath ? routeHomeId : null) ?? activeServerSnapshot.serverId;
        const entry = resolveWebServerEntrySignInRoute();
        // Keep the request in the onboarding route for this attempt. The
        // auth operation or the destination's own access policy still owns access.
        const href = path && homeId
            ? withInternalRouteQueryParams(entry, { [PROTECTED_DESTINATION_PARAM]: JSON.stringify([path, homeId, Boolean(queryHomeId), accountId]) })
            : entry;
        return queryHomeId
            ? <UnauthenticatedDestinationHome serverId={queryHomeId} href={href} />
            : <Redirect href={href as never} />;
    }

    return <WizardAuthReturnRouteContext.Provider value={signInEntry}>
        <SignedOutRecoveryWorkflow
            pathname={pathname}
            signedIn={isAuthenticated}
            homeTarget={firstRouteParam(globalSearchParams.target) || null}
            navigation={router}
        >
            {children}
        </SignedOutRecoveryWorkflow>
    </WizardAuthReturnRouteContext.Provider>;
}

/** Boot refuses unknown Home credentials; retain that refusal without mounting the protected route. */
function UnauthenticatedDestinationHome({ serverId, href }: Readonly<{ serverId: string; href: string }>): React.ReactElement {
    // Profile knowledge cannot override boot's credential-adoption decision, including first-key custody.
    return <KnownHomeGate serverId={serverId} testIDPrefix="root-destination"><Redirect href={href as never} /></KnownHomeGate>;
}

/** Keep routes registered while withholding protected scenes during a redirect. */
export function renderRootLayoutRedirectGate(props: { children: React.ReactNode }): React.ReactElement {
    return <RootLayoutRedirectGate>{props.children}</RootLayoutRedirectGate>;
}

/** Admit a supplied Home below modal ownership and before shell or cache consumers mount. */
export function WebServerOverrideGate({ children, serverUrlOverride }: Readonly<{
    children: React.ReactNode;
    serverUrlOverride?: string | null;
}>): React.ReactElement | null {
    const { refreshFromActiveServer: refreshAuth } = useAuth();
    const activeServerSnapshot = useActiveServerSnapshot();
    const bootstrappedServerUrlRef = React.useRef(activeServerSnapshot.serverUrl ?? null);
    const [isApplyingWebServerOverride, setIsApplyingWebServerOverride] = React.useState(() =>
        resolveWebServerUrlOverrideAction({ bootstrappedServerUrl: bootstrappedServerUrlRef.current, serverUrlOverride }).kind === 'switch_server',
    );
    const webServerOverrideHandledRef = React.useRef(false);
    const [draftHref, setDraftHref] = React.useState<string | null>(null);
    const consumeDraft = React.useCallback(() => { setDraftHref(null); }, []);
    const navigation = React.useMemo(() => ({ draftHref, consumeDraft }), [draftHref, consumeDraft]);
    React.useEffect(() => {
        if (webServerOverrideHandledRef.current) return;
        const overrideAction = resolveWebServerUrlOverrideAction({
            bootstrappedServerUrl:
                bootstrappedServerUrlRef.current,
            serverUrlOverride,
        });
        if (overrideAction.kind === 'none') {
            setIsApplyingWebServerOverride(false);
            return;
        }
        // Same-server refresh/URL cleanup holds nothing. Only a real cross-server switch owns a root hold.
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
                        signal: controller.signal,
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
                    });
                    if (cancelled) return;
                    webServerOverrideHandledRef.current = true;
                    setIsApplyingWebServerOverride(false);
                    return;
                } catch (error) {
                    if (cancelled) return;
                    const dismissOverride = async () => {
                        consumeWebServerUrlOverrideFromLocation({ serverUrl: overrideAction.serverUrl, signal: controller.signal });
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
    }, [refreshAuth, serverUrlOverride]);

    if (isApplyingWebServerOverride) {
        return null;
    }

    return <WebServerOverrideNavigationContext.Provider value={navigation}>{children}</WebServerOverrideNavigationContext.Provider>;
}
