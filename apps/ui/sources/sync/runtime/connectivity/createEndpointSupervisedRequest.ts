import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { acquireEndpointSupervisor } from './endpointSupervisorPool';
import {
    assertEndpointReadyForRequestOrThrow,
    reportEndpointResponseToSupervisor,
    shouldReportEndpointFailure,
    waitForEndpointSupervisorToSettle,
} from './endpointSupervision';
import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

function normalizePath(path: string): string {
    const value = String(path ?? '').trim();
    if (!value) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    return value.startsWith('/') ? value : `/${value}`;
}

function tryParseUrl(raw: string): URL | null {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

function readAuthorizationHeader(headers: Headers): string {
    const value = headers.get('Authorization');
    return typeof value === 'string' ? value.trim() : '';
}

export function createEndpointSupervisedRequest(params: Readonly<{
    serverId: string;
    serverUrl: string;
    token?: string | null;
    endpointSupervisor?: ManagedEndpointSupervisor | null;
}>): (path: string, init: RequestInit) => Promise<Response> {
    const serverUrl = String(params.serverUrl ?? '').trim().replace(/\/+$/, '');
    const baseUrlParsed = tryParseUrl(serverUrl);

    return async (path: string, init: RequestInit) => {
        const normalizedPath = normalizePath(path);
        const requestUrl = normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')
            ? normalizedPath
            : `${serverUrl}${normalizedPath}`;

        const headers = new Headers(init?.headers ?? {});
        const token = typeof params.token === 'string' ? params.token.trim() : '';
        if (token && !headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`);
        }

        const absoluteRequestUrl = tryParseUrl(requestUrl);
        const authHeader = readAuthorizationHeader(headers);
        const hadAuth = authHeader.length > 0;
        if (hadAuth) {
            // Fail-closed: never allow an authenticated request when we cannot validate that it targets the expected
            // base origin (e.g. a malformed base URL can turn into a same-origin relative fetch in browsers).
            if (!absoluteRequestUrl || !baseUrlParsed) {
                throw new Error('Refused authenticated request because request/server URL is not a valid absolute URL');
            }
            if (
                (absoluteRequestUrl.protocol !== 'http:' && absoluteRequestUrl.protocol !== 'https:')
                || (baseUrlParsed.protocol !== 'http:' && baseUrlParsed.protocol !== 'https:')
            ) {
                throw new Error('Refused authenticated request because request/server URL is not http(s)');
            }
            if (absoluteRequestUrl.origin !== baseUrlParsed.origin) {
                throw new Error(`Refused authenticated request to ${absoluteRequestUrl.origin}; expected ${baseUrlParsed.origin}`);
            }
        }

        const externalSupervisor = params.endpointSupervisor ?? null;
        const handle = externalSupervisor
            ? null
            : await acquireEndpointSupervisor({
                serverId: params.serverId,
                endpoint: serverUrl,
                tokenOverride: token || null,
            });
        const supervisor = externalSupervisor ?? handle!.supervisor;

        try {
            const state = await waitForEndpointSupervisorToSettle(supervisor);
            assertEndpointReadyForRequestOrThrow(state, { requireAuth: hadAuth });

            let response: Response;
            try {
                response = await runtimeFetch(requestUrl, {
                    ...init,
                    headers,
                    method: init?.method ?? 'GET',
                });
            } catch (error) {
                if (shouldReportEndpointFailure({ init, error })) {
                    const errorMessage = sanitizeEndpointErrorMessage(error);
                    if (errorMessage) {
                        supervisor.reportFailure({ errorMessage });
                    }
                }
                throw error;
            }

            reportEndpointResponseToSupervisor(supervisor, response, hadAuth || token.length > 0);
            return response;
        } finally {
            await handle?.release().catch(() => {});
        }
    };
}
