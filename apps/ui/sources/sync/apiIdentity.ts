import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';
import { backoff } from '@/utils/time';
import { getServerUrl } from '@/sync/serverConfig';

export async function setAccountIdentityShowOnProfile(params: {
    credentials: AuthCredentials;
    providerId: string;
    showOnProfile: boolean;
}): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    const provider = params.providerId.toString().trim().toLowerCase();
    if (!provider) {
        throw new HappyError('Invalid provider', false, { status: 400, kind: 'config' });
    }

    await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/account/identity/${encodeURIComponent(provider)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${params.credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ showOnProfile: params.showOnProfile }),
        });

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

