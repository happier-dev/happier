import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildDataKeyCredentialsForToken } from '@/auth/flows/buildDataKeyCredentialsForToken';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';

export default function MtlsCallbackScreen() {
    const auth = useAuth();
    const params = useLocalSearchParams();

    React.useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const code = typeof params.code === 'string' ? params.code : '';
                if (!code.trim()) {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace('/');
                    return;
                }

                const snapshot = getActiveServerSnapshot();
                const rawServerUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
                const serverUrl = rawServerUrl.replace(/\/+$/, '');
                if (!serverUrl) {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace('/');
                    return;
                }

                const controller = new AbortController();
                const timeoutMs = 15000;
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const res = await fetch(`${serverUrl}/v1/auth/mtls/claim`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ code }),
                        signal: controller.signal,
                    });
                    const json = await res.json().catch(() => null);
                    if (!res.ok || !json || typeof json.token !== 'string') {
                        await Modal.alert(t('common.error'), t('errors.operationFailed'));
                        router.replace('/');
                        return;
                    }

                    const token = String(json.token);
                    const credentials = await buildDataKeyCredentialsForToken(token);
                    await auth.loginWithCredentials(credentials);
                    if (!mounted) return;
                    router.replace('/');
                } finally {
                    clearTimeout(timer);
                }
            } catch (error) {
                const message = process.env.EXPO_PUBLIC_DEBUG
                    ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                    : t('errors.operationFailed');
                await Modal.alert(t('common.error'), message);
                router.replace('/');
            }
        })();
        return () => {
            mounted = false;
        };
    }, [auth, params.code]);

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator />
        </View>
    );
}

