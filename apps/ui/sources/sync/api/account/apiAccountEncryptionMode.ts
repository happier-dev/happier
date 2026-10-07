import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import {
    getActiveServerSnapshot,
    getActiveServerHomeCarrier,
    type ActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';
import { HappyError } from '@/utils/errors/errors';
import {
    AccountEncryptionModeResponseSchema,
    AccountEncryptionCurrentnessResponseSchema,
    AccountEncryptionCurrentnessErrorResponseSchema,
    type AccountEncryptionCurrentnessErrorResponse,
    type AccountEncryptionCurrentnessResponse,
    type AccountEncryptionModeResponse,
} from '@happier-dev/protocol/account/encryptionMode';

type AccountEncryptionMode = AccountEncryptionModeResponse['mode'];
type AccountEncryptionModeResult = Readonly<{ mode: AccountEncryptionMode; updatedAt: number }>;

const ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS = 5_000;

/** Readiness on a rejected currentness read is not authority to migrate Account data. */
export class AccountEncryptionCurrentnessReadinessError extends HappyError {
    readonly recipientEnvelopeReadiness: AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness'];

    constructor(readiness: AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness']) {
        super('Account encryption currentness requires recovery', false, {
            status: 400,
            kind: 'config',
            code: 'account-encryption-currentness-unavailable',
        });
        Object.setPrototypeOf(this, AccountEncryptionCurrentnessReadinessError.prototype);
        this.recipientEnvelopeReadiness = readiness;
    }
}

type AccountEncryptionModeCacheEntry = Readonly<{
    expiresAt?: number;
    promise?: Promise<AccountEncryptionModeResult>;
    value?: AccountEncryptionModeResult;
}>;

const accountEncryptionModeCache = new Map<string, AccountEncryptionModeCacheEntry>();
const accountEncryptionModeCacheInvalidationListeners = new Set<() => void>();
let accountEncryptionModeCacheRevision = 0;

function normalizeAccountEncryptionMode(raw: unknown): AccountEncryptionMode {
    const value = String(raw ?? '').trim();
    // Fail closed to E2EE for unknown/legacy values.
    if (value === 'plain') return 'plain';
    if (value === 'e2ee') return 'e2ee';
    return 'e2ee';
}

function normalizeUpdatedAt(raw: unknown): number {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** The canonical server-and-credential identity for this Account mode read. */
export function getAccountEncryptionModeScopeKey(
    credentials: AuthCredentials,
    snapshot: Pick<
        ActiveServerSnapshot,
        'serverId' | 'serverUrl' | 'generation'
    > = getActiveServerSnapshot(),
): string {
    return [
        snapshot.serverId,
        snapshot.serverUrl,
        String(snapshot.generation),
        resolveAuthCredentialsScopeKey(credentials),
    ].join('\u0000');
}

function pruneAccountEncryptionModeCache(now: number): void {
    for (const [key, entry] of accountEncryptionModeCache) {
        if (entry.promise) continue;
        if ((entry.expiresAt ?? 0) > now) continue;
        accountEncryptionModeCache.delete(key);
    }
}

export function invalidateAccountEncryptionModeCache(): void {
    accountEncryptionModeCache.clear();
    accountEncryptionModeCacheRevision += 1;
    for (const listener of [...accountEncryptionModeCacheInvalidationListeners]) {
        try {
            listener();
        } catch {
            // One observer cannot block the incumbent cache owner from
            // withdrawing a stale Account disclosure for every other mount.
        }
    }
}

/** Owner-local revision for consumers that must withdraw stale disclosures. */
export function getAccountEncryptionModeCacheRevision(): number {
    return accountEncryptionModeCacheRevision;
}

/**
 * Observe only cache invalidation. The cache remains the single reader and
 * value owner; callers re-read through it instead of receiving a second value
 * channel.
 */
export function subscribeAccountEncryptionModeCacheInvalidation(
    listener: () => void,
): () => void {
    accountEncryptionModeCacheInvalidationListeners.add(listener);
    return () => {
        accountEncryptionModeCacheInvalidationListeners.delete(listener);
    };
}

export async function fetchAccountEncryptionCurrentness(
    credentials: AuthCredentials,
    options: Readonly<{
        request?: (path: string, init: RequestInit) => Promise<Response>;
        signal?: AbortSignal;
    }> = {},
): Promise<AccountEncryptionCurrentnessResponse> {
    const request = options.request ?? ((path: string, init: RequestInit) =>
        serverFetch(path, init, { includeAuth: false }));
    const readCurrentness = async () => await request('/v1/account/encryption/currentness', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        signal: options.signal,
    });
    let response = await readCurrentness();
    if (!response.ok) {
        if (response.status === 400) {
            const recovery = AccountEncryptionCurrentnessErrorResponseSchema.safeParse(
                await response.json().catch(() => null),
            );
            if (recovery.success) {
                if (
                    recovery.data.recipientEnvelopeReadiness.reason === 'encryption_setup_required'
                    && 'secret' in credentials
                    // A captured request cannot authorize recovery through the
                    // independently selected Home and its stored credentials.
                    && !options.request
                ) {
                    const target = getActiveServerSnapshot();
                    const stored = target.serverUrl
                        ? await TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.serverId }).catch(() => null)
                        : null;
                    let secret: Uint8Array | null = null;
                    let expectedAccountId: string | null = null;
                    try {
                        secret = stored?.token === credentials.token && 'secret' in stored && stored.secret === credentials.secret
                            ? decodeBase64(credentials.secret)
                            : null;
                        expectedAccountId = parseToken(credentials.token);
                    } catch {
                        // Malformed retained material never becomes a recovery proof.
                    }
                    if (secret?.length === 32 && expectedAccountId && target.serverUrl) {
                        try {
                            const { authGetTokenAtEndpoint } = await import('@/auth/flows/getToken');
                            const homeCarrier = getActiveServerHomeCarrier();
                            // The missing-binding repair uses requireExistingAccount;
                            // compare the issued Account with the stored bearer below.
                            const repaired = await authGetTokenAtEndpoint({
                                endpointUrl: target.serverUrl,
                                ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
                                ...(homeCarrier ? { homeCarrier } : {}),
                                serverId: target.serverId,
                                addressAnchorUrl: target.serverUrl,
                                secret,
                                requireExistingAccount: true,
                                requireKeyChallengeV2: true,
                                ...(options.signal ? { signal: options.signal } : {}),
                            });
                            const current = getActiveServerSnapshot();
                            if (
                                parseToken(repaired.token) === expectedAccountId
                                && current.serverId === target.serverId
                                && current.serverUrl === target.serverUrl
                                && current.generation === target.generation
                            ) {
                                response = await readCurrentness();
                            }
                        } catch {
                            if (options.signal?.aborted) options.signal.throwIfAborted();
                            // Keep the original typed recovery result when proof fails.
                        } finally {
                            secret.fill(0);
                        }
                    }
                }
                if (response.ok) {
                    const repaired = AccountEncryptionCurrentnessResponseSchema.safeParse(
                        await response.json().catch(() => null),
                    );
                    if (repaired.success) return repaired.data;
                }
                throw new AccountEncryptionCurrentnessReadinessError(recovery.data.recipientEnvelopeReadiness);
            }
        }
        throw new HappyError(
            'This server must be upgraded before changing account encryption',
            false,
            {
                status: response.status,
                kind: 'config',
                code: 'account-encryption-currentness-unavailable',
            },
        );
    }
    const parsed =
        AccountEncryptionCurrentnessResponseSchema.safeParse(
            await response.json().catch(() => null),
        );
    if (!parsed.success) {
        throw new HappyError(
            'This server returned incomplete account encryption currentness',
            false,
            {
                status: response.status,
                kind: 'server',
                code: 'account-encryption-currentness-unavailable',
            },
        );
    }
    return parsed.data;
}

export async function fetchAccountEncryptionMode(
    credentials: AuthCredentials,
    opts: Readonly<{
        retry?: 'default' | 'none';
        /**
         * Explicit Home-targeted request transport. When supplied, the mode read
         * is one direct attempt against that request and never consults the
         * active-server mode cache; the caller's endpoint owns the target.
         */
        request?: (path: string, init?: RequestInit) => Promise<Response>;
    }> = {},
): Promise<AccountEncryptionModeResult> {
    const run = async (): Promise<AccountEncryptionModeResponse> => {
        const response = await (opts.request ?? ((path, init) =>
            serverFetch(path, init, { includeAuth: false })))(
            '/v1/account/encryption',
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        // Back-compat: older servers may not implement this endpoint. Fail closed to E2EE.
        if (response.status === 404) {
            return { mode: 'e2ee', updatedAt: 0 };
        }

        if (!response.ok) {
            const errorBody: unknown = await response.json().catch(() => null);
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError('Failed to load encryption setting', false, {
                    status: response.status,
                    kind: 'server',
                    code: response.status === 400
                        && typeof errorBody === 'object'
                        && errorBody !== null
                        && 'error' in errorBody
                        && errorBody.error === 'account-encryption-recovery-required'
                        ? 'account-encryption-recovery-required'
                        : undefined,
                });
            }
            throw new Error(`Failed to load account encryption mode: ${response.status}`);
        }

        const data: unknown = await response.json();
        const parsed = AccountEncryptionModeResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new Error('Failed to parse account encryption mode response');
        }
        return {
            mode: normalizeAccountEncryptionMode(parsed.data.mode),
            updatedAt: normalizeUpdatedAt(parsed.data.updatedAt),
        };
    };

    if (opts.retry === 'none' || opts.request) {
        return await run();
    }

    const cacheKey = getAccountEncryptionModeScopeKey(credentials);
    const now = Date.now();
    pruneAccountEncryptionModeCache(now);

    const cached = accountEncryptionModeCache.get(cacheKey);
    if (cached?.promise) {
        return await cached.promise;
    }
    if (cached?.value && (cached.expiresAt ?? 0) > now) {
        return cached.value;
    }

    const promise = backoff(async () => {
        return await run();
    });
    accountEncryptionModeCache.set(cacheKey, { promise });
    try {
        const value = await promise;
        if (accountEncryptionModeCache.get(cacheKey)?.promise === promise) {
            accountEncryptionModeCache.set(cacheKey, {
                value,
                expiresAt: Date.now() + ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS,
            });
        }
        return value;
    } catch (error) {
        if (accountEncryptionModeCache.get(cacheKey)?.promise === promise) {
            accountEncryptionModeCache.delete(cacheKey);
        }
        throw error;
    }
}

/**
 * The Account mode this device last read for these credentials, without asking the server; `null`
 * when it has not been read (or the read expired). For summaries that must not issue a request.
 */
export function getCachedAccountEncryptionMode(credentials: AuthCredentials): AccountEncryptionMode | null {
    const now = Date.now();
    pruneAccountEncryptionModeCache(now);
    const cached = accountEncryptionModeCache.get(getAccountEncryptionModeScopeKey(credentials));
    return cached?.value && (cached.expiresAt ?? 0) > now ? cached.value.mode : null;
}

export async function updateAccountEncryptionMode(
    credentials: AuthCredentials,
    mode: AccountEncryptionMode,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<AccountEncryptionModeResult> {
    const run = async (): Promise<AccountEncryptionModeResponse> => {
        const response = await serverFetch(
            '/v1/account/encryption',
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ mode }),
            },
            { includeAuth: false },
        );

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Encryption opt-out is not enabled on this server', false, { status: response.status, kind: 'config' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError('Failed to update encryption setting', false, { status: response.status, kind: 'server' });
            }
            throw new Error(`Failed to update account encryption mode: ${response.status}`);
        }

        const data: unknown = await response.json();
        const parsed = AccountEncryptionModeResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new Error('Failed to parse account encryption mode response');
        }
        return {
            mode: normalizeAccountEncryptionMode(parsed.data.mode),
            updatedAt: normalizeUpdatedAt(parsed.data.updatedAt),
        };
    };

    if (opts.retry === 'none') {
        const result = await run();
        invalidateAccountEncryptionModeCache();
        return result;
    }

    const result = await backoff(run);
    invalidateAccountEncryptionModeCache();
    return result;
}
