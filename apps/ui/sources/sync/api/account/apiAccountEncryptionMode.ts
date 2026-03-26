import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import {
    AccountEncryptionModeResponseSchema,
    type AccountEncryptionModeResponse,
} from '@happier-dev/protocol';

type AccountEncryptionMode = AccountEncryptionModeResponse['mode'];

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

export async function fetchAccountEncryptionMode(
    credentials: AuthCredentials,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<{ mode: AccountEncryptionMode; updatedAt: number }> {
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

    return await backoff(run);
}

export async function updateAccountEncryptionMode(
    credentials: AuthCredentials,
    mode: AccountEncryptionMode,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<{ mode: AccountEncryptionMode; updatedAt: number }> {
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
        return await run();
    }

    return await backoff(run);
}
