import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

    const headers = new Headers(init?.headers ?? {});
    if (options.includeAuth !== false) {
        const absoluteRequestUrl = tryParseUrl(requestUrl);
        const activeServerUrl = tryParseUrl(snapshot.serverUrl);
        if (
            absoluteRequestUrl &&
            activeServerUrl &&
            absoluteRequestUrl.origin !== activeServerUrl.origin
        ) {
            throw new Error(
                `Refused authenticated request to ${absoluteRequestUrl.origin}; active server is ${activeServerUrl.origin}`,
            );
        }
        const credentials = await TokenStorage.getCredentials();
        if (credentials?.token) {
            headers.set('Authorization', `Bearer ${credentials.token}`);
        }
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

    let response: Response;
    try {
        response = await fetch(requestUrl, {
            ...init,
            headers,
            signal: requestController.signal,
        });
    } finally {
        removeUpstreamListener();
        inFlightControllers.delete(requestController);
    }

    const current = getActiveServerSnapshot();
    if (current.generation !== snapshot.generation || current.serverId !== snapshot.serverId) {
        throw new StaleServerGenerationError();
    }

    return response;
}
