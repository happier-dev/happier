import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { runtimeFetchManualResponse } from '@/utils/system/runtimeFetch';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { normalizeRequestBodyHeaders } from '@/sync/http/requestBodyHeaders';
import { isIdempotentServerRead, withServerReadLifetime, type ServerFetchOptions } from '@/sync/http/client';
import {
    AccountStoredContentCompatibilityUnavailableError,
    readAccountStoredContentCompatibilityRequestDeclaration,
    resolveAccountStoredContentCompatibilityHeaders,
    stripAccountStoredContentCompatibilityHeader,
} from '@/sync/http/accountStoredContentCompatibility';

import {
    acquireServerReachabilitySupervisor,
    peekServerReachabilityScope,
    reportServerReachabilityProbeResult,
    reportServerUnreachable,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';
import { classifyEndpointResponse } from './classifyEndpointResponse';

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

type ReachableFetchParams = Readonly<{
    serverUrl: string;
    homeIdentityId?: string;
    token: string | null;
    url: string;
    init: RequestInit;
    timeoutMs?: number;
    recoveryRead?: ServerFetchOptions['recoveryRead'];
    signal?: AbortSignal;
    /** Verified request origin; reachability and auth audience remain keyed by serverUrl. */
    runtimeOrigin?: string;
    /** Called after reachability/origin guards pass and immediately before dispatch. */
    onIssued?: () => void;
}>;

export function runtimeFetchWithServerReachability(params: ReachableFetchParams): Promise<Response>;
export function runtimeFetchWithServerReachability<T>(params: ReachableFetchParams, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
export async function runtimeFetchWithServerReachability<T>(params: ReachableFetchParams, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
    const method = String(params.init.method ?? 'GET').toUpperCase();
    const readPolicy = params.recoveryRead
        ?? (isIdempotentServerRead(method, tryParseUrl(params.url)?.pathname ?? params.url) ? 'unbounded' : false);
    if (readPolicy) {
        const cancellation = mergeAbortSignals([params.signal, params.init.signal ?? undefined]);
        try {
            return await withServerReadLifetime<T>({ ...params.init, signal: cancellation.signal },
                (init, consume) => performReachableFetch({ ...params, signal: undefined, init }, consume),
                consumeResponse, { responseSizeBounded: readPolicy === 'paged' });
        } finally { cancellation.dispose(); }
    }
    return await performReachableFetch(params, consumeResponse);
}

async function performReachableFetch<T>(params: ReachableFetchParams, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
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

    const cancellation = mergeAbortSignals([params.signal, params.init.signal ?? undefined]);
    const signal = cancellation.signal;
    const acquisitionLifetime = new AbortController();
    const reachabilityPromise = acquireServerReachabilitySupervisor({
        serverUrl: params.serverUrl,
        token: effectiveToken,
        signal: acquisitionLifetime.signal,
        ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
    });
    let reachability: Awaited<typeof reachabilityPromise> | null = null;

    try {
        await waitForServerReachable({
            serverUrl: params.serverUrl,
            token: effectiveToken,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.homeIdentityId ? { homeIdentityId: params.homeIdentityId } : {}),
            signal,
            timeoutMs: params.timeoutMs,
            acceptAuthFailed: true,
        });
        reachability = await reachabilityPromise;
        const probeReportScope = peekServerReachabilityScope(params.serverUrl, effectiveToken);
        let issued = false;
        const markIssued = () => {
            if (issued) return;
            params.onIssued?.();
            issued = true;
        };
        let response: Response;
        try {
            response = await fetchWithCredentialRedirectRefusal(params.url, { ...params.init, headers, signal },
                (url, init) => runtimeFetchManualResponse(url, init, markIssued));
        } catch (error) {
            if (issued && !signal?.aborted) reportServerUnreachable(params.serverUrl, error, effectiveToken);
            throw error;
        }
        const probe = classifyEndpointResponse(response, hasAuth);
        if (probe) reportServerReachabilityProbeResult(params.serverUrl, probe, probeReportScope ?? undefined, effectiveToken);
        if (!consumeResponse) return response;
        const result = await consumeResponse(response);
        throwIfAborted(signal);
        return result;
    } finally {
        cancellation.dispose();
        acquisitionLifetime.abort();
        if (reachability) {
            await reachability.release();
        } else {
            // Cancellation ends this caller immediately; shared startup may
            // still be serving others. Release this lease when it arrives.
            void reachabilityPromise.then(lease => lease.release()).catch(() => {});
        }
    }
}
