import { Linking, Platform } from 'react-native';

import {
    AccountEncryptionMigrateExternalAuthProofSchema,
    AccountEncryptionMigrateRequestSchema,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    type AccountEncryptionMigrateExternalAuthProof,
    type AccountEncryptionMigrateRequest,
    type FeaturesResponse,
} from '@happier-dev/protocol';
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
} from '@/sync/api/capabilities/serverFeaturesClient';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { parseToken } from '@/utils/auth/parseToken';
import {
    getActiveServerId,
    getActiveServerUrl,
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { authGetToken } from '@/auth/flows/getToken';

const FIRST_KEY_PURPOSE = 'account_encryption_first_key';

type FirstKeyMigrationInput = Readonly<{
    accountId: string;
    currentCredentials: AuthCredentials;
    proposedCredentials: LegacyAuthCredentials;
    request: AccountEncryptionMigrateRequest;
}>;

type FirstKeyStartResult =
    | Readonly<{
        kind: 'oauth';
        provider: string;
        url: string;
    }>
    | Readonly<{
        kind: 'mtls';
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
    }>;

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
        const token = await authGetToken(
            seed,
            {
                expectedAccountId:
                    continuation.accountId,
            },
        );
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
        });

        const persistence =
            await params.persistCredentials(
                credentials,
                {
                    firstKeyRecoveryAuthorization: {
                        [firstKeyCredentialPersistenceBrand]:
                            true,
                        token,
                    },
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
    return (
        typeof state.returnTo === 'string'
        && state.returnTo.startsWith('/')
        && !state.returnTo.startsWith('//')
    )
        ? state.returnTo
        : '/settings/account';
}

async function assertCommittedFirstKeyCredentialsMatchCustody(
    params: Readonly<{
        state: PendingExternalAuth;
        credentials: LegacyAuthCredentials;
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

function resolveConfiguredProvider(
    linkedProviderIds: readonly string[],
    features: FeaturesResponse,
): string {
    const authCapabilities =
        features.capabilities.auth;
    const oauthProviders =
        features.capabilities.oauth.providers;
    for (const rawProviderId of linkedProviderIds) {
        const providerId = normalizeProviderId(rawProviderId);
        if (!providerId) continue;
        if (providerId === 'mtls') {
            const mtlsGateEnabled =
                features.features.auth.mtls.enabled === true;
            const mtlsLoginEnabled =
                Array.isArray(authCapabilities.login.methods)
                && authCapabilities.login.methods.some(
                    (method) =>
                        normalizeProviderId(method.id) === 'mtls'
                        && method.enabled === true,
                );
            if (mtlsGateEnabled && mtlsLoginEnabled) {
                return providerId;
            }
            continue;
        }
        const authProvider =
            authCapabilities?.providers?.[providerId];
        const oauthProvider = oauthProviders?.[providerId];
        if (
            authProvider?.enabled === true
            && authProvider?.configured === true
            && oauthProvider?.enabled === true
            && oauthProvider?.configured === true
        ) {
            return providerId;
        }
    }
    return unavailableExternalAuth();
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
        returnTo: string;
    }>,
): Promise<FirstKeyStartResult> {
    await TokenStorage.clearPendingExternalAuth();
    try {
        const request = assertFirstKeyMigrationInput(params);
        await assertProposedCredentialsMatchRequest(
            params.proposedCredentials,
            request,
        );
        const snapshot =
            await getServerFeaturesSnapshot({ force: true });
        if (snapshot.status !== 'ready') {
            return unavailableExternalAuth();
        }
        const provider = resolveConfiguredProvider(
            params.linkedProviderIds,
            snapshot.features,
        );
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request,
                accountId: params.accountId,
                sourceMode: 'plain',
            });
        const { proof, proofHash } = await createProof();
        const createdAt = Date.now();
        const activeServerId = getActiveServerId();
        const activeServerUrl = getActiveServerUrl();
        const serverContext = {
            ...(activeServerId
                ? { serverId: activeServerId }
                : {}),
            ...(activeServerUrl
                ? { serverUrl: activeServerUrl }
                : {}),
        };
        const createPendingContinuation = (
            pending?: string,
        ) => ({
            accountId: params.accountId,
            requestDigest,
            requestJson: JSON.stringify(params.request),
            createdAt,
            expiresAt:
                createdAt
                + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS,
            ...(pending ? { pending } : {}),
        });

        if (provider === 'mtls') {
            const response = await serverFetch(
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
                });
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
            });
        if (!stored) {
            return unavailableExternalAuth();
        }

        const query = new URLSearchParams({
            mode: 'keyless',
            purpose: FIRST_KEY_PURPOSE,
            proofHash,
            requestDigest,
        });
        const response = await serverFetch(
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
    }
}

export async function openAccountEncryptionFirstKeyExternalAuthUrl(
    url: string,
): Promise<void> {
    if (!isSafeExternalAuthUrl(url)) {
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
        await TokenStorage.clearPendingExternalAuth();
        throw error;
    }
}

async function submitAccountEncryptionFirstKeyMigration(
    params: FirstKeyMigrationInput & Readonly<{
        externalAuthProof: AccountEncryptionMigrateExternalAuthProof;
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
    const result = await migrateAccountEncryptionMode(
        params.currentCredentials,
        requestWithExternalAuth,
        { retry: 'none' },
    );
    return result;
}

export async function resumeAccountEncryptionFirstKeyExternalAuth(
    params: Readonly<{
        provider: string;
        pending: string;
        currentCredentials: AuthCredentials;
        persistCredentials: (
            credentials: LegacyAuthCredentials,
            options:
                AccountEncryptionFirstKeyCredentialPersistenceOptions,
        ) => Promise<Readonly<{ kind: string }>>;
    }>,
): Promise<Readonly<{
    returnTo: string;
    migration: Awaited<
        ReturnType<typeof migrateAccountEncryptionMode>
    >;
}>> {
    let shouldClearPending = true;
    let removeFirstKeyMigrationAttempted:
        PendingExternalAuth | undefined;
    try {
        const provider = normalizeProviderId(params.provider);
        const pending = params.pending.trim();
        const pendingState =
            await TokenStorage.readPendingExternalAuthState();
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
        const persistence =
            await params.persistCredentials(
            proposedCredentials,
            {
                firstKeyRecoveryAuthorization: {
                    [firstKeyCredentialPersistenceBrand]:
                        true,
                    token:
                        proposedCredentials.token,
                },
            },
        );
        if (persistence.kind !== 'completed') {
            return pendingCustodyFailed();
        }
        shouldClearPending = true;
        removeFirstKeyMigrationAttempted =
            attemptedState;
        return {
            returnTo:
                typeof state.returnTo === 'string'
                && state.returnTo.startsWith('/')
                && !state.returnTo.startsWith('//')
                    ? state.returnTo
                    : '/settings/account',
            migration,
        };
    } finally {
        if (shouldClearPending) {
            await clearPendingExternalAuthRequired(
                removeFirstKeyMigrationAttempted,
            );
        }
    }
}

export async function retryPendingAccountEncryptionFirstKeyExternalAuth(
    params: Readonly<{
        currentCredentials: AuthCredentials;
        persistCredentials: (
            credentials: LegacyAuthCredentials,
            options:
                AccountEncryptionFirstKeyCredentialPersistenceOptions,
        ) => Promise<Readonly<{ kind: string }>>;
    }>,
): Promise<Readonly<{
    returnTo: string;
    mode: 'e2ee';
}> | null> {
    const pendingState =
        await TokenStorage.readPendingExternalAuthState();
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
        try {
            await assertCommittedFirstKeyCredentialsMatchCustody({
                state,
                credentials:
                    params.currentCredentials,
            });
        } catch {
            return null;
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
    });
    if (resumed.migration.mode !== 'e2ee') {
        return null;
    }
    return {
        returnTo: resumed.returnTo,
        mode: 'e2ee',
    };
}
