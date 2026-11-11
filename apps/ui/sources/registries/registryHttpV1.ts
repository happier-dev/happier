import type { RegistryHttpV1, RegistryHttpResultV1 } from '@happier-dev/protocol/registries';
import type { RegistrySourceV1 } from '@happier-dev/protocol/registries';
import { readRegistryHttpRateLimitV1 } from '@happier-dev/protocol/registries';

type RegistryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Platform HTTP only. Protocol owns format interpretation and direct/daemon placement. */
export function createUiRegistryHttpV1(fetch: RegistryFetch, signal?: AbortSignal,
    nowMs: () => number = Date.now, rateLimitedUntil = new Map<string, number>()): RegistryHttpV1 {
    const read = async <T>(url: string, opts: { source?: RegistrySourceV1 } | undefined,
        decode: (response: Response) => Promise<T>, init: RequestInit = {}): Promise<RegistryHttpResultV1<T>> => {
        signal?.throwIfAborted();
        // Saved Secrets materialize only in CLI/daemon processes, including on native clients.
        if (opts?.source?.token) return { ok: false, status: { state: 'auth_failed' } };
        const origin = new URL(url).origin;
        const limitedUntil = rateLimitedUntil.get(origin);
        if (limitedUntil !== undefined && limitedUntil > nowMs()) {
            return { ok: false, status: { state: 'rate_limited', retryAt: limitedUntil } };
        }
        // TypeError stays intact: only protocol's ordered fetch plan may move to a daemon.
        const response = await fetch(url, { ...init, credentials: 'omit', ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (!response.ok) {
            const rateLimit = readRegistryHttpRateLimitV1({ status: response.status, headers: response.headers, nowMs: nowMs() });
            if (rateLimit) {
                if (rateLimit.retryAt !== undefined) rateLimitedUntil.set(origin, rateLimit.retryAt);
                return { ok: false, status: rateLimit };
            }
            return { ok: false, status: { state: response.status === 401 || response.status === 403 ? 'auth_failed'
                : response.status === 404 ? 'invalid_source' : 'unreachable' } };
        }
        try {
            const value = await decode(response);
            signal?.throwIfAborted();
            return { ok: true, value, fetchedAt: nowMs() };
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof SyntaxError) return { ok: false, status: { state: 'invalid_source' } };
            throw error;
        }
    };
    return {
        getJson: (url, opts) => read(url, opts, response => response.json()),
        getText: (url, opts) => read(url, opts, response => response.text()),
        getBytes: (url, opts) => read(url, opts, async response => new Uint8Array(await response.arrayBuffer())),
        postForm: (url, body, opts) => read(url, opts, response => response.text(), { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    };
}
