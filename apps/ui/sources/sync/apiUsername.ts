import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { serverFetch } from './http/client';
import { HappyError } from '@/utils/errors';

export async function setAccountUsername(
    credentials: AuthCredentials,
    username: string,
): Promise<{ username: string }> {
    return await backoff(async () => {
        const response = await serverFetch('/v1/account/username', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username }),
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to set username';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                const kind =
                    message === 'username-disabled' || message === 'friends-disabled'
                        ? 'config'
                        : 'server';
                throw new HappyError(message, false, { status: response.status, kind });
            }
            throw new Error(`Failed to set username: ${response.status}`);
        }

        const data = await response.json();
        if (!data || typeof data !== 'object' || typeof (data as any).username !== 'string') {
            throw new Error('Failed to parse set username response');
        }
        return { username: (data as any).username };
    });
}
