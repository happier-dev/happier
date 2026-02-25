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
import { getRandomBytes } from '@/platform/cryptoRandom';


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

function resolveProvisioningModes(raw: string | null): Readonly<{ allowPlain: boolean; allowE2ee: boolean }> {
    if (raw == null) {
        // Back-compat: older servers don't include provisioningModes, so assume both options.
        return { allowPlain: true, allowE2ee: true };
    }

    const modes = raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    const set = new Set(modes);

    return { allowPlain: set.has('plain'), allowE2ee: set.has('e2ee') };
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
    const [provisioningChoiceOpen, setProvisioningChoiceOpen] = React.useState(false);
    const pendingAuthContextRef = React.useRef<null | Readonly<{
        providerId: string;
        providerName: string;
        pending: string;
        proof: string | null;
        secret: string | null;
        intent: 'signup' | 'reset' | null;
        returnTo: string;
        serverUrl?: string;
        storagePolicy: string | null;
        provisioning: string | null;
        provisioningModes: string | null;
        accountMode: string | null;
        username: string | null;
        chosenMode: 'plain' | 'e2ee' | null;
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
    const resolvedStoragePolicy = paramString(params, 'storagePolicy');
    const resolvedProvisioning = paramString(params, 'provisioning');
    const resolvedProvisioningModes = paramString(params, 'provisioningModes');
    const resolvedAccountMode = paramString(params, 'accountMode');

    const finalizeAuth = React.useCallback((params: { mode: 'plain' | 'e2ee' }) => {
        const ctx = pendingAuthContextRef.current;
        if (!ctx) {
            router.replace('/');
            return;
        }

        fireAndForget((async () => {
            setBusy(true);
            try {
                if (params.mode === 'plain' && !ctx.proof) {
                    await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                    await TokenStorage.clearPendingExternalAuth();
                    pendingAuthContextRef.current = null;
                    router.replace('/');
                    return;
                }

                let secret = ctx.secret;
                if (params.mode === 'e2ee' && !secret) {
                    const seed = getRandomBytes(32);
                    secret = encodeBase64(seed, 'base64url');
                    await TokenStorage.setPendingExternalAuth({
                        provider: ctx.providerId,
                        ...(ctx.proof ? { proof: ctx.proof } : {}),
                        secret,
                        ...(ctx.intent ? { intent: ctx.intent } : {}),
                        ...(ctx.serverUrl ? { serverUrl: ctx.serverUrl } : {}),
                        ...(ctx.returnTo ? { returnTo: ctx.returnTo } : {}),
                    });
                    pendingAuthContextRef.current = { ...ctx, secret };
                }

                const base = typeof ctx.serverUrl === 'string' ? ctx.serverUrl.trim().replace(/\/+$/, '') : '';
                const finalizePath =
                    params.mode === 'plain'
                        ? `/v1/auth/external/${encodeURIComponent(ctx.providerId)}/finalize-keyless`
                        : `/v1/auth/external/${encodeURIComponent(ctx.providerId)}/finalize`;
                const url = base ? `${base}${finalizePath}` : finalizePath;

                const payload: any =
                    params.mode === 'plain'
                        ? {
                            pending: ctx.pending,
                            proof: ctx.proof,
                            ...(ctx.username ? { username: ctx.username } : {}),
                        }
                        : (() => {
                            const secretBytes = decodeBase64(secret!, 'base64url');
                            const { challenge, signature, publicKey } = authChallenge(secretBytes);
                            const keyedBody: any = {
                                pending: ctx.pending,
                                publicKey: encodeBase64(publicKey),
                                challenge: encodeBase64(challenge),
                                signature: encodeBase64(signature),
                                ...(ctx.proof ? { proof: ctx.proof } : {}),
                                ...(ctx.username ? { username: ctx.username } : {}),
                            };
                            if (ctx.intent === 'reset') {
                                keyedBody.reset = true;
                            }
                            return keyedBody;
                        })();

                if (params.mode === 'e2ee') {
                    const secretBytes = decodeBase64(secret!, 'base64url');
                    const supportsSharing = await isSessionSharingSupported({ timeoutMs: 800 });
                    if (supportsSharing) {
                        const binding = await buildContentKeyBinding(secretBytes);
                        payload.contentPublicKey = binding.contentPublicKey;
                        payload.contentPublicKeySig = binding.contentPublicKeySig;
                    }
                }

                const response = await serverFetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                }, { includeAuth: false });
                const json = await response.json().catch(() => ({}));

                if (response.ok && json?.token) {
                    await TokenStorage.clearPendingExternalAuth();
                    pendingAuthContextRef.current = null;
                    setUsernameHint(null);
                    setProvisioningChoiceOpen(false);
                    maybeActivateServerUrl(ctx.serverUrl);
                    if (params.mode === 'plain') {
                        const credentials = await buildDataKeyCredentialsForToken(json.token);
                        await (auth as any).loginWithCredentials(credentials);
                    } else {
                        await auth.login(json.token, secret!);
                    }
                    router.replace(ctx.returnTo);
                    return;
                }

                const err = typeof json?.error === 'string' ? json.error : 'token-exchange-failed';
                if (err === 'provider-already-linked') {
                    await TokenStorage.clearPendingExternalAuth();
                    pendingAuthContextRef.current = null;
                    router.replace(buildRestoreRedirectUrl({ providerId: ctx.providerId, reason: 'provider_already_linked' }));
                    return;
                }
                if (err === 'restore-required') {
                    await TokenStorage.clearPendingExternalAuth();
                    pendingAuthContextRef.current = null;
                    router.replace('/restore');
                    return;
                }
                if (err === 'username-required' || err === 'username-taken') {
                    const initialHint = err === 'username-taken' ? t('friends.username.taken') : t('friends.username.invalid');
                    setUsernameHint(initialHint);
                    return;
                }
                if (err === 'invalid-pending') {
                    await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                    await TokenStorage.clearPendingExternalAuth();
                    pendingAuthContextRef.current = null;
                    router.replace('/');
                    return;
                }

                await Modal.alert(t('common.error'), mapFinalizeErrorToMessage(err));
                await TokenStorage.clearPendingExternalAuth();
                pendingAuthContextRef.current = null;
                router.replace('/');
            } finally {
                setBusy(false);
            }
        })(), { tag: 'OAuthProviderReturn.finalizeAuth' });
    }, [auth, router]);

    const submitUsername = React.useCallback(() => {
        const ctx = pendingAuthContextRef.current;
        if (!ctx) {
            router.replace('/');
            return;
        }
        const nextUsername = usernameValue.trim();
        if (!nextUsername) {
            setUsernameHint(t('friends.username.invalid'));
            return;
        }

        const nextCtx = { ...ctx, username: nextUsername };
        pendingAuthContextRef.current = nextCtx;
        setUsernameHint(null);

        if (nextCtx.accountMode === 'e2ee') {
            router.replace('/restore');
            return;
        }
        if (nextCtx.accountMode === 'plain') {
            finalizeAuth({ mode: 'plain' });
            return;
        }
        if (nextCtx.provisioning === 'required') {
            const modes = resolveProvisioningModes(nextCtx.provisioningModes);
            if (nextCtx.storagePolicy === 'optional') {
                if (modes.allowPlain && modes.allowE2ee) {
                    setProvisioningChoiceOpen(true);
                    return;
                }
                if (modes.allowPlain) {
                    finalizeAuth({ mode: 'plain' });
                    return;
                }
                if (modes.allowE2ee) {
                    finalizeAuth({ mode: 'e2ee' });
                    return;
                }

                fireAndForget((async () => {
                    await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                    await TokenStorage.clearPendingExternalAuth();
                })(), { tag: 'OAuthProviderReturn.provisioningModesUnavailable' });
                pendingAuthContextRef.current = null;
                router.replace('/');
                return;
            }
            if (nextCtx.storagePolicy === 'plaintext_only') {
                finalizeAuth({ mode: 'plain' });
                return;
            }
            finalizeAuth({ mode: 'e2ee' });
            return;
        }

        finalizeAuth({ mode: nextCtx.secret ? 'e2ee' : 'plain' });
    }, [finalizeAuth, router, usernameValue]);

    const cancelUsername = React.useCallback(() => {
        fireAndForget((async () => {
            await TokenStorage.clearPendingExternalAuth();
        })(), { tag: 'OAuthProviderReturn.cancelUsername' });
        pendingAuthContextRef.current = null;
        setUsernameHint(null);
        setUsernameValue('');
        setProvisioningChoiceOpen(false);
        router.replace('/');
    }, [router]);

    const chooseProvisioningMode = React.useCallback((mode: 'plain' | 'e2ee') => {
        const ctx = pendingAuthContextRef.current;
        if (!ctx) {
            router.replace('/');
            return;
        }
        pendingAuthContextRef.current = { ...ctx, chosenMode: mode };
        setProvisioningChoiceOpen(false);
        finalizeAuth({ mode });
    }, [finalizeAuth, router]);

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
                const secret = typeof state?.secret === 'string' ? state.secret : null;
                const proof = typeof state?.proof === 'string' ? state.proof : null;

                if (!pending || !state || state.provider !== providerId || (!proof && !secret)) {
                    await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                    safeReplace('/');
                    return;
                }
                const returnTo = normalizeInternalReturnTo(state.returnTo) ?? '/';

                try {
                    const login = loginFromParams;
                    pendingAuthContextRef.current = {
                        providerId,
                        providerName: provider.displayName ?? providerId,
                        pending,
                        proof,
                        secret,
                        intent: (state.intent as any) ?? null,
                        returnTo,
                        serverUrl: state.serverUrl,
                        storagePolicy: resolvedStoragePolicy,
                        provisioning: resolvedProvisioning,
                        provisioningModes: resolvedProvisioningModes,
                        accountMode: resolvedAccountMode,
                        username: null,
                        chosenMode: null,
                    };

                    if (status === 'username_required') {
                        const reason = reasonFromParams;
                        const initialHint = reason === 'invalid_login' ? t('friends.username.invalid') : t('friends.username.taken');
                        setUsernameHint(initialHint);
                        setUsernameValue(login || '');
                        return;
                    }

                    if (resolvedAccountMode === 'e2ee') {
                        safeReplace('/restore');
                        return;
                    }

                    if (resolvedAccountMode === 'plain') {
                        finalizeAuth({ mode: 'plain' });
                        return;
                    }

                    if (resolvedProvisioning === 'required') {
                        const modes = resolveProvisioningModes(resolvedProvisioningModes);
                        if (resolvedStoragePolicy === 'optional') {
                            if (modes.allowPlain && modes.allowE2ee) {
                                setProvisioningChoiceOpen(true);
                                return;
                            }
                            if (modes.allowPlain) {
                                finalizeAuth({ mode: 'plain' });
                                return;
                            }
                            if (modes.allowE2ee) {
                                finalizeAuth({ mode: 'e2ee' });
                                return;
                            }

                            await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                            await TokenStorage.clearPendingExternalAuth();
                            pendingAuthContextRef.current = null;
                            safeReplace('/');
                            return;
                        }
                        if (resolvedStoragePolicy === 'plaintext_only') {
                            finalizeAuth({ mode: 'plain' });
                            return;
                        }
                        finalizeAuth({ mode: 'e2ee' });
                        return;
                    }

                    const fallbackKeyless = (resolvedMode ?? '').toString().trim().toLowerCase() === 'keyless';
                    if (fallbackKeyless && proof) {
                        finalizeAuth({ mode: 'plain' });
                        return;
                    }

                    finalizeAuth({ mode: secret ? 'e2ee' : 'plain' });
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

    if (provisioningChoiceOpen) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
                <View style={{ width: '100%', maxWidth: 420 }}>
                    <Text style={{ fontSize: 18, marginBottom: 8, color: theme.colors.text }}>
                        {t('welcome.chooseEncryptionTitle')}
                    </Text>
                    <Text style={{ fontSize: 14, marginBottom: 16, color: theme.colors.textSecondary }}>
                        {t('welcome.chooseEncryptionBody')}
                    </Text>

                    <View style={{ flexDirection: 'column', gap: 12 }}>
                        <Pressable
                            testID="oauth-provisioning-choice-e2ee"
                            onPress={() => chooseProvisioningMode('e2ee')}
                            style={{
                                paddingVertical: 10,
                                borderRadius: 8,
                                backgroundColor: theme.colors.button.primary.background,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint }}>
                                {t('welcome.chooseEncryptionEncrypted')}
                            </Text>
                        </Pressable>

                        <Pressable
                            testID="oauth-provisioning-choice-plain"
                            onPress={() => chooseProvisioningMode('plain')}
                            style={{
                                paddingVertical: 10,
                                borderRadius: 8,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text style={{ color: theme.colors.text }}>
                                {t('welcome.chooseEncryptionPlain')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
                {busy ? <ActivityIndicator size="small" style={{ marginTop: 16 }} /> : null}
            </View>
        );
    }

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
