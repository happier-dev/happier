import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { AccountEncryptionMigrateExternalAuthProofSchema, AccountEncryptionMigrateRequestSchema, createAccountEncryptionMigrateRequestBindingDigestV1, type AccountEncryptionMigrateExternalAuthProof, type AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import { AccountExternalAuthProofV1Schema, type AccountExternalAuthProofV1 } from '@happier-dev/protocol/auth/accountExternalAuthProof';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1, PasswordCredentialMutationV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { PlainAccountPasswordCredentialV1Schema, type PlainAccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import {
    ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS,
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
    TokenStorage,
    type AuthCredentials,
    type LegacyAuthCredentials,
    type PendingExternalAuth,
} from '@/auth/storage/tokenStorage';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import { digest } from '@/platform/digest';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    migrateAccountEncryptionMode,
} from '@/sync/api/account/apiAccountEncryptionMigrate';
import {
    fetchAccountEncryptionCurrentness,
} from '@/sync/api/account/apiAccountEncryptionMode';
import {
    getServerFeaturesSnapshot,
    probeServerFeaturesAtUrl,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    createServerFetchAtEndpoint,
    type ServerFetch,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { parseToken } from '@/utils/auth/parseToken';
import { normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import {
    getActiveServerId,
    getActiveServerUrl,
    getServerProfileById,
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { acquireAccountServiceAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import {
    projectAuthEntryMethodCapabilities,
    projectAuthenticationMethodCapabilities,
    type AuthenticationMethodCapabilities,
} from '@/auth/capabilities/authMethodCapabilities';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { preparePlainAccountPasswordEnroll } from '@/sync/api/auth/accountSecurity';

const FIRST_KEY_PURPOSE = 'account_encryption_first_key';
const PASSWORD_ENROLLMENT_PURPOSE = 'account_password_enrollment';

type FirstKeyMigrationInput = Readonly<{
    accountId: string;
    currentCredentials: AuthCredentials;
    proposedCredentials: LegacyAuthCredentials;
    request: AccountEncryptionMigrateRequest;
}>;

type AccountEncryptionScopeGuard = Readonly<{
    isCurrent(): boolean;
}>;

function assertAccountEncryptionScopeCurrent(scopeGuard: AccountEncryptionScopeGuard | undefined): void {
    if (scopeGuard && !scopeGuard.isCurrent()) {
        throw new Error('account_encryption_scope_changed');
    }
}

type FirstKeyStartResult =
    | Readonly<{
        kind: 'oauth';
        provider: string;
        url: string;
    }>
    | Readonly<{
        kind: 'mtls';
        externalAuthProof: AccountEncryptionMigrateExternalAuthProof;
    }>
    | Readonly<{
        kind: 'email_password';
        externalAuthProof: AccountEncryptionMigrateExternalAuthProof;
    }>;

export type AccountEncryptionFirstKeyCredentialMutationResult =
    | Readonly<{ kind: 'allowed' }>
    | Readonly<{
        kind: 'finish_encryption_setup';
        recovery: AccountEncryptionFirstKeyRecoveryHandle;
    }>;

export type AccountEncryptionFirstKeyAbandonResult =
    | Readonly<{ kind: 'abandoned' }>
    | Readonly<{ kind: 'recovery_failed' }>;

export type AccountEncryptionFirstKeyRejectedCredentialMarkResult =
    | Readonly<{
        kind: 'recorded';
        recovery:
            AccountEncryptionFirstKeyRecoveryHandle;
    }>
    | Readonly<{ kind: 'not_current' }>
    | Readonly<{ kind: 'write_failed' }>;

export type AccountEncryptionFirstKeyRejectedCredentialRecoveryResult =
    | Readonly<{
        kind: 'completed';
        returnTo: string;
        mode: 'e2ee';
    }>
    | Readonly<{ kind: 'not_applicable' }>
    | Readonly<{ kind: 'recovery_failed' }>;

const firstKeyRecoveryHandleBrand = Symbol(
    'account-encryption-first-key-recovery',
);
const firstKeyCredentialPersistenceBrand = Symbol(
    'account-encryption-first-key-credential-persistence',
);

export type AccountEncryptionFirstKeyRecoveryHandle = Readonly<{
    [firstKeyRecoveryHandleBrand]: true;
    pending: PendingExternalAuth;
    serverUrl?: string;
    serverId?: string;
}>;

export type AccountEncryptionFirstKeyCredentialPersistenceAuthorization =
    Readonly<{
        [firstKeyCredentialPersistenceBrand]: true;
        token: string;
    }>;

export type AccountEncryptionFirstKeyCredentialPersistenceOptions =
    Readonly<{
        firstKeyRecoveryAuthorization:
            AccountEncryptionFirstKeyCredentialPersistenceAuthorization;
        target: FirstKeyHomeTarget;
    }>;

type FirstKeyHomeTarget = Readonly<{
    serverUrl: string;
    serverId: string;
}>;

function normalizeFirstKeyHomeTarget(
    value: Readonly<{
        serverUrl?: string | null;
        serverId?: string | null;
    }>,
): FirstKeyHomeTarget {
    const serverUrl = String(value.serverUrl ?? '').trim();
    const serverId = String(value.serverId ?? '').trim();
    if (!serverUrl || !serverId) return invalidExternalAuth();
    return { serverUrl, serverId };
}

async function acquireFirstKeyTargetRequest(
    target: FirstKeyHomeTarget,
    credentials?: AuthCredentials,
    signal?: AbortSignal,
) {
    const serverIdentityId = getServerProfileById(target.serverId)?.serverIdentityId?.trim() ?? target.serverId;
    const acquired = await acquireAccountServiceAuthTransport({ serverIdentityId, canonicalServerUrl: target.serverUrl });
    const request = createServerFetchAtEndpoint({
        endpointUrl: target.serverUrl,
        serverId: target.serverId,
        ...acquired.transport,
        runtimeOrigin: acquired.transport.runtimeOrigin ?? undefined,
        ...(credentials ? { credentials } : {}),
        ...(signal ? { signal } : {}),
    });
    return { ...acquired, request };
}

export function isAccountEncryptionFirstKeyCredentialPersistenceAuthorized(
    value: unknown,
    credentials: AuthCredentials,
): boolean {
    if (
        !value
        || typeof value !== 'object'
        || !(
            'firstKeyRecoveryAuthorization'
            in value
        )
    ) {
        return false;
    }
    const authorization = (
        value as AccountEncryptionFirstKeyCredentialPersistenceOptions
    ).firstKeyRecoveryAuthorization;
    return (
        authorization
            ?.[firstKeyCredentialPersistenceBrand] === true
        && authorization.token === credentials.token
        && isLegacyAuthCredentials(credentials)
    );
}

function isMarkedFirstKeyCustody(
    value: PendingExternalAuth | null,
): value is PendingExternalAuth {
    return value?.accountEncryptionFirstKey
        ?.migrationSubmissionAttempted === true;
}

export async function guardAccountEncryptionFirstKeyCredentialMutation(
    target?: Readonly<{
        serverUrl: string;
        serverId?: string;
    }>,
): Promise<AccountEncryptionFirstKeyCredentialMutationResult> {
    let pendingState =
        target
            ? await TokenStorage
                .readPendingExternalAuthStateForServerUrl(
                    target.serverUrl,
                    target.serverId
                        ? { serverId: target.serverId }
                        : {},
                )
            : await TokenStorage
                .readPendingExternalAuthState();
    let resolvedTarget = target;
    if (
        !target
        && (
            pendingState.serverMismatch
            || !isMarkedFirstKeyCustody(
                pendingState.value,
            )
        )
    ) {
        for (const profile of listServerProfiles()) {
            const candidate =
                await TokenStorage
                    .readPendingExternalAuthStateForServerUrl(
                        profile.serverUrl,
                        { serverId: profile.id },
                    );
            if (
                candidate.serverMismatch
                || !isMarkedFirstKeyCustody(
                    candidate.value,
                )
            ) {
                continue;
            }
            pendingState = candidate;
            resolvedTarget = {
                serverUrl: profile.serverUrl,
                serverId: profile.id,
            };
            break;
        }
    }
    if (
        (target && pendingState.serverMismatch)
        || !isMarkedFirstKeyCustody(
            pendingState.value,
        )
    ) {
        return { kind: 'allowed' };
    }
    return {
        kind: 'finish_encryption_setup',
        recovery: {
            [firstKeyRecoveryHandleBrand]: true,
            pending: pendingState.value,
            ...(resolvedTarget?.serverUrl
                ? { serverUrl: resolvedTarget.serverUrl }
                : {}),
            ...(resolvedTarget?.serverId
                ? { serverId: resolvedTarget.serverId }
                : {}),
        },
    };
}

export async function abandonAccountEncryptionFirstKeyExternalAuth(
    recovery: AccountEncryptionFirstKeyRecoveryHandle,
): Promise<AccountEncryptionFirstKeyAbandonResult> {
    if (
        recovery?.[firstKeyRecoveryHandleBrand] !== true
        || !isMarkedFirstKeyCustody(recovery.pending)
    ) {
        return { kind: 'recovery_failed' };
    }
    const removed =
        await TokenStorage.clearPendingExternalAuth({
            removeFirstKeyMigrationAttempted:
                recovery.pending,
            ...(recovery.serverUrl
                ? { serverUrl: recovery.serverUrl }
                : {}),
            ...(recovery.serverId
                ? { serverId: recovery.serverId }
                : {}),
        });
    return removed
        ? { kind: 'abandoned' }
        : { kind: 'recovery_failed' };
}

export async function markAccountEncryptionFirstKeyRejectedCredential(
    params: Readonly<{
        recovery:
            AccountEncryptionFirstKeyRecoveryHandle;
        token: string;
    }>,
): Promise<AccountEncryptionFirstKeyRejectedCredentialMarkResult> {
    const { recovery } = params;
    if (
        recovery?.[firstKeyRecoveryHandleBrand] !== true
        || !isMarkedFirstKeyCustody(
            recovery.pending,
        )
        || !recovery.serverUrl
    ) {
        return { kind: 'not_current' };
    }
    const marked =
        await TokenStorage
            .markPendingExternalAuthFirstKeyRejectedCredential({
                expected: recovery.pending,
                token: params.token,
                serverUrl:
                    recovery.serverUrl,
                ...(recovery.serverId
                    ? {
                        serverId:
                            recovery.serverId,
                    }
                    : {}),
            });
    if (marked.kind !== 'recorded') {
        return marked;
    }
    return {
        kind: 'recorded',
        recovery: {
            [firstKeyRecoveryHandleBrand]: true,
            pending: marked.pending,
            serverUrl:
                recovery.serverUrl,
            ...(recovery.serverId
                ? {
                    serverId:
                        recovery.serverId,
                }
                : {}),
        },
    };
}

export async function recoverAccountEncryptionFirstKeyRejectedCredential(
    params: Readonly<{
        recovery:
            AccountEncryptionFirstKeyRecoveryHandle;
        persistCredentials: (
            credentials: LegacyAuthCredentials,
            options:
                AccountEncryptionFirstKeyCredentialPersistenceOptions,
        ) => Promise<Readonly<{ kind: string }>>;
        target?: FirstKeyHomeTarget;
        scopeGuard?: AccountEncryptionScopeGuard;
    }>,
): Promise<AccountEncryptionFirstKeyRejectedCredentialRecoveryResult> {
    const { recovery } = params;
    if (
        recovery?.[firstKeyRecoveryHandleBrand] !== true
        || !isMarkedFirstKeyCustody(recovery.pending)
    ) {
        return { kind: 'recovery_failed' };
    }
    if (
        !recovery.pending.accountEncryptionFirstKey
            ?.rejectedCredentialTokenDigest
    ) {
        return { kind: 'not_applicable' };
    }
    if (!recovery.serverUrl) {
        return { kind: 'recovery_failed' };
    }

    try {
        const state =
            await TokenStorage
                .readExactPendingExternalAuthFirstKeyMigrationAttempt({
                    expected: recovery.pending,
                    serverUrl: recovery.serverUrl,
                    ...(recovery.serverId
                        ? {
                            serverId:
                                recovery.serverId,
                        }
                        : {}),
                });
        const continuation =
            state?.accountEncryptionFirstKey;
        if (
            !state
            || continuation
                ?.migrationSubmissionAttempted !== true
            || !continuation
                .rejectedCredentialTokenDigest
            || typeof state.secret !== 'string'
        ) {
            return { kind: 'recovery_failed' };
        }

        const seed = decodeBase64(
            state.secret,
            'base64url',
        );
        if (seed.length !== 32) {
            return { kind: 'recovery_failed' };
        }
        const target = normalizeFirstKeyHomeTarget({
            serverId: recovery.serverId ?? state.serverId,
            serverUrl: recovery.serverUrl ?? state.serverUrl,
        });
        if (params.target && (params.target.serverId !== target.serverId || params.target.serverUrl !== target.serverUrl)) {
            return { kind: 'recovery_failed' };
        }
        const serverIdentityId = getServerProfileById(target.serverId)?.serverIdentityId?.trim();
        const acquired = await acquireFirstKeyTargetRequest(target);
        try {
            const { token } = await authGetTokenAtEndpoint({
                endpointUrl: target.serverUrl, canonicalServerUrl: target.serverUrl, serverId: target.serverId,
                ...(serverIdentityId ? { serverIdentityId } : {}),
                ...acquired.transport, runtimeOrigin: acquired.transport.runtimeOrigin ?? undefined,
                secret: seed, expectedAccountId: continuation.accountId, requireKeyChallengeV2: true,
            });
            if (
                parseToken(token)
                !== continuation.accountId
            ) {
                return { kind: 'recovery_failed' };
            }
            const credentials = {
                token,
                secret: state.secret,
            } as const;
            await assertCommittedFirstKeyCredentialsMatchCustody({
                state,
                credentials,
                request: acquired.request,
            });

            assertAccountEncryptionScopeCurrent(params.scopeGuard);
            const persistence = await params.persistCredentials(
                credentials,
                {
                    firstKeyRecoveryAuthorization: {
                        [firstKeyCredentialPersistenceBrand]: true,
                        token,
                    },
                    target,
                },
            );
            if (persistence.kind !== 'completed') {
                return { kind: 'recovery_failed' };
            }
            if (
                !await TokenStorage
                    .clearPendingExternalAuth({
                        removeFirstKeyMigrationAttempted:
                            state,
                        serverUrl:
                            recovery.serverUrl,
                        ...(recovery.serverId
                            ? {
                                serverId:
                                    recovery.serverId,
                            }
                            : {}),
                    })
            ) {
                return { kind: 'recovery_failed' };
            }
            return {
                kind: 'completed',
                returnTo:
                    resolveFirstKeyReturnTo(state),
                mode: 'e2ee',
            };
        } finally {
            seed.fill(0);
            await acquired.close();
        }
    } catch {
        return { kind: 'recovery_failed' };
    }
}

function invalidExternalAuth(): never {
    throw new HappyError(
        'first-key-external-auth-invalid',
        false,
        {
            status: 400,
            kind: 'auth',
            code: 'first-key-external-auth-invalid',
        },
    );
}

/**
 * The current-password first-key proof (02.04 :179): the Home verifies the
 * present Account's current Plain password and mints the transition-bound
 * `email_password` variant of the existing first-key proof for this exact
 * migration request digest. Keyless first-key enrollment and a retained-key
 * password-bearing conversion both obtain it here; the raw password only
 * travels in this one request.
 */
export async function requestAccountEncryptionFirstKeyPasswordProof(params: Readonly<{
    request: ServerFetch;
    token: string;
    password: string;
    requestDigest: string;
}>): Promise<AccountEncryptionMigrateExternalAuthProof> {
    const response = await params.request('/v1/auth/email/step-up', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            v: 1,
            password: params.password,
            purpose: FIRST_KEY_PURPOSE,
            requestDigest: params.requestDigest,
        }),
    }, { includeAuth: false, retry: 'none' });
    const payload: unknown = await response.json().catch(() => null);
    const parsed = response.ok && payload && typeof payload === 'object' && 'externalAuthProof' in payload
        ? AccountEncryptionMigrateExternalAuthProofSchema.safeParse(payload.externalAuthProof)
        : null;
    if (!parsed?.success || parsed.data.provider !== 'email_password') return invalidExternalAuth();
    return parsed.data;
}

function unavailableExternalAuth(): never {
    throw new HappyError(
        'first-key-external-auth-unavailable',
        false,
        {
            status: 400,
            kind: 'auth',
            code: 'first-key-external-auth-unavailable',
        },
    );
}

function pendingCleanupFailed(): never {
    throw new HappyError(
        'first-key-pending-cleanup-failed',
        false,
        {
            status: 500,
            kind: 'unknown',
            code: 'first-key-pending-cleanup-failed',
        },
    );
}

function pendingCustodyFailed(): never {
    throw new HappyError(
        'first-key-pending-custody-failed',
        false,
        {
            status: 500,
            kind: 'unknown',
            code: 'first-key-pending-custody-failed',
        },
    );
}

function isDefinitivePreCommitMigrationFailure(
    error: unknown,
): boolean {
    if (!(error instanceof HappyError)) return false;
    const status = error.status;
    return (
        typeof status === 'number'
        && status >= 400
        && status < 500
        && status !== 408
        && status !== 429
    );
}

export async function shouldRetainAccountEncryptionMigrationArtifactUploads(params: Readonly<{
    error: unknown;
    migrationIssued: boolean;
    firstKey?: Readonly<{ accountId: string; request: AccountEncryptionMigrateRequest; target: FirstKeyHomeTarget }>;
}>): Promise<boolean> {
    if (params.firstKey) {
        const { accountId, request, target } = params.firstKey;
        try {
            const pending = await TokenStorage.readPendingExternalAuthStateForServerUrl(target.serverUrl, {
                serverId: target.serverId,
                storageReadFailure: 'surface',
            });
            const firstKey = pending.value?.accountEncryptionFirstKey;
            return !pending.serverMismatch && firstKey?.accountId === accountId
                && firstKey.requestDigest === createAccountEncryptionMigrateRequestBindingDigestV1({ accountId, request, sourceMode: 'plain' });
        } catch {
            // An unreadable custody owner cannot establish that the request was discarded.
            return true;
        }
    }
    return params.migrationIssued && !isDefinitivePreCommitMigrationFailure(params.error);
}

async function clearPendingExternalAuthRequired(
    removeFirstKeyMigrationAttempted?: PendingExternalAuth,
): Promise<void> {
    if (!await TokenStorage.clearPendingExternalAuth(
        removeFirstKeyMigrationAttempted
            ? { removeFirstKeyMigrationAttempted }
            : undefined,
    )) {
        return pendingCleanupFailed();
    }
}

function normalizeProviderId(value: unknown): string {
    return typeof value === 'string'
        ? value.trim().toLowerCase()
        : '';
}

function isRecord(
    value: unknown,
): value is Record<string, unknown> {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value),
    );
}

function assertFirstKeyMigrationInput(
    input: FirstKeyMigrationInput,
): AccountEncryptionMigrateRequest {
    if (
        !isTokenOnlyAuthCredentials(input.currentCredentials)
        || input.currentCredentials.token
            !== input.proposedCredentials.token
        || !input.proposedCredentials.secret
        || !input.accountId.trim()
    ) {
        return invalidExternalAuth();
    }
    const request =
        AccountEncryptionMigrateRequestSchema.safeParse(input.request);
    if (
        !request.success
        || request.data.toMode !== 'e2ee'
        || request.data.expectedSigningKeyFingerprint !== null
        || request.data.expectedContentKeyFingerprint !== null
        || request.data.externalAuthProof !== undefined
        || !request.data.keyProof
    ) {
        return invalidExternalAuth();
    }
    return request.data;
}

async function assertProposedCredentialsMatchRequest(
    proposedCredentials: LegacyAuthCredentials,
    request: AccountEncryptionMigrateRequest,
): Promise<void> {
    let seed: Uint8Array;
    try {
        seed = decodeBase64(
            proposedCredentials.secret,
            'base64url',
        );
    } catch {
        return invalidExternalAuth();
    }
    if (seed.length !== 32 || !request.keyProof) {
        return invalidExternalAuth();
    }
    const contentBinding = await buildContentKeyBinding(seed);
    if (
        request.keyProof.publicKey
            !== encodeBase64(deriveAccountSigningPublicKey(seed))
        || request.keyProof.contentPublicKey
            !== contentBinding.contentPublicKey
        || request.keyProof.contentPublicKeySig
            !== contentBinding.contentPublicKeySig
    ) {
        return invalidExternalAuth();
    }
}

function resolveFirstKeyReturnTo(
    state: PendingExternalAuth,
): string {
    return normalizeInternalReturnPath(state.returnTo) ?? '/settings/account';
}

async function assertCommittedFirstKeyCredentialsMatchCustody(
    params: Readonly<{
        state: PendingExternalAuth;
        credentials: LegacyAuthCredentials;
        request: ServerFetch;
    }>,
): Promise<void> {
    const continuation =
        params.state.accountEncryptionFirstKey;
    if (
        continuation?.migrationSubmissionAttempted !== true
        || params.state.secret !== params.credentials.secret
        || parseToken(params.credentials.token)
            !== continuation.accountId
    ) {
        return invalidExternalAuth();
    }

    let rawRequest: unknown;
    try {
        rawRequest = JSON.parse(
            continuation.requestJson,
        );
    } catch {
        return invalidExternalAuth();
    }
    const parsedRequest =
        AccountEncryptionMigrateRequestSchema.safeParse(
            rawRequest,
        );
    if (
        !parsedRequest.success
        || parsedRequest.data.toMode !== 'e2ee'
        || !parsedRequest.data.keyProof
        || !parsedRequest.data.keyProof.contentPublicKey
        || createAccountEncryptionMigrateRequestBindingDigestV1({
            request: parsedRequest.data,
            accountId: continuation.accountId,
            sourceMode: 'plain',
        }) !== continuation.requestDigest
    ) {
        return invalidExternalAuth();
    }

    await assertProposedCredentialsMatchRequest(
        params.credentials,
        parsedRequest.data,
    );
    const expectedSigningKeyFingerprint =
        computeAccountEncryptionMigrateKeyFingerprintV1(
            decodeBase64(
                parsedRequest.data.keyProof.publicKey,
                'base64url',
            ),
        );
    const expectedContentKeyFingerprint =
        computeAccountEncryptionMigrateKeyFingerprintV1(
            decodeBase64(
                parsedRequest.data.keyProof.contentPublicKey,
                'base64url',
            ),
        );
    const current =
        await fetchAccountEncryptionCurrentness(
            params.credentials,
            { request: params.request },
        );
    if (
        current.mode !== 'e2ee'
        || current.signingKeyFingerprint
            !== expectedSigningKeyFingerprint
        || current.contentKeyFingerprint
            !== expectedContentKeyFingerprint
    ) {
        return invalidExternalAuth();
    }
}

function resolveLinkedPurposeBoundProviderFromCapabilities(
    linkedProviderIds: readonly string[],
    capabilities: AuthenticationMethodCapabilities,
): string | null {
    const availableProviderIds = [
        ...capabilities.configuredKeylessProviderIds,
        ...(capabilities.keylessLoginMethodIds.includes('mtls') ? ['mtls'] : []),
    ];
    return resolveLinkedPurposeBoundProvider(linkedProviderIds, availableProviderIds);
}

function resolveLinkedPurposeBoundProvider(
    linkedProviderIds: readonly string[],
    availableProviderIds: readonly string[],
): string | null {
    const available = new Set(availableProviderIds.map(normalizeProviderId).filter(Boolean));
    for (const rawProviderId of linkedProviderIds) {
        const providerId = normalizeProviderId(rawProviderId);
        if (providerId && available.has(providerId)) return providerId;
    }
    return null;
}

async function createProof(): Promise<Readonly<{
    proof: string;
    proofHash: string;
}>> {
    const proof = encodeBase64(
        getRandomBytes(32),
        'base64url',
    );
    const proofHash = encodeHex(
        await digest(
            'SHA-256',
            new TextEncoder().encode(proof),
        ),
    ).toLowerCase();
    return { proof, proofHash };
}

export async function startAccountEncryptionFirstKeyExternalAuth(
    params: FirstKeyMigrationInput & Readonly<{
        linkedProviderIds: readonly string[];
        nativePassword?: string;
        returnTo: string;
        target?: FirstKeyHomeTarget;
    }>,
): Promise<FirstKeyStartResult> {
    // Capture before the first await. A focus change may happen while secure
    // pending custody or provider parameters are being prepared.
    const target = normalizeFirstKeyHomeTarget(
        params.target ?? {
            serverId: getActiveServerId(),
            serverUrl: getActiveServerUrl(),
        },
    );
    const acquired = await acquireFirstKeyTargetRequest(target);
    const requestAtTarget = acquired.request;
    try {
        await TokenStorage.clearPendingExternalAuth();
        const request = assertFirstKeyMigrationInput(params);
        await assertProposedCredentialsMatchRequest(
            params.proposedCredentials,
            request,
        );
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request,
                accountId: params.accountId,
                sourceMode: 'plain',
            });
        const createdAt = Date.now();
        const serverContext = {
            serverId: target.serverId,
            serverUrl: target.serverUrl,
        };
        const createPendingContinuation = (pending?: string) => ({
            accountId: params.accountId,
            requestDigest,
            requestJson: JSON.stringify(params.request),
            createdAt,
            expiresAt: createdAt + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS,
            ...(pending ? { pending } : {}),
        });
        if (params.nativePassword !== undefined) {
            const externalAuthProof = await requestAccountEncryptionFirstKeyPasswordProof({
                request: requestAtTarget,
                token: params.currentCredentials.token,
                password: params.nativePassword,
                requestDigest,
            });
            const stored = await TokenStorage.setPendingExternalAuth({
                provider: externalAuthProof.provider,
                proof: externalAuthProof.proof,
                secret: params.proposedCredentials.secret,
                returnTo: params.returnTo,
                ...serverContext,
                accountEncryptionFirstKey: createPendingContinuation(externalAuthProof.pending),
            }, target);
            if (!stored) return unavailableExternalAuth();
            return { kind: 'email_password', externalAuthProof };
        }
        const accountScope = createServerAccountScope(target.serverId, params.accountId);
        if (!accountScope) return invalidExternalAuth();
        const authEntry = await fetchHomeAuthEntry({
            accountScope,
            endpointUrl: target.serverUrl,
            serverId: target.serverId,
        });
        let capabilities: AuthenticationMethodCapabilities;
        if (authEntry.kind === 'ready' && authEntry.projection.state === 'ready') {
            capabilities = projectAuthEntryMethodCapabilities(authEntry.projection);
        } else if (authEntry.kind === 'unsupported') {
            // Only a server that genuinely lacks the contextual endpoint may use
            // the canonical released-feature adapter. Incompatible or unavailable
            // current responses must not silently downgrade to legacy decisions.
            const snapshot = params.target
                ? await probeServerFeaturesAtUrl({
                    endpointUrl: target.serverUrl,
                    serverId: target.serverId,
                    ...acquired.transport,
                    runtimeOrigin: acquired.transport.runtimeOrigin ?? undefined,
                    force: true,
                })
                : await getServerFeaturesSnapshot({
                    force: true,
                    serverId: target.serverId,
                });
            if (snapshot.status !== 'ready') return unavailableExternalAuth();
            capabilities = projectAuthenticationMethodCapabilities(snapshot.features);
        } else {
            return unavailableExternalAuth();
        }
        const provider = resolveLinkedPurposeBoundProviderFromCapabilities(
            params.linkedProviderIds,
            capabilities,
        ) ?? unavailableExternalAuth();
        const { proof, proofHash } = await createProof();

        if (provider === 'mtls') {
            const response = await requestAtTarget(
                '/v1/auth/mtls',
                {
                    method: 'POST',
                    headers: {
                        Authorization:
                            `Bearer ${params.currentCredentials.token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        purpose: FIRST_KEY_PURPOSE,
                        proofHash,
                        requestDigest,
                    }),
                },
                { includeAuth: false, retry: 'none' },
            );
            const payload: unknown =
                await response.json().catch(() => null);
            if (
                !response.ok
                || !isRecord(payload)
                || payload.success !== true
                || typeof payload.pending !== 'string'
            ) {
                return invalidExternalAuth();
            }
            const externalAuthProof =
                AccountEncryptionMigrateExternalAuthProofSchema.parse({
                    provider,
                    pending: payload.pending,
                    proof,
                });
            const stored =
                await TokenStorage.setPendingExternalAuth({
                    provider,
                    proof,
                    secret: params.proposedCredentials.secret,
                    returnTo: params.returnTo,
                    ...serverContext,
                    accountEncryptionFirstKey:
                        createPendingContinuation(
                            externalAuthProof.pending,
                        ),
                }, target);
            if (!stored) {
                return unavailableExternalAuth();
            }
            return {
                kind: 'mtls',
                externalAuthProof,
            };
        }

        const stored =
            await TokenStorage.setPendingExternalAuth({
                provider,
                proof,
                secret: params.proposedCredentials.secret,
                returnTo: params.returnTo,
                ...serverContext,
                accountEncryptionFirstKey:
                    createPendingContinuation(),
            }, target);
        if (!stored) {
            return unavailableExternalAuth();
        }

        const query = new URLSearchParams({
            mode: 'keyless',
            purpose: FIRST_KEY_PURPOSE,
            proofHash,
            requestDigest,
        });
        const response = await requestAtTarget(
            `/v1/auth/external/${
                encodeURIComponent(provider)
            }/params?${query.toString()}`,
            {
                method: 'GET',
                headers: {
                    Authorization:
                        `Bearer ${params.currentCredentials.token}`,
                },
            },
            { includeAuth: false, retry: 'none' },
        );
        const payload: unknown =
            await response.json().catch(() => null);
        if (
            !response.ok
            || !isRecord(payload)
            || typeof payload.url !== 'string'
        ) {
            return unavailableExternalAuth();
        }
        return {
            kind: 'oauth',
            provider,
            url: payload.url,
        };
    } catch (error) {
        await TokenStorage.clearPendingExternalAuth();
        throw error;
    } finally {
        await acquired.close();
    }
}

export async function openPurposeBoundAccountExternalAuthUrl(
    url: string,
): Promise<void> {
    if (!isSafeExternalAuthUrl(url)) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        await TokenStorage.clearPendingExternalAuth();
        return invalidExternalAuth();
    }
    try {
        if (Platform.OS === 'web') {
            const browserGlobal =
                globalThis as typeof globalThis & {
                    window?: {
                        location?: {
                            assign?: (value: string) => void;
                        };
                    };
                };
            const location = browserGlobal.window?.location;
            if (typeof location?.assign !== 'function') {
                return invalidExternalAuth();
            }
            location.assign(url);
            return;
        }
        if (!await Linking.canOpenURL(url)) {
            return invalidExternalAuth();
        }
        await Linking.openURL(url);
    } catch (error) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        await TokenStorage.clearPendingExternalAuth();
        throw error;
    }
}

export const openAccountEncryptionFirstKeyExternalAuthUrl =
    openPurposeBoundAccountExternalAuthUrl;

type AccountPasswordEnrollmentHomeTarget = FirstKeyHomeTarget;

const ACCOUNT_PASSWORD_ENROLLMENT_PENDING_TTL_MS =
    ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS;

type AccountPasswordEnrollmentExternalAuthCustody = Readonly<{
    ceremonyId: number;
    provider: string;
    proof: string;
    accountId: string;
    normalizedNativeEmail: string;
    targetCredential: PlainAccountPasswordCredentialV1;
    requestDigest: string;
    createdAt: number;
    expiresAt: number;
    returnTo: string;
    target: AccountPasswordEnrollmentHomeTarget;
    callbackClaimed: boolean;
    pending?: string;
}>;

let accountPasswordEnrollmentCeremonySequence = 0;
let accountPasswordEnrollmentExternalAuthCustody:
    | AccountPasswordEnrollmentExternalAuthCustody
    | null = null;
let accountPasswordEnrollmentExpiryTimer:
    | ReturnType<typeof setTimeout>
    | null = null;

function retireAccountPasswordEnrollmentExternalAuthCustody(
    ceremonyId?: number,
): void {
    if (
        ceremonyId !== undefined
        && accountPasswordEnrollmentExternalAuthCustody?.ceremonyId
            !== ceremonyId
    ) return;
    if (accountPasswordEnrollmentExpiryTimer !== null) {
        clearTimeout(accountPasswordEnrollmentExpiryTimer);
        accountPasswordEnrollmentExpiryTimer = null;
    }
    accountPasswordEnrollmentExternalAuthCustody = null;
}

function installAccountPasswordEnrollmentExternalAuthCustody(
    custody: Omit<AccountPasswordEnrollmentExternalAuthCustody, 'ceremonyId'>,
): AccountPasswordEnrollmentExternalAuthCustody {
    retireAccountPasswordEnrollmentExternalAuthCustody();
    const installed = {
        ...custody,
        ceremonyId: ++accountPasswordEnrollmentCeremonySequence,
    };
    accountPasswordEnrollmentExternalAuthCustody = installed;
    accountPasswordEnrollmentExpiryTimer = setTimeout(() => {
        retireAccountPasswordEnrollmentExternalAuthCustody(
            installed.ceremonyId,
        );
    }, Math.max(0, installed.expiresAt - Date.now()));
    const unref = (
        accountPasswordEnrollmentExpiryTimer as unknown as {
            unref?: () => void;
        }
    ).unref;
    unref?.call(accountPasswordEnrollmentExpiryTimer);
    return installed;
}

function readAccountPasswordEnrollmentExternalAuthCustody(
): AccountPasswordEnrollmentExternalAuthCustody | null {
    const custody = accountPasswordEnrollmentExternalAuthCustody;
    if (!custody) return null;
    if (Date.now() >= custody.expiresAt) {
        retireAccountPasswordEnrollmentExternalAuthCustody(
            custody.ceremonyId,
        );
        return null;
    }
    return custody;
}

export function clearAccountPasswordEnrollmentExternalAuthCustody(
    expected?: Readonly<{
        accountId: string;
        target: AccountPasswordEnrollmentHomeTarget;
        includingClaimed?: true;
    }>,
): void {
    const custody = readAccountPasswordEnrollmentExternalAuthCustody();
    if (!custody) return;
    if (
        expected
        && custody.callbackClaimed
        && expected.includingClaimed !== true
    ) return;
    if (
        expected
        && (
            custody.accountId !== expected.accountId
            || custody.target.serverId !== expected.target.serverId
            || custody.target.serverUrl.replace(/\/+$/, '')
                !== expected.target.serverUrl.replace(/\/+$/, '')
        )
    ) return;
    retireAccountPasswordEnrollmentExternalAuthCustody(
        custody.ceremonyId,
    );
}

export function readAccountPasswordEnrollmentExternalAuthCallbackContext(
    provider: string,
): Readonly<{
    target: AccountPasswordEnrollmentHomeTarget;
}> | null {
    const custody = readAccountPasswordEnrollmentExternalAuthCustody();
    if (!custody) return null;
    if (
        normalizeProviderId(custody.provider)
        !== normalizeProviderId(provider)
    ) {
        retireAccountPasswordEnrollmentExternalAuthCustody(
            custody.ceremonyId,
        );
        return null;
    }
    // This read is the callback route's claim, not a reusable lookup. Keep the
    // claimed bytes for the already-running callback -> Settings handoff, but
    // never expose them to a replayed/remounted callback route.
    if (custody.callbackClaimed) return null;
    accountPasswordEnrollmentExternalAuthCustody = {
        ...custody,
        callbackClaimed: true,
    };
    return { target: custody.target };
}

type AccountPasswordEnrollmentStartResult =
    | Readonly<{ kind: 'oauth'; provider: string; url: string }>
    | Readonly<{
        kind: 'mtls';
        normalizedNativeEmail: string;
        targetCredential: PlainAccountPasswordCredentialV1;
        externalAuthProof: AccountExternalAuthProofV1;
    }>;

function invalidPasswordEnrollmentExternalAuth(): never {
    throw new HappyError('password-enrollment-external-auth-invalid', false, {
        status: 400,
        kind: 'auth',
        code: 'password-enrollment-external-auth-invalid',
    });
}

function unavailablePasswordEnrollmentExternalAuth(): never {
    throw new HappyError('password-enrollment-external-auth-unavailable', false, {
        status: 400,
        kind: 'auth',
        code: 'password-enrollment-external-auth-unavailable',
    });
}

function assertPasswordEnrollmentIdentity(
    credentials: AuthCredentials,
    accountId: string,
): void {
    try {
        if (parseToken(credentials.token) !== accountId) invalidPasswordEnrollmentExternalAuth();
    } catch {
        invalidPasswordEnrollmentExternalAuth();
    }
}

function selectPasswordEnrollmentExternalAuthProvider(
    linkedProviderIds: readonly string[],
    projection: Parameters<typeof projectAuthEntryMethodCapabilities>[0],
): string {
    return resolveLinkedPurposeBoundProviderFromCapabilities(
        linkedProviderIds,
        projectAuthEntryMethodCapabilities(projection),
    )
        ?? unavailablePasswordEnrollmentExternalAuth();
}

function passwordEnrollmentContinuationMatches(
    state: AccountPasswordEnrollmentExternalAuthCustody | null,
    params: Readonly<{
        accountId: string;
        target: AccountPasswordEnrollmentHomeTarget;
        provider?: string;
    }>,
): state is AccountPasswordEnrollmentExternalAuthCustody {
    if (!state) return false;
    const targetCredential = PlainAccountPasswordCredentialV1Schema.safeParse(
        state.targetCredential,
    );
    if (!targetCredential.success) return false;
    const mutation = PasswordCredentialMutationV1Schema.safeParse({
        v: 1,
        action: 'connect',
        accountId: state.accountId,
        expectedCredentialRevision: null,
        normalizedNativeEmail: state.normalizedNativeEmail,
        newCredentialDigest: createPasswordCredentialTargetDigestV1(
            targetCredential.data,
        ),
    });
    return Boolean(
        mutation.success
        && createPasswordCredentialMutationDigestV1(mutation.data)
            === state.requestDigest
        && state.accountId === params.accountId
        && state.target.serverId === params.target.serverId
        && state.target.serverUrl.replace(/\/+$/, '') === params.target.serverUrl.replace(/\/+$/, '')
        && (!params.provider || normalizeProviderId(state.provider) === normalizeProviderId(params.provider))
        && Date.now() < state.expiresAt,
    );
}

export async function startAccountPasswordEnrollmentExternalAuth(params: Readonly<{
    accountId: string;
    currentCredentials: AuthCredentials;
    linkedProviderIds: readonly string[];
    normalizedNativeEmail: string;
    newPassword: string;
    signal?: AbortSignal;
    returnTo: string;
    target: AccountPasswordEnrollmentHomeTarget;
}>): Promise<AccountPasswordEnrollmentStartResult> {
    const target = normalizeFirstKeyHomeTarget(params.target);
    assertPasswordEnrollmentIdentity(params.currentCredentials, params.accountId);
    const returnTo = normalizeInternalReturnPath(params.returnTo);
    const accountScope = createServerAccountScope(target.serverId, params.accountId);
    if (!returnTo || !accountScope) return invalidPasswordEnrollmentExternalAuth();
    retireAccountPasswordEnrollmentExternalAuthCustody();
    const acquired = await acquireFirstKeyTargetRequest(
        target,
        params.currentCredentials,
        params.signal,
    );
    try {
        const entry = await fetchHomeAuthEntry({
            accountScope,
            endpointUrl: target.serverUrl,
            serverId: target.serverId,
        });
        if (entry.kind !== 'ready' || entry.projection.state !== 'ready') {
            return unavailablePasswordEnrollmentExternalAuth();
        }
        const provider = selectPasswordEnrollmentExternalAuthProvider(
            params.linkedProviderIds,
            entry.projection,
        );
        const targetCredential = await preparePlainAccountPasswordEnroll(
            acquired.request,
            {
                normalizedNativeEmail: params.normalizedNativeEmail,
                newPassword: params.newPassword,
                ...(params.signal ? { signal: params.signal } : {}),
            },
        );
        const mutation = PasswordCredentialMutationV1Schema.parse({
            v: 1,
            action: 'connect',
            accountId: params.accountId,
            expectedCredentialRevision: null,
            normalizedNativeEmail: params.normalizedNativeEmail,
            newCredentialDigest:
                createPasswordCredentialTargetDigestV1(targetCredential),
        });
        const requestDigest =
            createPasswordCredentialMutationDigestV1(mutation);
        const normalizedNativeEmail = mutation.normalizedNativeEmail;
        if (!normalizedNativeEmail) return invalidPasswordEnrollmentExternalAuth();
        const { proof, proofHash } = await createProof();
        const createdAt = Date.now();
        const custody = {
            accountId: params.accountId,
            provider,
            proof,
            normalizedNativeEmail,
            targetCredential,
            requestDigest,
            createdAt,
            expiresAt: createdAt + ACCOUNT_PASSWORD_ENROLLMENT_PENDING_TTL_MS,
            returnTo,
            target,
            callbackClaimed: false,
        };
        if (provider === 'mtls') {
            const response = await acquired.request('/v1/auth/mtls', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${params.currentCredentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    purpose: PASSWORD_ENROLLMENT_PURPOSE,
                    proofHash,
                    requestDigest,
                }),
            }, { includeAuth: false, retry: 'none' });
            const payload: unknown = await response.json().catch(() => null);
            if (!response.ok || !isRecord(payload) || payload.success !== true || typeof payload.pending !== 'string') {
                retireAccountPasswordEnrollmentExternalAuthCustody();
                return invalidPasswordEnrollmentExternalAuth();
            }
            const externalAuthProof = AccountExternalAuthProofV1Schema.parse({
                provider,
                pending: payload.pending,
                proof,
            });
            return {
                kind: 'mtls',
                normalizedNativeEmail,
                targetCredential,
                externalAuthProof,
            };
        }
        installAccountPasswordEnrollmentExternalAuthCustody(custody);
        const query = new URLSearchParams({
            mode: 'keyless',
            purpose: PASSWORD_ENROLLMENT_PURPOSE,
            proofHash,
            requestDigest,
        });
        const response = await acquired.request(
            `/v1/auth/external/${encodeURIComponent(provider)}/params?${query.toString()}`,
            {
                method: 'GET',
                headers: { Authorization: `Bearer ${params.currentCredentials.token}` },
            },
            { includeAuth: false, retry: 'none' },
        );
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !isRecord(payload) || typeof payload.url !== 'string') {
            retireAccountPasswordEnrollmentExternalAuthCustody();
            return unavailablePasswordEnrollmentExternalAuth();
        }
        return { kind: 'oauth', provider, url: payload.url };
    } catch (error) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        throw error;
    } finally {
        await acquired.close();
    }
}

export async function resumeAccountPasswordEnrollmentExternalAuth(params: Readonly<{
    provider: string;
    pending: string | null;
    currentCredentials: AuthCredentials;
    target: AccountPasswordEnrollmentHomeTarget;
}>): Promise<Readonly<{ returnTo: string }>> {
    const target = normalizeFirstKeyHomeTarget(params.target);
    const accountId = parseToken(params.currentCredentials.token);
    const custody = readAccountPasswordEnrollmentExternalAuthCustody();
    if (
        !params.pending
        || !passwordEnrollmentContinuationMatches(custody, { accountId, target, provider: params.provider })
    ) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        return invalidPasswordEnrollmentExternalAuth();
    }
    // The callback pending is the one settlement point for this ceremony.
    // A duplicate callback route (including React strict-mode remounts) must
    // fail without erasing the already-settled same-process handoff that the
    // Account Security route still needs to consume.
    if (custody.pending !== undefined) {
        return invalidPasswordEnrollmentExternalAuth();
    }
    AccountExternalAuthProofV1Schema.parse({
        provider: custody.provider,
        pending: params.pending,
        proof: custody.proof,
    });
    installAccountPasswordEnrollmentExternalAuthCustody({
        ...custody,
        pending: params.pending,
    });
    return { returnTo: normalizeInternalReturnPath(custody.returnTo) ?? '/settings/account/security' };
}

export async function cancelAccountPasswordEnrollmentExternalAuth(params: Readonly<{
    provider: string;
    currentCredentials: AuthCredentials | null;
    target: AccountPasswordEnrollmentHomeTarget;
}>): Promise<Readonly<{ returnTo: string }>> {
    const target = normalizeFirstKeyHomeTarget(params.target);
    const custody = readAccountPasswordEnrollmentExternalAuthCustody();
    let returnTo = '/settings/account/security';
    if (custody && params.currentCredentials) {
        let accountId: string | null = null;
        try {
            accountId = parseToken(params.currentCredentials.token);
        } catch {
            accountId = null;
        }
        if (accountId && passwordEnrollmentContinuationMatches(custody, {
            accountId,
            target,
            provider: params.provider,
        })) {
            const candidate = normalizeInternalReturnPath(custody.returnTo);
            if (
                candidate === '/settings/account/security'
                || candidate?.startsWith('/settings/account/security?')
            ) {
                returnTo = candidate;
            }
        }
    }
    retireAccountPasswordEnrollmentExternalAuthCustody();
    return { returnTo };
}

export type AccountPasswordEnrollmentExternalAuthSessionResult =
    | Readonly<{ kind: 'opened' }>
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'cancelled' }>;

/**
 * Keeps the prepared Plain credential and its proof in the originating process.
 * Native callbacks already return to that process through Linking; web must use
 * the existing Expo auth-session popup so a full-page navigation cannot destroy
 * the only (intentionally non-persisted) custody of the password mutation.
 */
export async function openAccountPasswordEnrollmentExternalAuthSession(
    params: Readonly<{
        kind: 'oauth';
        provider: string;
        url: string;
        currentCredentials: AuthCredentials;
        target: AccountPasswordEnrollmentHomeTarget;
    }>,
): Promise<AccountPasswordEnrollmentExternalAuthSessionResult> {
    if (!isSafeExternalAuthUrl(params.url)) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        return invalidPasswordEnrollmentExternalAuth();
    }
    if (Platform.OS !== 'web') {
        await openPurposeBoundAccountExternalAuthUrl(params.url);
        return { kind: 'opened' };
    }

    const browserGlobal = globalThis as typeof globalThis & {
        window?: { location?: { origin?: string } };
    };
    const origin = browserGlobal.window?.location?.origin;
    let callbackUrl: URL;
    try {
        callbackUrl = new URL(
            `/oauth/${encodeURIComponent(params.provider)}`,
            origin,
        );
    } catch {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        return invalidPasswordEnrollmentExternalAuth();
    }

    try {
        const result = await WebBrowser.openAuthSessionAsync(
            params.url,
            callbackUrl.toString(),
        );
        if (result.type !== 'success') {
            await cancelAccountPasswordEnrollmentExternalAuth({
                provider: params.provider,
                currentCredentials: params.currentCredentials,
                target: params.target,
            });
            return { kind: 'cancelled' };
        }

        let returned: URL;
        try {
            returned = new URL(result.url);
        } catch {
            retireAccountPasswordEnrollmentExternalAuthCustody();
            return invalidPasswordEnrollmentExternalAuth();
        }
        if (
            returned.origin !== callbackUrl.origin
            || returned.pathname !== callbackUrl.pathname
            || returned.searchParams.get('flow') !== 'auth'
            || returned.searchParams.get('purpose')
                !== PASSWORD_ENROLLMENT_PURPOSE
        ) {
            retireAccountPasswordEnrollmentExternalAuthCustody();
            return invalidPasswordEnrollmentExternalAuth();
        }
        if (returned.searchParams.has('error')) {
            await cancelAccountPasswordEnrollmentExternalAuth({
                provider: params.provider,
                currentCredentials: params.currentCredentials,
                target: params.target,
            });
            return { kind: 'cancelled' };
        }

        const pending = returned.searchParams.get('pending');
        if (!pending) {
            retireAccountPasswordEnrollmentExternalAuthCustody();
            return invalidPasswordEnrollmentExternalAuth();
        }
        await resumeAccountPasswordEnrollmentExternalAuth({
            provider: params.provider,
            pending,
            currentCredentials: params.currentCredentials,
            target: params.target,
        });
        return { kind: 'completed' };
    } catch (error) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        throw error;
    }
}

export async function readAccountPasswordEnrollmentExternalAuthProof(params: Readonly<{
    accountId: string;
    currentCredentials: AuthCredentials;
    target: AccountPasswordEnrollmentHomeTarget;
}>): Promise<Readonly<{
    normalizedNativeEmail: string;
    targetCredential: PlainAccountPasswordCredentialV1;
    externalAuthProof: AccountExternalAuthProofV1;
}> | null> {
    const target = normalizeFirstKeyHomeTarget(params.target);
    assertPasswordEnrollmentIdentity(params.currentCredentials, params.accountId);
    const custody = readAccountPasswordEnrollmentExternalAuthCustody();
    if (!passwordEnrollmentContinuationMatches(custody, {
        accountId: params.accountId,
        target,
    })) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        return null;
    }
    const pending = custody.pending;
    if (!pending || !custody.proof) return null;
    const externalAuthProof = AccountExternalAuthProofV1Schema.safeParse({
        provider: custody.provider,
        pending,
        proof: custody.proof,
    });
    if (!externalAuthProof.success) {
        retireAccountPasswordEnrollmentExternalAuthCustody();
        return null;
    }
    const result = {
        normalizedNativeEmail: custody.normalizedNativeEmail,
        targetCredential: custody.targetCredential,
        externalAuthProof: externalAuthProof.data,
    };
    retireAccountPasswordEnrollmentExternalAuthCustody(
        custody.ceremonyId,
    );
    return result;
}

async function submitAccountEncryptionFirstKeyMigration(
    params: FirstKeyMigrationInput & Readonly<{
        externalAuthProof: AccountEncryptionMigrateExternalAuthProof;
        target: FirstKeyHomeTarget;
        requestAtTarget: ServerFetch;
    }>,
) {
    const request = assertFirstKeyMigrationInput(params);
    await assertProposedCredentialsMatchRequest(
        params.proposedCredentials,
        request,
    );
    const externalAuthProof =
        AccountEncryptionMigrateExternalAuthProofSchema.parse(
            params.externalAuthProof,
        );
    const requestWithExternalAuth =
        AccountEncryptionMigrateRequestSchema.parse({
            ...params.request,
            externalAuthProof,
        });
    if (!requestWithExternalAuth.sessionDrafts?.items.length && !requestWithExternalAuth.authoringMemory?.items.length) {
        return await migrateAccountEncryptionMode(
            params.currentCredentials,
            requestWithExternalAuth,
            {
                retry: 'none',
                request: params.requestAtTarget,
                target: params.target,
            },
        );
    }
    const [
        { runAccountEncryptionModeMigration },
        {
            acknowledgeNewSessionDraftEncryptionMigration,
        },
        { sync },
    ] = await Promise.all([
        import('./runAccountEncryptionModeMigration'),
        import('@/sync/ops/sessionDrafts/sessionDraftRepository'),
        import('@/sync/sync'),
    ]);
    const sessionDraftScope = {
        serverId: params.target.serverId,
        accountId: params.accountId,
    };
    return await runAccountEncryptionModeMigration({
        request: requestWithExternalAuth,
        migrate: async (migrationRequest) =>
            await migrateAccountEncryptionMode(
                params.currentCredentials,
                migrationRequest,
                {
                    retry: 'none',
                    request: params.requestAtTarget,
                    target: params.target,
                },
            ),
        activateTargetMode: () => {
            sync.reconfigureAuthoringMemoryForAccountMode(params.proposedCredentials, 'e2ee');
            if (requestWithExternalAuth.sessionDrafts?.items.length) {
                sync.reconfigureSessionDraftRepositoryForAccountMode(
                    params.proposedCredentials,
                    'e2ee',
                );
            }
        },
        acknowledgeSessionDrafts: async (records) => {
            if (!sessionDraftScope) {
                throw new Error(
                    'Session draft repository scope is unavailable',
                );
            }
            await acknowledgeNewSessionDraftEncryptionMigration(
                sessionDraftScope,
                records,
            );
        },
    });
}

export async function resumeAccountEncryptionFirstKeyExternalAuth(
    params: Readonly<{
        provider: string;
        pending: string;
        currentCredentials: AuthCredentials;
        target?: FirstKeyHomeTarget;
        persistCredentials: (
            credentials: LegacyAuthCredentials,
            options:
                AccountEncryptionFirstKeyCredentialPersistenceOptions,
        ) => Promise<Readonly<{ kind: string }>>;
        scopeGuard?: AccountEncryptionScopeGuard;
    }>,
): Promise<Readonly<{
    returnTo: string;
    migration: Awaited<
        ReturnType<typeof migrateAccountEncryptionMode>
    >;
}>> {
    let shouldClearPending = true;
    let closeTransport = async () => {};
    let removeFirstKeyMigrationAttempted:
        PendingExternalAuth | undefined;
    try {
        const provider = normalizeProviderId(params.provider);
        const pending = params.pending.trim();
        const pendingState = params.target
            ? await TokenStorage.readPendingExternalAuthStateForServerUrl(
                params.target.serverUrl,
                { serverId: params.target.serverId },
            )
            : await TokenStorage.readPendingExternalAuthContinuationState();
        const state = pendingState.value;
        const hasMarkedFirstKeyCustody =
            state?.accountEncryptionFirstKey
                ?.migrationSubmissionAttempted === true;
        if (hasMarkedFirstKeyCustody) {
            shouldClearPending = false;
        }
        if (pendingState.serverMismatch) {
            return invalidExternalAuth();
        }
        if (
            !provider
            || !pending
            || !state
            || normalizeProviderId(state.provider) !== provider
            || typeof state.proof !== 'string'
            || typeof state.secret !== 'string'
            || !state.accountEncryptionFirstKey
            || !isTokenOnlyAuthCredentials(
                params.currentCredentials,
            )
        ) {
            return invalidExternalAuth();
        }
        const target = normalizeFirstKeyHomeTarget({
            serverId: state.serverId,
            serverUrl: state.serverUrl,
        });
        if (
            params.target
            && (
                params.target.serverId !== target.serverId
                || params.target.serverUrl !== target.serverUrl
            )
        ) {
            return invalidExternalAuth();
        }
        const acquired = await acquireFirstKeyTargetRequest(target);
        closeTransport = acquired.close;
        const requestAtTarget = acquired.request;

        let rawRequest: unknown;
        try {
            rawRequest = JSON.parse(
                state.accountEncryptionFirstKey.requestJson,
            );
        } catch {
            return invalidExternalAuth();
        }
        const parsedRequest =
            AccountEncryptionMigrateRequestSchema.safeParse(rawRequest);
        if (
            !parsedRequest.success
            || parsedRequest.data.externalAuthProof !== undefined
        ) {
            return invalidExternalAuth();
        }
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request: parsedRequest.data,
                accountId:
                    state.accountEncryptionFirstKey.accountId,
                sourceMode: 'plain',
            });
        if (
            requestDigest
            !== state.accountEncryptionFirstKey.requestDigest
            || (
                state.accountEncryptionFirstKey.pending !== undefined
                && state.accountEncryptionFirstKey.pending !== pending
            )
        ) {
            return invalidExternalAuth();
        }

        const proposedCredentials = {
            token: params.currentCredentials.token,
            secret: state.secret,
        } as const;
        await assertProposedCredentialsMatchRequest(
            proposedCredentials,
            parsedRequest.data,
        );
        AccountEncryptionMigrateExternalAuthProofSchema.parse({
            provider,
            pending,
            proof: state.proof,
        });
        const hadPriorMigrationSubmissionAttempt =
            state.accountEncryptionFirstKey
                .migrationSubmissionAttempted === true;
        const attemptedState: PendingExternalAuth = {
            ...state,
            accountEncryptionFirstKey: {
                ...state.accountEncryptionFirstKey,
                pending,
                migrationSubmissionAttempted: true,
            },
        };
        shouldClearPending = false;
        if (
            state.accountEncryptionFirstKey.pending
            === undefined
            || !hadPriorMigrationSubmissionAttempt
        ) {
            const stored =
                await TokenStorage.setPendingExternalAuth(
                    attemptedState,
                    target,
                );
            if (!stored) {
                return pendingCustodyFailed();
            }
        }
        let migration: Awaited<
            ReturnType<
                typeof submitAccountEncryptionFirstKeyMigration
            >
        >;
        try {
            migration =
                await submitAccountEncryptionFirstKeyMigration({
                    accountId:
                        state.accountEncryptionFirstKey.accountId,
                    currentCredentials:
                        params.currentCredentials,
                    proposedCredentials,
                    request: parsedRequest.data,
                    externalAuthProof: {
                        provider,
                        pending,
                        proof: state.proof,
                    },
                    target,
                    requestAtTarget,
                });
        } catch (error) {
            if (
                isDefinitivePreCommitMigrationFailure(error)
                && !hadPriorMigrationSubmissionAttempt
            ) {
                shouldClearPending = true;
                removeFirstKeyMigrationAttempted =
                    attemptedState;
            }
            throw error;
        }
        assertAccountEncryptionScopeCurrent(params.scopeGuard);
        const persistence = await params.persistCredentials(
            proposedCredentials,
            {
                firstKeyRecoveryAuthorization: {
                    [firstKeyCredentialPersistenceBrand]: true,
                    token: proposedCredentials.token,
                },
                target,
            },
        );
        if (persistence.kind !== 'completed') {
            return pendingCustodyFailed();
        }
        shouldClearPending = true;
        removeFirstKeyMigrationAttempted =
            attemptedState;
        return {
            returnTo: normalizeInternalReturnPath(state.returnTo) ?? '/settings/account',
            migration,
        };
    } finally {
        try {
            if (shouldClearPending) {
                await clearPendingExternalAuthRequired(removeFirstKeyMigrationAttempted);
            }
        } finally {
            await closeTransport();
        }
    }
}

export async function retryPendingAccountEncryptionFirstKeyExternalAuth(
    params: Readonly<{
        currentCredentials: AuthCredentials;
        target?: FirstKeyHomeTarget;
        persistCredentials: (
            credentials: LegacyAuthCredentials,
            options:
                AccountEncryptionFirstKeyCredentialPersistenceOptions,
        ) => Promise<Readonly<{ kind: string }>>;
        scopeGuard?: AccountEncryptionScopeGuard;
    }>,
): Promise<Readonly<{
    returnTo: string;
    mode: 'e2ee';
}> | null> {
    const pendingState = params.target
        ? await TokenStorage.readPendingExternalAuthStateForServerUrl(params.target.serverUrl, { serverId: params.target.serverId })
        : await TokenStorage.readPendingExternalAuthContinuationState();
    const state = pendingState.value;
    const provider = normalizeProviderId(state?.provider);
    const pending =
        state?.accountEncryptionFirstKey?.pending?.trim()
        ?? '';
    if (
        pendingState.serverMismatch
        || !state?.accountEncryptionFirstKey
        || !provider
        || !pending
    ) {
        return null;
    }
    if (isLegacyAuthCredentials(
        params.currentCredentials,
    )) {
        let closeTransport = async () => {};
        try {
            const target = normalizeFirstKeyHomeTarget({
                serverId: state.serverId,
                serverUrl: state.serverUrl,
            });
            const acquired = await acquireFirstKeyTargetRequest(target);
            closeTransport = acquired.close;
            await assertCommittedFirstKeyCredentialsMatchCustody({
                state,
                credentials:
                    params.currentCredentials,
                request: acquired.request,
            });
        } catch {
            return null;
        } finally {
            await closeTransport();
        }
        await clearPendingExternalAuthRequired(state);
        return {
            returnTo:
                resolveFirstKeyReturnTo(state),
            mode: 'e2ee',
        };
    }
    const resumed =
        await resumeAccountEncryptionFirstKeyExternalAuth({
        provider,
        pending,
        currentCredentials: params.currentCredentials,
        persistCredentials: params.persistCredentials,
        scopeGuard: params.scopeGuard,
        target: normalizeFirstKeyHomeTarget({
            serverId: state.serverId,
            serverUrl: state.serverUrl,
        }),
    });
    if (resumed.migration.mode !== 'e2ee') {
        return null;
    }
    return {
        returnTo: resumed.returnTo,
        mode: 'e2ee',
    };
}
