import { describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeResponseV1 } from '@happier-dev/plugin-sdk';
import { createPluginFetchService } from './service';

function createResponse(body: unknown): FetchRuntimeResponseV1 {
    return Object.freeze({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: Object.freeze({}),
        body,
        text: async () => String(body),
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
    });
}

describe('createPluginFetchService', () => {
    it('rejects network calls before adapter execution when network permission is not declared', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const service = createPluginFetchService({
            networkAllowed: false,
            adapter,
        });

        await expect(service({ url: 'https://example.test/blocked' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_PERMISSION_DENIED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('applies request interceptors in deterministic order and forwards abort signals to the host adapter', async () => {
        const order: string[] = [];
        const controller = new AbortController();
        const adapter = vi.fn(async (request) => {
            order.push('adapter');
            expect(request.signal).toBe(controller.signal);
            expect(request.headers).toEqual({
                'x-a': '1',
                'x-b': '1',
                'x-z': '1',
            });
            return createResponse('ok');
        });
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            interceptors: [
                {
                    id: 'z-last',
                    priority: 0,
                    intercept: async (request, next) => {
                        order.push('z-before');
                        const response = await next({
                            ...request,
                            headers: { ...request.headers, 'x-z': '1' },
                        });
                        order.push('z-after');
                        return response;
                    },
                },
                {
                    id: 'b-first',
                    priority: 10,
                    intercept: async (request, next) => {
                        order.push('b-before');
                        const response = await next({
                            ...request,
                            headers: { ...request.headers, 'x-b': '1' },
                        });
                        order.push('b-after');
                        return response;
                    },
                },
                {
                    id: 'a-first',
                    priority: 10,
                    intercept: async (request, next) => {
                        order.push('a-before');
                        const response = await next({
                            ...request,
                            headers: { ...request.headers, 'x-a': '1' },
                        });
                        order.push('a-after');
                        return response;
                    },
                },
            ],
        });

        await expect(service({
            url: 'https://example.test/allowed',
            signal: controller.signal,
        })).resolves.toMatchObject({ ok: true, status: 200 });

        expect(order).toEqual([
            'a-before',
            'b-before',
            'z-before',
            'adapter',
            'z-after',
            'b-after',
            'a-after',
        ]);
    });

    it('rejects pre-aborted requests without invoking interceptors or adapter', async () => {
        const controller = new AbortController();
        controller.abort();
        const adapter = vi.fn(async () => createResponse('unused'));
        const interceptor = vi.fn(async (_request, next) => next(_request));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            interceptors: [{
                id: 'never',
                intercept: interceptor,
            }],
        });

        await expect(service({
            url: 'https://example.test/aborted',
            signal: controller.signal,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(interceptor).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('enforces declared URL origins before adapter execution', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
        });

        await expect(service({ url: 'https://blocked.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_URL_SCOPE_DENIED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects network calls when no declared URL origin scope is available', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: [],
        });

        await expect(service({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_URL_SCOPE_DENIED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects interceptor rewrites to undeclared URL origins before adapter execution', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                id: 'rewrite',
                intercept: async (request, next) => await next({
                    ...request,
                    url: 'https://blocked.example.test/status',
                }),
            }],
        });

        await expect(service({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_URL_SCOPE_DENIED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('aborts the host adapter when request timeout elapses', async () => {
        const adapter = vi.fn(async (request) => {
            await new Promise<void>((resolve, reject) => {
                request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
                    name: 'AbortError',
                })), { once: true });
                setTimeout(resolve, 250);
            });
            return createResponse('late');
        });
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
        });

        await expect(service({
            url: 'https://example.test/slow',
            timeoutMs: 5,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('rejects on timeout even when the host adapter ignores abort signals', async () => {
        const adapter = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return createResponse('late');
        });
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
        });

        await expect(service({
            url: 'https://example.test/slow',
            timeoutMs: 5,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    it('retries transient adapter failures with attempt metadata', async () => {
        const adapter = vi.fn(async (request) => {
            if (adapter.mock.calls.length === 1) {
                throw Object.assign(new Error('temporarily unavailable'), {
                    code: 'ETIMEDOUT',
                });
            }
            return createResponse(request.metadata?.attempt);
        });
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            retry: {
                maxAttempts: 2,
                baseDelayMs: 0,
            },
        });

        await expect(service({
            url: 'https://example.test/retry',
        })).resolves.toMatchObject({
            body: 2,
        });
        expect(adapter).toHaveBeenCalledTimes(2);
    });
});
