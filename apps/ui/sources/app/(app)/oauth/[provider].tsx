import React from 'react';
import { Linking, Platform, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { useUnistyles } from 'react-native-unistyles';

import {
    useAuth,
    type AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import {
    TokenStorage,
    normalizeAccountDirectoryEndpoint,
    type PendingAccountDirectoryAuth,
    type AccountHomeAuthenticationContinuation,
    type PendingExternalAuth,
} from '@/auth/storage/tokenStorage';
import { createAccountServiceReturn } from '@/auth/accountDirectory/accountDirectoryNavigation';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { authChallenge } from '@/auth/flows/challenge';
import { createAuthenticationFailure } from '@/auth/flows/authenticationFailure';
import { authenticationErrorMessage } from '@/auth/flows/authenticationErrorMessage';
import {
    createServerFetchAtEndpoint,
    serverFetch,
} from '@/sync/http/client';
import { isSessionSharingSupported } from '@/sync/api/capabilities/sessionSharingSupport';
import { getAuthProvider } from '@/auth/providers/registry';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { createHomeOAuthRequestContext } from '@/auth/providers/homeExternalAuthTarget';
import { accountDirectoryAuthClient, acquireAccountServiceAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { Text } from '@/components/ui/text/Text';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { trackAccountCreated, trackAccountRestored } from '@/track';

import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { admitInternalRouteHref, normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    resolveServerProfileScopeId,
    resolveServerProfileForPortableIdentity,
} from '@/sync/domains/server/serverProfiles';
import {
    cancelAccountPasswordEnrollmentExternalAuth,
    clearAccountPasswordEnrollmentExternalAuthCustody,
    guardAccountEncryptionFirstKeyCredentialMutation,
    readAccountPasswordEnrollmentExternalAuthCallbackContext,
    resumeAccountPasswordEnrollmentExternalAuth,
    resumeAccountEncryptionFirstKeyExternalAuth,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createManagedIdentityProviderClient } from '@/components/settings/home/identity/managedIdentityProviderClient';
import {
    consumePendingIdentityProviderTest,
    recordIdentityProviderTestReturn,
} from '@/components/settings/home/identity/identityProviderTestReturn';
import { consumePendingGitHubAppManifestSetup, consumePendingGitHubAppVerification } from '@/components/settings/home/githubApps/githubAppOAuthReturn';
import { homeAdministrationGitHubAppPath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { teamGitHubAppPath } from '@/components/settings/teams/teamsRoutes';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import {
    isTeamAuthenticationFailureCode,
    presentTeamAuthenticationFailure,
    type TeamAuthenticationFailureCode,
} from '@/components/teams/entry/teamAuthenticationFailure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    classifyAccountServiceOAuthCallbackFailure,
    describeAccountServiceFailure,
    type AccountServiceFailureCode,
} from '@/components/account/auth/accountServiceFailurePresentation';
import { TeamInvitationPostAuthContinuationV1Schema } from '@happier-dev/protocol/teams';
type AccountDirectoryCallbackStage = 'signing_in';
type AccountDirectoryCallbackState = Readonly<{ providerName: string; endpointUrl: string }> & (
    | Readonly<{ kind: 'progress'; stage: AccountDirectoryCallbackStage }>
    | Readonly<{ kind: 'error'; failure: AccountServiceFailureCode }>
);

const ACCOUNT_ENCRYPTION_FIRST_KEY_PURPOSE =
    'account_encryption_first_key';
const ACCOUNT_PASSWORD_ENROLLMENT_PURPOSE =
    'account_password_enrollment';
const ACCOUNT_DIRECTORY_PURPOSE = 'account_directory';
const IDENTITY_CONNECTION_TEST_PURPOSE = 'identity_connection_test';
const GITHUB_APP_INSTALLATION_VERIFICATION_PURPOSE = 'github_app_installation_verification';
const GITHUB_APP_MANIFEST_SETUP_PURPOSE = 'github_app_manifest_setup';

function normalizeAccountDirectoryIdentityParam(value: string | null): string | null {
    return String(value ?? '').trim() || null;
}

async function guardOrdinaryAuthIngress(
): Promise<AuthCredentialLifecycleResult> {
    const result =
        await guardAccountEncryptionFirstKeyCredentialMutation();
    return result.kind === 'allowed'
        ? { kind: 'completed' }
        : result;
}

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
        case 'home-link-provisioning-failed':
            return t('errors.operationFailed');
        default:
            return t('errors.tokenExchangeFailed');
    }
}

export function sanitizeExternalOAuthCallbackError(
    code: string,
    providerName: string,
): string {
    switch (code) {
        case 'oauth_not_configured':
            return t('friends.providerGate.notConfigured', { provider: providerName });
        case 'invalid_state':
            return t('errors.oauthStateMismatch');
        default:
            return t('errors.operationFailed');
    }
}

function trackSuccessfulOAuthAuth(params: {
    secret: string | null;
    intent: 'signup' | 'reset' | null;
}) {
    if (params.intent === 'reset') {
        trackAccountRestored();
        return;
    }
    if (params.intent === 'signup' || params.secret) {
        trackAccountCreated();
        return;
    }
    trackAccountRestored();
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

function buildRestoreRedirectUrl(params: { providerId: string; reason: 'provider_already_linked' }): `/restore?${string}` {
    const provider = encodeURIComponent(params.providerId);
    const reason = encodeURIComponent(params.reason);
    return `/restore?provider=${provider}&reason=${reason}`;
}

function normalizeComparableServerUrl(value: unknown): string {
    if (typeof value !== 'string') return '';
    return createServerUrlComparableKey(value);
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

async function maybeActivateServerTarget(
    rawServerUrl: unknown,
    rawServerIdentityId: unknown,
    refreshAuth: () => Promise<void>,
): Promise<void> {
    const serverUrl = typeof rawServerUrl === 'string' ? rawServerUrl.trim() : '';
    const serverIdentityId = typeof rawServerIdentityId === 'string'
        ? rawServerIdentityId.trim()
        : '';
    if (!serverUrl || !serverIdentityId) return;

    const active = getActiveServerSnapshot();
    if (
        active.serverId === serverIdentityId
        && normalizeComparableServerUrl(active.serverUrl) === normalizeComparableServerUrl(serverUrl)
    ) return;

    const resolved = resolveServerProfileForPortableIdentity(serverIdentityId);
    if (
        resolved.kind !== 'resolved'
        || normalizeComparableServerUrl(resolved.profile.canonicalServerUrl ?? resolved.profile.serverUrl)
            !== normalizeComparableServerUrl(serverUrl)
    ) return;
    await setActiveServerAndSwitch({
        serverId: resolveServerProfileScopeId(resolved.profile),
        scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
        refreshAuth,
    });
}

function OAuthProviderReturnBody() {
    const router = useRouter();
    const params = useLocalSearchParams() as any;
    const auth = useAuth();
    const { theme } = useUnistyles();

    const [busy, setBusy] = React.useState(false);
    const [usernameHint, setUsernameHint] = React.useState<string | null>(null);
    const [usernameValue, setUsernameValue] = React.useState<string>('');
    const [provisioningChoiceOpen, setProvisioningChoiceOpen] = React.useState(false);
    const [accountDirectoryJourney, setAccountDirectoryJourney] =
        React.useState<AccountDirectoryCallbackState | null>(null);
    const [persistedAccountDirectoryReturn, setPersistedAccountDirectoryReturn] =
        React.useState(false);
    /**
     * A typed Team answer from finalize. It is presented in place, in Team
     * terms, with the exact Home-qualified Team page as the way forward; the
     * Team context is never collapsed into a generic alert and the Home root.
     */
    const [teamFailure, setTeamFailure] = React.useState<Readonly<{
        code: TeamAuthenticationFailureCode;
        returnTo: string;
    }> | null>(null);
    const accountDirectoryAttemptRef = React.useRef<null | Readonly<{
        controller: AbortController;
        target: Readonly<{ endpoint: string; serverIdentityId: string }> | null;
        pending: PendingAccountDirectoryAuth | null;
        returnTo: string;
    }>>(null);
    const accountDirectoryCredentialCommitStartedRef = React.useRef(false);
    const pendingAuthContextRef = React.useRef<null | Readonly<{
        providerId: string;
        providerName: string;
        /** The start-time Home presentation, re-persisted if custody is rewritten here. */
        presentation?: PendingExternalAuth['presentation'];
        pending: string;
        proof: string | null;
        secret: string | null;
        intent: 'signup' | 'reset' | null;
        accountContinuation?: AccountHomeAuthenticationContinuation;
        teamContinuation?: NonNullable<PendingExternalAuth['teamContinuation']>;
        continuationCustody?: Readonly<{ pending: PendingExternalAuth; signal: AbortSignal }>;
        returnTo: string;
        serverUrl?: string;
        serverId?: string;
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
    const resolvedAdmissionReference = paramString(params, 'admissionReference');
    const resolvedConnectUsername = paramString(params, 'username');
    const resolvedMode = paramString(params, 'mode');
    const resolvedStoragePolicy = paramString(params, 'storagePolicy');
    const resolvedProvisioning = paramString(params, 'provisioning');
    const resolvedProvisioningModes = paramString(params, 'provisioningModes');
    const resolvedAccountMode = paramString(params, 'accountMode');
    const resolvedPurpose = paramString(params, 'purpose');
    const resolvedResultHandle = paramString(params, 'resultHandle');
    const resolvedRegistrationId = paramString(params, 'registrationId');
    const resolvedInstallationVerified = paramString(params, 'verified');
    const resolvedManifestCreated = paramString(params, 'created');
    const resolvedCredentialTarget = paramString(params, 'credentialTarget');
    const resolvedEndpointUrl =
        paramString(params, 'endpointUrl')
        ?? paramString(params, 'endpoint');
    const resolvedEndpointIdentity =
        paramString(params, 'endpointServerIdentityId')
        ?? paramString(params, 'serverIdentityId')
        ?? paramString(params, 'serverId');
    const resolvedCanonicalServerUrl = paramString(params, 'canonicalServerUrl');
    const resolvedDirectoryReturn =
        resolvedPurpose === ACCOUNT_DIRECTORY_PURPOSE
        || resolvedCredentialTarget === ACCOUNT_DIRECTORY_PURPOSE;

    const returnHomeAuthenticationRequired = React.useCallback(async (ctx: NonNullable<typeof pendingAuthContextRef.current>) => {
        if (!ctx.accountContinuation || !ctx.continuationCustody) return false;
        const custody = ctx.continuationCustody;
        if (custody.signal.aborted || !await TokenStorage.isPendingExternalAuthContinuationCurrent(custody.pending)) return true;
        const destination = createAccountServiceReturn(ctx.accountContinuation);
        if (!destination) return true;
        await TokenStorage.clearPendingExternalAuth({ serverUrl: custody.pending.serverUrl!, serverId: custody.pending.serverId });
        if (custody.signal.aborted) return true;
        if (!await TokenStorage.recordAccountDirectoryOAuthReturn({ ...ctx.accountContinuation,
            homeAuthenticationFailure: { homeServerIdentityId: ctx.accountContinuation.homeServerIdentityId, code: 'restore_required' },
        }, { expectedCredentialTokenDigest: ctx.accountContinuation.credentialTokenDigest })) return true;
        pendingAuthContextRef.current = null;
        router.replace(admitInternalRouteHref(destination));
        return true;
    }, [router]);

    const finalizeAuth = React.useCallback((params: { mode: 'plain' | 'e2ee' }) => {
        const ctx = pendingAuthContextRef.current;
        if (!ctx) {
            router.replace('/');
            return Promise.resolve();
        }

        const promise = (async () => {
            setBusy(true);
            let closeTransport = async () => {};
            let continuationPending = ctx.continuationCustody?.pending;
            const ownsContinuation = async () => (!ctx.accountContinuation && !ctx.teamContinuation) || Boolean(
                continuationPending && ctx.continuationCustody && !ctx.continuationCustody.signal.aborted
                && await TokenStorage.isPendingExternalAuthContinuationCurrent(continuationPending),
            );
            // A Team-scoped attempt fails back to the exact Home-qualified Team
            // page it started from; only an ordinary Home attempt falls to the root.
            const failureReturnTo = ctx.teamContinuation ? ctx.returnTo : '/';
            const clearTeamContinuationCustody = async () => {
                await TokenStorage.clearPendingExternalAuth(continuationPending ? {
                    removeExact: continuationPending,
                    ...(ctx.serverUrl ? { serverUrl: ctx.serverUrl } : {}),
                    ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                } : {});
            };
            try {
                if (!await ownsContinuation()) return;
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
                    const stored =
                        await TokenStorage.setPendingExternalAuth({
                            provider: ctx.providerId,
                            ...(ctx.presentation ? { presentation: ctx.presentation } : {}),
                            ...(ctx.proof ? { proof: ctx.proof } : {}),
                            secret,
                            ...(ctx.intent ? { intent: ctx.intent } : {}),
                            ...(ctx.serverUrl ? { serverUrl: ctx.serverUrl } : {}),
                            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                            ...(ctx.returnTo ? { returnTo: ctx.returnTo } : {}),
                            ...(ctx.accountContinuation ? { accountContinuation: ctx.accountContinuation } : {}),
                            ...(ctx.teamContinuation ? { teamContinuation: ctx.teamContinuation } : {}),
                        }, ctx.serverUrl ? {
                            serverUrl: ctx.serverUrl,
                            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                        } : undefined);
                    if (!stored) {
                        const guard =
                            await guardAccountEncryptionFirstKeyCredentialMutation();
                        if (guard.kind !== 'allowed') {
                            await presentFirstKeyCredentialLifecycle({
                                run: guardOrdinaryAuthIngress,
                            });
                        } else {
                            await Modal.alert(
                                t('common.error'),
                                t('errors.oauthInitializationFailed'),
                            );
                        }
                        return;
                    }
                    pendingAuthContextRef.current = { ...ctx, secret };
                    if (continuationPending) continuationPending = { ...continuationPending, secret };
                }

                const base = typeof ctx.serverUrl === 'string' ? ctx.serverUrl.trim().replace(/\/+$/, '') : '';
                const acquired = ctx.accountContinuation
                    ? await acquireAccountServiceAuthTransport({
                        serverIdentityId: ctx.accountContinuation.homeServerIdentityId,
                        canonicalServerUrl: base,
                    })
                    : null;
                if (acquired) closeTransport = acquired.close;
                if (!await ownsContinuation()) return;
                const finalizePath =
                    params.mode === 'plain'
                        ? `/v1/auth/external/${encodeURIComponent(ctx.providerId)}/finalize-keyless`
                        : `/v1/auth/external/${encodeURIComponent(ctx.providerId)}/finalize`;
                const request = base
                    ? createServerFetchAtEndpoint({
                        endpointUrl: base,
                        ...acquired?.transport,
                        runtimeOrigin: acquired?.transport.runtimeOrigin ?? undefined,
                        ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                    })
                    : serverFetch;

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
                    const supportsSharing = await isSessionSharingSupported({
                        ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                    });
                    if (supportsSharing) {
                        const binding = await buildContentKeyBinding(secretBytes);
                        payload.contentPublicKey = binding.contentPublicKey;
                        payload.contentPublicKeySig = binding.contentPublicKeySig;
                    }
                }

                const response = await request(finalizePath, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    ...(ctx.continuationCustody ? { signal: ctx.continuationCustody.signal } : {}),
                }, { includeAuth: false, retry: 'none' });
                const json = await response.json().catch(() => ({}));
                if (!await ownsContinuation()) return;

                if (response.ok && json?.token) {
                    // The invitation continuation is the exception: the Home sends
                    // it only for a first-time invitation redemption. Every other
                    // Team-scoped admission (existing member, JIT, provisioned)
                    // answers with the credential alone, and that credential is
                    // committed like any other. Same contract as the mTLS return.
                    let retainPostAuthInvitation = false;
                    if (json.teamInvitationContinuation !== undefined) {
                        const parsed = TeamInvitationPostAuthContinuationV1Schema.safeParse(
                            json.teamInvitationContinuation,
                        );
                        if (!ctx.teamContinuation
                            || !parsed.success
                            || parsed.data.reference !== ctx.pending
                            || parsed.data.teamId !== ctx.teamContinuation.teamId
                        ) {
                            await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                            await clearTeamContinuationCustody();
                            pendingAuthContextRef.current = null;
                            router.replace(admitInternalRouteHref(failureReturnTo));
                            return;
                        }
                        if (!ctx.serverUrl) return;
                        const updatedPending = await TokenStorage.recordTeamInvitationPostAuthContinuation(
                            continuationPending!,
                            parsed.data,
                            {
                                serverUrl: ctx.serverUrl,
                                ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                            },
                        );
                        if (!updatedPending) {
                            await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                            pendingAuthContextRef.current = null;
                            router.replace(admitInternalRouteHref(failureReturnTo));
                            return;
                        }
                        continuationPending = updatedPending;
                        retainPostAuthInvitation = true;
                    }
                    const persistenceOptions = base ? {
                        target: {
                            serverUrl: base,
                            ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                        },
                    } as const : null;
                    await presentFirstKeyCredentialLifecycle({
                        run: async () =>
                            params.mode === 'plain'
                                ? persistenceOptions
                                    ? await auth.loginWithCredentials(
                                        { token: String(json.token) },
                                        persistenceOptions,
                                    )
                                    : await auth.loginWithCredentials({ token: String(json.token) })
                                : persistenceOptions
                                    ? await auth.login(String(json.token), secret!, persistenceOptions)
                                    : await auth.login(String(json.token), secret!),
                        onCompleted: async () => {
                            if (!await ownsContinuation()) return;
                            // Only a retained invitation continuation keeps the
                            // pending record; the Team page claims it exactly once.
                            if (!ctx.teamContinuation) {
                                await TokenStorage.clearPendingExternalAuth();
                            } else if (!retainPostAuthInvitation) {
                                await clearTeamContinuationCustody();
                            }
                            pendingAuthContextRef.current = null;
                            setUsernameHint(null);
                            setProvisioningChoiceOpen(false);
                            if (ctx.accountContinuation) {
                                const destination = createAccountServiceReturn(ctx.accountContinuation);
                                if (!destination) throw new Error('Invalid Home authentication return');
                                if (!await TokenStorage.recordAccountDirectoryOAuthReturn({ ...ctx.accountContinuation,
                                    authenticatedHome: { homeServerIdentityId: ctx.accountContinuation.homeServerIdentityId,
                                        credentials: params.mode === 'plain' ? { token: String(json.token) } : { token: String(json.token), secret: secret! } },
                                }, { expectedCredentialTokenDigest: ctx.accountContinuation.credentialTokenDigest })) {
                                    throw new Error('Account Service credential custody changed');
                                }
                                router.replace(admitInternalRouteHref(destination));
                                return;
                            }
                            await maybeActivateServerTarget(ctx.serverUrl, ctx.serverId, auth.refreshFromActiveServer);
                            trackSuccessfulOAuthAuth({
                                secret,
                                intent: ctx.intent,
                            });
                            router.replace(admitInternalRouteHref(ctx.teamContinuation && retainPostAuthInvitation
                                ? teamSignInReturnPath({
                                    teamId: ctx.teamContinuation.destination.teamId,
                                    carrier: ctx.teamContinuation.homeServerIdentityId,
                                    postAuthInvitation: true,
                                })
                                : ctx.returnTo));
                        },
                    });
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
                    if (await returnHomeAuthenticationRequired(ctx)) return;
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
                    router.replace(admitInternalRouteHref(failureReturnTo));
                    return;
                }
                if (ctx.teamContinuation && isTeamAuthenticationFailureCode(err)) {
                    await clearTeamContinuationCustody();
                    pendingAuthContextRef.current = null;
                    setTeamFailure({ code: err, returnTo: ctx.returnTo });
                    return;
                }

                const failure = createAuthenticationFailure(response.status, json);
                await Modal.alert(t('common.error'), failure.code
                    ? authenticationErrorMessage(failure, ctx.serverUrl) ?? mapFinalizeErrorToMessage(err)
                    : mapFinalizeErrorToMessage(err));
                await TokenStorage.clearPendingExternalAuth();
                pendingAuthContextRef.current = null;
                router.replace(admitInternalRouteHref(failureReturnTo));
            } finally {
                await closeTransport();
                setBusy(false);
            }
        })();
        fireAndForget(promise, { tag: 'OAuthProviderReturn.finalizeAuth' });
        return promise;
    }, [auth, router, returnHomeAuthenticationRequired]);

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
            return Promise.resolve();
        }
        pendingAuthContextRef.current = { ...ctx, chosenMode: mode };
        setProvisioningChoiceOpen(false);
        return finalizeAuth({ mode });
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
        // Claim the live ceremony during this effect setup, before the
        // originating Settings screen's deferred unmount cleanup runs.
        // No secret leaves the process-local owner.
        const passwordEnrollmentCallbackContext =
            flow === 'auth'
                && providerId
                && (
                    resolvedPurpose === ACCOUNT_PASSWORD_ENROLLMENT_PURPOSE
                    || resolvedPurpose === null
                )
                ? readAccountPasswordEnrollmentExternalAuthCallbackContext(
                    providerId,
                )
                : null;
        let retireClaimedPasswordEnrollmentOnDispose =
            passwordEnrollmentCallbackContext !== null;

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
            router.replace(admitInternalRouteHref(path));
        };

        fireAndForget((async () => {
            if (resolvedPurpose === GITHUB_APP_MANIFEST_SETUP_PURPOSE) {
                const pendingSetup = consumePendingGitHubAppManifestSetup();
                if (!pendingSetup || !resolvedRegistrationId || resolvedManifestCreated !== '1' || error) {
                    await Modal.alertAsync(t('common.error'), t('identityAdministration.error'));
                    safeReplace('/settings');
                    return;
                }
                safeReplace(pendingSetup.kind === 'home'
                    ? homeAdministrationGitHubAppPath(pendingSetup.serverId, resolvedRegistrationId)
                    : teamGitHubAppPath(
                        { serverId: pendingSetup.serverId, teamId: pendingSetup.teamId },
                        resolvedRegistrationId,
                    ));
                return;
            }
            if (resolvedPurpose === GITHUB_APP_INSTALLATION_VERIFICATION_PURPOSE) {
                const pendingVerification = resolvedRegistrationId
                    ? consumePendingGitHubAppVerification(resolvedRegistrationId)
                    : null;
                const fallback = pendingVerification?.returnTo ?? '/settings';
                if (!pendingVerification || error || resolvedInstallationVerified !== '1') {
                    await Modal.alertAsync(t('common.error'), t('identityAdministration.error'));
                }
                safeReplace(fallback);
                return;
            }
            if (resolvedPurpose === IDENTITY_CONNECTION_TEST_PURPOSE) {
                const pendingTest = consumePendingIdentityProviderTest(providerId);
                const fallback = pendingTest?.returnTo ?? '/settings';
                if (!pendingTest) {
                    await Modal.alertAsync(t('common.error'), t('identityAdministration.error'));
                    safeReplace(fallback);
                    return;
                }
                if (!resolvedResultHandle || error) {
                    recordIdentityProviderTestReturn(pendingTest, {
                        kind: 'failed',
                        code: error ?? 'identity_connection_test_invalid',
                    });
                    safeReplace(fallback);
                    return;
                }
                const scope = createServerAccountScope(pendingTest.serverId, pendingTest.accountId);
                if (!scope) {
                    recordIdentityProviderTestReturn(pendingTest, {
                        kind: 'failed',
                        code: 'identity_connection_test_invalid',
                    });
                    safeReplace(fallback);
                    return;
                }
                const actionInput = {
                    owner: { kind: 'home' as const },
                    id: pendingTest.providerId,
                    resultHandle: resolvedResultHandle,
                };
                const result = await createManagedIdentityProviderClient(scope).execute(
                    'identity.providers.test.consume',
                    actionInput,
                    { signal: controller.signal },
                );
                if (result.kind === 'failed') {
                    recordIdentityProviderTestReturn(pendingTest, {
                        kind: 'failed',
                        code: result.failure.code,
                    });
                } else if (result.kind === 'approval_pending') {
                    recordIdentityProviderTestReturn(pendingTest, {
                        kind: 'approval_pending',
                        artifactId: result.artifactId,
                        actionId: 'identity.providers.test.consume',
                        scope,
                    });
                } else {
                    recordIdentityProviderTestReturn(pendingTest, {
                        kind: 'completed',
                        diagnostics: result.value.diagnostics ?? null,
                    });
                }
                safeReplace(fallback);
                return;
            }
            const callbackDirectoryEndpoint = normalizeAccountDirectoryEndpoint(resolvedEndpointUrl ?? '');
            const callbackDirectoryIdentity = normalizeAccountDirectoryIdentityParam(resolvedEndpointIdentity);
            const exactCallbackDirectoryTarget = callbackDirectoryEndpoint && callbackDirectoryIdentity
                ? { endpoint: callbackDirectoryEndpoint, serverIdentityId: callbackDirectoryIdentity }
                : null;
            const exactCallbackPending = resolvedDirectoryReturn && exactCallbackDirectoryTarget
                ? await TokenStorage.getPendingAccountDirectoryAuth(exactCallbackDirectoryTarget, { includeExpired: true })
                : null;
            const directoryCustody = exactCallbackPending
                ? { kind: 'matched' as const, pending: exactCallbackPending }
                : resolvedDirectoryReturn && !exactCallbackDirectoryTarget && providerId
                    ? await TokenStorage.resolvePendingAccountDirectoryAuthCustody(providerId)
                    : resolvedDirectoryReturn
                        ? { kind: 'corrupt' as const }
                        : { kind: 'absent' as const };
            const custodyPending = directoryCustody.kind === 'matched'
                ? directoryCustody.pending
                : null;
            const directoryEndpoint = normalizeAccountDirectoryEndpoint(
                resolvedEndpointUrl ?? custodyPending?.endpoint ?? '',
            );
            const directoryIdentity = normalizeAccountDirectoryIdentityParam(
                resolvedEndpointIdentity ?? custodyPending?.serverIdentityId ?? null,
            );
            const directoryTarget = directoryEndpoint && directoryIdentity
                ? {
                    endpoint: directoryEndpoint,
                    serverIdentityId: directoryIdentity,
                }
                : null;
            // Persisted custody is authoritative for the callback family. URL
            // markers help cold-start rendering, but a redirect/intermediary
            // may omit them; the captured endpoint identity still correlates
            // the return to its dedicated Directory continuation namespace.
            let pendingDirectoryAuth: PendingAccountDirectoryAuth | null = custodyPending;
            let directoryCustodyFailure: 'ambiguous' | 'corrupt' | 'unavailable' | null =
                directoryCustody.kind === 'ambiguous'
                || directoryCustody.kind === 'corrupt'
                || directoryCustody.kind === 'unavailable'
                    ? directoryCustody.kind
                    : null;
            const isDirectoryReturn = pendingDirectoryAuth !== null
                || directoryCustodyFailure !== null;
            if (!disposed && !controller.signal.aborted) {
                setPersistedAccountDirectoryReturn(isDirectoryReturn && !resolvedDirectoryReturn);
            }

            if (isDirectoryReturn) {
                const directoryReturnTo =
                    normalizeInternalReturnPath(pendingDirectoryAuth?.returnTo)
                    ?? '/settings/account';
                const directoryProvider = providerId
                    ? getAuthProvider(providerId)
                    : null;
                const providerName = directoryProvider?.displayName ?? providerId;
                accountDirectoryAttemptRef.current = {
                    controller,
                    target: directoryTarget,
                    pending: pendingDirectoryAuth,
                    returnTo: directoryReturnTo,
                };
                accountDirectoryCredentialCommitStartedRef.current = false;
                const safeSetDirectoryJourney = (
                    state: AccountDirectoryCallbackState,
                ) => {
                    if (disposed || controller.signal.aborted) return;
                    setAccountDirectoryJourney(state);
                };
                const setDirectoryStage = (stage: AccountDirectoryCallbackStage) => {
                    safeSetDirectoryJourney({
                        kind: 'progress',
                        stage,
                        providerName,
                        endpointUrl: directoryEndpoint ?? resolvedEndpointUrl ?? '',
                    });
                };
                setDirectoryStage('signing_in');
                safeSetBusy(true);
                try {
                    if (directoryCustodyFailure) {
                        safeSetDirectoryJourney({
                            kind: 'error',
                            failure: { source: 'oauth_callback', code: 'credential_storage_failed' },
                            providerName,
                            endpointUrl: directoryEndpoint ?? resolvedEndpointUrl ?? '',
                        });
                        return;
                    }
                    if (error) {
                        if (directoryTarget && pendingDirectoryAuth) {
                            await TokenStorage
                                .clearPendingAccountDirectoryAuth(directoryTarget, {
                                    expected: pendingDirectoryAuth,
                                })
                                .catch(() => false);
                        }
                        safeSetDirectoryJourney({
                            kind: 'error',
                            failure: { source: 'oauth_callback', code: 'provider_failed' },
                            providerName,
                            endpointUrl: directoryEndpoint ?? resolvedEndpointUrl ?? '',
                        });
                        return;
                    }

                    if (
                        !providerId
                        || !directoryProvider
                    ) {
                        if (directoryTarget && pendingDirectoryAuth) {
                            await TokenStorage
                                .clearPendingAccountDirectoryAuth(directoryTarget, {
                                    expected: pendingDirectoryAuth,
                                })
                                .catch(() => false);
                        }
                        safeSetDirectoryJourney({
                            kind: 'error',
                            failure: { source: 'oauth_callback', code: 'invalid_request' },
                            providerName,
                            endpointUrl: directoryEndpoint ?? resolvedEndpointUrl ?? '',
                        });
                        return;
                    }

                    const result = await accountDirectoryAuthClient.exchangeOAuth({
                        providerId,
                        purpose: resolvedPurpose ?? pendingDirectoryAuth?.purpose ?? null,
                        credentialTarget: resolvedCredentialTarget
                            ?? pendingDirectoryAuth?.credentialTarget
                            ?? null,
                        endpointUrl: resolvedEndpointUrl ?? pendingDirectoryAuth?.endpoint ?? null,
                        serverIdentityId: resolvedEndpointIdentity
                            ?? pendingDirectoryAuth?.serverIdentityId
                            ?? null,
                        canonicalServerUrl: resolvedCanonicalServerUrl
                            ?? pendingDirectoryAuth?.canonicalServerUrl
                            ?? null,
                        pendingKey: resolvedPending,
                        mode: resolvedMode,
                        pending: pendingDirectoryAuth,
                        onCredentialCommitStarted: () => {
                            accountDirectoryCredentialCommitStartedRef.current = true;
                            setDirectoryStage('signing_in');
                        },
                        signal: controller.signal,
                    });
                    if (controller.signal.aborted && (
                        result.kind !== 'cancelled' || !result.accountCredentialCommitted
                    )) return;
                    if (result.kind === 'authenticated') {
                        router.replace(admitInternalRouteHref(result.destination));
                        return;
                    }
                    if (result.kind === 'cancelled') {
                        if (result.accountCredentialCommitted && pendingDirectoryAuth) {
                            const destination = createAccountServiceReturn(pendingDirectoryAuth);
                            if (destination) router.replace(admitInternalRouteHref(destination));
                        }
                        return;
                    }

                    if (
                        result.kind === 'failed' && result.code === 'keyed-authentication-required'
                        && pendingDirectoryAuth?.mode === 'keyless'
                        && directoryEndpoint
                        && directoryIdentity
                        && pendingDirectoryAuth.returnTo
                    ) {
                        let keyedStart: Awaited<ReturnType<typeof accountDirectoryAuthClient.startOAuth>> | null = null;
                        try {
                            keyedStart = await accountDirectoryAuthClient.startOAuth({
                                endpointUrl: directoryEndpoint,
                                endpointServerIdentityId: directoryIdentity,
                                canonicalServerUrl: pendingDirectoryAuth.canonicalServerUrl,
                                providerId,
                                mode: 'keyed',
                                entryIntent: pendingDirectoryAuth.entryIntent,
                                returnTo: pendingDirectoryAuth.returnTo,
                                ...(pendingDirectoryAuth.linkHomeServerIdentityId ? { linkHomeServerIdentityId: pendingDirectoryAuth.linkHomeServerIdentityId } : {}),
                                ...(pendingDirectoryAuth.explicitHomeServerIdentityId ? { explicitHomeServerIdentityId: pendingDirectoryAuth.explicitHomeServerIdentityId } : {}),
                                signal: controller.signal,
                            });
                            if (!isSafeExternalAuthUrl(keyedStart.url)) {
                                throw new Error('Invalid keyed Account Service OAuth URL');
                            }
                            await Linking.openURL(keyedStart.url);
                            return;
                        } catch {
                            if (keyedStart) {
                                await TokenStorage.clearPendingAccountDirectoryAuth({
                                    endpoint: keyedStart.pending.endpoint,
                                    serverIdentityId: keyedStart.pending.serverIdentityId,
                                }, { expected: keyedStart.pending }).catch(() => false);
                            }
                            safeSetDirectoryJourney({
                                kind: 'error',
                                failure: { source: 'oauth_callback', code: 'token_exchange_failed' },
                                providerName,
                                endpointUrl: directoryEndpoint,
                            });
                            return;
                        }
                    }

                    // A failed or tampered continuation is single-use from the
                    // client perspective. Never clear replacement custody that
                    // a newer OAuth start already installed for the same target.
                    if (directoryTarget && pendingDirectoryAuth
                        && (result.kind === 'relink_required' || !result.retryable)) {
                        await TokenStorage
                            .clearPendingAccountDirectoryAuth(directoryTarget, {
                                expected: pendingDirectoryAuth,
                            })
                            .catch(() => false);
                    }
                    safeSetDirectoryJourney({
                        kind: 'error',
                        failure: result.kind === 'relink_required'
                            ? { source: 'oauth_callback', code: 'directory_link_conflict' }
                            : classifyAccountServiceOAuthCallbackFailure(result.code),
                        providerName,
                        endpointUrl: directoryEndpoint ?? resolvedEndpointUrl ?? '',
                    });
                } finally {
                    safeSetBusy(false);
                }
                return;
            }

            const pendingAuthStateForFlow =
                flow === 'auth'
                    ? await TokenStorage
                        .readPendingExternalAuthContinuationState()
                    : null;
            const hasStoredFirstKeyContinuation = Boolean(
                pendingAuthStateForFlow?.value
                    ?.accountEncryptionFirstKey,
            );
            const hasProcessLocalPasswordEnrollmentContinuation =
                passwordEnrollmentCallbackContext !== null;
            const clearPendingPasswordEnrollmentAuth = async () => {
                clearAccountPasswordEnrollmentExternalAuthCustody();
            };
            const isFirstKeyReturn =
                resolvedPurpose
                    === ACCOUNT_ENCRYPTION_FIRST_KEY_PURPOSE
                || hasStoredFirstKeyContinuation;
            const isPasswordEnrollmentReturn =
                resolvedPurpose === ACCOUNT_PASSWORD_ENROLLMENT_PURPOSE
                || hasProcessLocalPasswordEnrollmentContinuation;

            if (!providerId) {
                if (isFirstKeyReturn || isPasswordEnrollmentReturn) {
                    if (isPasswordEnrollmentReturn) {
                        await clearPendingPasswordEnrollmentAuth();
                    } else {
                        await TokenStorage.clearPendingExternalAuth();
                    }
                    await Modal.alert(
                        t('common.error'),
                        t('errors.oauthInitializationFailed'),
                    );
                }
                safeReplace(isPasswordEnrollmentReturn ? '/settings/account/security' : '/');
                return;
            }

            // A fresh load holds no Home projection. The start's own custody carries
            // the Home-projected presentation, so a dynamic provider keeps its name
            // (teams-lane-03/01 §10.2) instead of being re-derived from its id.
            const pendingConnect = flow === 'auth'
                ? null
                : await TokenStorage.getPendingExternalConnect();
            const boundConnect = pendingConnect?.provider === providerId ? pendingConnect : null;
            const connectReturnTo = normalizeInternalReturnPath(boundConnect?.returnTo) ?? '/settings/account';
            const startCustody = flow === 'auth' ? pendingAuthStateForFlow?.value ?? null : pendingConnect;
            const provider = getAuthProvider(
                providerId,
                startCustody?.provider === providerId ? startCustody.presentation : undefined,
            );
            if (!provider) {
                if (isFirstKeyReturn || isPasswordEnrollmentReturn) {
                    if (isPasswordEnrollmentReturn) {
                        await clearPendingPasswordEnrollmentAuth();
                    } else {
                        await TokenStorage.clearPendingExternalAuth();
                    }
                }
                await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                safeReplace(isPasswordEnrollmentReturn ? '/settings/account/security' : '/');
                return;
            }

            if (error) {
                const providerName = provider.displayName ?? providerId;
                const message = sanitizeExternalOAuthCallbackError(error, providerName);
                await Modal.alert(t('common.error'), message);
                let passwordEnrollmentReturnTo = '/settings/account/security';
                let authenticationReturnTo = '/';
                if (flow !== 'auth') {
                    await TokenStorage.clearPendingExternalConnect();
                } else if (isPasswordEnrollmentReturn) {
                    const target = passwordEnrollmentCallbackContext?.target;
                    const serverUrl = target?.serverUrl ?? '';
                    const serverId = target?.serverId ?? '';
                    const currentCredentials = serverUrl && serverId
                        ? await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId }).catch(() => null)
                        : null;
                    if (serverUrl && serverId) {
                        const cancelled = await cancelAccountPasswordEnrollmentExternalAuth({
                            provider: providerId,
                            currentCredentials,
                            target: { serverUrl, serverId },
                        });
                        passwordEnrollmentReturnTo = cancelled.returnTo;
                    } else {
                        await clearPendingPasswordEnrollmentAuth();
                    }
                } else if (isFirstKeyReturn) {
                    await TokenStorage.clearPendingExternalAuth();
                } else {
                    const pendingAuth = pendingAuthStateForFlow?.value;
                    if (!pendingAuthStateForFlow?.serverMismatch
                        && pendingAuth?.provider === providerId
                        && pendingAuth.teamContinuation) {
                        authenticationReturnTo = teamSignInReturnPath({
                            teamId: pendingAuth.teamContinuation.destination.teamId,
                            carrier: pendingAuth.teamContinuation.homeServerIdentityId,
                        });
                        await TokenStorage.clearPendingExternalAuth({
                            serverUrl: pendingAuth.serverUrl,
                            serverId: pendingAuth.serverId,
                            removeExact: pendingAuth,
                        });
                    }
                }
                safeReplace(
                    flow === 'auth'
                    && !isFirstKeyReturn
                    && !isPasswordEnrollmentReturn
                        ? authenticationReturnTo
                        : isPasswordEnrollmentReturn
                            ? passwordEnrollmentReturnTo
                            : flow !== 'auth'
                                ? connectReturnTo
                                : '/settings/account',
                );
                return;
            }

            if (flow === 'auth') {
                const pending = pendingFromParams;
                if (
                    hasProcessLocalPasswordEnrollmentContinuation
                    && resolvedPurpose
                        !== ACCOUNT_PASSWORD_ENROLLMENT_PURPOSE
                ) {
                    await clearPendingPasswordEnrollmentAuth();
                    await Modal.alert(
                        t('common.error'),
                        t('errors.oauthStateMismatch'),
                    );
                    safeReplace('/settings/account/security');
                    return;
                }
                if (resolvedPurpose === ACCOUNT_PASSWORD_ENROLLMENT_PURPOSE) {
                    const target = passwordEnrollmentCallbackContext?.target;
                    const serverUrl = target?.serverUrl ?? '';
                    const serverId = target?.serverId ?? '';
                    const currentCredentials = serverUrl && serverId
                        ? await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId }).catch(() => null)
                        : null;
                    if (!currentCredentials || !serverUrl || !serverId) {
                        await clearPendingPasswordEnrollmentAuth();
                        await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                        safeReplace('/settings/account/security');
                        return;
                    }
                    try {
                        safeSetBusy(true);
                        const resumed = await resumeAccountPasswordEnrollmentExternalAuth({
                            provider: providerId,
                            pending,
                            currentCredentials,
                            target: { serverUrl, serverId },
                        });
                        // The Settings route now owns the same-process handoff
                        // and consumes it exactly once. Every earlier route
                        // disposal must retire the claimed ceremony instead.
                        retireClaimedPasswordEnrollmentOnDispose = false;
                        safeReplace(resumed.returnTo);
                    } catch (callbackError) {
                        await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                        clearAccountPasswordEnrollmentExternalAuthCustody();
                        safeReplace('/settings/account/security');
                    } finally {
                        safeSetBusy(false);
                    }
                    return;
                }
                if (
                    resolvedPurpose
                    === ACCOUNT_ENCRYPTION_FIRST_KEY_PURPOSE
                ) {
                    const firstKeyState =
                        pendingAuthStateForFlow?.value;
                    const firstKeyServerUrl =
                        typeof firstKeyState?.serverUrl === 'string'
                            ? firstKeyState.serverUrl.trim()
                            : '';
                    const firstKeyServerId =
                        typeof firstKeyState?.serverId === 'string'
                            ? firstKeyState.serverId.trim()
                            : '';
                    const currentCredentials =
                        firstKeyServerUrl && firstKeyServerId
                            ? await TokenStorage.getCredentialsForServerUrl(
                                firstKeyServerUrl,
                                { serverId: firstKeyServerId },
                            ).catch(() => null)
                            : credentialsFromAuth
                                ?? await TokenStorage.getCredentials()
                                    .catch(() => null);
                    if (!currentCredentials) {
                        await TokenStorage.clearPendingExternalAuth();
                        await Modal.alert(
                            t('common.error'),
                            t('errors.oauthInitializationFailed'),
                        );
                        safeReplace('/settings/account');
                        return;
                    }
                    try {
                        safeSetBusy(true);
                        const resumed =
                            await resumeAccountEncryptionFirstKeyExternalAuth({
                                provider: providerId,
                                pending,
                                currentCredentials,
                                ...(firstKeyServerUrl && firstKeyServerId
                                    ? {
                                        target: {
                                            serverUrl: firstKeyServerUrl,
                                            serverId: firstKeyServerId,
                                        },
                                    }
                                    : {}),
                                persistCredentials:
                                    auth.loginWithCredentials,
                            });
                        safeReplace(resumed.returnTo);
                    } catch (error) {
                        await Modal.alert(
                            t('common.error'),
                            t('errors.oauthStateMismatch'),
                        );
                        if (
                            !(error instanceof HappyError)
                            || error.code
                                !==
                                'first-key-pending-custody-failed'
                        ) {
                            safeReplace('/settings/account');
                        }
                    } finally {
                        safeSetBusy(false);
                    }
                    return;
                }
                if (hasStoredFirstKeyContinuation) {
                    await TokenStorage.clearPendingExternalAuth();
                    await Modal.alert(
                        t('common.error'),
                        t('errors.oauthStateMismatch'),
                    );
                    safeReplace('/settings/account');
                    return;
                }
                const pendingAuthState =
                    pendingAuthStateForFlow!;
                const state = pendingAuthState.value;
                const secret = typeof state?.secret === 'string' ? state.secret : null;
                const proof = typeof state?.proof === 'string' ? state.proof : null;
                const serverUrlMismatch =
                    pendingAuthState.serverMismatch;
                const teamAdmissionReferenceMismatch = state?.teamContinuation !== undefined
                    && resolvedAdmissionReference !== state.teamContinuation.admissionReference;

                if (!pending || !state || state.provider !== providerId || (!proof && !secret) || serverUrlMismatch || teamAdmissionReferenceMismatch) {
                    if (serverUrlMismatch || teamAdmissionReferenceMismatch) {
                        const mismatchRecoveryPath = teamAdmissionReferenceMismatch && state?.teamContinuation
                            ? teamSignInReturnPath({
                                teamId: state.teamContinuation.destination.teamId,
                                carrier: state.teamContinuation.homeServerIdentityId,
                            })
                            : '/';
                        await TokenStorage.clearPendingExternalAuth();
                        await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                        safeReplace(mismatchRecoveryPath);
                        return;
                    }
                    // In dev (React strict-mode) or certain hydration paths, this screen can mount more than once.
                    // If another instance already completed the flow, pending state may have been cleared even
                    // though the user is now logged in. Avoid showing a false-negative OAuth error in that case.
                    const existingCredentials = await TokenStorage.getCredentials().catch(() => null);
                    if (existingCredentials?.token) {
                        safeReplace('/');
                        return;
                    }
                    await Modal.alert(t('common.error'), t('errors.oauthInitializationFailed'));
                    safeReplace('/');
                    return;
                }
                // The continuation stores the Home's *portable* identity. That is
                // the Team entry page's `target` carrier, not its device-local
                // `serverId` convenience: passing it as `serverId` resolved it
                // through the local profile-id namespace, which can match an
                // unrelated profile and cannot report an ambiguous Home. Build the
                // URL through the one Team sign-in return owner.
                const returnTo = state.teamContinuation
                    ? teamSignInReturnPath({
                        teamId: state.teamContinuation.destination.teamId,
                        carrier: state.teamContinuation.homeServerIdentityId,
                    })
                    : normalizeInternalReturnPath(state.returnTo) ?? '/';

                try {
                    const login = loginFromParams;
                    pendingAuthContextRef.current = {
                        providerId,
                        providerName: provider.displayName ?? providerId,
                        ...(state.presentation ? { presentation: state.presentation } : {}),
                        pending,
                        proof,
                        secret,
                        intent: (state.intent as any) ?? null,
                        ...(state.accountContinuation ? { accountContinuation: state.accountContinuation } : {}),
                        ...(state.teamContinuation ? { teamContinuation: state.teamContinuation } : {}),
                        ...(state.accountContinuation || state.teamContinuation
                            ? { continuationCustody: { pending: state, signal: controller.signal } }
                            : {}),
                        returnTo,
                        serverUrl: state.serverUrl,
                        serverId: state.serverId,
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
                        if (await returnHomeAuthenticationRequired(pendingAuthContextRef.current)) return;
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
            // The continuation names the exact Home whose credential started the
            // connect. Finalize, cancel and the replacement credential all belong
            // to that Home, whichever Home is focused now (TA-R14/TA-R16).
            const connectTarget = boundConnect?.serverUrl && boundConnect.serverId
                ? { serverUrl: boundConnect.serverUrl, serverId: boundConnect.serverId }
                : null;
            const credentials = connectTarget
                ? await TokenStorage.getCredentialsForServerUrl(
                    connectTarget.serverUrl,
                    { serverId: connectTarget.serverId },
                ).catch(() => null)
                : credentialsFromAuth;
            const connectRequestContext = connectTarget
                ? createHomeOAuthRequestContext(connectTarget, undefined, controller.signal) ?? undefined
                : undefined;
            const finalizeConnectNavigation = async () => {
                await TokenStorage.clearPendingExternalConnect();
                safeReplace(connectReturnTo);
            };
            const finalizeConnectAndAdoptCredential = async (input: Readonly<{
                pending: string;
                username: string;
            }>): Promise<boolean> => {
                if (!credentials) return false;
                const replacement = await provider.finalizeConnect(credentials, input, connectRequestContext);
                if (!replacement.token) return true;
                const adopted = { ...credentials, token: replacement.token };
                const lifecycle = connectTarget
                    ? await auth.loginWithCredentials(adopted, { target: connectTarget })
                    : await auth.loginWithCredentials(adopted);
                return lifecycle.kind === 'completed';
            };
            const presentTeamConnectFailure = async (error: unknown): Promise<boolean> => {
                if (!(error instanceof HappyError) || !isTeamAuthenticationFailureCode(error.message)) return false;
                await TokenStorage.clearPendingExternalConnect();
                setTeamFailure({ code: error.message, returnTo: connectReturnTo });
                return true;
            };
            if (status === 'connected') {
                const pending = paramString(params, 'pending');
                const username = resolvedConnectUsername;
                // Released Homes completed the identity mutation in the callback and
                // returned no pending handle. Preserve that predecessor completion.
                if (!pending) {
                    await finalizeConnectNavigation();
                    return;
                }
                if (!username || !credentials) {
                    await Modal.alert(t('common.error'), t('errors.oauthStateMismatch'));
                    await finalizeConnectNavigation();
                    return;
                }
                try {
                    safeSetBusy(true);
                    if (!await finalizeConnectAndAdoptCredential({ pending, username })) return;
                } catch (e) {
                    if (await presentTeamConnectFailure(e)) return;
                    await Modal.alert(
                        t('common.error'),
                        e instanceof HappyError
                            ? mapFinalizeErrorToMessage(e.message)
                            : t('errors.operationFailed'),
                    );
                } finally {
                    safeSetBusy(false);
                }
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
                        await provider.cancelConnectPending(credentials, pending, connectRequestContext);
                    } catch {
                        await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    } finally {
                        await finalizeConnectNavigation();
                    }
                    return;
                }

                try {
                    safeSetBusy(true);
                    if (!await finalizeConnectAndAdoptCredential({ pending, username: next })) return;
                    await finalizeConnectNavigation();
                    return;
                } catch (e) {
                    if (await presentTeamConnectFailure(e)) return;
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
            if (retireClaimedPasswordEnrollmentOnDispose) {
                clearAccountPasswordEnrollmentExternalAuthCustody();
            }
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
        resolvedAdmissionReference,
        resolvedConnectUsername,
        resolvedPurpose,
        resolvedResultHandle,
        resolvedCredentialTarget,
        resolvedEndpointUrl,
        resolvedEndpointIdentity,
        resolvedCanonicalServerUrl,
        resolvedDirectoryReturn,
        auth.login,
        auth.loginWithCredentials,
        resolvedFlow === 'auth' ? '' : auth.credentials?.token ?? '',
    ]);

    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);

    const cancelAccountDirectoryJourney = React.useCallback(async () => {
        if (accountDirectoryCredentialCommitStartedRef.current) return;
        const attempt = accountDirectoryAttemptRef.current;
        attempt?.controller.abort('account-service-oauth-cancelled');
        const fallbackEndpoint = normalizeAccountDirectoryEndpoint(
            resolvedEndpointUrl ?? '',
        );
        const fallbackIdentity = normalizeAccountDirectoryIdentityParam(
            resolvedEndpointIdentity,
        );
        const target = attempt?.target ?? (fallbackEndpoint && fallbackIdentity
            ? {
                endpoint: fallbackEndpoint,
                serverIdentityId: fallbackIdentity,
            }
            : null);
        if (target && attempt?.pending) {
            await TokenStorage
                .clearPendingAccountDirectoryAuth(target, { expected: attempt.pending })
                .catch(() => false);
        }
        accountDirectoryAttemptRef.current = null;
        accountDirectoryCredentialCommitStartedRef.current = false;
        router.replace(admitInternalRouteHref(attempt?.returnTo ?? '/settings/account'));
    }, [resolvedEndpointIdentity, resolvedEndpointUrl, router]);

    const recoverAccountDirectoryJourney = React.useCallback(() => {
        const returnTo = accountDirectoryAttemptRef.current?.returnTo
            ?? '/settings/account';
        accountDirectoryAttemptRef.current = null;
        accountDirectoryCredentialCommitStartedRef.current = false;
        router.replace(admitInternalRouteHref(returnTo));
    }, [router]);

    const wizardTitle =
        provisioningChoiceOpen
            ? t('welcome.chooseEncryptionTitle')
            : usernameHint != null
                ? t('profile.username')
                : t('setupOnboarding.resumeIntentTitle');

    const wizardSubtitle =
        provisioningChoiceOpen
            ? t('welcome.chooseEncryptionBody')
            : usernameHint != null
                ? usernameHint
                : t('setupOnboarding.resumeIntentBody');

    // The return lands in the step frame (the welcome pane signed out): its choices and field are
    // the shared button and field owners on the frame's column, not a centred island of their own.
    const body = provisioningChoiceOpen ? (
        <View style={{ width: '100%', gap: theme.space.s12 }}>
            <RoundButton
                testID="oauth-provisioning-choice-e2ee"
                size="normal"
                title={t('welcome.chooseEncryptionEncrypted')}
                action={async () => { await chooseProvisioningMode('e2ee'); }}
                disabled={busy}
            />
            <RoundButton
                testID="oauth-provisioning-choice-plain"
                size="normal"
                display="secondary"
                title={t('welcome.chooseEncryptionPlain')}
                action={async () => { await chooseProvisioningMode('plain'); }}
                disabled={busy}
            />
            {busy ? <ActivitySpinner size="small" /> : null}
        </View>
    ) : usernameHint != null ? (
        <View style={{ width: '100%', gap: theme.space.s16 }}>
            <FieldTextInput
                testID="oauth-username-input"
                value={usernameValue}
                onChangeText={setUsernameValue}
                autoCapitalize="none"
                accessibilityLabel={t('profile.username')}
                placeholder={t('profile.username')}
                returnKeyType="done"
                onSubmitEditing={submitUsername}
            />
            <RoundButton
                testID="oauth-username-save"
                size="normal"
                title={t('common.save')}
                onPress={submitUsername}
                loading={busy}
            />
            <RoundButton
                testID="oauth-username-cancel"
                size="normal"
                display="inverted"
                title={t('common.cancel')}
                onPress={cancelUsername}
            />
        </View>
    ) : busy ? (
        <View style={{ alignItems: 'flex-start' }}>
            <ActivitySpinner size="small" />
        </View>
    ) : null;

    const visibleAccountDirectoryJourney = (resolvedDirectoryReturn || persistedAccountDirectoryReturn)
        ? accountDirectoryJourney ?? {
                kind: 'progress' as const,
                stage: 'signing_in' as const,
                providerName: getAuthProvider(resolvedProviderId)?.displayName
                    ?? resolvedProviderId,
                endpointUrl: normalizeAccountDirectoryEndpoint(
                    resolvedEndpointUrl ?? '',
                ) ?? resolvedEndpointUrl ?? '',
            }
        : null;

    if (teamFailure) {
        const presentation = presentTeamAuthenticationFailure(teamFailure.code);
        // A terminal answer of the sign-in step: it reads in the step frame like every other
        // terminal step (heading, the cause, the way forward), never as a card floating outside it.
        return (
            <AuthRouteStepFrame
                testID="oauth-team-failure"
                title={presentation.title}
                subtitle={presentation.body}
                primary={{
                    testID: 'oauth-team-failure-action',
                    label: t('teams.entry.returnToTeamSignIn'),
                    onPress: () => router.replace(admitInternalRouteHref(teamFailure.returnTo)),
                }}
                secondary={{
                    testID: 'oauth-team-failure-secondary-action',
                    label: t('teams.entry.returnToHappier'),
                    onPress: () => router.replace('/'),
                }}
            >
                {null}
            </AuthRouteStepFrame>
        );
    }

    if (visibleAccountDirectoryJourney) {
        const canCancel = visibleAccountDirectoryJourney.kind === 'progress'
            && visibleAccountDirectoryJourney.stage === 'signing_in'
            && !accountDirectoryCredentialCommitStartedRef.current;
        const directoryFailure = visibleAccountDirectoryJourney.kind === 'error'
            ? describeAccountServiceFailure(visibleAccountDirectoryJourney.failure)
            : null;
        return (
            <AuthRouteStepFrame
                testID="oauth-return-wizard"
                title={t('settingsAccount.accountServiceOAuth.stages.signingIn')}
                secondary={canCancel
                    ? { label: t('common.cancel'), onPress: () => { void cancelAccountDirectoryJourney(); } }
                    : undefined}
                footerHint={canCancel ? (
                    <Text testID="oauth-account-directory-cancel-note">
                        {t('settingsAccount.accountServiceOAuth.cancelNote')}
                    </Text>
                ) : undefined}
            >
                {directoryFailure ? (
                    <SurfaceStateCard
                        testID="oauth-account-directory-failure"
                        kind="error"
                        title={directoryFailure.title}
                        reason={directoryFailure.body}
                        accessibilitySemantics="alert"
                        action={{ label: t('common.back'), onPress: recoverAccountDirectoryJourney }}
                    />
                ) : (
                    <View style={{ alignItems: 'flex-start' }}>
                        <ActivitySpinner size="small" />
                    </View>
                )}
            </AuthRouteStepFrame>
        );
    }

    return (
        <AuthRouteStepFrame
            testID="oauth-return-wizard"
            progress={{ index: 1, count: 3 }}
            title={wizardTitle}
            subtitle={wizardSubtitle}
            onBack={handleBack}
        >
            {body}
        </AuthRouteStepFrame>
    );
}

export default function OAuthProviderReturn() {
    const completedParentAuthSession = React.useMemo(() => {
        try {
            return WebBrowser.maybeCompleteAuthSession().type === 'success';
        } catch {
            return false;
        }
    }, []);

    if (completedParentAuthSession) return null;
    return <OAuthProviderReturnBody />;
}
