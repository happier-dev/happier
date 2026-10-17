import * as React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';

import { useAuth } from '@/auth/context/AuthContext';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildDataKeyCredentialsForToken } from '@/auth/flows/buildDataKeyCredentialsForToken';
import { serverFetch } from '@/sync/http/client';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { readConfiguredServerUrlEnv } from '@/sync/domains/server/readConfiguredServerUrlEnv';

const ignoreBrandHeroGetStarted = () => undefined;

function paramString(params: Record<string, unknown>, key: string): string {
    const value = params[key];
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : '';
    }
    if (typeof value === 'string') {
        return value;
    }

    try {
        const search = globalThis.window?.location?.search;
        if (typeof search !== 'string' || !search) return '';
        const parsed = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
        return parsed.get(key) ?? '';
    } catch {
        return '';
    }
}

export default function MtlsCallbackScreen() {
    const auth = useAuth();
    const params = useLocalSearchParams();
    const resolvedError = paramString(params, 'error').trim().toLowerCase();
    const resolvedCode = paramString(params, 'code');

    React.useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                if (resolvedError === 'restore_required') {
                    router.replace('/restore');
                    return;
                }

                if (!resolvedCode.trim()) {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace('/');
                    return;
                }

                const snapshot = getActiveServerSnapshot();
                const rawServerUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
                const serverUrl = rawServerUrl.replace(/\/+$/, '') || readConfiguredServerUrlEnv().replace(/\/+$/, '');
                if (!serverUrl) {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace('/');
                    return;
                }

                const controller = new AbortController();
                const timeoutMs = 15000;
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const res = await serverFetch(
                        `${serverUrl}/v1/auth/mtls/claim`,
                        {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ code: resolvedCode }),
                            signal: controller.signal,
                        },
                        { includeAuth: false },
                    );
                    const json = await res.json().catch(() => null);
                    if (!res.ok || !json || typeof json.token !== 'string') {
                        await Modal.alert(t('common.error'), t('errors.operationFailed'));
                        router.replace('/');
                        return;
                    }

                    const token = String(json.token);
                    const credentials = await buildDataKeyCredentialsForToken(token, json.content);
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
    }, [auth, resolvedCode, resolvedError]);

    return (
        <UnauthenticatedSplitShell
            stepId="mtls-callback"
            isWelcomeStep={false}
            allowMobileBrandHero={false}
            onOpenRelayCustomFlow={() => router.push('/setup')}
            onBrandHeroGetStarted={ignoreBrandHeroGetStarted}
            testID="unauth-shell-route-mtls-callback"
        >
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner />
            </View>
        </UnauthenticatedSplitShell>
    );
}
