import React, { useState, useEffect } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { clearPendingTerminalConnect, getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import {
    buildTerminalConnectAuthRedirectHref,
    buildTerminalConnectDeepLink,
    parseTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { consumeTerminalConnectWebBootstrapHash } from '@/utils/path/terminalConnectWebBootstrap';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useUnistyles } from 'react-native-unistyles';

export default function TerminalConnectScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [serverUrlFromHash, setServerUrlFromHash] = useState<string | null>(null);
    const [hashProcessed, setHashProcessed] = useState(false);
    const auth = useAuth();
    const authRedirectTriggeredRef = React.useRef(false);

    const navigateBackOrToHome = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);

    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            router.replace('/');
        }
    });

    const primaryButtonStyle = React.useMemo(() => ({
        alignItems: 'center' as const,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 14,
        minHeight: 52,
        justifyContent: 'center' as const,
        paddingHorizontal: 16,
        paddingVertical: 12,
    }), [theme.colors.button.primary.background]);

    const secondaryButtonStyle = React.useMemo(() => ({
        alignItems: 'center' as const,
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.textSecondary,
        borderRadius: 14,
        borderWidth: 1,
        minHeight: 52,
        justifyContent: 'center' as const,
        paddingHorizontal: 16,
        paddingVertical: 12,
    }), [theme.colors.surface, theme.colors.textSecondary]);

    // Extract key from hash on web platform
    useEffect(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined' && !hashProcessed) {
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

                const desiredServerUrl = normalizeServerUrl(parsed.serverUrl ?? '') || getActiveServerUrl();
                if (desiredServerUrl) {
                    // Persist the connect link in storage so dev strict-mode remounts still have access
                    // after we clear the URL (hash/query) for safety.
                    setPendingTerminalConnect({
                        publicKeyB64Url: parsed.publicKeyB64Url,
                        serverUrl: desiredServerUrl,
                    });
                    setServerUrlFromHash(desiredServerUrl);
                }

                // Clear sensitive params from the URL to avoid exposing the key in history.
                window.history.replaceState(null, '', window.location.pathname);
            } else {
                const pending = getPendingTerminalConnect();
                if (pending?.publicKeyB64Url) {
                    setPublicKey(pending.publicKeyB64Url);
                    setServerUrlFromHash(pending.serverUrl);
                }
            }
            setHashProcessed(true);
        }
    }, [hashProcessed]);

    useEffect(() => {
        if (auth.isAuthenticated) return;
        if (!hashProcessed || !publicKey) return;
        if (authRedirectTriggeredRef.current) return;

        authRedirectTriggeredRef.current = true;
        const desiredServerUrl = normalizeServerUrl(serverUrlFromHash ?? '');
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: desiredServerUrl || getActiveServerUrl(),
        });

        fireAndForget((async () => {
            if (desiredServerUrl) {
                try {
                    await upsertActivateAndSwitchServer({
                        serverUrl: desiredServerUrl,
                        source: 'url',
                        scope: 'device',
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                } catch {
                    // ignore; auth entry route can still proceed and recover later
                }
            }
            router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: desiredServerUrl }));
        })(), { tag: 'TerminalConnectScreen.redirectToAuth' });
    }, [auth.isAuthenticated, auth.refreshFromActiveServer, hashProcessed, publicKey, router, serverUrlFromHash]);

    const handleConnect = async () => {
        if (publicKey) {
            const authUrl = buildTerminalConnectDeepLink({
                publicKeyB64Url: publicKey,
                serverUrl: serverUrlFromHash,
            });
            await processAuthUrl(authUrl);
        }
    };

    const handleReject = () => {
        clearPendingTerminalConnect();
        navigateBackOrToHome();
    };

    // Show placeholder for mobile platforms
    if (Platform.OS !== 'web') {
        return (
            <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }}>
                <View style={{ alignItems: 'center', gap: 12 }}>
                    <Text style={{
                        ...Typography.default('semiBold'),
                        fontSize: 18,
                        textAlign: 'center',
                    }}>
                        {t('terminal.webBrowserRequired')}
                    </Text>
                    <Text style={{
                        ...Typography.default(),
                        color: theme.colors.textSecondary,
                        fontSize: 14,
                        lineHeight: 20,
                        textAlign: 'center',
                    }}>
                        {t('terminal.webBrowserRequiredDescription')}
                    </Text>
                </View>
            </View>
        );
    }

    // Show loading state while processing hash
    if (!hashProcessed) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }}>
                <View style={{ alignItems: 'center', gap: 12 }}>
                    <ActivityIndicator color={theme.colors.button.primary.background} />
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>
                        {t('terminal.processingConnection')}
                    </Text>
                </View>
            </View>
        );
    }

    if (!auth.isAuthenticated && publicKey) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }}>
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
                    {t('modals.pleaseSignInFirst')}
                </Text>
            </View>
        );
    }

    // Show error if no key found
    if (!publicKey) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }}>
                <View style={{ alignItems: 'center', gap: 8 }}>
                    <Text style={{
                        ...Typography.default('semiBold'),
                        color: theme.colors.textDestructive,
                        fontSize: 16,
                        textAlign: 'center',
                    }}>
                        {t('terminal.invalidConnectionLink')}
                    </Text>
                    <Text style={{
                        ...Typography.default(),
                        color: theme.colors.textSecondary,
                        fontSize: 14,
                        lineHeight: 20,
                        textAlign: 'center',
                    }}>
                        {t('terminal.invalidConnectionLinkDescription')}
                    </Text>
                </View>
            </View>
        );
    }

    // Show confirmation screen for valid connection
    return (
        <View style={{ flex: 1, paddingHorizontal: 24, paddingVertical: 32 }}>
            <View style={{ gap: 24 }}>
                <View style={{ alignItems: 'center', gap: 12 }}>
                    <Text style={{
                        ...Typography.default('semiBold'),
                        fontSize: 20,
                        textAlign: 'center',
                    }}>
                        {t('terminal.connectTerminal')}
                    </Text>
                    <Text style={{
                        ...Typography.default(),
                        color: theme.colors.textSecondary,
                        fontSize: 14,
                        lineHeight: 20,
                        textAlign: 'center',
                    }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>
                </View>

                <View style={{ gap: 8 }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 14 }}>
                        {t('terminal.connectionDetails')}
                    </Text>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 14 }}>
                        {t('terminal.publicKey')}: {publicKey.substring(0, 12)}...
                    </Text>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 14 }}>
                        {t('terminal.encryption')}: {t('terminal.endToEndEncrypted')}
                    </Text>
                </View>

                <View style={{ gap: 12 }}>
                    <Pressable
                        accessibilityRole="button"
                        disabled={isLoading}
                        onPress={handleConnect}
                        style={({ pressed }) => [
                            primaryButtonStyle,
                            { opacity: isLoading ? 0.6 : pressed ? 0.85 : 1 },
                        ]}
                        testID="terminal-connect-approve"
                    >
                        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'center' }}>
                            {isLoading ? <ActivityIndicator color={theme.colors.button.primary.tint} /> : null}
                            <Text style={{
                                ...Typography.default('semiBold'),
                                color: theme.colors.button.primary.tint,
                                fontSize: 16,
                                textAlign: 'center',
                            }}>
                                {isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                            </Text>
                        </View>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        disabled={isLoading}
                        onPress={handleReject}
                        style={({ pressed }) => [
                            secondaryButtonStyle,
                            { opacity: isLoading ? 0.6 : pressed ? 0.85 : 1 },
                        ]}
                        testID="terminal-connect-reject"
                    >
                        <Text style={{
                            ...Typography.default('semiBold'),
                            color: theme.colors.text,
                            fontSize: 16,
                            textAlign: 'center',
                        }}>
                            {t('terminal.reject')}
                        </Text>
                    </Pressable>
                </View>

                <View style={{ gap: 8 }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 14 }}>
                        {t('terminal.security')}
                    </Text>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 }}>
                        {t('terminal.clientSideProcessing')}
                    </Text>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 14, lineHeight: 20 }}>
                        {t('terminal.linkProcessedLocally')}
                    </Text>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 }}>
                        {t('terminal.securityFooter')}
                    </Text>
                </View>
            </View>
        </View>
    );
}
