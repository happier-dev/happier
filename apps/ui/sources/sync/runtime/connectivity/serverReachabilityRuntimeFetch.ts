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

    await waitForServerReachable({
        serverUrl: params.serverUrl,
        token: effectiveToken,
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
