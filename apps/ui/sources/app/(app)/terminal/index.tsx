import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { TerminalConnectSurface } from '@/components/terminalConnect/TerminalConnectSurface';
import { useAuth } from '@/auth/context/AuthContext';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { t } from '@/text';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import {
    buildTerminalConnectAuthRedirectHref,
    buildTerminalConnectDeepLink,
    type ParsedTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';

function resolveTerminalPublicKey(searchParams: Record<string, string | string[] | undefined>): string | null {
    const keyParam = searchParams.key;
    if (typeof keyParam === 'string' && keyParam.trim()) return keyParam.trim();
    if (Array.isArray(keyParam) && keyParam[0]?.trim()) return keyParam[0].trim();

    const knownParams = new Set(['key', 'server', 'pairingSecret', 'createdAt', 'expiresAt', 'supportsTokenOnly']);
    const unknownKeys = Object.keys(searchParams).filter((key) => !knownParams.has(key));
    if (unknownKeys.length !== 1) return null;

    const legacyKey = unknownKeys[0]?.trim();
    return legacyKey ?? null;
}

function resolveTerminalServerUrl(searchParams: Record<string, string | string[] | undefined>): string | null {
    const value = searchParams.server;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
    return null;
}

function resolveTerminalPairing(
    searchParams: Record<string, string | string[] | undefined>,
): ParsedTerminalConnectUrl['pairing'] {
    const readOne = (value: string | string[] | undefined): string =>
        typeof value === 'string'
            ? value.trim()
            : Array.isArray(value)
                ? String(value[0] ?? '').trim()
                : '';
    const secretB64Url = readOne(searchParams.pairingSecret);
    const createdAtMs = Number(readOne(searchParams.createdAt));
    const expiresAtMs = Number(readOne(searchParams.expiresAt));
    if (
        !secretB64Url
        || !Number.isSafeInteger(createdAtMs)
        || !Number.isSafeInteger(expiresAtMs)
        || createdAtMs < 0
        || expiresAtMs <= createdAtMs
    ) {
        return undefined;
    }
    return { secretB64Url, createdAtMs, expiresAtMs };
}

function resolveSupportsTokenOnly(
    searchParams: Record<string, string | string[] | undefined>,
): boolean {
    const value = searchParams.supportsTokenOnly;
    return (typeof value === 'string' ? value : value?.[0]) === '1';
}

export default function TerminalScreen() {
    const router = useRouter();
    const searchParams = useLocalSearchParams();
    const auth = useAuth();
    const authRedirectTriggeredRef = React.useRef(false);

    const publicKey = React.useMemo(() => resolveTerminalPublicKey(searchParams), [searchParams]);
    const serverUrl = React.useMemo(() => resolveTerminalServerUrl(searchParams), [searchParams]);
    const pairing = React.useMemo(() => resolveTerminalPairing(searchParams), [searchParams]);
    const supportsTokenOnly = React.useMemo(
        () => Boolean(pairing) && resolveSupportsTokenOnly(searchParams),
        [pairing, searchParams],
    );

    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            router.back();
        },
    });

    React.useEffect(() => {
        if (auth.isAuthenticated || !publicKey || authRedirectTriggeredRef.current) {
            return;
        }

        authRedirectTriggeredRef.current = true;
        const currentServerUrl = canonicalizeServerUrl(getServerUrl());
        const effectiveTarget = resolveEffectiveServerUrlOverride({
            requestedServerUrl: serverUrl,
            activeServerUrl: currentServerUrl,
        });
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: effectiveTarget || currentServerUrl || getServerUrl(),
            ...(pairing ? { pairing } : {}),
            ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
        });
        router.replace(buildTerminalConnectAuthRedirectHref({
            serverUrl: effectiveTarget || currentServerUrl || getServerUrl(),
        }));
    }, [auth.isAuthenticated, pairing, publicKey, router, serverUrl, supportsTokenOnly]);

    const handleConnect = React.useCallback(async () => {
        if (!publicKey) {
            return;
        }
        const authUrl = buildTerminalConnectDeepLink({
            publicKeyB64Url: publicKey,
            serverUrl,
            ...(pairing ? { pairing } : {}),
            ...(supportsTokenOnly ? { supportsTokenOnly: true } : {}),
        });
        await processAuthUrl(authUrl);
    }, [pairing, processAuthUrl, publicKey, serverUrl, supportsTokenOnly]);

    const handleReject = React.useCallback(() => {
        clearPendingTerminalConnect();
        router.back();
    }, [router]);

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
