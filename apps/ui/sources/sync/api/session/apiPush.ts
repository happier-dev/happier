import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { z } from 'zod';
import { PushTokenSchema, PushTokenRegisterResponseSchema, PushTokensResponseSchema, PushTokensRemoteAlertProjectionV2Schema, type PushTokensRemoteAlertProjectionV2 } from '@happier-dev/protocol/push/pushTokenRegistration';
import type { DeviceRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';

export async function registerPushToken(
    credentials: AuthCredentials,
    token: string,
    opts: Readonly<{ serverId?: string; apiEndpoint?: string; clientServerUrl?: string; retry?: 'default' | 'none'; runtimeOrigin?: string; remoteAlerts?: { registrationId: string; policy: DeviceRemoteAlertPolicyV1 | null } }> = {},
): Promise<void> {
    const API_ENDPOINT = (opts.apiEndpoint ?? '').trim().replace(/\/+$/, '');
    const CLIENT_SERVER_URL = (opts.clientServerUrl ?? '').trim().replace(/\/+$/, '');
    const RUNTIME_ORIGIN = (opts.runtimeOrigin ?? '').trim().replace(/\/+$/, '');
    const path = '/v1/push-tokens';

    const run = async () => {
        const endpointCredentials = (() => {
            if (!API_ENDPOINT) return null;
            const serverId = String(opts.serverId ?? '').trim();
            if (!serverId) return null;
            return TokenStorage.getCredentialsForServerUrl(API_ENDPOINT, { serverId });
        })();

        const resolvedCredentials = endpointCredentials ? await endpointCredentials.catch(() => null) : null;
        const effectiveCredentials = resolvedCredentials ?? credentials;

        const doFetch = API_ENDPOINT
            ? (p: string, init: RequestInit) => runtimeFetchWithServerReachability({
                serverUrl: API_ENDPOINT,
                token: effectiveCredentials.token,
                url: `${RUNTIME_ORIGIN || API_ENDPOINT}${p}`,
                ...(RUNTIME_ORIGIN ? { runtimeOrigin: RUNTIME_ORIGIN } : {}),
                init,
            })
            : (p: string, init: RequestInit) => serverFetch(p, init, { includeAuth: false });

        const response = await doFetch(path, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${effectiveCredentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token, ...(CLIENT_SERVER_URL ? { clientServerUrl: CLIENT_SERVER_URL } : {}), ...(opts.remoteAlerts === undefined ? {} : { remoteAlerts: opts.remoteAlerts }) }),
        });

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

        if (response.status === 204) {
            return;
        }

        let rawBody = '';
        try {
            rawBody = await response.text();
        } catch {
            rawBody = '';
        }

        // Some proxies return an empty body on 2xx; treat that as success.
        if (!rawBody.trim()) {
            return;
        }

        let data: unknown = null;
        try {
            data = JSON.parse(rawBody) as unknown;
        } catch {
            throw new Error('Failed to register push token');
        }

        if (!PushTokenRegisterResponseSchema.safeParse(data).success) {
            throw new Error('Failed to register push token');
        }
    };

    if (opts.retry === 'none') {
        await run();
        return;
    }

    await backoff(run);
}

const PushTokenDeleteResponseSchema = z.object({
    success: z.literal(true),
});

export type PushToken = z.infer<typeof PushTokenSchema>;

export async function fetchPushTokensRemoteAlertProjection(
    credentials: AuthCredentials,
    request: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<PushTokensRemoteAlertProjectionV2 | null> {
    const response = await request('/v1/push-tokens?projectionVersion=2', {
        method: 'GET', headers: { Authorization: `Bearer ${credentials.token}` },
    });
    if (!response.ok) return null;
    const parsed = PushTokensRemoteAlertProjectionV2Schema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
}

export async function fetchPushTokens(
    credentials: AuthCredentials,
    opts: Readonly<{ apiEndpoint?: string }> = {},
): Promise<PushToken[]> {
    const API_ENDPOINT = (opts.apiEndpoint ?? '').trim().replace(/\/+$/, '');
    const path = '/v1/push-tokens';
    const doFetch = API_ENDPOINT
        ? (p: string, init: RequestInit) => runtimeFetchWithServerReachability({
            serverUrl: API_ENDPOINT,
            token: credentials.token,
            url: `${API_ENDPOINT}${p}`,
            init,
        })
        : (p: string, init: RequestInit) => serverFetch(p, init, { includeAuth: false });

    const response = await doFetch(path, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError('Failed to load push tokens', false);
        }
        throw new Error(`Failed to load push tokens: ${response.status}`);
    }

    const parsed = PushTokensResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
        throw new Error('Failed to parse push tokens response');
    }

    return parsed.data.tokens;
}

export async function deletePushToken(
    credentials: AuthCredentials,
    token: string,
    opts: Readonly<{ apiEndpoint?: string; runtimeOrigin?: string }> = {},
): Promise<void> {
    const API_ENDPOINT = (opts.apiEndpoint ?? '').trim().replace(/\/+$/, '');
    const RUNTIME_ORIGIN = (opts.runtimeOrigin ?? '').trim().replace(/\/+$/, '');
    const encodedToken = encodeURIComponent(String(token ?? '').trim());
    if (!encodedToken) {
        throw new Error('Missing push token');
    }

    const path = `/v1/push-tokens/${encodedToken}`;
    const doFetch = API_ENDPOINT
        ? (p: string, init: RequestInit) => runtimeFetchWithServerReachability({
            serverUrl: API_ENDPOINT,
            token: credentials.token,
            url: `${RUNTIME_ORIGIN || API_ENDPOINT}${p}`,
            ...(RUNTIME_ORIGIN ? { runtimeOrigin: RUNTIME_ORIGIN } : {}),
            init,
        })
        : (p: string, init: RequestInit) => serverFetch(p, init, { includeAuth: false });

    const response = await doFetch(path, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
        },
    });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError('Failed to delete push token', false);
        }
        throw new Error(`Failed to delete push token: ${response.status}`);
    }

    let json: unknown = null;
    try {
        json = await response.json();
    } catch {
        json = null;
    }

    if (PushTokenDeleteResponseSchema.safeParse(json).success) {
        return;
    }

    if (response.status === 204) {
        return;
    }

    // Some proxies return an empty body on 200; treat that as success.
    if (response.status === 200 && json == null) {
        return;
    }

    throw new Error('Failed to delete push token');
}
