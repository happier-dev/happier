import * as React from 'react';
import { useRouter } from 'expo-router';
import { Linking, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import sodium from '@/encryption/libsodium.lib';
import { retryServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { getAuthProvider } from '@/auth/providers/registry';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    captureHomeExternalAuthTarget,
    createHomeOAuthRequestContext,
} from '@/auth/providers/homeExternalAuthTarget';
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

/**
 * Lost access is always a step inside a host that titles it and owns its way back (the welcome pane's
 * chevron, the setup card's back), so the view is its explanation and the reset actions only.
 */
export type LostAccessViewProps = Readonly<{
    returnTo: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: theme.space.s24,
    },
    loading: {
        width: '100%',
        alignItems: 'flex-start',
    },
    // The consequence of a reset, not more of the purpose line above it: it reads in ink.
    body: {
        ...Typography.variant('reading'),
        color: theme.colors.text.primary,
    },
    actions: {
        width: '100%',
        gap: theme.space.s12,
    },
    actionButton: {
        width: '100%',
        maxWidth: 360,
    },
}));

export const LostAccessView = React.memo(function LostAccessView(props: LostAccessViewProps) {
    const router = useRouter();
    useUnistyles();
    const styles = stylesheet;

    const featuresSnapshot = useServerFeaturesRuntimeSnapshot();

    const startReset = React.useCallback(async (providerIdRaw: string) => {
        // Bind reset OAuth to the Home selected when the user initiates it,
        // before confirmation or lifecycle guards can yield to a focus change.
        const target = captureHomeExternalAuthTarget(getActiveServerSnapshot());
        const requestContext = createHomeOAuthRequestContext(target);
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
            if (!requestContext) {
                throw new Error('Home OAuth target is unavailable');
            }
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

            const stored =
                await TokenStorage.setPendingExternalAuth({
                    provider: providerId,
                    secret,
                    intent: 'reset',
                    returnTo: props.returnTo,
                    ...target,
                }, requestContext.target);
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

            const url = await provider.getExternalAuthUrl(
                { mode: 'keyed', publicKey },
                requestContext,
            );
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

    if (featuresSnapshot.status === 'loading') {
        return (
            <View style={styles.loading}>
                <ActivitySpinner size="small" />
            </View>
        );
    }

    if (featuresSnapshot.status !== 'ready') {
        return <SurfaceStateCard
            testID="lost-access-unavailable"
            kind="unavailable"
            title={t('errors.operationFailed')}
            action={{
                testID: 'lost-access-retry',
                label: t('common.retry'),
                onPress: () => fireAndForget(retryServerFeaturesSnapshot({
                    serverId: getActiveServerSnapshot().serverId,
                }), { tag: 'LostAccessView.retryRecoveryProviders' }),
            }}
            accessibilitySemantics="status"
        />;
    }

    const features = featuresSnapshot.features;
    const providers = features.features.auth.recovery.providerReset.enabled === true
        ? features.capabilities?.auth?.recovery?.providerReset?.providers ?? []
        : [];

    return (
        <View testID="lost-access-view" style={styles.root}>
            {/* The reset copy describes the reset; a Home that offers none says what is left instead. */}
            <Text testID="lost-access-body" style={styles.body}>
                {providers.length > 0 ? t('connect.lostAccessBody') : t('connect.lostAccessNoResetBody')}
            </Text>
            {providers.length > 0 ? (
                <View style={styles.actions}>
                    {providers.map((providerId) => (
                        <View key={providerId} style={styles.actionButton}>
                            <RoundButton
                                testID={`lost-access-provider-${providerId}`}
                                size="large"
                                title={t('connect.lostAccessContinue', {
                                    provider: getAuthProvider(providerId)?.displayName ?? providerId,
                                })}
                                action={() => startReset(providerId)}
                            />
                        </View>
                    ))}
                </View>
            ) : (
                <View style={styles.actions}>
                    <View style={styles.actionButton}>
                        <RoundButton
                            testID="lost-access-use-key"
                            size="large"
                            title={t('connect.restoreWithSecretKeyInstead')}
                            action={async () => router.push('/restore/manual')}
                        />
                    </View>
                </View>
            )}
        </View>
    );
});
