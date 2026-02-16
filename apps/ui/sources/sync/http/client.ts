import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

export { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

export class StaleServerGenerationError extends Error {
    constructor() {
        super('Ignored response from a stale server generation');
        this.name = 'StaleServerGenerationError';
    }
}

type ServerFetchOptions = Readonly<{
    includeAuth?: boolean;
}>;

const inFlightControllers = new Set<AbortController>();
let abortSequence = 0;

export function abortServerFetches(reason: string = 'server-switch'): void {
    abortSequence += 1;
    for (const controller of inFlightControllers) {
        controller.abort(reason);
    }
    inFlightControllers.clear();
}

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

export async function serverFetch(
    path: string,
    init?: RequestInit,
    options: ServerFetchOptions = {},
): Promise<Response> {
    const localAbortSequence = abortSequence;
    const snapshot = getActiveServerSnapshot();
    const normalizedPath = normalizePath(path);
    const requestUrl = normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')
        ? normalizedPath
        : `${snapshot.serverUrl}${normalizedPath}`;

    const absoluteRequestUrl = tryParseUrl(requestUrl);
    const activeServerUrl = tryParseUrl(snapshot.serverUrl);
    const isCrossOrigin =
        !!absoluteRequestUrl
        && !!activeServerUrl
        && absoluteRequestUrl.origin !== activeServerUrl.origin;

    const headers = new Headers(init?.headers ?? {});
    let usedToken: string | null = null;
    if (options.includeAuth !== false) {
        if (isCrossOrigin) {
            throw new Error(
                `Refused authenticated request to ${absoluteRequestUrl!.origin}; active server is ${activeServerUrl!.origin}`,
            );
        }
        const credentials = await TokenStorage.getCredentials();
        if (credentials?.token) {
            usedToken = credentials.token;
            headers.set('Authorization', `Bearer ${credentials.token}`);
        }
    }
    // Also capture an explicit Authorization header, even when includeAuth=false (many ops pass
    // credentials explicitly to avoid repeated TokenStorage reads).
    const explicitAuthHeader = headers.get('Authorization') ?? '';
    if (!usedToken && explicitAuthHeader.startsWith('Bearer ')) {
        usedToken = explicitAuthHeader.slice(7).trim() || null;
    }
    if (isCrossOrigin && explicitAuthHeader.trim().length > 0) {
        // Prevent accidental token leakage when passing absolute URLs.
        throw new Error(
            `Refused authenticated request to ${absoluteRequestUrl!.origin}; active server is ${activeServerUrl!.origin}`,
        );
    }

    const requestController = new AbortController();
    inFlightControllers.add(requestController);
    if (abortSequence !== localAbortSequence) {
        requestController.abort('server-switch');
    }

    const upstreamSignal = init?.signal;
    let removeUpstreamListener = () => {};
    if (upstreamSignal) {
        if (upstreamSignal.aborted) {
            requestController.abort();
        } else {
            const onAbort = () => requestController.abort();
            upstreamSignal.addEventListener('abort', onAbort, { once: true });
            removeUpstreamListener = () => upstreamSignal.removeEventListener('abort', onAbort);
        }
    }

    const method = String(init?.method ?? 'GET').toUpperCase();
    const isActiveOrigin =
        !isCrossOrigin
        && !!absoluteRequestUrl
        && !!activeServerUrl;

    let response: Response | null = null;
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            response = await runtimeFetch(requestUrl, {
                ...init,
                headers,
                signal: requestController.signal,
            });

            const current = getActiveServerSnapshot();
            if (current.generation !== snapshot.generation || current.serverId !== snapshot.serverId) {
                throw new StaleServerGenerationError();
            }

            if (!usedToken || response.status !== 401 || !isActiveOrigin) {
                break;
            }

            // If the active token is rejected, clear it to prevent the UI from getting stuck in a persistent 401 loop.
            // The follow-up request (if any) will re-read credentials and may pick up a refreshed token, or allow the
            // UI to present a clean sign-in state for that server scope.
            try {
                await TokenStorage.invalidateCredentialsTokenForServerUrl(snapshot.serverUrl, usedToken);
            } catch {
                // ignore
            }

            // Only retry idempotent requests to avoid surprising duplication.
            if (attempt !== 0 || (method !== 'GET' && method !== 'HEAD')) {
                break;
            }

            // Re-read credentials and retry once if we found a different token.
            try {
                const fresh = await TokenStorage.getCredentials();
                const freshToken = fresh?.token ?? null;
                if (freshToken && freshToken !== usedToken) {
                    usedToken = freshToken;
                    headers.set('Authorization', `Bearer ${freshToken}`);
                    continue;
                }
            } catch {
                // ignore
            }

            break;
        }
    } finally {
        removeUpstreamListener();
        inFlightControllers.delete(requestController);
    }

    if (!response) {
        // Defensive: loop always runs at least once, but keep return type strict.
        throw new Error('serverFetch did not attempt the request');
    }
    return response;
}
