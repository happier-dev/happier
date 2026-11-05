import * as React from 'react';
import { AccountCredentialJourney } from '@/components/account/auth/AccountCredentialJourney';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { authGetTokenAtEndpoint, type AuthGetTokenAtEndpointParams } from '@/auth/flows/getToken';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { t } from '@/text';
import { trackAccountRestored } from '@/track';
import { SecretKeyEntryForm, type SecretKeyEntrySubmitResult } from './SecretKeyEntryForm';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import {
    guardAccountEncryptionFirstKeyCredentialMutation,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type SecretKeyLoginTarget = Readonly<Pick<AuthGetTokenAtEndpointParams,
    'endpointUrl' | 'serverId' | 'runtimeOrigin' | 'homeCarrier' | 'signal' | 'requireKeyChallengeV2' | 'expectedAccountId' | 'admission'
> & { canonicalServerUrl: string; serverIdentityId: string }>;

export type SecretKeyLoginFormProps = Readonly<{
    embedded?: boolean;
    returnTo?: string;
    onSuccess?: () => void;
    submitTitle?: string;
} & (
    | { target: SecretKeyLoginTarget; onAuthenticated: (credentials: AuthCredentials) => void | Promise<void> }
    | { target?: undefined; onAuthenticated?: undefined }
)>;

const stylesheet = StyleSheet.create(() => ({
    container: {
        width: '100%',
        backgroundColor: 'transparent',
    },
}));

export const SecretKeyLoginForm = React.memo(function SecretKeyLoginForm(props: SecretKeyLoginFormProps) {
    return <AccountCredentialJourney request={props.target?.expectedAccountId ? null : {
        kind: 'home', profileRef: props.target?.serverId ?? getActiveServerSnapshot().serverId, returnTo: props.returnTo ?? '/',
    }}><SecretKeyLoginFormBody {...props} /></AccountCredentialJourney>;
});

const SecretKeyLoginFormBody = React.memo(function SecretKeyLoginFormBody(props: SecretKeyLoginFormProps) {
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const mountedRef = React.useRef(true);
    const authenticationControllerRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            authenticationControllerRef.current?.abort();
        };
    }, []);
    // Callers compose target props inline. Only a real target/contract change
    // retires the attempt; a fresh object describing the same Home does not.
    React.useEffect(() => () => authenticationControllerRef.current?.abort(), [
        props.target?.endpointUrl,
        props.target?.canonicalServerUrl,
        props.target?.serverId,
        props.target?.serverIdentityId,
        props.target?.runtimeOrigin,
        props.target?.homeCarrier,
        props.target?.expectedAccountId,
        props.target?.requireKeyChallengeV2,
        props.target?.admission?.kind,
        props.target?.admission?.token,
        props.target?.signal,
    ]);

    const handleSuccess = React.useCallback(() => {
        if (props.onSuccess) {
            props.onSuccess();
            return;
        }
        router.dismissTo('/');
    }, [props.onSuccess, router]);

    const handleLogin = React.useCallback(async (input: Readonly<{
        normalizedKey: string;
        secret: Uint8Array;
    }>): Promise<SecretKeyEntrySubmitResult> => {
        let home = props.target?.canonicalServerUrl;
        const controller = new AbortController();
        authenticationControllerRef.current = controller;
        const cancellation = mergeAbortSignals([controller.signal, props.target?.signal]);
        const isCurrent = () => mountedRef.current && !cancellation.signal.aborted;
        try {
            if (!isCurrent()) return { kind: 'cancelled' };
            // Sign-out retires the authenticated transport, not the selected Home.
            // Both ingress paths use the exact endpoint auth owner, which can run
            // before an authenticated connection exists and preserves the target.
            const active = getActiveServerSnapshot();
            const target: Omit<SecretKeyLoginTarget, 'serverIdentityId'> & Readonly<{ serverIdentityId?: string }> = props.target ?? {
                ...(resolveHomeAuthenticationTarget({ kind: 'saved_profile', profileRef: active.serverId }) ?? {
                    endpointUrl: active.serverUrl, canonicalServerUrl: active.serverUrl,
                    serverId: active.serverId,
                }),
                runtimeOrigin: active.runtimeOrigin,
                homeCarrier: getActiveServerHomeCarrier() ?? undefined,
                requireKeyChallengeV2: false,
            };
            home = target.canonicalServerUrl;
            const persistenceTarget = { serverUrl: home, serverId: target.serverId ?? target.serverIdentityId };
            let allowed = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => {
                    const guard = await guardAccountEncryptionFirstKeyCredentialMutation(persistenceTarget);
                    return guard.kind === 'allowed' ? { kind: 'completed' } : guard;
                },
                onCompleted: () => { allowed = true; },
            });
            if (!allowed || !isCurrent()) return { kind: 'cancelled' };

            const authenticated = await authGetTokenAtEndpoint({ ...target, secret: input.secret, signal: cancellation.signal, isCurrent });
            if (!isCurrent()) return { kind: 'cancelled' };
            const request = createServerFetchAtEndpoint({ ...target, credentials: authenticated });
            const { mode } = await fetchAccountEncryptionMode(authenticated, {
                request: (path, init) => request(path, { ...init, signal: cancellation.signal }, { includeAuth: false, retry: 'none' }),
            });
            const credentials: AuthCredentials = mode === 'plain'
                ? { token: authenticated.token }
                : { token: authenticated.token, secret: input.normalizedKey };
            if (mode === 'e2ee') await createEncryptionFromAuthCredentials(credentials);
            if (!isCurrent()) return { kind: 'cancelled' };

            let completed = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => isCurrent()
                    ? await auth.loginWithCredentials(credentials, { target: persistenceTarget })
                    : { kind: 'recovery_failed' },
                onCompleted: () => {
                    completed = true;
                },
            });
            if (!completed || !isCurrent()) return { kind: 'cancelled' };
            trackAccountRestored();
            if (props.onAuthenticated) await props.onAuthenticated(credentials);
            else handleSuccess();
            return { kind: 'completed' };
        } catch (error) {
            if (!isCurrent()) return { kind: 'cancelled' };
            return { kind: 'failed', error, home };
        } finally {
            cancellation.dispose();
            if (authenticationControllerRef.current === controller) authenticationControllerRef.current = null;
        }
    }, [auth, handleSuccess, props]);

    return (
        <View style={styles.container}>
            <SecretKeyEntryForm
                description={t('connect.restoreWithSecretKeyDescription')}
                submitTitle={props.submitTitle ?? t('connect.signInWithKeySubmit')}
                onSubmit={handleLogin}
            />
        </View>
    );
});
