import { PluginError } from '../errors.js';
import type { HttpRequest, HttpStreamResponse } from './contracts.js';
import type { PluginHttpRuntimeAdapter } from './service.js';
import { readBoundedPluginHttpResponseBody } from './responseBody.js';

type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
type Fetch = (input: string, init?: FetchInit) => Promise<Response>;

/** The HTTP owner selects native following only when Fetch preserves its credential policy. */
export function createFetchPluginHttpRuntime(fetch: Fetch): PluginHttpRuntimeAdapter {
    const open = async (request: HttpRequest, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const response = await fetch(request.url, { method: request.method ?? 'GET', headers: request.headers,
            ...(request.body === undefined ? {} : { body: request.body as FetchInit['body'] }),
            redirect: request.redirect, credentials: 'omit', ...(signal ? { signal } : {}) });
        if (response.type === 'opaqueredirect' || response.status === 0
            || (response.redirected && request.redirect !== 'follow')) {
            await response.body?.cancel().catch(() => undefined);
            throw new PluginError({ code: 'plugin_fetch_redirect_refused',
                message: 'This transport cannot expose the redirect response safely' });
        }
        return response;
    };
    const metadata = (response: Response, url: string) => ({ status: response.status,
        finalUrl: response.url || url, headers: Object.freeze(Object.fromEntries(response.headers.entries())) });
    return Object.freeze({
        async request(request, options = {}) {
            const controller = new AbortController();
            const abort = () => controller.abort(options.signal?.reason);
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener('abort', abort, { once: true });
            try {
                const response = await open(request, controller.signal);
                if (request.responseBody === 'discard') {
                    await response.body?.cancel();
                    return { ...metadata(response, request.url), body: new Uint8Array() };
                }
                const body = await readBoundedPluginHttpResponseBody(response, controller);
                controller.signal.throwIfAborted();
                return { ...metadata(response, request.url), body };
            } finally {
                options.signal?.removeEventListener('abort', abort);
            }
        },
        async requestStream(request, options = {}): Promise<HttpStreamResponse> {
            const response = await open(request, options.signal);
            const reader = response.body?.getReader();
            let disposed = false;
            const dispose = async () => {
                if (disposed) return;
                disposed = true;
                try { await reader?.cancel(); } finally { reader?.releaseLock(); }
            };
            return { ...metadata(response, request.url), dispose, chunks: { async *[Symbol.asyncIterator]() {
                try {
                    while (reader && !disposed) {
                        options.signal?.throwIfAborted();
                        const item = await reader.read();
                        if (item.done) return;
                        yield item.value;
                    }
                } finally { await dispose(); }
            } } };
        },
        async openWebSocket() {
            throw new PluginError({ code: 'plugin_fetch_adapter_unavailable', message: 'WebSockets are unavailable in this host context' });
        },
    });
}
