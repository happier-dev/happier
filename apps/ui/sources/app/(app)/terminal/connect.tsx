import React from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { TerminalConnectSurface } from '@/components/terminalConnect/TerminalConnectSurface';
import { useAuth } from '@/auth/context/AuthContext';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { t } from '@/text';
import { clearPendingTerminalConnect, getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { normalizeServerUrl, setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerUrl, resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { focusTerminalConnectHome } from '@/auth/terminal/focusTerminalConnectHome';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';
import { Modal } from '@/modal';
import { shouldSwitchToServerUrl } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import {
    buildTerminalConnectAuthRedirectHref,
    buildTerminalConnectDeepLink,
    parseTerminalConnectUrl,
    TERMINAL_CONNECT_WEB_PATH,
    resolveTerminalConnectPreAuthTarget,
    type ParsedTerminalConnectUrl,
    type TerminalConnectPreAuthTargetDecision,
} from '@/utils/path/terminalConnectUrl';
import { consumeTerminalConnectWebBootstrapHash } from '@/utils/path/terminalConnectWebBootstrap';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

function scrubTerminalConnectHashIfResumable(request: ParsedTerminalConnectUrl | null) {
    if (!request || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const pending = getPendingTerminalConnect();
    // Pending reads intentionally belong to the focused Home. Retain the URL
    // through discovery until a remount can recover this exact captured request.
    if (pending?.publicKeyB64Url !== request.publicKeyB64Url
        || pending.serverIdentityId !== request.serverIdentityId
        || pending.pairing?.secretB64Url !== request.pairing?.secretB64Url) return;
    window.history.replaceState(null, '', window.location.pathname);
}

export default function TerminalConnectScreen() {
    const router = useRouter();
    const routeHash = useLocalSearchParams<{ '#': string }>()['#'];
    const processedRouteHashRef = React.useRef<string | undefined>(undefined);
    const [publicKey, setPublicKey] = React.useState<string | null>(null);
    const [serverUrlFromHash, setServerUrlFromHash] = React.useState<string | null>(null);
    const [serverIdentityId, setServerIdentityId] = React.useState<string | null>(null);
    const [pairing, setPairing] = React.useState<ParsedTerminalConnectUrl['pairing']>();
    const [supportsTokenOnly, setSupportsTokenOnly] = React.useState(false);
    const [strictAuthUrl, setStrictAuthUrl] = React.useState<string | null>(null);
    const [homeConnectionDescriptor, setHomeConnectionDescriptor] = React.useState<HomeConnectionDescriptorV1 | undefined>();
    const [requiresUpdate, setRequiresUpdate] = React.useState(false);
    const [hashProcessed, setHashProcessed] = React.useState(false);
    const auth = useAuth();
    const authRedirectTriggeredRef = React.useRef(false);
    const [preAuthTarget, setPreAuthTarget] = React.useState<TerminalConnectPreAuthTargetDecision | null>(null);

    const navigateBackOrToHome = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);

    const approvalRequest = React.useMemo<ParsedTerminalConnectUrl | null>(() => publicKey ? {
        publicKeyB64Url: publicKey,
        serverUrl: serverUrlFromHash,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        ...(pairing ? { pairing } : {}),
        ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
        ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
    } : null, [homeConnectionDescriptor, pairing, publicKey, serverIdentityId, serverUrlFromHash, supportsTokenOnly]);

    const { processAuthUrl, processParsedAuthUrl, isLoading, approvalDetails, retryApprovalDetails } = useConnectTerminal({
        approvalRequest,
        allowLoopbackServerOverride: true,
        onSuccess: () => {
            router.replace('/');
        },
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') {
            return;
        }

        if (hashProcessed && (!routeHash || processedRouteHashRef.current === routeHash)) return;
        processedRouteHashRef.current = routeHash;
        // Router state can arrive before browser history moves to this route.
        let sourceUrl = routeHash
            ? new URL(`${TERMINAL_CONNECT_WEB_PATH}#${routeHash}`, window.location.href).href
            : window.location.href;
        let parsed = parseTerminalConnectUrl(sourceUrl);
        if (!parsed) {
            try {
                const bootstrappedHash = window.sessionStorage
                    ? consumeTerminalConnectWebBootstrapHash(window.sessionStorage)
                    : null;
                if (bootstrappedHash) {
                    const suffix = bootstrappedHash.startsWith('#') ? bootstrappedHash : `#${bootstrappedHash}`;
                    sourceUrl = new URL(`${TERMINAL_CONNECT_WEB_PATH}${suffix}`, window.location.href).href;
                    parsed = parseTerminalConnectUrl(sourceUrl);
                }
            } catch {
                // The visible URL remains authoritative when bootstrap storage is unavailable.
            }
        }

        if (parsed?.publicKeyB64Url) {
            authRedirectTriggeredRef.current = false;
            setPreAuthTarget(null);
            setRequiresUpdate(false);
            if (parsed.compatibility?.admission === 'update_required') {
                window.history.replaceState(null, '', window.location.pathname);
                setRequiresUpdate(true);
                setHashProcessed(true);
                fireAndForget(processParsedAuthUrl(parsed), { tag: 'TerminalConnectScreen.updateRequired' });
                return;
            }
            setPublicKey(parsed.publicKeyB64Url);
            setPairing(parsed.pairing);
            setServerIdentityId(parsed.serverIdentityId ?? null);
            setSupportsTokenOnly(parsed.supportsTokenOnly === true);
            setStrictAuthUrl(parsed.wireVersion === 4 ? sourceUrl : null);
            setHomeConnectionDescriptor(parsed.homeConnectionDescriptor);

            const pendingServerUrl = normalizeServerUrl(
                parsed.homeConnectionDescriptor?.canonicalServerUrl ?? parsed.serverUrl ?? getActiveServerUrl(),
            );
            setServerUrlFromHash(pendingServerUrl);
            // Capture custody before scrubbing the only URL copy. Discovery can outlive
            // this mount; its result decides navigation, not whether we retain the intent.
            setPendingTerminalConnect({
                publicKeyB64Url: parsed.publicKeyB64Url,
                serverUrl: pendingServerUrl,
                serverIdentityId: parsed.serverIdentityId ?? '',
                ...(parsed.pairing ? { pairing: parsed.pairing } : {}),
                ...(parsed.supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                ...(parsed.homeConnectionDescriptor ? { homeConnectionDescriptor: parsed.homeConnectionDescriptor } : {}),
            });

            scrubTerminalConnectHashIfResumable(parsed);
        } else {
            const pending = getPendingTerminalConnect();
            if (pending?.publicKeyB64Url) {
                setPublicKey(pending.publicKeyB64Url);
                setServerUrlFromHash(pending.serverUrl);
                setPairing(pending.pairing);
                setServerIdentityId(pending.serverIdentityId);
                setSupportsTokenOnly(pending.supportsTokenOnly === true);
                setHomeConnectionDescriptor(pending.homeConnectionDescriptor);
            }
        }

        setHashProcessed(true);
    }, [auth.isAuthenticated, hashProcessed, processParsedAuthUrl, routeHash]);

    React.useEffect(() => {
        if (!hashProcessed || !publicKey || requiresUpdate) return;
        let cancelled = false;
        fireAndForget((async () => {
            const target = await resolveTerminalConnectPreAuthTarget({
                requestedServerUrl: serverUrlFromHash, activeServerUrl: normalizeServerUrl(getActiveServerUrl()),
                ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
                allowLegacyLoopbackOverride: auth.isAuthenticated,
            });
            if (cancelled) return;
            setPreAuthTarget(target);
            if (!target) return;
            setPendingTerminalConnect({
                publicKeyB64Url: publicKey, serverUrl: target.pendingServerUrl, serverIdentityId: serverIdentityId ?? '',
                ...(pairing ? { pairing } : {}), ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
            });
            scrubTerminalConnectHashIfResumable(approvalRequest);
        })(), { tag: 'TerminalConnectScreen.preAuthTarget' });
        return () => { cancelled = true; };
    }, [approvalRequest, auth.isAuthenticated, hashProcessed, homeConnectionDescriptor, pairing, publicKey, requiresUpdate, serverIdentityId, serverUrlFromHash, supportsTokenOnly]);

    React.useEffect(() => {
        if (auth.isAuthenticated || !hashProcessed || !publicKey || authRedirectTriggeredRef.current) {
            return;
        }

        const activeServerUrl = normalizeServerUrl(getActiveServerUrl());
        if (!preAuthTarget) return;
        if (!preAuthTarget.canNavigateToAuth) {
            return;
        }
        authRedirectTriggeredRef.current = true;
        const effectiveTarget = preAuthTarget.pendingServerUrl;
        const desiredServerUrl = preAuthTarget.pendingServerUrl;
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: desiredServerUrl,
            serverIdentityId: serverIdentityId ?? '',
            ...(pairing ? { pairing } : {}),
            ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
            ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
        });

        fireAndForget((async () => {
            if (homeConnectionDescriptor) {
                try {
                    const profile = await focusTerminalConnectHome({ descriptor: homeConnectionDescriptor, refreshAuth: auth.refreshFromActiveServer });
                    if (!profile) return;
                    scrubTerminalConnectHashIfResumable(approvalRequest);
                    router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: desiredServerUrl }));
                } catch (error) {
                    Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
                }
                return;
            }
            if (effectiveTarget && shouldSwitchToServerUrl({ targetServerUrl: effectiveTarget, activeServerUrl })) {
                try {
                    let profile = resolveUniqueServerProfileByUrl(effectiveTarget);
                    if (!profile) {
                        const connected = await connectHomeAtAddress({
                            serverUrl: effectiveTarget,
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
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                    if (switched === 'blocked') return;
                    if (profile.serverUrl !== desiredServerUrl) {
                        setPendingTerminalConnect({
                            publicKeyB64Url: publicKey,
                            serverUrl: profile.serverUrl,
                            serverIdentityId: serverIdentityId ?? '',
                            ...(pairing ? { pairing } : {}),
                            ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                            ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
                        });
                    }
                    scrubTerminalConnectHashIfResumable(approvalRequest);
                    router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: profile.serverUrl }));
                    return;
                } catch (error) {
                    Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
                    return;
                }
            }
            scrubTerminalConnectHashIfResumable(approvalRequest);
            router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: desiredServerUrl }));
        })(), { tag: 'TerminalConnectScreen.redirectToAuth' });
    }, [approvalRequest, auth.isAuthenticated, auth.refreshFromActiveServer, hashProcessed, homeConnectionDescriptor, pairing, preAuthTarget, publicKey, router, serverIdentityId, supportsTokenOnly]);

    const handleConnect = React.useCallback(async () => {
        if (!publicKey) {
            return;
        }

        const authUrl = strictAuthUrl ?? buildTerminalConnectDeepLink({
            publicKeyB64Url: publicKey,
            serverUrl: preAuthTarget?.pendingServerUrl ?? serverUrlFromHash,
            serverIdentityId: serverIdentityId ?? undefined,
            ...(pairing ? { pairing } : {}),
            ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
            ...(homeConnectionDescriptor ? { homeConnectionDescriptor } : {}),
        });
        await processAuthUrl(authUrl);
    }, [homeConnectionDescriptor, pairing, preAuthTarget, processAuthUrl, publicKey, serverIdentityId, serverUrlFromHash, strictAuthUrl, supportsTokenOnly]);

    const handleReject = React.useCallback(() => {
        clearPendingTerminalConnect();
        navigateBackOrToHome();
    }, [navigateBackOrToHome]);

    if (Platform.OS !== 'web') {
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('terminal.webBrowserRequired'),
                    description: t('terminal.webBrowserRequiredDescription'),
                }}
            />
        );
    }

    if (!hashProcessed) {
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('terminal.processingConnection'),
                    loading: true,
                }}
            />
        );
    }

    if (!auth.isAuthenticated && publicKey) {
        if (preAuthTarget?.canNavigateToAuth === false) {
            return (
                <TerminalConnectSurface
                    testID="terminal-connect-surface"
                    state={{
                        kind: 'message',
                        title: t('welcome.serverUnavailableTitle'),
                        description: t('welcome.serverUnavailableBody', {
                            serverUrl: homeConnectionDescriptor?.canonicalServerUrl ?? serverUrlFromHash ?? '',
                        }),
                        tone: 'critical',
                    }}
                />
            );
        }
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('modals.pleaseSignInFirst'),
                }}
            />
        );
    }

    if (!publicKey) {
        if (requiresUpdate) {
            return (
                <TerminalConnectSurface
                    testID="terminal-connect-surface"
                    state={{
                        kind: 'message',
                        title: t('connect.updateRequiredTitle'),
                        description: t('connect.legacyPairingUpdateRequiredBody'),
                        tone: 'critical',
                    }}
                />
            );
        }
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('terminal.invalidConnectionLink'),
                    description: t('terminal.invalidConnectionLinkDescription'),
                    tone: 'critical',
                }}
            />
        );
    }

    return (
        <TerminalConnectSurface
            testID="terminal-connect-surface"
            state={{
                kind: 'approval',
                publicKey,
                isLoading,
                storageMode: approvalDetails.kind === 'ready' ? approvalDetails.storageMode : null,
                homeUrl: approvalDetails.kind === 'ready' || approvalDetails.kind === 'needs_sign_in'
                    ? approvalDetails.homeUrl : homeConnectionDescriptor?.canonicalServerUrl ?? serverUrlFromHash ?? '',
                needsSignIn: approvalDetails.kind === 'needs_sign_in',
                ...(approvalDetails.kind === 'error' ? {
                    errorDescription: t('modals.failedToConnectTerminal'),
                    onRetry: retryApprovalDetails,
                } : {}),
                onApprove: handleConnect,
                onReject: handleReject,
            }}
        />
    );
}
