import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import {
    AccountEncryptionModeResponseSchema,
    type AccountEncryptionModeResponse,
} from '@happier-dev/protocol';

type AccountEncryptionMode = AccountEncryptionModeResponse['mode'];

export async function fetchAccountEncryptionMode(
    credentials: AuthCredentials,
): Promise<{ mode: AccountEncryptionMode; updatedAt: number }> {
    return await backoff(async () => {
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
        return parsed.data;
    });
}

export async function updateAccountEncryptionMode(
    credentials: AuthCredentials,
    mode: AccountEncryptionMode,
): Promise<{ mode: AccountEncryptionMode; updatedAt: number }> {
    return await backoff(async () => {
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
        return parsed.data;
    });
}
