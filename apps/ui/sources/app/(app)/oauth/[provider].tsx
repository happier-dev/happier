import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { authChallenge } from '@/auth/flows/challenge';
import { serverFetch } from '@/sync/http/client';
import { isSessionSharingSupported } from '@/sync/api/capabilities/apiFeatures';
import { getAuthProvider } from '@/auth/providers/registry';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';

function paramString(params: Record<string, unknown>, key: string): string | null {
    const value = (params as any)[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
    return typeof value === 'string' ? value : null;
}

function mapUsernameErrorToMessage(code: string): string {
    switch (code) {
        case 'username-taken':
            return t('friends.username.taken');
        case 'invalid-username':
        case 'username-required':
            return t('friends.username.invalid');
        case 'username-disabled':
            return t('friends.username.disabled');
        case 'friends-disabled':
            return t('friends.disabled');
        default:
            return t('errors.tokenExchangeFailed');
    }
}

function mapFinalizeErrorToMessage(code: string): string {
    switch (code) {
        case 'username-taken':
        case 'invalid-username':
        case 'username-required':
        case 'username-disabled':
        case 'friends-disabled':
            return mapUsernameErrorToMessage(code);
        case 'invalid-pending':
            return t('errors.oauthStateMismatch');
        default:
            return t('errors.tokenExchangeFailed');
    }
}

export default function OAuthProviderReturn() {
    const router = useRouter();
    const params = useLocalSearchParams() as any;
    const auth = useAuth();

    const [busy, setBusy] = React.useState(false);
    const handledRef = React.useRef(false);

    React.useEffect(() => {
        if (handledRef.current) return;
        handledRef.current = true;

        let cancelled = false;
        const safeSetBusy = (value: boolean) => {
            if (!cancelled) setBusy(value);
        };
        const safeReplace = (path: string) => {
            if (!cancelled) router.replace(path);
        };

        void (async () => {
            const providerId = (paramString(params, 'provider') ?? '').trim().toLowerCase();
            if (!providerId) {
                safeReplace('/');
                return;
            }
            const provider = getAuthProvider(providerId);
            if (!provider) {
                await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                safeReplace('/');
                return;
            }

            const flow = paramString(params, 'flow');
            const status = paramString(params, 'status');
            const error = paramString(params, 'error');
            if (error) {
                const providerName = provider.displayName ?? providerId;
                const message =
                    error === 'oauth_not_configured'
                        ? t('friends.providerGate.notConfigured', { provider: providerName })
                        : error === 'invalid_state'
                            ? t('errors.oauthStateMismatch')
                            : error;
                await Modal.alert(t('common.error'), message);
                if (flow !== 'auth') {
                    await TokenStorage.clearPendingExternalConnect();
                }
                safeReplace(flow === 'auth' ? '/' : '/settings/account');
                return;
            }

            if (flow === 'auth') {
                const pending = paramString(params, 'pending') ?? '';
                const state = await TokenStorage.getPendingExternalAuth();
                if (!pending || !state || state.provider !== providerId || !state.secret) {
                    await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                    safeReplace('/');
                    return;
                }

                try {
                    const secretBytes = decodeBase64(state.secret, 'base64url');
                    const { challenge, signature, publicKey } = authChallenge(secretBytes);

                    const body: any = {
                        pending,
                        publicKey: encodeBase64(publicKey),
                        challenge: encodeBase64(challenge),
                        signature: encodeBase64(signature),
                    };
                    if (state.intent === 'reset') {
                        body.reset = true;
                    }

                    const supportsSharing = await isSessionSharingSupported({ timeoutMs: 800 });
                    if (supportsSharing) {
                        const binding = await buildContentKeyBinding(secretBytes);
                        body.contentPublicKey = binding.contentPublicKey;
                        body.contentPublicKeySig = binding.contentPublicKeySig;
                    }

                    const login = paramString(params, 'login') ?? '';
                    const reason = paramString(params, 'reason');

                    const finalize = async (payload: any) => {
                        safeSetBusy(true);
                        try {
                            const response = await serverFetch(`/v1/auth/external/${encodeURIComponent(providerId)}/finalize`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload),
                            }, { includeAuth: false });
                            const json = await response.json().catch(() => ({}));
                            return { ok: response.ok, status: response.status, json };
                        } finally {
                            safeSetBusy(false);
                        }
                    };

                    const promptForUsername = async (params: { hint: string; defaultValue?: string }) => {
                        return await Modal.prompt(
                            t('profile.username'),
                            params.hint,
                            {
                                placeholder: t('profile.username'),
                                defaultValue: params.defaultValue,
                                confirmText: t('common.save'),
                                cancelText: t('common.cancel'),
                            },
                        );
                    };

                    const runUsernameLoop = async (params: { initialHint: string; initialDefaultValue?: string }) => {
                        let hint = params.initialHint;
                        let defaultValue = params.initialDefaultValue;

                        while (true) {
                            const username = await promptForUsername({ hint, defaultValue });
                            if (username == null) {
                                await TokenStorage.clearPendingExternalAuth();
                                safeReplace('/');
                                return;
                            }

                            const res = await finalize({ ...body, username });
                            if (res.ok && res.json?.token) {
                                await TokenStorage.clearPendingExternalAuth();
                                if (cancelled) return;
                                await auth.login(res.json.token, state.secret);
                                if (cancelled) return;
                                safeReplace('/friends');
                                return;
                            }

                            const err =
                                typeof res.json?.error === 'string'
                                    ? res.json.error
                                    : 'token-exchange-failed';
                            if (err === 'provider-already-linked') {
                                const providerName = provider.displayName ?? providerId;
                                await Modal.alert(t('common.error'), t('errors.providerAlreadyLinked', { provider: providerName }));
                                await TokenStorage.clearPendingExternalAuth();
                                safeReplace('/restore');
                                return;
                            }
                            if (err === 'username-taken') {
                                hint = t('friends.username.taken');
                                defaultValue = username;
                                continue;
                            }
                            if (err === 'invalid-username' || err === 'username-required') {
                                hint = t('friends.username.invalid');
                                defaultValue = username;
                                continue;
                            }
                            if (err === 'invalid-pending') {
                                await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                                await TokenStorage.clearPendingExternalAuth();
                                safeReplace('/');
                                return;
                            }

                            await Modal.alert(t('common.error'), mapFinalizeErrorToMessage(err));
                            await TokenStorage.clearPendingExternalAuth();
                            safeReplace('/');
                            return;
                        }
                    };

                    if (status === 'username_required') {
                        const initialHint = reason === 'invalid_login' ? t('friends.username.invalid') : t('friends.username.taken');
                        await runUsernameLoop({ initialHint, initialDefaultValue: login || undefined });
                        return;
                    }

                    const res = await finalize(body);
                    if (!res.ok || !res.json?.token) {
                        const err =
                            typeof res.json?.error === 'string'
                                ? res.json.error
                                : 'token-exchange-failed';
                        if (err === 'provider-already-linked') {
                            const providerName = provider.displayName ?? providerId;
                            await Modal.alert(t('common.error'), t('errors.providerAlreadyLinked', { provider: providerName }));
                            await TokenStorage.clearPendingExternalAuth();
                            safeReplace('/restore');
                            return;
                        }
                        if (err === 'username-required' || err === 'username-taken') {
                            const initialHint = err === 'username-taken' ? t('friends.username.taken') : t('friends.username.invalid');
                            await runUsernameLoop({ initialHint, initialDefaultValue: login || undefined });
                            return;
                        }

                        await Modal.alert(t('common.error'), mapFinalizeErrorToMessage(err));
                        await TokenStorage.clearPendingExternalAuth();
                        safeReplace('/');
                        return;
                    }

                    await TokenStorage.clearPendingExternalAuth();
                    if (cancelled) return;
                    await auth.login(res.json.token, state.secret);
                    if (cancelled) return;
                    safeReplace('/friends');
                    return;
                } finally {
                    safeSetBusy(false);
                }
            }

            // connect flow (default)
            const credentials = auth.credentials;
            const pendingConnect = await TokenStorage.getPendingExternalConnect();
            const connectReturnTo =
                pendingConnect && pendingConnect.provider === providerId && typeof pendingConnect.returnTo === 'string' && pendingConnect.returnTo.trim().startsWith('/')
                    ? pendingConnect.returnTo.trim()
                    : '/settings/account';
            const finalizeConnectNavigation = async () => {
                await TokenStorage.clearPendingExternalConnect();
                safeReplace(connectReturnTo);
            };
            if (status === 'connected') {
                await finalizeConnectNavigation();
                return;
            }

            if (status !== 'username_required') {
                await finalizeConnectNavigation();
                return;
            }

            const pending = paramString(params, 'pending') ?? '';
            const login = paramString(params, 'login') ?? '';
            const reason = paramString(params, 'reason');
            if (!credentials || !pending) {
                await Modal.alert(t('common.error'), t('friends.username.required'));
                await finalizeConnectNavigation();
                return;
            }

            let hint = reason === 'invalid_login' ? t('friends.username.invalid') : t('friends.username.taken');
            let defaultValue = login || undefined;

            while (true) {
                const next = await Modal.prompt(
                        t('profile.username'),
                        hint,
                        {
                            placeholder: t('profile.username'),
                            defaultValue,
                            confirmText: t('common.save'),
                            cancelText: t('common.cancel'),
                    },
                );

                if (next == null) {
                    try {
                        await provider.cancelConnectPending(credentials, pending);
                    } catch {
                        await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    } finally {
                        await finalizeConnectNavigation();
                    }
                    return;
                }

                try {
                    safeSetBusy(true);
                    await provider.finalizeConnect(credentials, { pending, username: next });
                    await finalizeConnectNavigation();
                    return;
                } catch (e) {
                    if (e instanceof HappyError) {
                        if (e.message === 'username-taken') {
                            hint = t('friends.username.taken');
                            defaultValue = next;
                            continue;
                        }
                        if (e.message === 'invalid-username') {
                            hint = t('friends.username.invalid');
                            defaultValue = next;
                            continue;
                        }
                        if (e.message === 'invalid-pending') {
                            await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                            await finalizeConnectNavigation();
                            return;
                        }
                        await Modal.alert(t('common.error'), mapFinalizeErrorToMessage(e.message));
                        await finalizeConnectNavigation();
                        return;
                    }

                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    await finalizeConnectNavigation();
                    return;
                } finally {
                    safeSetBusy(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [auth, params, router]);

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {busy ? <ActivityIndicator size="small" /> : null}
        </View>
    );
}
