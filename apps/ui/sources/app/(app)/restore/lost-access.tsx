import React from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
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

export default function LostAccess() {
    const router = useRouter();
    const [providers, setProviders] = React.useState<string[] | null>(null);

    React.useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const features = await getReadyServerFeatures();
                const resetGate = features?.features?.auth?.recovery?.providerReset ?? null;
                const providersList = features?.capabilities?.auth?.recovery?.providerReset?.providers ?? [];
                const enabled = resetGate?.enabled === true ? providersList : [];
                if (mounted) setProviders(enabled);
            } catch {
                if (mounted) setProviders([]);
            }
        })();
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
            await TokenStorage.setPendingExternalAuth({ provider: providerId, secret, intent: 'reset' });

            const kp = sodium.crypto_sign_seed_keypair(secretBytes);
            const publicKey = encodeBase64(kp.publicKey, 'base64url');
            const url = await provider.getExternalSignupUrl({ publicKey });
            if (!isSafeExternalAuthUrl(url)) {
                throw new Error('unsafe_url');
            }
            const supported = await Linking.canOpenURL(url);
            if (!supported) {
                throw new Error('unsupported_url');
            }
            await Linking.openURL(url);
        } catch {
            await TokenStorage.clearPendingExternalAuth();
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    };

    if (providers === null) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    if (providers.length === 0) {
        return (
            <View style={{ flex: 1, padding: 24 }}>
                <Text style={{ fontSize: 16 }}>{t('connect.lostAccessBody')}</Text>
                <View style={{ height: 16 }} />
                <RoundButton title={t('common.back')} display="inverted" onPress={() => router.back()} />
            </View>
        );
    }

    return (
        <View style={{ flex: 1, padding: 24 }}>
            <Text style={{ fontSize: 20, fontWeight: '600' }}>{t('connect.lostAccessTitle')}</Text>
            <View style={{ height: 12 }} />
            <Text style={{ fontSize: 16 }}>{t('connect.lostAccessBody')}</Text>
            <View style={{ height: 24 }} />
            {providers.map((providerId) => (
                <View key={providerId} style={{ marginBottom: 12 }}>
                    <RoundButton
                        title={t('connect.lostAccessContinue', {
                            provider: getAuthProvider(providerId)?.displayName ?? providerId,
                        })}
                        action={() => startReset(providerId)}
                    />
                </View>
            ))}
            <View style={{ height: 12 }} />
            <RoundButton title={t('common.back')} display="inverted" onPress={() => router.back()} />
        </View>
    );
}
