import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from 'expo-router';

import {
    useAuth,
    type AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import { authGetToken, authGetTokenAtEndpoint, type AuthGetTokenAtEndpointParams } from '@/auth/flows/getToken';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    activateStackRuntimeServer,
    readStackRuntimeServerUrl,
} from '@/sync/domains/server/stackRuntimeServer';
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

async function guardStackAuthIngress(
): Promise<AuthCredentialLifecycleResult> {
    const current =
        await guardAccountEncryptionFirstKeyCredentialMutation();
    if (current.kind !== 'allowed') return current;
    const stackServerUrl = readStackRuntimeServerUrl();
    if (!stackServerUrl) return { kind: 'completed' };
    const target =
        await guardAccountEncryptionFirstKeyCredentialMutation({
            serverUrl: stackServerUrl,
        });
    return target.kind === 'allowed'
        ? { kind: 'completed' }
        : target;
}

export type SecretKeyLoginTarget = Readonly<Pick<AuthGetTokenAtEndpointParams,
    'endpointUrl' | 'serverId' | 'runtimeOrigin' | 'homeCarrier' | 'signal' | 'requireKeyChallengeV2' | 'expectedAccountId' | 'admission'
> & { canonicalServerUrl: string; serverIdentityId: string }>;

export type SecretKeyLoginFormProps = Readonly<{
    embedded?: boolean;
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
            const target = props.target;
            if (target) {
                const onAuthenticated = props.onAuthenticated;
                if (!onAuthenticated) return { kind: 'failed' };
                const persistenceTarget = { serverUrl: target.canonicalServerUrl, serverId: target.serverId ?? target.serverIdentityId };
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
                    onCompleted: () => { completed = true; },
                });
                if (!completed || !isCurrent()) return { kind: 'cancelled' };
                trackAccountRestored();
                await onAuthenticated(credentials);
                return { kind: 'completed' };
            }
            let mayActivateStack = false;
            await presentFirstKeyCredentialLifecycle({
                run: guardStackAuthIngress,
                onCompleted: () => {
                    mayActivateStack = true;
                },
            });
            if (!mayActivateStack || !isCurrent()) return { kind: 'cancelled' };

            await activateStackRuntimeServer({ scope: 'device' });
            if (!isCurrent()) return { kind: 'cancelled' };
            home = getActiveServerSnapshot().serverUrl;

            const token = await authGetToken(input.secret, { signal: cancellation.signal });
            if (!isCurrent()) return { kind: 'cancelled' };
            if (!token) {
                return { kind: 'invalid_key' };
            }

            let completed = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => isCurrent()
                    ? await auth.login(token, input.normalizedKey)
                    : { kind: 'recovery_failed' },
                onCompleted: () => {
                    completed = true;
                },
            });
            if (!completed || !isCurrent()) return { kind: 'cancelled' };
            trackAccountRestored();
            handleSuccess();
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
                submitTitle={props.submitTitle ?? t('connect.restoreAccount')}
                onSubmit={handleLogin}
            />
        </View>
    );
});
