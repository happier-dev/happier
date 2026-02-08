import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { HappyError } from '@/utils/errors';
import { getServerUrl } from './serverConfig';

function parseSuccessResponse(
    raw: unknown,
): { success: boolean; message: string | null } | null {
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as any;
    if (typeof rec.success !== 'boolean') return null;
    const msg = rec.error ?? rec.reason ?? rec.message ?? null;
    return { success: rec.success, message: typeof msg === 'string' && msg.trim() ? msg.trim() : null };
}

/**
 * Register (connect) an inference vendor access token on the server.
 *
 * Note: This is not related to identity providers (OAuth / linked accounts).
 */
export async function connectVendorToken(
    credentials: AuthCredentials,
    vendor: string,
    token: string,
): Promise<void> {
    const apiEndpoint = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${apiEndpoint}/v1/connect/${encodeURIComponent(vendor)}/register`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token }),
        });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = `Failed to connect ${vendor}`;
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to connect ${vendor}: ${response.status}`);
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch {
            throw new HappyError(`Failed to connect ${vendor}: invalid response`, false, { kind: 'server', status: response.status });
        }

        const parsed = parseSuccessResponse(json);
        if (!parsed) {
            throw new HappyError(`Failed to connect ${vendor}: invalid response`, false, { kind: 'server', status: response.status });
        }
        if (!parsed.success) {
            const suffix = parsed.message ? `: ${parsed.message}` : '';
            throw new HappyError(`Failed to connect ${vendor}${suffix}`, false, { kind: 'server', status: response.status });
        }
    });
}

/**
 * Disconnect an inference vendor token from the user's account.
 */
export async function disconnectVendorToken(credentials: AuthCredentials, vendor: string): Promise<void> {
    const apiEndpoint = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${apiEndpoint}/v1/connect/${encodeURIComponent(vendor)}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${credentials.token}`,
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                let message = `${vendor} account not connected`;
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = `Failed to disconnect ${vendor}`;
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to disconnect ${vendor}: ${response.status}`);
        }

        let json: unknown;
        try {
            json = await response.json();
        } catch {
            throw new HappyError(`Failed to disconnect ${vendor}: invalid response`, false, { kind: 'server', status: response.status });
        }

        const parsed = parseSuccessResponse(json);
        if (!parsed) {
            throw new HappyError(`Failed to disconnect ${vendor}: invalid response`, false, { kind: 'server', status: response.status });
        }
        if (!parsed.success) {
            const suffix = parsed.message ? `: ${parsed.message}` : '';
            throw new HappyError(`Failed to disconnect ${vendor}${suffix}`, false, { kind: 'server', status: response.status });
        }
    });
}
