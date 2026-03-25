import { runtimeFetch } from '@/utils/system/runtimeFetch';

import {
    reportServerUnreachable,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';
import { readServerReachabilityWaitTimeoutMs } from './serverReachabilityTuning';

function tryParseUrl(raw: string, base?: string): URL | null {
    try {
        return base ? new URL(raw, base) : new URL(raw);
    } catch {
        return null;
    }
}

export async function runtimeFetchWithServerReachability(params: Readonly<{
    serverUrl: string;
    token: string | null;
    url: string;
    init: RequestInit;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<Response> {
    const headers = new Headers(params.init.headers ?? {});
    const explicitAuthHeader = headers.get('Authorization') ?? '';
    const hasAuth = Boolean(params.token) || explicitAuthHeader.trim().length > 0;
    if (hasAuth) {
        const server = tryParseUrl(params.serverUrl);
        const target = tryParseUrl(params.url, params.serverUrl);
        if (!server || !target) {
            throw new Error(
                `Refused authenticated request because request/server URL is not a valid absolute URL ` +
                `(requestUrl=${params.url}, serverUrl=${params.serverUrl})`,
            );
        }
        if ((server.protocol !== 'http:' && server.protocol !== 'https:') || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
            throw new Error(
                `Refused authenticated request because request/server URL is not http(s) ` +
                `(requestUrl=${params.url}, serverUrl=${params.serverUrl})`,
            );
        }
        if (server.origin !== target.origin) {
            throw new Error(`Refused authenticated request to ${target.origin}; expected ${server.origin}`);
        }
    }

    await waitForServerReachable({
        serverUrl: params.serverUrl,
        token: params.token,
        signal: params.signal ?? (params.init.signal ?? undefined),
        timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : readServerReachabilityWaitTimeoutMs(),
        acceptAuthFailed: true,
    });

    try {
        return await runtimeFetch(params.url, params.init);
    } catch (error) {
        reportServerUnreachable(params.serverUrl, error);
        throw error;
    }
}
