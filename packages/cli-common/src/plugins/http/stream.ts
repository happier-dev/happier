import { PluginError } from '../errors.js';
import type { HttpRequest, HttpStreamRequest, HttpStreamResponse } from './contracts.js';
import type { PluginHttpStreamingSanitizer } from './service.js';
import { snapshotPluginHttpRequest } from './request.js';

export function snapshotPluginHttpStreamRequest(input: HttpRequest): HttpStreamRequest {
    const request = snapshotPluginHttpRequest(input);
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET') || request.body !== undefined
        || (request.credentialBinding !== undefined && request.credentialBinding.kind !== 'connectedAccountPurpose')) {
        throw new PluginError({ code: 'invalid_request', message: 'HTTP streams require a bodyless GET or HEAD request' });
    }
    // Preserve admitted identity: credential/currentness custody is keyed by
    // this request at the later native injection boundary.
    if (request.responseBody === undefined && request.observeTlsPeer === undefined) return request as HttpStreamRequest;
    // Strip finite-only options at stream ingress, before credential injection.
    const { responseBody: _responseBody, observeTlsPeer: _observeTlsPeer, ...stream } = request;
    return snapshotPluginHttpRequest(stream) as HttpStreamRequest;
}

/** Keeps cancellation, custody and redaction alive for exactly this body. */
export function wrapPluginHttpStream(response: HttpStreamResponse, options: Readonly<{
    signal?: AbortSignal;
    sanitizer?: PluginHttpStreamingSanitizer;
    onDispose?(): void | Promise<void>;
}> = {}): HttpStreamResponse {
    const { signal, onDispose } = options;
    let sanitizer = options.sanitizer;
    let disposed = false;
    let interrupted = false;
    let disposal: Promise<void> | undefined;
    let source: AsyncIterator<Uint8Array> | undefined;
    const dispose = (): Promise<void> => {
        if (disposal) return disposal;
        disposed = true;
        signal?.removeEventListener('abort', abort);
        sanitizer = undefined;
        disposal = (async () => {
            try { await response.dispose(); }
            finally { await onDispose?.(); }
        })();
        return disposal;
    };
    const abort = () => { interrupted = true; void dispose().catch(() => undefined); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const checkCurrent = async () => {
        if (signal?.aborted) {
            const error = new Error('Plugin fetch request was aborted');
            error.name = 'AbortError';
            throw error;
        }
    };
    const iterator: AsyncIterator<Uint8Array> = {
        async next() {
            try {
                if (disposed && !interrupted) return { done: true, value: undefined };
                await checkCurrent();
                if (disposed) return { done: true, value: undefined };
                source ??= response.chunks[Symbol.asyncIterator]();
                while (true) {
                    let item: IteratorResult<Uint8Array>;
                    try { item = await source.next(); }
                    catch (error) {
                        // Explicit disposal owns normal completion, including
                        // the redaction lease it has already retired. Native
                        // aborts instead retain their current authority cause.
                        if (disposed && !interrupted) return { done: true, value: undefined };
                        await checkCurrent();
                        if (disposed) return { done: true, value: undefined };
                        throw error;
                    }
                    if (disposed && !interrupted) return { done: true, value: undefined };
                    await checkCurrent();
                    if (disposed) return { done: true, value: undefined };
                    if (item.done) {
                        const tail = sanitizer?.flushBytes();
                        await dispose();
                        return tail?.length ? { done: false, value: tail } : { done: true, value: undefined };
                    }
                    if (!sanitizer) return { done: false, value: item.value };
                    const bytes = sanitizer.pushBytes(item.value);
                    if (bytes.length) return { done: false, value: bytes };
                }
            } catch (error) {
                await dispose().catch(() => undefined);
                throw error;
            }
        },
        async return() { await dispose(); return { done: true, value: undefined }; },
    };
    return Object.freeze({
        status: response.status, finalUrl: response.finalUrl, headers: Object.freeze({ ...response.headers }),
        chunks: Object.freeze({ [Symbol.asyncIterator]: () => iterator }), dispose,
    });
}
