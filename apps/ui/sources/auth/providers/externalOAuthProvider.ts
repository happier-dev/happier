import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';
import { serverFetch } from '@/sync/http/client';

import type { AuthProvider } from '@/auth/providers/types';
import type { AuthProviderId } from '@happier-dev/protocol';

const OAUTH_NOT_CONFIGURED_ERROR = 'oauth_not_configured';

export function createExternalOAuthProvider(params: {
    id: AuthProviderId;
    displayName: string;
    badgeIconName?: string;
    supportsProfileBadge?: boolean;
    connectButtonColor?: string;
}): AuthProvider {
    const providerId = params.id.toString().trim().toLowerCase();
    const providerName = params.displayName;

    return Object.freeze({
        id: providerId,
        displayName: providerName,
        badgeIconName: params.badgeIconName,
        supportsProfileBadge: params.supportsProfileBadge,
        connectButtonColor: params.connectButtonColor,
        getExternalSignupUrl: async ({ publicKey }) => {
            const response = await serverFetch(
                `/v1/auth/external/${encodeURIComponent(providerId)}/params?publicKey=${encodeURIComponent(publicKey)}`,
                undefined,
                { includeAuth: false },
            );
            if (!response.ok) {
                if (response.status === 400) {
                    const error = await response.json().catch(() => null);
                    if (error?.error === OAUTH_NOT_CONFIGURED_ERROR) {
                        throw new HappyError(`${providerName} OAuth is not configured on this server.`, false, {
                            status: 400,
                            kind: 'config',
                        });
                    }
                }
                throw new Error('external-signup-unavailable');
            }
            const data = (await response.json()) as any;
            if (!data?.url) {
                throw new Error('external-signup-unavailable');
            }
            return String(data.url);
        },
        getConnectUrl: async (credentials: AuthCredentials) => {
            return await backoff(async () => {
                const response = await serverFetch(
                    `/v1/connect/external/${encodeURIComponent(providerId)}/params`,
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
                    if (response.status === 400) {
                        let message = `${providerName} OAuth is not configured on this server.`;
                        try {
                            const error = await response.json();
                            if (error?.error === OAUTH_NOT_CONFIGURED_ERROR) {
                                message = `${providerName} OAuth is not configured on this server.`;
                            } else if (error?.error) {
                                message = String(error.error);
                            }
                        } catch {
                            // ignore
                        }
                        throw new HappyError(message, false, { status: 400, kind: 'config' });
                    }
                    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                        let message = `Failed to get ${providerName} OAuth params`;
                        try {
                            const error = await response.json();
                            if (error?.error) message = String(error.error);
                        } catch {
                            // ignore
                        }
                        throw new HappyError(message, false, {
                            status: response.status,
                            kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
                        });
                    }
                    throw new Error(`Failed to get ${providerName} OAuth params: ${response.status}`);
                }

                const data = (await response.json()) as any;
                if (!data?.url) {
                    throw new HappyError(`Failed to get ${providerName} OAuth params`, false, { status: 500, kind: 'config' });
                }
                return String(data.url);
            });
        },
        finalizeConnect: async (credentials: AuthCredentials, payload: { pending: string; username: string }) => {
            return await backoff(async () => {
                const response = await serverFetch(
                    `/v1/connect/external/${encodeURIComponent(providerId)}/finalize`,
                    {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${credentials.token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload),
                    },
                    { includeAuth: false },
                );

                if (!response.ok) {
                    if (response.status === 409) {
                        const json = await response.json().catch(() => ({}));
                        if (json?.error === 'username-taken') {
                            throw new HappyError('username-taken', false, { status: 409, kind: 'auth' });
                        }
                        if (json?.error === 'provider-already-linked') {
                            throw new HappyError('provider-already-linked', false, { status: 409, kind: 'auth' });
                        }
                        throw new HappyError(`Failed to finalize ${providerName} connection`, false, { status: 409, kind: 'auth' });
                    }
                    if (response.status === 400) {
                        const json = await response.json().catch(() => ({}));
                        if (json?.error === 'invalid-username') {
                            throw new HappyError('invalid-username', false, { status: 400, kind: 'auth' });
                        }
                        if (json?.error === 'invalid-pending') {
                            throw new HappyError('invalid-pending', false, { status: 400, kind: 'auth' });
                        }
                        throw new HappyError(`Failed to finalize ${providerName} connection`, false, { status: 400, kind: 'auth' });
                    }
                    throw new Error(`Failed to finalize ${providerName} connect: ${response.status}`);
                }

                const data = (await response.json()) as unknown;
                if (!data || typeof data !== 'object' || (data as any).success !== true) {
                    throw new Error(`Failed to finalize ${providerName} connection`);
                }
            });
        },
        cancelConnectPending: async (credentials: AuthCredentials, pending: string) => {
            const key = pending.trim();
            if (!key) return;

            await backoff(async () => {
                const response = await serverFetch(
                    `/v1/connect/external/${encodeURIComponent(providerId)}/pending/${encodeURIComponent(key)}`,
                    {
                        method: 'DELETE',
                        headers: {
                            Authorization: `Bearer ${credentials.token}`,
                        },
                    },
                    { includeAuth: false },
                );
                if (!response.ok) {
                    // Best-effort cleanup; ignore failures.
                    return;
                }
            });
        },
        disconnect: async (credentials: AuthCredentials) => {
            return await backoff(async () => {
                const response = await serverFetch(
                    `/v1/connect/external/${encodeURIComponent(providerId)}`,
                    {
                        method: 'DELETE',
                        headers: {
                            Authorization: `Bearer ${credentials.token}`,
                        },
                    },
                    { includeAuth: false },
                );

                if (!response.ok) {
                    if (response.status === 404) {
                        let message = `${providerName} account not connected`;
                        try {
                            const error = await response.json();
                            if (error?.error) message = String(error.error);
                        } catch {
                            // ignore
                        }
                        throw new HappyError(message, false, { status: 404, kind: 'config' });
                    }
                    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                        let message = `Failed to disconnect ${providerName}`;
                        try {
                            const error = await response.json();
                            if (error?.error) message = String(error.error);
                        } catch {
                            // ignore
                        }
                        throw new HappyError(message, false, {
                            status: response.status,
                            kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
                        });
                    }
                    throw new Error(`Failed to disconnect ${providerName}: ${response.status}`);
                }

                const data = (await response.json()) as unknown;
                if (!data || typeof data !== 'object' || (data as any).success !== true) {
                    throw new Error(`Failed to disconnect ${providerName} account`);
                }
            });
        },
    });
}
