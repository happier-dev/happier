import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalFetchRuntime } from './globalFetchRuntime';

const STABLE_RESPONSE_BODY_CEILING_BYTES = 32 * 1024 * 1024;
const servers: ReturnType<typeof createServer>[] = [];

function createTrackedStream(chunks: readonly Uint8Array[]) {
    let pullCount = 0;
    let cancellationReason: unknown;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = chunks[pullCount];
            pullCount += 1;
            if (chunk) {
                controller.enqueue(chunk);
            } else {
                controller.close();
            }
        },
        cancel(reason) {
            cancellationReason = reason;
        },
    }, { highWaterMark: 0 });
    return {
        body,
        getCancellationReason: () => cancellationReason,
        getPullCount: () => pullCount,
    };
}

describe('createGlobalFetchRuntime', () => {
    afterEach(async () => {
        vi.unstubAllGlobals();
        await Promise.all(servers.splice(0).map(async (server) => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }));
    });

    it('connects only to the policy-validated address while preserving the URL hostname', async () => {
        let receivedHost = '';
        const server = createServer((request, response) => {
            receivedHost = request.headers.host ?? '';
            response.end('pinned');
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');

        const runtime = createGlobalFetchRuntime() as ReturnType<typeof createGlobalFetchRuntime> & Readonly<{
            request(
                input: Parameters<ReturnType<typeof createGlobalFetchRuntime>['request']>[0],
                options: Readonly<{ validatedAddresses: readonly string[] }>,
            ): ReturnType<ReturnType<typeof createGlobalFetchRuntime>['request']>;
        }>;
        const response = await runtime.request({
            url: `http://dns-rebind.invalid:${address.port}/resource`,
            method: 'GET',
            redirect: 'error',
        }, { validatedAddresses: ['127.0.0.1'] });

        expect(new TextDecoder().decode(response.body)).toBe('pinned');
        expect(receivedHost).toBe(`dns-rebind.invalid:${address.port}`);
    });

    it('never falls back to ordinary DNS when admission supplies an empty address set', async () => {
        const fetchMock = vi.fn(async () => new Response('must not dispatch'));
        const openPinnedStream = vi.fn(async () => {
            throw new Error('pinned transport must not dispatch');
        });
        vi.stubGlobal('fetch', fetchMock);
        const runtime = createGlobalFetchRuntime({ openPinnedStream });

        await expect(runtime.request({
            url: 'https://unresolved.example.test/resource',
            method: 'GET',
            redirect: 'error',
        }, { validatedAddresses: [] })).rejects.toMatchObject({
            code: 'plugin_fetch_adapter_unavailable',
        });

        expect(openPinnedStream).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not report a pinned redirect as followed before its next hop is reauthorized', async () => {
        const cancel = vi.fn();
        const runtime = createGlobalFetchRuntime({
            openPinnedStream: async () => Object.freeze({
                status: 302,
                headers: Object.freeze({ location: 'https://next.example.test/result' }),
                contentLength: 0,
                read: async () => null,
                cancel,
            }),
        });

        await expect(runtime.request({
            url: 'https://api.example.test/start',
            redirect: 'follow',
        }, { validatedAddresses: ['93.184.216.34'] })).rejects.toMatchObject({
            code: 'plugin_fetch_redirect_follow_unavailable',
        });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('passes manual redirect mode to the system boundary and exposes the 3xx response', async () => {
        const fetchMock = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { location: 'https://next.example.test/result' },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const response = await createGlobalFetchRuntime().request({
            url: 'https://api.example.test/start',
            redirect: 'manual',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/start',
            expect.objectContaining({ redirect: 'manual' }),
        );
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('https://next.example.test/result');
        expect(response.body.byteLength).toBe(0);
    });

    it('stops consuming an oversized streamed response before pulling another chunk', async () => {
        const body = createTrackedStream([
            new Uint8Array(STABLE_RESPONSE_BODY_CEILING_BYTES),
            new Uint8Array([1]),
            new Uint8Array([2]),
        ]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body.body)));

        let error: unknown;
        try {
            await createGlobalFetchRuntime().request({
                url: 'https://api.example.test/oversized',
                redirect: 'error',
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });

        expect(body.getPullCount()).toBe(2);
        expect(body.getCancellationReason()).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });
    });

    it('cancels a known oversized body before its first chunk is pulled', async () => {
        const body = createTrackedStream([new Uint8Array([1])]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body.body, {
            headers: { 'content-length': String(STABLE_RESPONSE_BODY_CEILING_BYTES + 1) },
        })));

        let error: unknown;
        try {
            await createGlobalFetchRuntime().request({
                url: 'https://api.example.test/known-oversized',
                redirect: 'error',
            });
        } catch (caught) {
            error = caught;
        }

        expect(error).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });
        expect(body.getPullCount()).toBe(0);
        expect(body.getCancellationReason()).toMatchObject({
            code: 'plugin_fetch_response_too_large',
        });
    });

    it('returns a response exactly at the buffered ceiling when content length is absent', async () => {
        const expected = new Uint8Array(STABLE_RESPONSE_BODY_CEILING_BYTES);
        expected[0] = 1;
        expected[expected.byteLength - 1] = 2;
        vi.stubGlobal('fetch', vi.fn(async () => new Response(createTrackedStream([expected]).body)));

        const response = await createGlobalFetchRuntime().request({
            url: 'https://api.example.test/at-limit',
            redirect: 'error',
        });

        expect(response.body).toBeInstanceOf(Uint8Array);
        expect(response.body.byteLength).toBe(STABLE_RESPONSE_BODY_CEILING_BYTES);
        expect(response.body[0]).toBe(1);
        expect(response.body[response.body.byteLength - 1]).toBe(2);
    });

    it('propagates caller abort to an in-flight streamed response', async () => {
        const cancellation = new AbortController();
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let resolvePullStarted: (() => void) | undefined;
        const pullStarted = new Promise<void>((resolve) => {
            resolvePullStarted = resolve;
        });
        let receivedSignal: AbortSignal | null | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller;
            },
            pull() {
                resolvePullStarted?.();
                return new Promise<void>(() => undefined);
            },
        }, { highWaterMark: 0 });
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            receivedSignal = init?.signal;
            receivedSignal?.addEventListener('abort', () => {
                const error = new Error('request aborted');
                error.name = 'AbortError';
                streamController?.error(error);
            }, { once: true });
            return new Response(body);
        }));

        const pending = createGlobalFetchRuntime().request({
            url: 'https://api.example.test/slow',
            redirect: 'error',
        }, { signal: cancellation.signal });
        await pullStarted;
        cancellation.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(receivedSignal?.aborted).toBe(true);
    });
});
