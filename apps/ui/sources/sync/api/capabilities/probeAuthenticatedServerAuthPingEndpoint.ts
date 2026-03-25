import { runtimeFetch } from '@/utils/system/runtimeFetch';

export type AuthenticatedServerAuthPingProbeResult =
    | Readonly<{ status: 'ready' }>
    | Readonly<{ status: 'auth_failed'; statusCode: 401 | 403; errorMessage: string }>
    | Readonly<{ status: 'retry_later'; errorMessage: string }>
    | Readonly<{ status: 'server_unreachable'; errorMessage: string }>;

export function normalizeBaseUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return value.replace(/\/+$/, '');
    }
}

function joinBaseAndPath(baseUrl: string, path: string): string {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
}

export async function probeAuthenticatedServerAuthPingEndpoint(params: Readonly<{
    endpoint: string;
    token: string;
    signal?: AbortSignal;
}>): Promise<AuthenticatedServerAuthPingProbeResult> {
    const endpoint = normalizeBaseUrl(params.endpoint) ?? String(params.endpoint ?? '').replace(/\/+$/, '');

    try {
        const authResponse = await runtimeFetch(joinBaseAndPath(endpoint, '/v1/auth/ping'), {
            method: 'GET',
            signal: params.signal,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${params.token}`,
            },
        });

        if (authResponse.status === 401 || authResponse.status === 403) {
            return {
                status: 'auth_failed',
                statusCode: authResponse.status,
                errorMessage: `Authenticated probe returned ${authResponse.status}`,
            };
        }

        if (authResponse.status >= 500) {
            return {
                status: 'retry_later',
                errorMessage: `Authenticated probe returned ${authResponse.status}`,
            };
        }

        return { status: 'ready' };
    } catch (error) {
        return {
            status: 'server_unreachable',
            errorMessage: error instanceof Error ? error.message : String(error),
        };
    }
}
