import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { normalizeRequestBodyHeaders } from '@/sync/http/requestBodyHeaders';
import {
    AccountStoredContentCompatibilityUnavailableError,
    readAccountStoredContentCompatibilityRequestDeclaration,
    resolveAccountStoredContentCompatibilityHeaders,
    stripAccountStoredContentCompatibilityHeader,
} from '@/sync/http/accountStoredContentCompatibility';

import {
    acquireServerReachabilitySupervisor,
    peekServerReachabilityScope,
    reportServerAuthFailed,
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
    homeIdentityId?: string;
    token: string | null;
    url: string;
    init: RequestInit;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Verified request origin; reachability and auth audience remain keyed by serverUrl. */
    runtimeOrigin?: string;
    /** Called after reachability/origin guards pass and immediately before dispatch. */
    onIssued?: () => void;
}>): Promise<Response> {
    const targetUrl = tryParseUrl(params.url, params.serverUrl);
    const requestedCompatibilityDeclaration =
        readAccountStoredContentCompatibilityRequestDeclaration(params.init);
    const compatibility = targetUrl?.pathname === '/v1/features'
        ? null
        : resolveAccountStoredContentCompatibilityHeaders(
            params.init.headers,
            {
                serverUrl: params.serverUrl,
                ...(requestedCompatibilityDeclaration
                    ? { declaration: requestedCompatibilityDeclaration }
                    : {}),
            },
        );
    if (
        requestedCompatibilityDeclaration
        && compatibility?.status === 'unavailable'
    ) {
        throw new AccountStoredContentCompatibilityUnavailableError(
            compatibility.reason,
        );
    }
    const headers = compatibility?.status === 'available'
        ? compatibility.headers
        : stripAccountStoredContentCompatibilityHeader(params.init.headers);
    normalizeRequestBodyHeaders(headers, params.init.body);
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
        const target = tryParseUrl(params.url, params.runtimeOrigin ?? params.serverUrl);
        const allowedTransport = tryParseUrl(params.runtimeOrigin ?? params.serverUrl);
        if (!server || !target || !allowedTransport) {
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
        if (allowedTransport.origin !== target.origin) {
            throw new Error(`Refused authenticated request to ${target.origin}; expected ${allowedTransport.origin}`);
        }
    }

    const reachability = await acquireServerReachabilitySupervisor({
        serverUrl: params.serverUrl,
        token: effectiveToken,
        ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
    });

    try {
        await waitForServerReachable({
            serverUrl: params.serverUrl,
            token: effectiveToken,
            ...(params.homeIdentityId ? { homeIdentityId: params.homeIdentityId } : {}),
            signal: params.signal ?? (params.init.signal ?? undefined),
            timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : readServerReachabilityWaitTimeoutMs(),
            acceptAuthFailed: true,
        });
        const probeReportScope = peekServerReachabilityScope(params.serverUrl, effectiveToken);
        params.onIssued?.();
        const response = await runtimeFetch(params.url, {
            ...params.init,
            headers,
        });
        // A normal authenticated domain endpoint uses 403 for authorization
        // denials. Only 401 proves that this request's credential was rejected;
        // the dedicated authenticated readiness probe separately owns its
        // deliberate 401/403 credential check.
        if (hasAuth && response.status === 401) {
            if (probeReportScope) {
                reportServerAuthFailed(params.serverUrl, response.status, probeReportScope, effectiveToken);
            }
        }
        return response;
    } catch (error) {
        reportServerUnreachable(params.serverUrl, error, effectiveToken);
        throw error;
    } finally {
        await reachability.release();
    }
}
