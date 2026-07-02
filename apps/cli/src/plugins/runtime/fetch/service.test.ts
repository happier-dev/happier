import { describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeRequestV1, FetchRuntimeResponseV1 } from '@happier-dev/plugin-sdk';
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

    it('applies request-policy interceptors in deterministic lower-order order and composes patches', async () => {
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
                    pluginId: 'z.plugin',
                    contribution: {
                        id: 'z-last',
                        order: 20,
                        targets: [{ scope: 'plugin-fetch' }],
                    },
                    registration: {
                        id: 'z-last',
                        handle: async () => {
                            order.push('z');
                            return {
                                kind: 'allow',
                                request: { headers: { set: { 'x-z': '1' } } },
                            };
                        },
                    },
                },
                {
                    pluginId: 'b.plugin',
                    contribution: {
                        id: 'b-first',
                        order: 10,
                        targets: [{ scope: 'plugin-fetch' }],
                    },
                    registration: {
                        id: 'b-first',
                        handle: async () => {
                            order.push('b');
                            return {
                                kind: 'allow',
                                request: { headers: { set: { 'x-b': '1' } } },
                            };
                        },
                    },
                },
                {
                    pluginId: 'a.plugin',
                    contribution: {
                        id: 'a-first',
                        order: 10,
                        targets: [{ scope: 'plugin-fetch' }],
                    },
                    registration: {
                        id: 'a-first',
                        handle: async () => {
                            order.push('a');
                            return {
                                kind: 'allow',
                                request: { headers: { set: { 'x-a': '1' } } },
                            };
                        },
                    },
                },
            ],
        });

        await expect(service({
            url: 'https://example.test/allowed',
            signal: controller.signal,
        })).resolves.toMatchObject({ ok: true, status: 200 });

        expect(order).toEqual([
            'a',
            'b',
            'z',
            'adapter',
        ]);
    });

    it('rejects pre-aborted requests without invoking interceptors or adapter', async () => {
        const controller = new AbortController();
        controller.abort();
        const adapter = vi.fn(async () => createResponse('unused'));
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'never', targets: [{ scope: 'plugin-fetch' }] },
                registration: { id: 'never', handle: interceptor },
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
                pluginId: 'acme.policy',
                contribution: { id: 'rewrite', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'rewrite',
                    handle: async () => ({
                        kind: 'allow',
                        request: { url: 'https://blocked.example.test/status' },
                    }),
                },
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

    it('redacts protected credentials from interceptor input while allowing replacement patches', async () => {
        const seen: FetchRuntimeRequestV1[] = [];
        const adapter = vi.fn(async (request) => createResponse({
            authorization: request.headers?.authorization,
            user: request.headers?.['x-user-id'],
            safe: request.headers?.accept,
            url: request.url,
            body: request.body,
        }));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'credential-policy', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'credential-policy',
                    handle: async ({ originalRequest, effectiveRequest }) => {
                        seen.push(originalRequest, effectiveRequest);
                        return {
                            kind: 'allow',
                            request: {
                                headers: {
                                    set: { authorization: 'Bearer replacement' },
                                },
                            },
                        };
                    },
                },
            }],
        });

        await expect(service({
            url: 'https://api.example.test/status?token=secret&visible=yes',
            headers: {
                authorization: 'Bearer original',
                'x-user-id': 'user-1',
                'x-forwarded-for': '203.0.113.10',
                'x-forwarded-email': 'user@example.test',
                'x-real-ip': '203.0.113.11',
                accept: 'application/json',
            },
            body: {
                apiKey: 'secret',
                visible: true,
            },
        })).resolves.toMatchObject({
            body: {
                authorization: 'Bearer replacement',
                user: 'user-1',
                safe: 'application/json',
                url: 'https://api.example.test/status?token=secret&visible=yes',
                body: {
                    apiKey: 'secret',
                    visible: true,
                },
            },
        });

        expect(seen).toEqual([
            expect.objectContaining({
                url: 'https://api.example.test/status?token=%5Bredacted%5D&visible=yes',
                headers: expect.objectContaining({
                    authorization: '[redacted]',
                    'x-user-id': '[redacted]',
                    'x-forwarded-for': '[redacted]',
                    'x-forwarded-email': '[redacted]',
                    'x-real-ip': '[redacted]',
                    accept: 'application/json',
                }),
                body: {
                    apiKey: '[redacted]',
                    visible: true,
                },
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    authorization: '[redacted]',
                    'x-user-id': '[redacted]',
                    'x-forwarded-for': '[redacted]',
                    'x-forwarded-email': '[redacted]',
                    'x-real-ip': '[redacted]',
                    accept: 'application/json',
                }),
            }),
        ]);
    });

    it('redacts opaque string bodies before request-policy handlers observe them', async () => {
        const seenBodies: unknown[] = [];
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter: async (request) => createResponse(request.body),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'body-policy', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'body-policy',
                    handle: async ({ originalRequest, effectiveRequest }) => {
                        seenBodies.push(originalRequest.body, effectiveRequest.body);
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        await expect(service({
            url: 'https://api.example.test/token',
            headers: { 'content-type': 'application/json' },
            body: '{"access_token":"secret","visible":true}',
        })).resolves.toMatchObject({
            body: '{"access_token":"secret","visible":true}',
        });

        await expect(service({
            url: 'https://api.example.test/token',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'client_secret=secret&visible=yes',
        })).resolves.toMatchObject({
            body: 'client_secret=secret&visible=yes',
        });

        expect(seenBodies).toEqual([
            '[redacted]',
            '[redacted]',
            '[redacted]',
            '[redacted]',
        ]);
    });

    it('maps deny and thrown request-policy handlers to distinct host failures', async () => {
        const denied = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'deny', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'deny',
                    handle: async () => ({ kind: 'deny', code: 'policy_blocked' }),
                },
            }],
        });

        await expect(denied({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_DENIED',
        });

        const failed = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'throw', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'throw',
                    handle: async () => {
                        throw new Error('handler exploded');
                    },
                },
            }],
        });

        await expect(failed({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
    });

    it('classifies malformed request-policy results as interceptor failures', async () => {
        const malformed = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'malformed', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'malformed',
                    handle: async () => ({ kind: 'deny' }) as unknown as never,
                },
            }],
        });

        await expect(malformed({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
    });

    it('classifies invalid allow request patches as interceptor failures', async () => {
        const invalidPatch = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'invalid-patch', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'invalid-patch',
                    handle: async () => ({
                        kind: 'allow',
                        request: {
                            headers: {
                                set: { authorization: 42 },
                            },
                        },
                    }) as unknown as never,
                },
            }],
        });

        await expect(invalidPatch({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
    });

    it('classifies request body patches as invalid V1 policy results', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const bodyPatch = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'body-patch', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'body-patch',
                    handle: async () => ({
                        kind: 'allow',
                        request: {
                            body: 'mutated-body',
                        },
                    }) as unknown as never,
                },
            }],
        });

        await expect(bodyPatch({
            url: 'https://api.example.test/status',
            body: 'original-body',
        })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies response patches as invalid V1 policy results', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const responsePatch = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'response-patch', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'response-patch',
                    handle: async () => ({
                        kind: 'allow',
                        response: {
                            headers: {
                                set: { 'x-plugin': 'mutated' },
                            },
                        },
                    }) as unknown as never,
                },
            }],
        });

        await expect(responsePatch({
            url: 'https://api.example.test/status',
        })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not derive operation ids from raw request URLs or query strings', async () => {
        const operationIds: string[] = [];
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('ok'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'operation-policy', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'operation-policy',
                    handle: async ({ operation }) => {
                        operationIds.push(operation.id);
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        await service({ url: 'https://api.example.test/status?token=secret&visible=yes' });

        expect(operationIds).toHaveLength(1);
        expect(operationIds[0]).not.toContain('token=secret');
        expect(operationIds[0]).not.toContain('?');
        expect(operationIds[0]).toMatch(/^plugin-fetch:/);
    });

    it('skips the active interceptor during nested ctx.fetch recursion', async () => {
        const calls: string[] = [];
        let service: ReturnType<typeof createPluginFetchService>;
        const adapter = vi.fn(async (request) => {
            calls.push(`adapter:${request.url}`);
            return createResponse(request.url);
        });
        service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'self', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'self',
                    handle: async ({ effectiveRequest }) => {
                        calls.push(`interceptor:${effectiveRequest.url}`);
                        if (effectiveRequest.url.endsWith('/outer')) {
                            await service({ url: 'https://api.example.test/nested' });
                        }
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        await expect(service({ url: 'https://api.example.test/outer' })).resolves.toMatchObject({
            ok: true,
            status: 200,
        });

        expect(calls).toEqual([
            'interceptor:https://api.example.test/outer',
            'adapter:https://api.example.test/nested',
            'adapter:https://api.example.test/outer',
        ]);
    });

    it('keeps recursion protection scoped to the current logical request', async () => {
        const seen: string[] = [];
        let releaseFirst: () => void = () => undefined;
        let resolveFirstStarted: (() => void) | null = null;
        const firstStarted = new Promise<void>((resolve) => {
            resolveFirstStarted = resolve;
        });

        const adapter = vi.fn(async (request) => createResponse(request.url));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'self', targets: [{ scope: 'plugin-fetch' }] },
                registration: {
                    id: 'self',
                    handle: async ({ effectiveRequest }) => {
                        seen.push(effectiveRequest.url);
                        if (effectiveRequest.url.endsWith('/one')) {
                            resolveFirstStarted?.();
                            await new Promise<void>((resolveRelease) => {
                                releaseFirst = resolveRelease;
                            });
                        }
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        const first = service({ url: 'https://api.example.test/one' });
        await firstStarted;

        try {
            await expect(service({ url: 'https://api.example.test/two' }))
                .resolves
                .toMatchObject({ body: 'https://api.example.test/two' });
            expect(seen).toEqual([
                'https://api.example.test/one',
                'https://api.example.test/two',
            ]);
        } finally {
            releaseFirst();
        }
        await expect(first).resolves.toMatchObject({ body: 'https://api.example.test/one' });
    });

});
