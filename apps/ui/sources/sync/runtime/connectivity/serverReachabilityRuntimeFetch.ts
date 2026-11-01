import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { withServerReadLifetime, type ServerReadRequestInit } from '@/sync/http/client';
import { withConnectedServiceReaderSupport } from '@happier-dev/protocol';

import {
    createServerReachabilityResponseReporter,
    reportServerUnreachable,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';
import { readServerReachabilityWaitTimeoutMs } from './serverReachabilityTuning';
import { observeUiClientUpgradeRequiredResponse } from '@/sync/runtime/clientCompatibility/uiClientUpgradeRequired';

function tryParseUrl(raw: string, base?: string): URL | null {
    try {
        return base ? new URL(raw, base) : new URL(raw);
    } catch {
        return null;
    }
}

function redactUrlForError(raw: string): string {
    const value = String(raw ?? '').trim();
    if (!value) return '<empty-url>';

    try {
        const parsed = new URL(value);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return value
            .replace(/\/\/[^\/?#]*@/, '//')
            .replace(/[#?].*$/, '');
    }
}

type ServerReachabilityFetchParams = Readonly<{
    serverUrl: string;
    token: string | null;
    url: string;
    init: ServerReadRequestInit;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Explicit OS task work; do not resume the app's foreground supervisors. */
    networkMode?: 'background-task';
}>;

export function runtimeFetchWithServerReachability(params: ServerReachabilityFetchParams): Promise<Response> {
    const method = String(params.init.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
        return withServerReadLifetime<Response>({ ...params.init, signal: params.signal ?? params.init.signal },
            async (init, consume) => consume(await performReachableFetch({ ...params, init })));
    }
    return performReachableFetch(params);
}

async function performReachableFetch(params: ServerReachabilityFetchParams): Promise<Response> {
    const headers = new Headers(params.init.headers ?? {});
    const explicitAuthHeader = headers.get('Authorization') ?? '';
    const bearerTokenFromHeader = (() => {
        const header = explicitAuthHeader.trim();
        if (!header) return null;
        const match = /^bearer\s+(.+)$/i.exec(header);
        if (!match) return null;
        const token = match[1]?.trim() ?? '';
        return token || null;
    })();

    const effectiveToken = params.token ?? bearerTokenFromHeader;
    const hasAuth = Boolean(effectiveToken) || explicitAuthHeader.trim().length > 0;
    if (hasAuth) {
        const server = tryParseUrl(params.serverUrl);
        const target = tryParseUrl(params.url, params.serverUrl);
        if (!server || !target) {
            const logSafeRequestUrl = redactUrlForError(params.url);
            const logSafeServerUrl = redactUrlForError(params.serverUrl);
            throw new Error(
                `Refused authenticated request because request/server URL is not a valid absolute URL ` +
                `(requestUrl=${logSafeRequestUrl}, serverUrl=${logSafeServerUrl})`,
            );
        }
        if ((server.protocol !== 'http:' && server.protocol !== 'https:') || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
            const logSafeRequestUrl = redactUrlForError(params.url);
            const logSafeServerUrl = redactUrlForError(params.serverUrl);
            throw new Error(
                `Refused authenticated request because request/server URL is not http(s) ` +
                `(requestUrl=${logSafeRequestUrl}, serverUrl=${logSafeServerUrl})`,
            );
        }
        if (server.origin !== target.origin) {
            throw new Error(`Refused authenticated request to ${target.origin}; expected ${server.origin}`);
        }
    }

    if (params.networkMode !== 'background-task') {
        await waitForServerReachable({
            serverUrl: params.serverUrl,
            token: effectiveToken,
            signal: params.signal ?? (params.init.signal ?? undefined),
            timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : readServerReachabilityWaitTimeoutMs(),
            acceptAuthFailed: true,
        });
    }

    const reportResponse = createServerReachabilityResponseReporter(params.serverUrl, hasAuth);
    try {
        const requestUrl = hasAuth ? withConnectedServiceReaderSupport(params.url) : params.url;
        const response = await runtimeFetch(requestUrl, { ...params.init, headers });
        await observeUiClientUpgradeRequiredResponse(response);
        reportResponse(response);
        return response;
    } catch (error) {
        // The caller owns intentional cancellation; it does not establish a reachability failure.
        if (!params.init.signal?.aborted && !params.signal?.aborted) {
            reportServerUnreachable(params.serverUrl, error);
        }
        throw error;
    }
}
