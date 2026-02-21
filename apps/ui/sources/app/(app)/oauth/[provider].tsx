import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { authChallenge } from '@/auth/flows/challenge';
import { serverFetch } from '@/sync/http/client';
import { isSessionSharingSupported } from '@/sync/api/capabilities/sessionSharingSupport';
import { getAuthProvider } from '@/auth/providers/registry';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { Text, TextInput } from '@/components/ui/text/Text';
import { buildDataKeyCredentialsForToken } from '@/auth/flows/buildDataKeyCredentialsForToken';


function paramString(params: Record<string, unknown>, key: string): string | null {
    const value = (params as any)[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
    if (typeof value === 'string') return value;

    // Cold-start/hydration on web can temporarily omit search params from expo-router's
    // useLocalSearchParams, even though the URL already contains them. Fall back to
    // window.location.search so the OAuth return page can still finalize.
    try {
        const search = (globalThis as any)?.window?.location?.search;
        if (typeof search !== 'string' || !search) return null;
        const parsed = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
        const fromSearch = parsed.get(key);
        return typeof fromSearch === 'string' ? fromSearch : null;
    } catch {
        return null;
    }
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

function tryResolveProviderIdFromWebPathname(): string | null {
    try {
        const pathname = (globalThis as any)?.window?.location?.pathname;
        if (typeof pathname !== 'string' || !pathname.trim()) return null;
        const match = pathname.match(/\/oauth\/([^/?#]+)/i);
        const provider = match?.[1]?.toString?.().trim?.().toLowerCase?.() ?? '';
        return provider || null;
    } catch {
        return null;
    }
}

function buildRestoreRedirectUrl(params: { providerId: string; reason: 'provider_already_linked' }): string {
    const provider = encodeURIComponent(params.providerId);
    const reason = encodeURIComponent(params.reason);
    return `/restore?provider=${provider}&reason=${reason}`;
}

function normalizeInternalReturnTo(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) return null;
    if (trimmed.startsWith('//')) return null;
    return trimmed;
}

function maybeActivateServerUrl(rawServerUrl: unknown): void {
    const serverUrl = typeof rawServerUrl === 'string' ? rawServerUrl.trim() : '';
    if (!serverUrl) return;

    const active = getActiveServerSnapshot();
    const current = typeof active?.serverUrl === 'string' ? active.serverUrl.trim() : '';
    if (current === serverUrl) return;

    upsertAndActivateServer({ serverUrl, source: 'url', scope: 'tab' });
}

export default function OAuthProviderReturn() {
    const router = useRouter();
    const params = useLocalSearchParams() as any;
    const auth = useAuth();
    const { theme } = useUnistyles();

    const [busy, setBusy] = React.useState(false);
    const [usernameHint, setUsernameHint] = React.useState<string | null>(null);
    const [usernameValue, setUsernameValue] = React.useState<string>('');
    const pendingUsernameContextRef = React.useRef<null | Readonly<{
        providerId: string;
        providerName: string;
        mode: 'keyed' | 'keyless';
        secret: string | null;
        proof: string | null;
        returnTo: string;
        serverUrl?: string;
        basePayload: Record<string, unknown>;
    }>>(null);

    const resolvedProviderId =
        ((paramString(params, 'provider') ?? '').trim().toLowerCase()
            || tryResolveProviderIdFromWebPathname()
            || '').trim().toLowerCase();
    const resolvedFlow = paramString(params, 'flow');
    const resolvedStatus = paramString(params, 'status');
    const resolvedError = paramString(params, 'error');
    const resolvedPending = paramString(params, 'pending') ?? '';
    const resolvedLogin = paramString(params, 'login') ?? '';
    const resolvedReason = paramString(params, 'reason');
    const resolvedMode = paramString(params, 'mode');

    const submitUsername = React.useCallback(() => {
        const ctx = pendingUsernameContextRef.current;
        if (!ctx) {
            router.replace('/');
            return;
        }
        const nextUsername = usernameValue.trim();
        if (!nextUsername) {
            setUsernameHint(t('friends.username.invalid'));
            return;
        }

        fireAndForget((async () => {
            setBusy(true);
            try {
                const base = typeof ctx.serverUrl === 'string' ? ctx.serverUrl.trim().replace(/\/+$/, '') : '';
                const finalizePath =
                    ctx.mode === 'keyless'
                        ? `/v1/auth/external/${encodeURIComponent(ctx.providerId)}/finalize-keyless`
                        : `/v1/auth/external/${encodeURIComponent(ctx.providerId)}/finalize`;
                const url = base ? `${base}${finalizePath}` : finalizePath;
                const response = await serverFetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...ctx.basePayload, username: nextUsername }),
                }, { includeAuth: false });
                const json = await response.json().catch(() => ({}));

                if (response.ok && json?.token) {
                    await TokenStorage.clearPendingExternalAuth();
                    pendingUsernameContextRef.current = null;
                    setUsernameHint(null);
                    maybeActivateServerUrl(ctx.serverUrl);
                    if (ctx.mode === 'keyless') {
                        const credentials = await buildDataKeyCredentialsForToken(json.token);
                        await (auth as any).loginWithCredentials(credentials);
                    } else {
                        await auth.login(json.token, ctx.secret!);
                    }
                    router.replace(ctx.returnTo);
                    return;
                }

                const err = typeof json?.error === 'string' ? json.error : 'token-exchange-failed';
                if (err === 'provider-already-linked') {
                    await TokenStorage.clearPendingExternalAuth();
                    pendingUsernameContextRef.current = null;
                    setUsernameHint(null);
                    router.replace(buildRestoreRedirectUrl({ providerId: ctx.providerId, reason: 'provider_already_linked' }));
                    return;
                }
                if (err === 'restore-required') {
                    await TokenStorage.clearPendingExternalAuth();
                    pendingUsernameContextRef.current = null;
                    setUsernameHint(null);
                    router.replace('/restore');
                    return;
                }
                if (err === 'username-taken') {
                    setUsernameHint(t('friends.username.taken'));
                    return;
                }
                if (err === 'invalid-username' || err === 'username-required') {
                    setUsernameHint(t('friends.username.invalid'));
                    return;
                }
                if (err === 'invalid-pending') {
                    await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                    await TokenStorage.clearPendingExternalAuth();
                    pendingUsernameContextRef.current = null;
                    setUsernameHint(null);
                    router.replace('/');
                    return;
                }

                await Modal.alert(t('common.error'), mapFinalizeErrorToMessage(err));
                await TokenStorage.clearPendingExternalAuth();
                pendingUsernameContextRef.current = null;
                setUsernameHint(null);
                router.replace('/');
            } finally {
                setBusy(false);
            }
        })(), { tag: 'OAuthProviderReturn.submitUsername' });
    }, [auth, router, usernameValue]);

    const cancelUsername = React.useCallback(() => {
        fireAndForget((async () => {
            await TokenStorage.clearPendingExternalAuth();
        })(), { tag: 'OAuthProviderReturn.cancelUsername' });
        pendingUsernameContextRef.current = null;
        setUsernameHint(null);
        setUsernameValue('');
        router.replace('/');
    }, [router]);

    React.useEffect(() => {
        const providerId = resolvedProviderId;
        const flow = resolvedFlow;
        const status = resolvedStatus;
        const error = resolvedError;
        const pendingFromParams = resolvedPending;
        const loginFromParams = resolvedLogin;
        const reasonFromParams = resolvedReason;
        const loginFn = auth.login;
        const credentialsFromAuth = auth.credentials;

        let disposed = false;
        const controller = new AbortController();
        const isAbort = (e: unknown) => {
            if (controller.signal.aborted) return true;
            const name = (e as any)?.name;
            return typeof name === 'string' && name.toLowerCase() === 'aborterror';
        };

        const safeSetBusy = (value: boolean) => {
            if (disposed || controller.signal.aborted) return;
            setBusy(value);
        };
        const safeReplace = (path: string) => {
            if (disposed || controller.signal.aborted) return;
            router.replace(path);
        };

        fireAndForget((async () => {
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
                const pending = pendingFromParams;
                const state = await TokenStorage.getPendingExternalAuth();
                const keyless =
                    (resolvedMode ?? '').toString().trim().toLowerCase() === 'keyless'
                    || state?.mode === 'keyless';
                const secret = typeof state?.secret === 'string' ? state.secret : null;
                const proof = typeof state?.proof === 'string' ? state.proof : null;

                if (!pending || !state || state.provider !== providerId || (keyless ? !proof : !secret)) {
                    await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                    safeReplace('/');
                    return;
                }
                const returnTo = normalizeInternalReturnTo(state.returnTo) ?? '/';

                try {
                    const body: any = keyless
                        ? {
                            pending,
                            proof,
                        }
                        : (() => {
                            const secretBytes = decodeBase64(secret!, 'base64url');
                            const { challenge, signature, publicKey } = authChallenge(secretBytes);
                            const keyedBody: any = {
                                pending,
                                publicKey: encodeBase64(publicKey),
                                challenge: encodeBase64(challenge),
                                signature: encodeBase64(signature),
                            };
                            if (state.intent === 'reset') {
                                keyedBody.reset = true;
                            }
                            return keyedBody;
                        })();

                    if (!keyless) {
                        const secretBytes = decodeBase64(secret!, 'base64url');
                        const supportsSharing = await isSessionSharingSupported({ timeoutMs: 800 });
                        if (supportsSharing) {
                            const binding = await buildContentKeyBinding(secretBytes);
                            body.contentPublicKey = binding.contentPublicKey;
                            body.contentPublicKeySig = binding.contentPublicKeySig;
                        }
                    }

                    const login = loginFromParams;
                    const reason = reasonFromParams;

                    const finalize = async (payload: any) => {
                        safeSetBusy(true);
                        try {
                            const base = typeof state.serverUrl === 'string' ? state.serverUrl.trim().replace(/\/+$/, '') : '';
                            const finalizePath = keyless
                                ? `/v1/auth/external/${encodeURIComponent(providerId)}/finalize-keyless`
                                : `/v1/auth/external/${encodeURIComponent(providerId)}/finalize`;
                            const url = base ? `${base}${finalizePath}` : finalizePath;
                            const response = await serverFetch(url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                signal: controller.signal,
                                body: JSON.stringify(payload),
                            }, { includeAuth: false });
                            const json = await response.json().catch(() => ({}));
                            return { ok: response.ok, status: response.status, json };
                        } finally {
                            safeSetBusy(false);
                        }
	                    };

                    if (status === 'username_required') {
                        const initialHint = reason === 'invalid_login' ? t('friends.username.invalid') : t('friends.username.taken');
                        pendingUsernameContextRef.current = {
                            providerId,
                            providerName: provider.displayName ?? providerId,
                            mode: keyless ? 'keyless' : 'keyed',
                            secret,
                            proof,
                            returnTo,
                            serverUrl: state.serverUrl,
                            basePayload: body,
                        };
                        setUsernameHint(initialHint);
                        setUsernameValue(login || '');
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
                            await TokenStorage.clearPendingExternalAuth();
                            safeReplace(buildRestoreRedirectUrl({ providerId, reason: 'provider_already_linked' }));
                            return;
                        }
                        if (err === 'restore-required') {
                            await TokenStorage.clearPendingExternalAuth();
                            safeReplace('/restore');
                            return;
                        }
                        if (err === 'username-required' || err === 'username-taken') {
                            const initialHint = err === 'username-taken' ? t('friends.username.taken') : t('friends.username.invalid');
                            pendingUsernameContextRef.current = {
                                providerId,
                                providerName: provider.displayName ?? providerId,
                                mode: keyless ? 'keyless' : 'keyed',
                                secret,
                                proof,
                                returnTo,
                                serverUrl: state.serverUrl,
                                basePayload: body,
                            };
                            setUsernameHint(initialHint);
                            setUsernameValue(login || '');
                            return;
                        }

                        await Modal.alert(t('common.error'), mapFinalizeErrorToMessage(err));
                        await TokenStorage.clearPendingExternalAuth();
                        safeReplace('/');
                        return;
                    }

                    await TokenStorage.clearPendingExternalAuth();
                    maybeActivateServerUrl(state.serverUrl);
                    if (keyless) {
                        const credentials = await buildDataKeyCredentialsForToken(res.json.token);
                        await (auth as any).loginWithCredentials(credentials);
                    } else {
                        await loginFn(res.json.token, state.secret!);
                    }
                    safeReplace(returnTo);
                    return;
                } catch (e) {
                    if (isAbort(e)) return;
                    throw e;
                } finally {
                    safeSetBusy(false);
                }
            }

            // connect flow (default)
            const credentials = credentialsFromAuth;
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
        })(), { tag: 'OAuthProviderReturn.handleRedirect' });

        return () => {
            disposed = true;
            controller.abort('oauth-return-disposed');
        };
	    // Keep deps primitive so we don't dispose mid-flight due to param identity changes.
	    }, [
        router,
        resolvedProviderId,
        resolvedFlow,
        resolvedStatus,
        resolvedError,
        resolvedPending,
        resolvedLogin,
        resolvedReason,
        auth.login,
        resolvedFlow === 'auth' ? '' : auth.credentials?.token ?? '',
    ]);

    if (usernameHint != null) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
                <View style={{ width: '100%', maxWidth: 420 }}>
                    <Text style={{ fontSize: 18, marginBottom: 8, color: theme.colors.text }}>{t('profile.username')}</Text>
                    <Text style={{ fontSize: 14, marginBottom: 16, color: theme.colors.textSecondary }}>{usernameHint}</Text>
                    <TextInput
                        testID="oauth-username-input"
                        value={usernameValue}
                        onChangeText={setUsernameValue}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={t('profile.username')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            marginBottom: 12,
                            backgroundColor: theme.colors.input.background,
                            color: theme.colors.input.text,
                        }}
                    />
                    <View style={{ flexDirection: 'row', gap: 12 }}>
                        <Pressable
                            testID="oauth-username-cancel"
                            onPress={cancelUsername}
                            style={{
                                flex: 1,
                                paddingVertical: 10,
                                borderRadius: 8,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text style={{ color: theme.colors.text }}>{t('common.cancel')}</Text>
                        </Pressable>
                        <Pressable
                            testID="oauth-username-save"
                            onPress={submitUsername}
                            style={{
                                flex: 1,
                                paddingVertical: 10,
                                borderRadius: 8,
                                backgroundColor: theme.colors.button.primary.background,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint }}>{t('common.save')}</Text>
                        </Pressable>
                    </View>
                </View>
                {busy ? <ActivityIndicator size="small" style={{ marginTop: 16 }} /> : null}
            </View>
        );
    }

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {busy ? <ActivityIndicator size="small" /> : null}
        </View>
    );
}
