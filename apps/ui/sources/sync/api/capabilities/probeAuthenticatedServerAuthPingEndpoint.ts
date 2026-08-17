import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { buildRetryLaterProbeResultFromResponse } from '@/sync/runtime/connectivity/retryLaterProbeResult';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

export type AuthenticatedServerAuthPingProbeResult =
    | Extract<ReadinessProbeResult, { status: 'ready' }>
    | Readonly<{ status: 'auth_failed'; statusCode: 401 | 403; errorMessage: string }>
    | Extract<ReadinessProbeResult, { status: 'retry_later' }>
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

/**
 * `GET /v1/auth/ping` is a JSON-only route (`registerAuthPingRoute`: 200 → `{ ok: true }`). An HTML document is
 * therefore positive evidence that something other than this server answered — a captive portal, a transparent
 * proxy, or a sign-in interstitial. We deliberately do not *require* `application/json`, because reverse proxies
 * and other intermediaries can strip or rewrite the content type on an otherwise genuine response; absence of
 * evidence must not manufacture an outage.
 */
function isInterceptedHtmlResponse(response: Response): boolean {
    const contentType = response.headers?.get?.('Content-Type');
    if (typeof contentType !== 'string') return false;
    const normalized = contentType.toLowerCase();
    return normalized.includes('text/html') || normalized.includes('application/xhtml+xml');
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

        if (authResponse.status === 429 || authResponse.status >= 500) {
            return buildRetryLaterProbeResultFromResponse(authResponse, `Authenticated probe returned ${authResponse.status}`);
        }

        // Readiness needs positive evidence that this server answered this route. Anything else — a 404 from a
        // host that does not serve it, a redirect, an interception page — is not reachability, and treating it as
        // ready sends the socket into a connect/fail/re-probe loop against a server that will never accept it.
        // This matches the sibling readiness probe (`createEndpointReadinessProbe`), which already required 200.
        if (authResponse.status !== 200) {
            return {
                status: 'server_unreachable',
                errorMessage: `Authenticated probe returned ${authResponse.status}`,
            };
        }

        if (isInterceptedHtmlResponse(authResponse)) {
            return {
                status: 'server_unreachable',
                errorMessage: 'Authenticated probe was answered with an HTML document',
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
