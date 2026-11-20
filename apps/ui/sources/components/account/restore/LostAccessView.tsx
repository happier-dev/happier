import * as React from 'react';
import { useFirstRunRouteMove } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { useRouter } from 'expo-router';
import { Linking, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { StepQuietAction } from '@/components/onboarding/unauthShell/StepFormParts';
import { StepPrimaryButton } from '@/components/onboarding/unauthShell/stepBack';
import { StepActions, UnauthenticatedStepHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
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
 * Lost access is a step that titles itself (its mark, heading and what is left on this Home) inside a host that owns
 * its way back (the welcome pane's Back, the setup card's back), then its reset actions.
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
        alignItems: 'center',
    },
}));

export const LostAccessView = React.memo(function LostAccessView(props: LostAccessViewProps) {
    const router = useRouter();
    const moveToRoute = useFirstRunRouteMove();
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

    const openRecoveryKey = () => moveToRoute(() => router.push('/restore/manual'));
    // The step titles itself under its key mark (lab "Lost your key?"): what is left on this Home is its purpose line.
    const heading = (subtitle?: string) => (
        <UnauthenticatedStepHeading
            mark={<StepMark iconName="key" />}
            title={t('setupOnboarding.authLostAccessTitle')}
            subtitle={subtitle}
            subtitleTestID="lost-access-body"
        />
    );

    if (featuresSnapshot.status === 'loading') {
        return (
            <View style={styles.root}>
                {heading()}
                <View style={styles.loading}>
                    <ActivitySpinner size="small" />
                </View>
            </View>
        );
    }

    if (featuresSnapshot.status !== 'ready') {
        return (
            <View style={styles.root}>
                {heading()}
                <SurfaceStateCard
                    testID="lost-access-unavailable"
                    size="line"
                    lineLayout="notice"
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
                />
            </View>
        );
    }

    const features = featuresSnapshot.features;
    const providers = features.features.auth.recovery.providerReset.enabled === true
        ? features.capabilities?.auth?.recovery?.providerReset?.providers ?? []
        : [];

    return (
        <View testID="lost-access-view" style={styles.root}>
            {/* The reset copy describes the reset; a Home that offers none says what is left instead. */}
            {heading(providers.length > 0 ? t('connect.lostAccessBody') : t('connect.lostAccessNoResetBody'))}
            <StepActions>
                {providers.length > 0 ? (
                    <>
                        {providers.map((providerId) => (
                            <StepPrimaryButton
                                key={providerId}
                                testID={`lost-access-provider-${providerId}`}
                                title={t('connect.lostAccessContinue', {
                                    provider: getAuthProvider(providerId)?.displayName ?? providerId,
                                })}
                                onPress={() => startReset(providerId)}
                            />
                        ))}
                        {/* The key is still the quieter way back in (lab "I found my key"). */}
                        <StepQuietAction testID="lost-access-use-key" label={t('connect.restoreWithSecretKeyInstead')}
                            onPress={openRecoveryKey} />
                    </>
                ) : (
                    <StepPrimaryButton testID="lost-access-use-key" title={t('connect.restoreWithSecretKeyInstead')}
                        iconName="key" onPress={openRecoveryKey} />
                )}
            </StepActions>
        </View>
    );
});
