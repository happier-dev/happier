import * as React from 'react';
import { Linking, Platform, ScrollView, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import sodium from '@/encryption/libsodium.lib';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { getAuthProvider } from '@/auth/providers/registry';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { layout } from '@/components/ui/layout/layout';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type {
    AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import {
    guardAccountEncryptionFirstKeyCredentialMutation,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

async function guardOrdinaryAuthIngress(
): Promise<AuthCredentialLifecycleResult> {
    const result =
        await guardAccountEncryptionFirstKeyCredentialMutation();
    return result.kind === 'allowed'
        ? { kind: 'completed' }
        : result;
}

export type LostAccessViewProps = Readonly<{
    onBack: () => void;
    returnTo: string;
    embedded?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.base,
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
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    noticeBody: {
        fontSize: 16,
        color: theme.colors.text.primary,
        lineHeight: 24,
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

export const LostAccessView = React.memo(function LostAccessView(props: LostAccessViewProps) {
    useUnistyles();
    const styles = stylesheet;

    const [providers, setProviders] = React.useState<string[] | null>(null);
    const scrollViewStyle: StyleProp<ViewStyle> = props.embedded
        ? [styles.scrollView, { backgroundColor: 'transparent' }]
        : styles.scrollView;

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
        })(), { tag: 'LostAccessView.loadRecoveryProviders' });
        return () => {
            mounted = false;
        };
    }, []);

    const startReset = React.useCallback(async (providerIdRaw: string) => {
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
            let mayStart = false;
            await presentFirstKeyCredentialLifecycle({
                run: guardOrdinaryAuthIngress,
                onCompleted: () => {
                    mayStart = true;
                },
            });
            if (!mayStart) return;

            const secretBytes = await getRandomBytesAsync(32);
            const secret = encodeBase64(secretBytes, 'base64url');
            const signingKeyPair = sodium.crypto_sign_seed_keypair(secretBytes);
            const publicKey = encodeBase64(signingKeyPair.publicKey);

            const snapshot = getActiveServerSnapshot();
            const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
            const stored =
                await TokenStorage.setPendingExternalAuth({
                    provider: providerId,
                    secret,
                    intent: 'reset',
                    returnTo: props.returnTo,
                    ...(serverUrl ? { serverUrl } : {}),
                });
            if (!stored) {
                const guard =
                    await guardAccountEncryptionFirstKeyCredentialMutation();
                if (guard.kind !== 'allowed') {
                    await presentFirstKeyCredentialLifecycle({
                        run: guardOrdinaryAuthIngress,
                    });
                    return;
                }
                throw new Error(
                    'Failed to persist pending external authentication',
                );
            }

            const url = await provider.getExternalAuthUrl({ mode: 'keyed', publicKey });
            if (!isSafeExternalAuthUrl(url)) {
                throw new Error('unsafe_url');
            }

            if (Platform.OS === 'web') {
                const location = typeof window !== 'undefined' ? window.location : null;
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
    }, [props.returnTo]);

    if (providers === null) {
        return (
            <View style={styles.loading}>
                <ActivitySpinner size="small" />
            </View>
        );
    }

    const content = (
        <View style={styles.container}>
            <View style={styles.contentWrapper}>
                <View style={styles.noticeCard}>
                    <Text style={styles.noticeBody}>{t('connect.lostAccessBody')}</Text>
                </View>

                {providers.length > 0 ? (
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
                ) : null}

                <View style={styles.footer}>
                    <View style={styles.footerButton}>
                        <RoundButton
                            size="normal"
                            title={t('common.back')}
                            display="inverted"
                            onPress={props.onBack}
                        />
                    </View>
                </View>
            </View>
        </View>
    );

    return <ScrollView style={scrollViewStyle} contentContainerStyle={{ flexGrow: 1 }}>{content}</ScrollView>;
});
