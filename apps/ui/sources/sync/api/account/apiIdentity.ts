import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';

export async function setAccountIdentityShowOnProfile(params: {
    credentials: AuthCredentials;
    providerId: string;
    showOnProfile: boolean;
}): Promise<void> {
    const provider = params.providerId.toString().trim().toLowerCase();
    if (!provider) {
        throw new HappyError('Invalid provider', false, { status: 400, kind: 'config' });
    }

    await backoff(async () => {
        const response = await serverFetch(`/v1/account/identity/${encodeURIComponent(provider)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${params.credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ showOnProfile: params.showOnProfile }),
        }, { includeAuth: false });

        if (!response.ok) {
            let message = `Failed to update identity (${response.status})`;
            try {
                const error = await response.json();
                if (error?.error) message = String(error.error);
            } catch {
                // ignore
            }
            throw new HappyError(message, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config' });
        }
    });
}
