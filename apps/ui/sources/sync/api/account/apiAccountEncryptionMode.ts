import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { HappyError } from '@/utils/errors/errors';
import {
    AccountEncryptionModeResponseSchema,
    type AccountEncryptionModeResponse,
} from '@happier-dev/protocol';

type AccountEncryptionMode = AccountEncryptionModeResponse['mode'];
type AccountEncryptionModeResult = Readonly<{ mode: AccountEncryptionMode; updatedAt: number }>;

const ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS = 5_000;

type AccountEncryptionModeCacheEntry = Readonly<{
    expiresAt?: number;
    promise?: Promise<AccountEncryptionModeResult>;
    value?: AccountEncryptionModeResult;
}>;

const accountEncryptionModeCache = new Map<string, AccountEncryptionModeCacheEntry>();

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

function buildAccountEncryptionModeCacheKey(credentials: AuthCredentials): string {
    const snapshot = getActiveServerSnapshot();
    return [
        snapshot.serverId,
        snapshot.serverUrl,
        String(snapshot.generation),
        String(credentials.token ?? ''),
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
}

export async function fetchAccountEncryptionMode(
    credentials: AuthCredentials,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<AccountEncryptionModeResult> {
    const run = async (): Promise<AccountEncryptionModeResponse> => {
        const response = await serverFetch(
            '/v1/account/encryption',
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            },
            { includeAuth: false },
        );

        // Back-compat: older servers may not implement this endpoint. Fail closed to E2EE.
        if (response.status === 404) {
            return { mode: 'e2ee', updatedAt: 0 };
        }

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError('Failed to load encryption setting', false, { status: response.status, kind: 'server' });
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

    if (opts.retry === 'none') {
        return await run();
    }

    const cacheKey = buildAccountEncryptionModeCacheKey(credentials);
    const now = Date.now();
    pruneAccountEncryptionModeCache(now);

    const cached = accountEncryptionModeCache.get(cacheKey);
    if (cached?.promise) {
        return await cached.promise;
    }
    if (cached?.value && (cached.expiresAt ?? 0) > now) {
        return cached.value;
    }

    const promise = backoff(run);
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
