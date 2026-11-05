import * as React from 'react';
import { AccountCredentialJourney } from './AccountCredentialJourney';
import { View } from 'react-native';

import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';

import {
    authenticateSelectedAccountServiceWithGeneratedKey,
    authenticateSelectedAccountServiceWithKey,
    type AccountServiceKeyAuthOutcome,
} from '@/auth/accountDirectory/accountDirectoryKeyAuth';
import type { AccountDirectoryAuthTransport, AccountServiceEmailPasswordExecution, VerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { AccountServicePasswordForm, type AccountServicePasswordFormView } from './AccountServicePasswordForm';
import { SecretKeyEntryForm } from '@/components/account/restore/SecretKeyEntryForm';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AccountServiceContinuation } from './AccountServiceContinuation';
import {
    completeAccountServicePostAuth,
    shouldDismissAccountPostAuthContinuation,
    type AccountPostAuthInput,
    type AccountPostAuthResult,
} from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { t } from '@/text';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';

export type AccountDirectoryKeyLoginOutcome =
    | Exclude<AccountServiceKeyAuthOutcome, { kind: 'authenticated' }>
    | AccountPostAuthResult;

export type AccountDirectoryKeyLoginFormProps = Readonly<{
    returnTo?: string;
    service: VerifiedAccountServiceAuthority;
    serviceName: string;
    intent: AccountContinuationIntent;
    /**
     * `password` signs in (or starts mailbox-first creation) with email and password; the signed-in
     * session continues through the same post-auth owner as a key.
     */
    mode?: 'login' | 'provision' | 'password';
    /** For `password`: the service's email sign-in (for its reset fact) and which view opens. */
    password?: Readonly<{ login: AccountServiceEmailPasswordExecution | null; view: AccountServicePasswordFormView }>;
    transport?: AccountDirectoryAuthTransport;
    signal?: AbortSignal;
    onResult: (result: AccountDirectoryKeyLoginOutcome) => Promise<void> | void;
    /**
     * When set, the host renders the post-auth card itself (its own continuation
     * step) and owns cancellation of the transferred input; the form then never
     * shows the card.
     */
    onPostAuthContinuation?: (input: AccountPostAuthInput, result: AccountPostAuthResult) => void;
    onBack: () => void;
    onReauthenticate?: (input: AccountPostAuthInput) => void | Promise<void>;
    onOpenHomeAuthentication?: (
        input: AccountPostAuthInput,
        homeServerIdentityId: string,
        previous: AccountPostAuthResult,
    ) => void | Promise<void>;
    isCurrent?: () => boolean;
}>;

export const AccountDirectoryKeyLoginForm = React.memo(function AccountDirectoryKeyLoginForm(props: AccountDirectoryKeyLoginFormProps) {
    return <AccountCredentialJourney request={{ kind: 'account_directory', request: {
        service: props.service, intent: props.intent, returnTo: props.returnTo ?? '/',
    } }}><AccountDirectoryKeyLoginFormBody {...props} /></AccountCredentialJourney>;
});

const AccountDirectoryKeyLoginFormBody = React.memo(function AccountDirectoryKeyLoginFormBody(
    props: AccountDirectoryKeyLoginFormProps,
) {
    const abortControllerRef = React.useRef<AbortController | null>(null);
    const continuationTransferredRef = React.useRef(false);
    const generatedProvisionRef = React.useRef(false);
    const inputRef = React.useRef<AccountPostAuthInput | null>(null);
    const [postAuthResult, setPostAuthResult] = React.useState<AccountPostAuthResult | null>(null);
    const [provisionAttempt, setProvisionAttempt] = React.useState(0);
    const [provisionFailed, setProvisionFailed] = React.useState(false);

    React.useEffect(() => () => {
        if (!continuationTransferredRef.current) abortControllerRef.current?.abort();
    }, []);

    const beginAuthentication = React.useCallback(() => {
        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        continuationTransferredRef.current = false;
        const abort = () => controller.abort();
        if (props.signal?.aborted) controller.abort();
        else {
            props.signal?.addEventListener('abort', abort, { once: true });
            controller.signal.addEventListener('abort', () => props.signal?.removeEventListener('abort', abort), { once: true });
        }
        return controller;
    }, [props.signal]);

    const completeAuthentication = React.useCallback(async (auth: AccountServiceKeyAuthOutcome) => {
        if (props.isCurrent?.() === false) {
            const result = { kind: 'cancelled' as const };
            await props.onResult(result);
            return result as AccountDirectoryKeyLoginOutcome;
        }
        const intent = inputRef.current?.intent ?? props.intent;
        if (auth.kind !== 'authenticated') {
            await props.onResult(auth);
            return auth;
        }
        if (props.isCurrent?.() === false) {
            abortControllerRef.current?.abort();
            const result = { kind: 'cancelled' as const };
            await props.onResult(result);
            return result as AccountDirectoryKeyLoginOutcome;
        }

        const input: AccountPostAuthInput = {
            service: auth.service,
            session: auth.session,
            credentialTokenDigest: auth.credentialTokenDigest,
            intent,
            signal: abortControllerRef.current?.signal,
        };
        inputRef.current = input;
        const result = await completeAccountServicePostAuth(input);
        const showsCard = !shouldDismissAccountPostAuthContinuation(result);
        if (showsCard && props.onPostAuthContinuation) continuationTransferredRef.current = true;
        else if (showsCard) setPostAuthResult(result);
        await props.onResult(result);
        if (showsCard) props.onPostAuthContinuation?.(input, result);
        return result;
    }, [props]);

    const authenticate = React.useCallback(async (secret: Uint8Array) => {
        const abortController = beginAuthentication();
        return await completeAuthentication(await authenticateSelectedAccountServiceWithKey({
            service: props.service,
            secret,
            signal: abortController.signal,
            transport: props.transport,
        }));
    }, [beginAuthentication, completeAuthentication, props.service, props.transport]);

    const submit = React.useCallback(async ({ secret }: Readonly<{ secret: Uint8Array }>) => {
        const result = await authenticate(secret);
        return result.kind === 'stopped'
            ? { kind: 'cancelled' as const }
            : result.kind === 'invalid_key'
                ? { kind: 'invalid_key' as const }
                : result.kind === 'cancelled'
                    ? { kind: 'cancelled' as const }
                    : result.kind === 'failed' || result.kind === 'unavailable' || result.kind === 'relink_required'
                        ? { kind: 'failed' as const }
            : { kind: 'completed' as const };
    }, [authenticate]);

    React.useEffect(() => {
        if (props.mode !== 'provision' || generatedProvisionRef.current) return;
        generatedProvisionRef.current = true;
        setProvisionFailed(false);
        void (async () => {
            const abortController = beginAuthentication();
            try {
                let mayCreate = false;
                await presentFirstKeyCredentialLifecycle({
                    run: async () => {
                        const homeIdentity = props.intent.kind === 'enter'
                            ? props.intent.target.kind === 'explicit' ? props.intent.target.homeServerIdentityId : null
                            : props.intent.kind === 'refresh' ? null : props.intent.homeServerIdentityId;
                        const profile = homeIdentity ? resolveServerProfileForPortableIdentity(homeIdentity) : null;
                        const target = profile?.kind === 'resolved'
                            ? { serverUrl: profile.profile.serverUrl, serverId: profile.profile.id }
                            : homeIdentity === props.service.serverIdentityId
                                ? { serverUrl: props.service.canonicalServerUrl, serverId: props.service.serverIdentityId }
                                : undefined;
                        const guard = target ? await guardAccountEncryptionFirstKeyCredentialMutation(target) : { kind: 'allowed' as const };
                        return guard.kind === 'allowed' ? { kind: 'completed' } : guard;
                    },
                    onCompleted: () => { mayCreate = true; },
                });
                if (!mayCreate || abortController.signal.aborted) {
                    if (!abortController.signal.aborted) props.onBack();
                    return;
                }
                const result = await completeAuthentication(await authenticateSelectedAccountServiceWithGeneratedKey({
                    service: props.service,
                    signal: abortController.signal,
                    transport: props.transport,
                }));
                if (result.kind === 'cancelled' && !abortController.signal.aborted) props.onBack();
                if (result.kind === 'failed' || result.kind === 'unavailable' || result.kind === 'relink_required' || result.kind === 'invalid_key') {
                    setProvisionFailed(true);
                }
            } catch {
                setProvisionFailed(true);
            }
        })();
    }, [beginAuthentication, completeAuthentication, props.mode, props.service, props.transport, provisionAttempt]);

    if (postAuthResult && inputRef.current) {
        return <AccountServiceContinuation input={inputRef.current} result={postAuthResult}
            onReauthenticate={props.onReauthenticate ?? (() => {
                abortControllerRef.current?.abort();
                setPostAuthResult(null);
                if (props.mode === 'provision') props.onBack();
            })}
            onOpenHomeAuthentication={props.onOpenHomeAuthentication ? async (input, identity, previous) => {
                continuationTransferredRef.current = props.signal !== undefined;
                await props.onOpenHomeAuthentication!(input, identity, previous);
            } : undefined}
            onResult={async (result, input) => {
                if (input) inputRef.current = input;
                setPostAuthResult(result);
                await props.onResult(result);
            }} onBack={() => { abortControllerRef.current?.abort(); props.onBack(); }} />;
    }

    if (props.mode === 'provision') {
        if (provisionFailed) {
            return <SurfaceStateCard testID="account-directory-key-provision-failed" kind="error"
                title={t('welcome.signInServiceUnavailableTitle')} reason={t('errors.operationFailed')}
                accessibilitySemantics="alert"
                action={{ label: t('common.retry'), onPress: () => {
                    generatedProvisionRef.current = false;
                    setProvisionAttempt((attempt) => attempt + 1);
                } }} />;
        }
        return <View testID="account-directory-key-provision-pending"><ActivitySpinner /></View>;
    }

    if (props.mode === 'password') {
        return (
            <AccountServicePasswordForm
                service={props.service}
                serviceName={props.serviceName}
                transport={props.transport}
                login={props.password?.login ?? null}
                initialView={props.password?.view ?? 'sign_in'}
                onSignedIn={async (outcome) => {
                    beginAuthentication();
                    await completeAuthentication(outcome);
                }}
                onCancel={() => { abortControllerRef.current?.abort(); props.onBack(); }}
            />
        );
    }

    return (
        <SecretKeyEntryForm
            description={t('welcome.accountKeyDescription', { service: props.serviceName })}
            submitTitle={t('welcome.accountKeySubmit')}
            onSubmit={submit}
            onBack={() => { abortControllerRef.current?.abort(); props.onBack(); }}
        />
    );
});
