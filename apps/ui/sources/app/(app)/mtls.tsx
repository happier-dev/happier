import * as React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { TeamInvitationPostAuthContinuationV1Schema } from '@happier-dev/protocol/teams';

import { useAuth } from '@/auth/context/AuthContext';
import { createAuthenticationFailure } from '@/auth/flows/authenticationFailure';
import { authenticationErrorMessage } from '@/auth/flows/authenticationErrorMessage';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountServiceReturn } from '@/auth/accountDirectory/accountDirectoryNavigation';
import { acquireAccountServiceAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { admitInternalRouteHref, tryAdmitInternalRouteHref } from '@/utils/path/routeUtils';

export default function MtlsCallbackScreen() {
    const auth = useAuth();
    const params = useLocalSearchParams();

    React.useEffect(() => {
        let mounted = true;
        const controller = new AbortController();
        (async () => {
            let closeTransport = async () => {};
            let failureReturnTo = '/';
            try {
                const error = typeof params.error === 'string' ? params.error.trim().toLowerCase() : '';
                if (error === 'account-disabled') {
                    const state = await TokenStorage.readPendingExternalAuthContinuationState();
                    const pending = state.value;
                    if (!mounted) return;
                    if (!state.serverMismatch && pending?.provider === 'mtls' && pending.serverUrl
                        && await TokenStorage.isPendingExternalAuthContinuationCurrent(pending)) {
                        await Modal.alert(t('common.error'), authenticationErrorMessage(
                            createAuthenticationFailure(403, { error }), pending.serverUrl,
                        ) ?? t('errors.operationFailed'));
                        if (!mounted) return;
                        router.replace('/');
                        return;
                    }
                }
                if (error === 'restore_required') {
                    const state = await TokenStorage.readPendingExternalAuthContinuationState();
                    const pending = state.value;
                    if (!mounted) return;
                    if (!state.serverMismatch && pending?.provider === 'mtls' && pending.accountContinuation
                        && pending.serverUrl && await TokenStorage.isPendingExternalAuthContinuationCurrent(pending)) {
                        const destination = createAccountServiceReturn(pending.accountContinuation);
                        if (!destination) return;
                        await TokenStorage.clearPendingExternalAuth({ serverUrl: pending.serverUrl, serverId: pending.serverId });
                        if (!mounted) return;
                        if (!await TokenStorage.recordAccountDirectoryOAuthReturn({ ...pending.accountContinuation,
                            homeAuthenticationFailure: { homeServerIdentityId: pending.accountContinuation.homeServerIdentityId, code: 'restore_required' },
                        }, { expectedCredentialTokenDigest: pending.accountContinuation.credentialTokenDigest })) return;
                        router.replace(admitInternalRouteHref(destination));
                        return;
                    }
                    router.replace('/restore');
                    return;
                }

                const pendingState = await TokenStorage.readPendingExternalAuthContinuationState();
                const pending = pendingState.value;
                const serverId = String(pending?.serverId ?? '').trim();
                const serverUrl = String(pending?.serverUrl ?? '').trim().replace(/\/+$/, '');
                if (pendingState.serverMismatch || pending?.provider !== 'mtls' || !serverId || !serverUrl) {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace('/');
                    return;
                }
                const target = { serverId, serverUrl };
                let continuationPending = pending;
                failureReturnTo = pending.teamContinuation
                    ? teamSignInReturnPath({
                        teamId: pending.teamContinuation.destination.teamId,
                        carrier: pending.teamContinuation.homeServerIdentityId,
                    })
                    : typeof pending.returnTo === 'string' && tryAdmitInternalRouteHref(pending.returnTo) ? pending.returnTo : '/';
                const callbackAdmissionReference = typeof params.admissionReference === 'string'
                    ? params.admissionReference
                    : '';
                const admissionReferenceMatches = pending.teamContinuation
                    ? callbackAdmissionReference === pending.teamContinuation.admissionReference
                    : callbackAdmissionReference === '';
                if (!admissionReferenceMatches) {
                    await TokenStorage.clearPendingExternalAuth(target);
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace(admitInternalRouteHref(failureReturnTo));
                    return;
                }
                const ownsContinuation = async () => mounted && !controller.signal.aborted
                    && await TokenStorage.isPendingExternalAuthContinuationCurrent(continuationPending);
                if (!await ownsContinuation()) {
                    await TokenStorage.clearPendingExternalAuth(target);
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace(admitInternalRouteHref(failureReturnTo));
                    return;
                }
                const code = typeof params.code === 'string' ? params.code : '';
                if (!code.trim()) {
                    await TokenStorage.clearPendingExternalAuth(target);
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    router.replace(admitInternalRouteHref(failureReturnTo));
                    return;
                }
                const acquired = pending.accountContinuation
                    ? await acquireAccountServiceAuthTransport({ serverIdentityId: pending.accountContinuation.homeServerIdentityId,
                        canonicalServerUrl: serverUrl })
                    : null;
                if (acquired) closeTransport = acquired.close;
                if (!mounted || controller.signal.aborted) return;
                const requestAtTarget = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId,
                    ...acquired?.transport, runtimeOrigin: acquired?.transport.runtimeOrigin ?? undefined });

                const timeoutMs = 15000;
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const res = await requestAtTarget(
                        '/v1/auth/mtls/claim',
                        {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                                code,
                                ...(pending.teamContinuation
                                    ? { admissionReference: pending.teamContinuation.admissionReference }
                                    : {}),
                            }),
                            signal: controller.signal,
                        },
                        { includeAuth: false },
                    );
                    const json = await res.json().catch(() => null);
                    if (!await ownsContinuation()) return;
                    if (!res.ok || !json || typeof json.token !== 'string'
                        || (pending.teamContinuation && json.teamId !== pending.teamContinuation.teamId)) {
                        await TokenStorage.clearPendingExternalAuth(target);
                        await Modal.alert(t('common.error'), authenticationErrorMessage(
                            createAuthenticationFailure(res.status, json), serverUrl,
                        ) ?? t('errors.operationFailed'));
                        router.replace(admitInternalRouteHref(failureReturnTo));
                        return;
                    }

                    let retainPostAuthInvitation = false;
                    if (json.teamInvitationContinuation !== undefined) {
                        const parsed = TeamInvitationPostAuthContinuationV1Schema.safeParse(
                            json.teamInvitationContinuation,
                        );
                        if (!pending.teamContinuation
                            || !parsed.success
                            || parsed.data.teamId !== pending.teamContinuation.teamId) {
                            await TokenStorage.clearPendingExternalAuth(target);
                            await Modal.alert(t('common.error'), t('errors.operationFailed'));
                            router.replace(admitInternalRouteHref(failureReturnTo));
                            return;
                        }
                        const updatedPending = await TokenStorage.recordTeamInvitationPostAuthContinuation(
                            continuationPending,
                            parsed.data,
                            target,
                        );
                        if (!updatedPending) {
                            await TokenStorage.clearPendingExternalAuth(target);
                            await Modal.alert(t('common.error'), t('errors.operationFailed'));
                            router.replace(admitInternalRouteHref(failureReturnTo));
                            return;
                        }
                        continuationPending = updatedPending;
                        retainPostAuthInvitation = true;
                    }
                    if (!await ownsContinuation()) return;

                    const token = String(json.token);
                    const finishCredentialCustody = async () => {
                        if (!await ownsContinuation()) return;
                        if (!retainPostAuthInvitation) {
                            await TokenStorage.clearPendingExternalAuth(target);
                        }
                        if (!mounted) return;
                        if (pending.accountContinuation) {
                            const destination = createAccountServiceReturn(pending.accountContinuation);
                            if (!destination) throw new Error('Invalid Home authentication return');
                            if (!await TokenStorage.recordAccountDirectoryOAuthReturn({
                                ...pending.accountContinuation,
                                authenticatedHome: {
                                    homeServerIdentityId: pending.accountContinuation.homeServerIdentityId,
                                    credentials: { token },
                                },
                            }, { expectedCredentialTokenDigest: pending.accountContinuation.credentialTokenDigest })) {
                                throw new Error('Account Service credential custody changed');
                            }
                            resolvePostAuthLanding({ replace: router.replace, returnTo: destination });
                            return;
                        }
                        resolvePostAuthLanding({
                            replace: router.replace,
                            teamContinuation: pending.teamContinuation ? teamSignInReturnPath({
                                teamId: pending.teamContinuation.destination.teamId,
                                carrier: pending.teamContinuation.homeServerIdentityId,
                                postAuthInvitation: retainPostAuthInvitation,
                            }) : undefined,
                            returnTo: pending.returnTo,
                        });
                    };
                    await presentFirstKeyCredentialLifecycle({
                        run: async () =>
                            await auth.loginWithCredentials({ token }, { target, signInMethodId: 'mtls' }),
                        onCompleted: finishCredentialCustody,
                        onFinishCompleted: finishCredentialCustody,
                    });
                } finally {
                    clearTimeout(timer);
                }
            } catch (error) {
                if (!mounted) return;
                const message = process.env.EXPO_PUBLIC_DEBUG
                    ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                    : t('errors.operationFailed');
                await Modal.alert(t('common.error'), message);
                router.replace(admitInternalRouteHref(failureReturnTo));
            } finally {
                await closeTransport();
            }
        })();
        return () => {
            mounted = false;
            controller.abort();
        };
    }, [auth, params.admissionReference, params.code]);

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivitySpinner />
        </View>
    );
}
