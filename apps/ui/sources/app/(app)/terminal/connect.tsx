import React, { useState, useEffect } from 'react';
import { View, Platform } from 'react-native';
import { Text } from '@/components/ui/text/Text';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { clearPendingTerminalConnect, getPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { buildTerminalConnectDeepLink, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
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
            navigateBackOrToHome();
        },
        allowLoopbackServerOverride: true,
    });

    // Extract key from hash on web platform
    useEffect(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined' && !hashProcessed) {
            const parsed = parseTerminalConnectUrl(window.location.href);
            if (parsed?.publicKeyB64Url) {
                setPublicKey(parsed.publicKeyB64Url);

                const activeServerUrl = normalizeServerUrl(getActiveServerUrl());
                const requestedServerUrl = normalizeServerUrl(parsed.serverUrl ?? '');
                const effectiveTarget = resolveEffectiveServerUrlOverride({
                    requestedServerUrl,
                    activeServerUrl,
                    allowLoopbackSwitch: true,
                });
                const desiredServerUrl = effectiveTarget || activeServerUrl || getActiveServerUrl();

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
        const activeServerUrl = normalizeServerUrl(getActiveServerUrl());
        const effectiveTarget = resolveEffectiveServerUrlOverride({
            requestedServerUrl: serverUrlFromHash,
            activeServerUrl,
            allowLoopbackSwitch: true,
        });
        const desiredServerUrl = effectiveTarget || activeServerUrl || getActiveServerUrl();
        setPendingTerminalConnect({
            publicKeyB64Url: publicKey,
            serverUrl: desiredServerUrl,
        });

        fireAndForget((async () => {
            if (effectiveTarget) {
                try {
                    await upsertActivateAndSwitchServer({
                        serverUrl: effectiveTarget,
                        source: 'url',
                        scope: 'device',
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                } catch {
                    // ignore; auth entry route can still proceed and recover later
                }
            }
            router.replace('/');
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
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons 
                            name="laptop-outline" 
                            size={64} 
                            color={theme.colors.textSecondary}
                            style={{ marginBottom: 16 }} 
                        />
                        <Text style={{ 
                            ...Typography.default('semiBold'), 
                            fontSize: 18, 
                            textAlign: 'center',
                            marginBottom: 12 
                        }}>
                            {t('terminal.webBrowserRequired')}
                        </Text>
                        <Text style={{ 
                            ...Typography.default(), 
                            fontSize: 14, 
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            lineHeight: 20 
                        }}>
                            {t('terminal.webBrowserRequiredDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Show loading state while processing hash
    if (!hashProcessed) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>
                            {t('terminal.processingConnection')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    if (!auth.isAuthenticated && publicKey) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
                            {t('modals.pleaseSignInFirst')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Show error if no key found
    if (!publicKey) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{ 
                        alignItems: 'center',
                        paddingVertical: 32,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons 
                            name="warning-outline" 
                            size={48} 
                            color={theme.colors.warningCritical}
                            style={{ marginBottom: 16 }} 
                        />
                        <Text style={{ 
                            ...Typography.default('semiBold'), 
                            fontSize: 16, 
                            color: theme.colors.textDestructive,
                            textAlign: 'center',
                            marginBottom: 8 
                        }}>
                            {t('terminal.invalidConnectionLink')}
                        </Text>
                        <Text style={{ 
                            ...Typography.default(), 
                            fontSize: 14, 
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            lineHeight: 20 
                        }}>
                            {t('terminal.invalidConnectionLinkDescription')}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    // Show confirmation screen for valid connection
    return (
        <ItemList>
            {/* Connection Request Header */}
            <ItemGroup>
                <View style={{ 
                    alignItems: 'center',
                    paddingVertical: 24,
                    paddingHorizontal: 16
                }}>
                    <Ionicons 
                        name="terminal-outline" 
                        size={48} 
                        color={theme.colors.accent.blue}
                        style={{ marginBottom: 16 }} 
                    />
                    <Text style={{ 
                        ...Typography.default('semiBold'), 
                        fontSize: 20, 
                        textAlign: 'center',
                        marginBottom: 12
                    }}>
                        {t('terminal.connectTerminal')}
                    </Text>
                    <Text style={{ 
                        ...Typography.default(), 
                        fontSize: 14, 
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        lineHeight: 20 
                    }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>
                </View>
            </ItemGroup>

            {/* Connection Details */}
            <ItemGroup title={t('terminal.connectionDetails')}>
                <Item
                    title={t('terminal.publicKey')}
                    detail={`${publicKey.substring(0, 12)}...`}
                    icon={<Ionicons name="key-outline" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                />
                <Item
                    title={t('terminal.encryption')}
                    detail={t('terminal.endToEndEncrypted')}
                    icon={<Ionicons name="lock-closed-outline" size={29} color={theme.colors.success} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Action Buttons */}
            <ItemGroup>
                <View style={{ 
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 12 
                }}>
                    <RoundButton
                        testID="terminal-connect-approve"
                        title={isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                        onPress={handleConnect}
                        size="large"
                        disabled={isLoading}
                        loading={isLoading}
                    />
                    <RoundButton
                        testID="terminal-connect-reject"
                        title={t('terminal.reject')}
                        onPress={handleReject}
                        size="large"
                        display="inverted"
                        disabled={isLoading}
                    />
                </View>
            </ItemGroup>

            {/* Security Notice */}
            <ItemGroup 
                title={t('terminal.security')}
                footer={t('terminal.securityFooter')}
            >
                <Item
                    title={t('terminal.clientSideProcessing')}
                    subtitle={t('terminal.linkProcessedLocally')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.success} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}
