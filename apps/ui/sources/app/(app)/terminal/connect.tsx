import React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { TerminalConnectSurface } from '@/components/terminalConnect/TerminalConnectSurface';
import { useAuth } from '@/auth/context/AuthContext';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { t } from '@/text';
import { clearPendingTerminalConnect, getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { resolveEffectiveServerUrlOverride, shouldSwitchToServerUrl } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import {
    buildTerminalConnectAuthRedirectHref,
    buildTerminalConnectDeepLink,
    parseTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { consumeTerminalConnectWebBootstrapHash } from '@/utils/path/terminalConnectWebBootstrap';
import { fireAndForget } from '@/utils/system/fireAndForget';

export default function TerminalConnectScreen() {
    const router = useRouter();
    const [publicKey, setPublicKey] = React.useState<string | null>(null);
    const [serverUrlFromHash, setServerUrlFromHash] = React.useState<string | null>(null);
    const [hashProcessed, setHashProcessed] = React.useState(false);
    const auth = useAuth();
    const authRedirectTriggeredRef = React.useRef(false);

    const navigateBackOrToHome = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);

    const { processAuthUrl, isLoading } = useConnectTerminal({
        allowLoopbackServerOverride: true,
        onSuccess: () => {
            router.replace('/');
        },
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || hashProcessed) {
            return;
        }

        let parsed = parseTerminalConnectUrl(window.location.href);
        if (!parsed && window.sessionStorage) {
            const bootstrappedHash = consumeTerminalConnectWebBootstrapHash(window.sessionStorage);
            if (bootstrappedHash) {
                const suffix = bootstrappedHash.startsWith('#') ? bootstrappedHash : `#${bootstrappedHash}`;
                parsed = parseTerminalConnectUrl(`${window.location.href}${suffix}`);
            }
        }

        if (parsed?.publicKeyB64Url) {
            setPublicKey(parsed.publicKeyB64Url);

            const activeServerUrl = normalizeServerUrl(getActiveServerUrl());
            const requestedServerUrl = normalizeServerUrl(parsed.serverUrl ?? '');
            const effectiveTarget = resolveEffectiveServerUrlOverride({
                requestedServerUrl,
                activeServerUrl,
                allowLoopbackOverride: auth.isAuthenticated,
            });
            const desiredServerUrl = effectiveTarget || activeServerUrl || getActiveServerUrl();
            if (desiredServerUrl) {
                setPendingTerminalConnect({
                    publicKeyB64Url: parsed.publicKeyB64Url,
                    serverUrl: desiredServerUrl,
                });
                setServerUrlFromHash(desiredServerUrl);
            }

            window.history.replaceState(null, '', window.location.pathname);
        } else {
            const pending = getPendingTerminalConnect();
            if (pending?.publicKeyB64Url) {
                setPublicKey(pending.publicKeyB64Url);
                setServerUrlFromHash(pending.serverUrl);
            }
        }

        setHashProcessed(true);
    }, [auth.isAuthenticated, hashProcessed]);

    React.useEffect(() => {
        if (auth.isAuthenticated || !hashProcessed || !publicKey || authRedirectTriggeredRef.current) {
            return;
        }

        authRedirectTriggeredRef.current = true;
        const activeServerUrl = normalizeServerUrl(getActiveServerUrl());
        const effectiveTarget = resolveEffectiveServerUrlOverride({
            requestedServerUrl: serverUrlFromHash,
            activeServerUrl,
        });
        const desiredServerUrl = effectiveTarget || activeServerUrl || getActiveServerUrl();
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: desiredServerUrl,
        });

        fireAndForget((async () => {
            if (effectiveTarget && shouldSwitchToServerUrl({ targetServerUrl: effectiveTarget, activeServerUrl })) {
                try {
                    await upsertActivateAndSwitchServer({
                        serverUrl: effectiveTarget,
                        source: 'url',
                        scope: 'device',
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                } catch {
                    // ignore; auth entry route can still recover later
                }
            }
            router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: desiredServerUrl }));
        })(), { tag: 'TerminalConnectScreen.redirectToAuth' });
    }, [auth.isAuthenticated, auth.refreshFromActiveServer, hashProcessed, publicKey, router, serverUrlFromHash]);

    const handleConnect = React.useCallback(async () => {
        if (!publicKey) {
            return;
        }

        const authUrl = buildTerminalConnectDeepLink({
            publicKeyB64Url: publicKey,
            serverUrl: serverUrlFromHash,
        });
        await processAuthUrl(authUrl);
    }, [processAuthUrl, publicKey, serverUrlFromHash]);

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
                onApprove: handleConnect,
                onReject: handleReject,
            }}
        />
    );
}
