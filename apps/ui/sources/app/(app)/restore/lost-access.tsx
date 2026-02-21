import React from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { t } from '@/text';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getAuthProvider } from '@/auth/providers/registry';
import { Modal } from '@/modal';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/ui/layout/layout';
import { useUnistyles } from 'react-native-unistyles';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { Text } from '@/components/ui/text/Text';


export default function LostAccess() {
    useUnistyles();
    const router = useRouter();
    const [providers, setProviders] = React.useState<string[] | null>(null);

    const styles = stylesheet;

    React.useEffect(() => {
        let mounted = true;
        fireAndForget((async () => {
            try {
                const features = await getReadyServerFeatures();
                const resetGate = features?.features?.auth?.recovery?.providerReset ?? null;
                const providersList = features?.capabilities?.auth?.recovery?.providerReset?.providers ?? [];
                const enabled = resetGate?.enabled === true ? providersList : [];
                if (mounted) setProviders(enabled);
            } catch {
                if (mounted) setProviders([]);
            }
        })(), { tag: 'LostAccess.loadRecoveryProviders' });
        return () => {
            mounted = false;
        };
    }, []);

    const startReset = async (providerIdRaw: string) => {
        const providerId = providerIdRaw.trim().toLowerCase();
        const provider = getAuthProvider(providerId);
        if (!provider) {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
            return;
        }

        const ok = await Modal.confirm(
            t('connect.lostAccessConfirmTitle'),
            t('connect.lostAccessConfirmBody'),
            { confirmText: t('connect.lostAccessConfirmButton'), destructive: true },
        );
        if (!ok) return;

        try {
            const secretBytes = await getRandomBytesAsync(32);
            const secret = encodeBase64(secretBytes, 'base64url');
            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            await TokenStorage.setPendingExternalAuth({
                provider: providerId,
                secret,
                intent: 'reset',
                returnTo: '/',
                ...(serverUrl ? { serverUrl } : {}),
            });

            const kp = sodium.crypto_sign_seed_keypair(secretBytes);
            // Server expects standard base64 (not base64url) for `publicKey`.
            const publicKey = encodeBase64(kp.publicKey);
            const url = await provider.getExternalSignupUrl({ publicKey });
            if (!isSafeExternalAuthUrl(url)) {
                throw new Error('unsafe_url');
            }

            if (Platform.OS === 'web') {
                const location = (globalThis as any)?.window?.location;
                if (location && typeof location.assign === 'function') {
                    location.assign(url);
                    return;
                }
                if (location && typeof location.href === 'string') {
                    location.href = url;
                    return;
                }
            }

            const supported = await Linking.canOpenURL(url);
            if (!supported) throw new Error('unsupported_url');
            await Linking.openURL(url);
        } catch (error) {
            await TokenStorage.clearPendingExternalAuth();
            const message = process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed');
            await Modal.alert(t('common.error'), message);
        }
    };

    if (providers === null) {
        return (
            <View style={styles.loading}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    if (providers.length === 0) {
        return (
            <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
                <View style={styles.container}>
                    <View style={styles.contentWrapper}>
                        <View style={styles.noticeCard}>
                            <Text style={styles.noticeBody}>{t('connect.lostAccessBody')}</Text>
                        </View>
                        <View style={styles.footer}>
                            <View style={styles.footerButton}>
                                <RoundButton size="normal" title={t('common.back')} display="inverted" onPress={() => router.back()} />
                            </View>
                        </View>
                    </View>
                </View>
            </ScrollView>
        );
    }

    return (
        <ScrollView style={styles.scrollView} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <View style={styles.noticeCard}>
                        <Text style={styles.noticeBody}>{t('connect.lostAccessBody')}</Text>
                    </View>

                    <View style={styles.actions}>
                        {providers.map((providerId) => (
                            <View key={providerId} style={styles.actionButton}>
                                <RoundButton
                                    testID={`lost-access-provider-${providerId}`}
                                    size="normal"
                                    title={t('connect.lostAccessContinue', {
                                        provider: getAuthProvider(providerId)?.displayName ?? providerId,
                                    })}
                                    action={() => startReset(providerId)}
                                />
                            </View>
                        ))}
                    </View>

                    <View style={styles.footer}>
                        <View style={styles.footerButton}>
                            <RoundButton size="normal" title={t('common.back')} display="inverted" onPress={() => router.back()} />
                        </View>
                    </View>
                </View>
            </View>
        </ScrollView>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: Math.min(560, layout.maxWidth),
        paddingVertical: 28,
    },
    noticeCard: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface,
    },
    noticeBody: {
        fontSize: 15,
        color: theme.colors.text,
        lineHeight: 21,
        ...Typography.default(),
    },
    actions: {
        marginTop: 18,
        alignItems: 'center',
        width: '100%',
    },
    actionButton: {
        width: '100%',
        maxWidth: 360,
        marginTop: 12,
    },
    footer: {
        marginTop: 18,
        alignItems: 'center',
        width: '100%',
    },
    footerButton: {
        width: '100%',
        maxWidth: 360,
    },
}));
