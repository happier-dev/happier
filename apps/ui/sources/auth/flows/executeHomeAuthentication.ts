import { Linking, Platform } from 'react-native';

import type { AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { AuthCredentialLifecycleResult, AuthCredentialPersistenceOptions } from '@/auth/context/AuthContext';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { createHomeOAuthRequestContext, createTeamOAuthRequestContext } from '@/auth/providers/homeExternalAuthTarget';
import { getAuthProvider } from '@/auth/providers/registry';
import type { ExternalAuthStartInput, TeamOAuthRequestContext, TeamOAuthStart } from '@/auth/providers/types';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { type AccountHomeAuthenticationContinuation, type AuthCredentials, TokenStorage } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import { encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import sodium from '@/encryption/libsodium.lib';
import { Modal } from '@/modal';
import { digest } from '@/platform/digest';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { formatOperationFailedDebugMessage } from '@/utils/errors/formatOperationFailedDebugMessage';
import { HappyError } from '@/utils/errors/errors';
import { resolveAppUrlScheme } from '@/utils/url/appScheme';
import { t } from '@/text';

import {
    isPersonalHomeAuthenticationTarget,
    resolveHomeAuthenticationTarget,
} from './resolveHomeAuthenticationTarget';
import { createAuthenticationFailure } from './authenticationFailure';
import { authenticationErrorMessage } from './authenticationErrorMessage';
import { moveAccountCredentialJourneyToMain } from './accountCredentialJourney';

type LoginWithCredentials = (
    credentials: AuthCredentials,
    options?: AuthCredentialPersistenceOptions,
) => Promise<AuthCredentialLifecycleResult>;

export type ExecuteHomeAuthenticationOptions = Readonly<{
    request: WelcomeAuthenticationMethod;
    loginWithCredentials: LoginWithCredentials;
    returnTo: string;
    transport?: AccountDirectoryAuthTransport;
    keyChallengeV2Available?: boolean;
    accountContinuation?: AccountHomeAuthenticationContinuation;
    signal?: AbortSignal;
    retryServerCheck?: () => void;
    onAuthenticated?: (authenticatedHome: Readonly<{
        homeServerIdentityId: string;
        credentials: AuthCredentials;
        teamId?: string | null;
    }>) => void | Promise<void>;
    onProvisioned?: () => void | Promise<void>;
    onExternalAuthStarted?: () => void | Promise<void>;
    /** Explicit Team entry context for a Team-bound OAuth action. */
    teamAdmission?: Readonly<{
        teamId: string;
        invitationToken?: string;
        origin?: 'home' | 'team';
        /** Another Account authenticates afresh; the saved Account is never linked instead. */
        accountSelection?: 'current' | 'another';
    }>;
}>;

async function openExternalAuthUrl(url: string): Promise<void> {
    if (Platform.OS === 'web') {
        const location = typeof window !== 'undefined' ? window.location : null;
        if (location && typeof location.assign === 'function') {
            location.assign(url);
            return;
        }
        if (location && typeof location.href === 'string') {
            location.href = url;
            return;
        }
    }
    await Linking.openURL(url);
}

async function promptRetryGeneratedKeyModeResolution(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    let retry = false;
    const alert = Modal.alertAsync(t('common.error'), t('errors.operationFailed'), [
        { text: t('common.retry'), onPress: () => { retry = true; } },
        { text: t('common.cancel'), style: 'cancel' },
    ]);
    if (!signal) {
        await alert;
        return retry;
    }
    let removeAbortListener = () => {};
    const aborted = new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    await Promise.race([alert, aborted]);
    removeAbortListener();
    return retry && !signal.aborted;
}

/**
 * The authenticated Team-admission start.
 *
 * The provisioning start below mints a fresh 32-byte seed whose public key
 * BECOMES an Account (`Account.publicKey`), so a device that already holds this
 * Home's credential would be handed a second Account or refused
 * `provider-already-linked`. An Account that already exists proves itself with
 * the one thing every credential shape carries — its bearer token — so the Team
 * identity is linked to it through the authenticated connect finalizer, which
 * runs the same Team admission the provisioning finalizer does.
 */
async function startTeamAdmissionConnect(input: Readonly<{
    providerId: string;
    /** The Home-projected presentation of this provider choice. */
    presentation: WelcomeAuthenticationMethod['method']['presentation'];
    credentials: AuthCredentials;
    teamAdmission: NonNullable<ExecuteHomeAuthenticationOptions['teamAdmission']>;
    callbackTarget: Readonly<{ serverId: string; serverUrl: string }>;
    /** The exact Home whose saved credential starts this connect. */
    credentialTarget: Readonly<{ serverId: string; serverUrl: string }>;
    returnTo: string;
    transport?: AccountDirectoryAuthTransport;
    signal?: AbortSignal;
    onExternalAuthStarted?: () => void | Promise<void>;
}>): Promise<void> {
    try {
        const provider = getAuthProvider(input.providerId, input.presentation);
        if (!provider) throw new Error('Home OAuth provider is unavailable');
        const requestContext = createTeamOAuthRequestContext(
            input.callbackTarget,
            input.teamAdmission.teamId,
            input.transport,
            input.signal,
            input.teamAdmission.invitationToken,
            input.teamAdmission.origin,
        );
        if (!requestContext) throw new Error('Team OAuth target is unavailable');
        // The connect continuation owns its own return custody, exactly as the
        // Account Security link journey does; no keypair or proof is minted. It
        // is bound to the exact Home whose credential starts it, so the browser
        // return finalizes there even while another Home stays focused (TA-R14).
        if (!await TokenStorage.setPendingExternalConnect({
            provider: input.providerId,
            ...(input.presentation ? { presentation: input.presentation } : {}),
            returnTo: input.returnTo,
            serverUrl: input.credentialTarget.serverUrl,
            serverId: input.credentialTarget.serverId,
        })) {
            throw new Error('Failed to persist pending external connection');
        }
        const start = await provider.getConnectUrl(input.credentials, requestContext);
        if (input.signal?.aborted) throw new Error('Home authentication cancelled');
        if (!isSafeExternalAuthUrl(start.url)) throw new Error('Invalid Home OAuth URL');
        await openExternalAuthUrl(start.url);
        if (input.signal?.aborted) return;
        await input.onExternalAuthStarted?.();
    } catch {
        await TokenStorage.clearPendingExternalConnect().catch(() => false);
        if (!input.signal?.aborted) {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    }
}

function transportFields(transport: AccountDirectoryAuthTransport | undefined) {
    return {
        ...(transport?.runtimeOrigin ? { runtimeOrigin: transport.runtimeOrigin } : {}),
        ...(transport?.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
    };
}

function parseNativeMtlsStart(value: unknown): Readonly<{ startUrl: string; admissionReference: string }> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.startUrl !== 'string' || !record.startUrl.trim()) return null;
    if (typeof record.admissionReference !== 'string' || !record.admissionReference.trim()) return null;
    return { startUrl: record.startUrl, admissionReference: record.admissionReference };
}

function resolveNativeMtlsStartUrl(raw: string, exactServerUrl: string): string | null {
    try {
        const base = new URL(`${exactServerUrl.replace(/\/+$/, '')}/`);
        const value = raw.trim();
        const resolved = /^[a-z][a-z\d+.-]*:/i.test(value)
            ? new URL(value)
            : new URL(value.replace(/^\/+/, ''), base);
        if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return null;
        const url = resolved.toString();
        return isSafeExternalAuthUrl(url) ? url : null;
    } catch {
        return null;
    }
}

/**
 * Why the generic helper did nothing. Dispatch here is exhaustive by execution
 * kind: a destination this helper does not own is delegated to its named
 * controller or fails closed, and can never reach the mTLS/OAuth tail by
 * fallthrough (L02-R28).
 */
export type HomeAuthenticationExecutionOutcome =
    | Readonly<{ kind: 'handled' }>
    | Readonly<{
        kind: 'no_effect';
        reason:
            | 'not_home_purpose'
            | 'delegated_key_entry'
            | 'delegated_email_password'
            | 'unsupported_execution';
    }>;

export async function executeHomeAuthentication(
    options: ExecuteHomeAuthenticationOptions,
): Promise<HomeAuthenticationExecutionOutcome> {
    const request = options.request;
    if (request.authority.purpose !== 'home') return { kind: 'no_effect', reason: 'not_home_purpose' };
    const executionKind: string = request.execution.kind;
    // Recovery-key entry and every native email/password action own their own
    // controller. Naming them explicitly keeps the tail below reachable only by
    // the three executions this helper actually implements.
    if (executionKind === 'key_entry') return { kind: 'no_effect', reason: 'delegated_key_entry' };
    if (executionKind === 'email_password') return { kind: 'no_effect', reason: 'delegated_email_password' };
    if (executionKind !== 'generated_key' && executionKind !== 'oauth' && executionKind !== 'mtls') {
        return { kind: 'no_effect', reason: 'unsupported_execution' };
    }
    const target = resolveHomeAuthenticationTarget(request.authority.target);
    if (target && !options.accountContinuation && !options.teamAdmission?.invitationToken
        && await moveAccountCredentialJourneyToMain({ kind: 'home', profileRef: target.serverId, returnTo: options.returnTo })) {
        await options.onExternalAuthStarted?.();
        return { kind: 'handled' };
    }
    await runExecutableHomeAuthentication(options);
    return { kind: 'handled' };
}

async function runExecutableHomeAuthentication(options: ExecuteHomeAuthenticationOptions): Promise<void> {
    const request = options.request;
    if (request.authority.purpose !== 'home') return;
    const resolvedTarget = resolveHomeAuthenticationTarget(request.authority.target);
    if (!resolvedTarget || options.signal?.aborted) return;
    const isPersonalHome = isPersonalHomeAuthenticationTarget(request.authority.target);
    if (options.accountContinuation?.homeServerIdentityId !== undefined
        && options.accountContinuation.homeServerIdentityId !== resolvedTarget.serverIdentityId) return;
    const persistenceTarget = { serverUrl: resolvedTarget.canonicalServerUrl, serverId: resolvedTarget.serverId };
    const authenticated = async (credentials: AuthCredentials, teamId?: string) => {
        if (options.signal?.aborted) return;
        await options.onAuthenticated?.({
            homeServerIdentityId: resolvedTarget.serverIdentityId,
            credentials,
            ...(teamId ? { teamId } : {}),
        });
    };

    if (request.execution.kind === 'generated_key') {
        let secret: Uint8Array | undefined;
        try {
            let mayStart = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => {
                    const guarded = await guardAccountEncryptionFirstKeyCredentialMutation(persistenceTarget);
                    return guarded.kind === 'allowed' ? { kind: 'completed' } : guarded;
                },
                onCompleted: () => { mayStart = true; },
            });
            if (!mayStart) return;
            secret = await getRandomBytesAsync(32);
            const credentials = await authGetTokenAtEndpoint({
                ...resolvedTarget,
                ...transportFields(options.transport),
                signal: options.signal,
                secret,
                requireKeyChallengeV2: options.keyChallengeV2Available === true,
                ...(options.teamAdmission?.invitationToken
                    ? { admission: { kind: 'team_invitation' as const, token: options.teamAdmission.invitationToken } }
                    : {}),
            });
            const requestAtTarget = createServerFetchAtEndpoint({
                endpointUrl: resolvedTarget.endpointUrl,
                serverId: resolvedTarget.serverId,
                ...transportFields(options.transport),
                credentials,
                signal: options.signal,
            });
            let mode: 'plain' | 'e2ee';
            for (;;) {
                try {
                    ({ mode } = await fetchAccountEncryptionMode(credentials, {
                        request: (path, init) => requestAtTarget(path, init, { includeAuth: false, retry: 'none' }),
                    }));
                    break;
                } catch {
                    if (options.signal?.aborted || !await promptRetryGeneratedKeyModeResolution(options.signal)) return;
                }
            }
            const committedCredentials: AuthCredentials = mode === 'plain'
                ? { token: credentials.token }
                : { token: credentials.token, secret: encodeBase64(secret, 'base64url') };
            if (mode === 'e2ee') await createEncryptionFromAuthCredentials(committedCredentials);
            if (options.signal?.aborted) return;
            await presentFirstKeyCredentialLifecycle({
                run: () => options.loginWithCredentials(committedCredentials, { target: persistenceTarget }),
                onCompleted: async () => {
                    await options.onProvisioned?.();
                    await authenticated(committedCredentials, options.teamAdmission?.teamId);
                },
            });
        } catch (error) {
            if (options.signal?.aborted) return;
            if (error instanceof HappyError && error.code === 'signup-disabled') {
                options.retryServerCheck?.();
                await Modal.alert(
                    t('common.error'),
                    authenticationErrorMessage(error, resolvedTarget.canonicalServerUrl, { isPersonalHome })
                        ?? t('errors.signupDisabled'),
                );
                return;
            }
            const message = authenticationErrorMessage(error, resolvedTarget.canonicalServerUrl, { isPersonalHome }) ?? (process.env.EXPO_PUBLIC_DEBUG
                ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
                : t('errors.operationFailed'));
            await Modal.alert(t('common.error'), message);
        } finally {
            secret?.fill(0);
        }
        return;
    }

    const callbackTarget = {
        serverId: resolvedTarget.serverIdentityId,
        serverUrl: resolvedTarget.endpointUrl.replace(/\/+$/, ''),
    };
    if (request.execution.kind === 'oauth') {
        const providerId = request.execution.providerId;
        if (options.teamAdmission && options.teamAdmission.accountSelection !== 'another') {
            const existing = await TokenStorage.getCredentialsForServerUrl(
                persistenceTarget.serverUrl,
                { serverId: persistenceTarget.serverId },
            ).catch(() => null);
            if (options.signal?.aborted) return;
            if (existing) {
                await startTeamAdmissionConnect({
                    providerId,
                    presentation: request.method.presentation,
                    credentials: existing,
                    teamAdmission: options.teamAdmission,
                    callbackTarget,
                    credentialTarget: persistenceTarget,
                    returnTo: options.returnTo,
                    ...(options.transport ? { transport: options.transport } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                    ...(options.onExternalAuthStarted
                        ? { onExternalAuthStarted: options.onExternalAuthStarted }
                        : {}),
                });
                return;
            }
        }
        try {
            let mayStart = false;
            await presentFirstKeyCredentialLifecycle({
                run: async () => {
                    const guard = await guardAccountEncryptionFirstKeyCredentialMutation(persistenceTarget);
                    return guard.kind === 'allowed' ? { kind: 'completed' } : guard;
                },
                onCompleted: () => { mayStart = true; },
            });
            if (!mayStart) return;
            if (options.signal?.aborted) return;
            const proof = encodeBase64(await getRandomBytesAsync(32), 'base64url');
            const proofHash = encodeHex(await digest('SHA-256', new TextEncoder().encode(proof))).toLowerCase();
            let secret: string | undefined;
            let publicKey: string | undefined;
            if (request.execution.mode === 'keyed') {
                const secretBytes = await getRandomBytesAsync(32);
                secret = encodeBase64(secretBytes, 'base64url');
                publicKey = encodeBase64(sodium.crypto_sign_seed_keypair(secretBytes).publicKey);
            }
            // A dynamic provider is built from the Home's projected presentation
            // (teams-lane-03/01 §10.2), never re-derived from its id.
            const provider = getAuthProvider(providerId, request.method.presentation);
            // The return route rebuilds the provider on a fresh load; custody carries
            // the same projected presentation so it never re-derives one from the id.
            const startPresentation = request.method.presentation
                ? { presentation: request.method.presentation }
                : {};
            if (options.signal?.aborted) return;
            if (!provider) throw new Error('Home OAuth provider is unavailable');
            const startInput = request.execution.mode === 'keyed'
                ? { mode: 'keyed' as const, proofHash, publicKey: publicKey! }
                : { mode: 'keyless' as const, proofHash };
            let url: string;
            let pending;
            if (options.teamAdmission) {
                const requestContext = createTeamOAuthRequestContext(
                    callbackTarget,
                    options.teamAdmission.teamId,
                    options.transport,
                    options.signal,
                    options.teamAdmission.invitationToken,
                    options.teamAdmission.origin,
                );
                if (!requestContext) throw new Error('Team OAuth target is unavailable');
                const startTeamOAuth: (
                    input: ExternalAuthStartInput,
                    context: TeamOAuthRequestContext,
                ) => Promise<TeamOAuthStart> = provider.getExternalAuthUrl;
                const start = await startTeamOAuth(startInput, requestContext);
                url = start.url;
                pending = {
                    provider: providerId,
                    ...startPresentation,
                    proof,
                    ...(secret ? { secret } : {}),
                    ...callbackTarget,
                    teamContinuation: {
                        v: 1 as const,
                        purpose: 'team_admission' as const,
                        admissionReference: start.admissionReference,
                        teamId: options.teamAdmission.teamId,
                        homeServerIdentityId: resolvedTarget.serverIdentityId,
                        destination: { kind: 'team_sign_in' as const, teamId: options.teamAdmission.teamId },
                    },
                };
            } else {
                const requestContext = createHomeOAuthRequestContext(
                    callbackTarget,
                    options.transport,
                    options.signal,
                );
                if (!requestContext) throw new Error('Home OAuth target is unavailable');
                url = await provider.getExternalAuthUrl(startInput, requestContext);
                pending = {
                    provider: providerId,
                    ...startPresentation,
                    proof,
                    ...(secret ? { secret } : {}),
                    returnTo: options.accountContinuation?.returnTo ?? options.returnTo,
                    ...callbackTarget,
                    ...(options.accountContinuation ? { accountContinuation: options.accountContinuation } : {}),
                };
            }
            if (!await TokenStorage.setPendingExternalAuth(pending, callbackTarget)) {
                throw new Error('Failed to persist pending external authentication');
            }
            if (options.signal?.aborted) throw new Error('Home authentication cancelled');
            if (!isSafeExternalAuthUrl(url)) throw new Error('Invalid Home OAuth URL');
            await openExternalAuthUrl(url);
            if (options.signal?.aborted) return;
            await options.onExternalAuthStarted?.();
        } catch {
            await TokenStorage.clearPendingExternalAuth(callbackTarget).catch(() => false);
            if (!options.signal?.aborted) {
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
            }
        }
        return;
    }

    try {
        if (Platform.OS !== 'web') {
            const callbackUrl = `${resolveAppUrlScheme()}:///mtls`;
            try {
                if (options.signal?.aborted) throw new Error('Home authentication cancelled');
                if (!options.teamAdmission) {
                    const pending = {
                        provider: 'mtls',
                        ...callbackTarget,
                        returnTo: options.accountContinuation?.returnTo ?? options.returnTo,
                        ...(options.accountContinuation ? { accountContinuation: options.accountContinuation } : {}),
                    };
                    if (!await TokenStorage.setPendingExternalAuth(pending, callbackTarget)) {
                        throw new Error('Failed to persist pending mTLS authentication');
                    }
                    const legacyStartUrl = resolveNativeMtlsStartUrl(
                        `/v1/auth/mtls/start?returnTo=${encodeURIComponent(callbackUrl)}`,
                        callbackTarget.serverUrl,
                    );
                    if (!legacyStartUrl) throw new Error('Invalid mTLS start URL');
                    if (options.signal?.aborted) throw new Error('Home authentication cancelled');
                    await openExternalAuthUrl(legacyStartUrl);
                    if (options.signal?.aborted) return;
                    await options.onExternalAuthStarted?.();
                    return;
                }
                const requestAtTarget = createServerFetchAtEndpoint({
                    endpointUrl: callbackTarget.serverUrl,
                    serverId: callbackTarget.serverId,
                    ...transportFields(options.transport),
                    signal: options.signal,
                });
                const response = await requestAtTarget('/v1/auth/mtls/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        returnTo: callbackUrl,
                        teamId: options.teamAdmission.teamId,
                        ...(options.teamAdmission.invitationToken
                            ? { admission: { kind: 'team_invitation' as const, token: options.teamAdmission.invitationToken } }
                            : {}),
                    }),
                }, { includeAuth: false, retry: 'none' });
                const payload = await response.json().catch(() => null);
                if (!response.ok) throw createAuthenticationFailure(response.status, payload);
                const start = parseNativeMtlsStart(payload);
                const startUrl = start ? resolveNativeMtlsStartUrl(start.startUrl, callbackTarget.serverUrl) : null;
                if (!start || !startUrl) throw new Error('Invalid mTLS start response');
                const pending = {
                    provider: 'mtls',
                    ...callbackTarget,
                    teamContinuation: {
                        v: 1 as const,
                        purpose: 'team_admission' as const,
                        admissionReference: start.admissionReference,
                        teamId: options.teamAdmission.teamId,
                        homeServerIdentityId: resolvedTarget.serverIdentityId,
                        destination: { kind: 'team_sign_in' as const, teamId: options.teamAdmission.teamId },
                    },
                };
                if (!await TokenStorage.setPendingExternalAuth(pending, callbackTarget)) {
                    throw new Error('Failed to persist pending mTLS authentication');
                }
                if (options.signal?.aborted) throw new Error('Home authentication cancelled');
                await openExternalAuthUrl(startUrl);
                if (options.signal?.aborted) return;
                await options.onExternalAuthStarted?.();
            } catch (error) {
                await TokenStorage.clearPendingExternalAuth(callbackTarget).catch(() => false);
                throw error;
            }
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
            const requestAtTarget = createServerFetchAtEndpoint({
                endpointUrl: callbackTarget.serverUrl,
                serverId: callbackTarget.serverId,
                ...transportFields(options.transport),
                signal: options.signal,
            });
            const response = await requestAtTarget('/v1/auth/mtls', {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(options.teamAdmission?.invitationToken
                    ? { admission: { kind: 'team_invitation', token: options.teamAdmission.invitationToken } }
                    : {}),
            }, { includeAuth: false });
            const payload = await response.json().catch(() => null);
            if (!response.ok) throw createAuthenticationFailure(response.status, payload);
            if (!payload || typeof payload.token !== 'string') throw new Error('Invalid mTLS response');
            if (options.signal?.aborted) return;
            const credentials = { token: String(payload.token) };
            await presentFirstKeyCredentialLifecycle({
                run: () => options.loginWithCredentials(credentials, { target: persistenceTarget }),
                onCompleted: () => authenticated(credentials, options.teamAdmission?.teamId),
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (error) {
        if (options.signal?.aborted) return;
        const message = authenticationErrorMessage(error, resolvedTarget.canonicalServerUrl, { isPersonalHome }) ?? (process.env.EXPO_PUBLIC_DEBUG
            ? formatOperationFailedDebugMessage(t('errors.operationFailed'), error)
            : t('errors.operationFailed'));
        await Modal.alert(t('common.error'), message);
    }
}
