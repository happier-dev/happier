import { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';

export async function registerPushToken(
    credentials: AuthCredentials,
    token: string,
    opts: Readonly<{ apiEndpoint?: string }> = {},
): Promise<void> {
    const API_ENDPOINT = (opts.apiEndpoint ?? '').trim().replace(/\/+$/, '');
    const path = API_ENDPOINT ? `${API_ENDPOINT}/v1/push-tokens` : '/v1/push-tokens';
    await backoff(async () => {
        const response = await serverFetch(path, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token }),
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to register push token';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to register push token: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to register push token');
        }
    });
}
