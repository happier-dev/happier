import { describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeRequestV1, FetchRuntimeResponseV1 } from '@/plugins/runtime/exec/privateContract';
import type { PluginRequestInterceptorContributionV1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginInterceptedRequest, PluginInterceptorResult } from '@happier-dev/plugin-sdk/runtime';
import { createLoggerAndEventsAvailablePluginInvocationServiceBinding } from '../invocation/services/factory';
import {
    createStablePluginFetchHost,
    createPluginFetchService as createProductionPluginFetchService,
    isLiteralPrivateNetworkHostname,
    PluginFetchError,
    type CreatePluginFetchServiceParams,
    type PluginRequestInterceptorRegistryV1,
} from './service';

type LegacyPolicyInput = Readonly<{
    originalRequest: FetchRuntimeRequestV1;
    effectiveRequest: FetchRuntimeRequestV1;
    operation: Readonly<{ id: string; attempt: number }>;
}>;

type LegacyTestInterceptor = Readonly<{
    pluginId: string;
    contribution: PluginRequestInterceptorContributionV1;
    registration: Readonly<{
        id: string;
        handle(input: LegacyPolicyInput): unknown;
    }>;
}>;

function translateLegacyPolicyResult(
    request: PluginInterceptedRequest,
    result: unknown,
): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const record = result as Readonly<Record<string, unknown>>;
    if (record.decision === 'continue' || record.decision === 'deny') return result;
    if (record.kind === 'deny') return { decision: 'deny', code: record.code };
    if (record.kind !== 'allow' || Object.keys(record).some((key) => key !== 'kind' && key !== 'request')) return result;
    const patch = record.request;
    if (patch === undefined) return { decision: 'continue', request } satisfies PluginInterceptorResult;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return result;
    const patchRecord = patch as Readonly<Record<string, unknown>>;
    if (Object.keys(patchRecord).some((key) => !['url', 'method', 'headers'].includes(key))) return result;
    const headers = { ...request.headers };
    const headerPatch = patchRecord.headers;
    if (headerPatch && typeof headerPatch === 'object' && !Array.isArray(headerPatch)) {
        const headerRecord = headerPatch as Readonly<Record<string, unknown>>;
        for (const name of Array.isArray(headerRecord.remove) ? headerRecord.remove : []) {
            if (typeof name !== 'string') return result;
            for (const existing of Object.keys(headers)) {
                if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
            }
        }
        if (headerRecord.set && typeof headerRecord.set === 'object' && !Array.isArray(headerRecord.set)) {
            for (const [name, value] of Object.entries(headerRecord.set)) {
                if (typeof value !== 'string') return result;
                headers[name] = value;
            }
        }
    }
    return {
        decision: 'continue',
        request: {
            url: typeof patchRecord.url === 'string' ? patchRecord.url : request.url,
            method: typeof patchRecord.method === 'string' ? patchRecord.method : request.method,
            headers,
            ...(request.body ? { body: request.body } : {}),
        },
    };
}

function legacyInterceptorRegistry(
    interceptors: readonly LegacyTestInterceptor[],
): PluginRequestInterceptorRegistryV1 {
    return Object.freeze({
        declarations: Object.freeze(interceptors.map(({ pluginId, contribution }) => Object.freeze({ pluginId, contribution }))),
        activateContributionsOnDemand: async () => Object.freeze([]),
        readBindings: () => Object.freeze(interceptors.map((entry) => Object.freeze({
            pluginId: entry.pluginId,
            contribution: entry.contribution,
            invoke: async (request: PluginInterceptedRequest) => {
                const result = await entry.registration.handle({
                    originalRequest: request,
                    effectiveRequest: request,
                    operation: { id: 'plugin-fetch:test', attempt: 1 },
                });
                return translateLegacyPolicyResult(request, result) as PluginInterceptorResult;
            },
        }))),
    });
}

function createPluginFetchService(
    params: CreatePluginFetchServiceParams & Readonly<{ interceptors?: readonly LegacyTestInterceptor[] }>,
) {
    const { interceptors, interceptorRegistry, ...productionParams } = params;
    return createProductionPluginFetchService({
        ...productionParams,
        ...(interceptorRegistry
            ? { interceptorRegistry }
            : interceptors
                ? { interceptorRegistry: legacyInterceptorRegistry(interceptors) }
                : {}),
    });
}

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
    it('classifies only literal loopback and private IP hostnames as private-network targets', () => {
        expect([
            'localhost', 'api.localhost',
            '127.0.0.1', '10.2.3.4', '169.254.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.2',
            '::1', 'fc00::1', 'fd12::1', 'fe80::1', '[::1]',
        ].every(isLiteralPrivateNetworkHostname)).toBe(true);
        expect([
            'example.test', '172.15.255.255', '172.32.0.1', '192.0.2.1', '2001:db8::1',
        ].some(isLiteralPrivateNetworkHostname)).toBe(false);
    });

    it('exposes a manual 3xx and re-enters interceptors and final policy for an explicit next request', async () => {
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => Object.freeze({
            ...createResponse(null),
            status: request.url.endsWith('/start') ? 302 : 200,
            headers: request.url.endsWith('/start')
                ? Object.freeze({ location: 'https://next.example.test/result' })
                : Object.freeze({}),
            finalUrl: request.url,
        }));
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const revalidateFinalPolicy = vi.fn(async () => {});
        const host = createStablePluginFetchHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: {
                    id: 'observe',
                    origins: ['https://api.example.test', 'https://next.example.test'],
                },
                registration: { id: 'observe', handle: interceptor },
            }]),
            revalidateFinalPolicy,
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-redirect', [{
            required: true,
            request: {
                id: 'redirect-origins', capability: 'network', reason: 'Redirect destinations',
                scope: {
                    targets: [
                        { kind: 'fixedOrigin', origin: 'https://api.example.test' },
                        { kind: 'fixedOrigin', origin: 'https://next.example.test' },
                    ],
                    methods: ['GET'],
                },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'correlation-redirect', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        const first = await service.request({
            url: 'https://api.example.test/start', method: 'GET', redirect: 'manual',
        });
        expect(first).toMatchObject({
            status: 302,
            headers: { location: 'https://next.example.test/result' },
        });
        await expect(service.request({
            url: first.headers.location!, method: 'GET', redirect: 'manual',
        })).resolves.toMatchObject({ status: 200, finalUrl: 'https://next.example.test/result' });
        expect(interceptor).toHaveBeenCalledTimes(2);
        expect(revalidateFinalPolicy).toHaveBeenCalledTimes(2);
        expect(adapter).toHaveBeenCalledTimes(2);
    });

    it('revalidates connected-account configuration currentness before terminal I/O', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://api.example.test/status',
        }));
        const host = createStablePluginFetchHost({ adapter });
        const baseBinding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-7',
            'binding-connected-account',
            [{
                required: true,
                request: {
                    id: 'api',
                    capability: 'network',
                    reason: 'API access',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
                        methods: ['GET'],
                    },
                },
            }],
        );
        const binding = Object.freeze({
            ...baseBinding,
            networkCurrentness: () => false,
        }) as typeof baseBinding;
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7',
            correlationId: 'correlation-connected-account',
            surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        })).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('revalidates connected-account configuration currentness before every retry attempt', async () => {
        const adapter = vi.fn(async () => {
            throw Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
        });
        const host = createStablePluginFetchHost({
            adapter,
            retry: { maxAttempts: 2, baseDelayMs: 0 },
        });
        let currentnessChecks = 0;
        const baseBinding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-7',
            'binding-connected-account-retry',
            [{
                required: true,
                request: {
                    id: 'api',
                    capability: 'network',
                    reason: 'API access',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
                        methods: ['GET'],
                    },
                },
            }],
        );
        const binding = Object.freeze({
            ...baseBinding,
            networkCurrentness: () => {
                currentnessChecks += 1;
                return currentnessChecks === 1;
            },
        }) as typeof baseBinding;
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7',
            correlationId: 'correlation-connected-account-retry',
            surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        })).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
        expect(currentnessChecks).toBe(2);
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('binds the stable fetch service and denies an interceptor-rewritten method before terminal I/O', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://api.example.test/result',
            headers: Object.freeze({ 'content-type': 'text/plain' }),
            arrayBuffer: async () => new Uint8Array([111, 107]).buffer,
        }));
        const revalidateFinalPolicy = vi.fn(async (effect: Readonly<{
            request: FetchRuntimeRequestV1;
        }>) => {
            if (effect.request.method === 'POST') {
                throw new PluginError({
                    code: 'plugin_final_resource_not_selected',
                    message: 'Method was not selected',
                });
            }
        });
        const host = createStablePluginFetchHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: { id: 'rewrite', origins: ['https://api.example.test'] },
                registration: {
                    id: 'rewrite',
                    handle: async ({ effectiveRequest }) => effectiveRequest.url.endsWith('/rewrite')
                        ? { kind: 'allow', request: { method: 'POST' } }
                        : { kind: 'allow' },
                },
            }]),
            revalidateFinalPolicy,
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-1', [{
            required: true,
            request: {
                id: 'api', capability: 'network', reason: 'API access',
                scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }], methods: ['GET'] },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'correlation-1', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET', redirect: 'error',
        })).resolves.toEqual({
            status: 200,
            finalUrl: 'https://api.example.test/result',
            headers: { 'content-type': 'text/plain' },
            body: new Uint8Array([111, 107]),
        });
        await expect(service.request({
            url: 'https://api.example.test/rewrite',
            method: 'GET', redirect: 'error',
        })).rejects.toMatchObject({ code: 'plugin_final_resource_not_selected' });
        await expect(service.request({
            url: 'https://api.example.test/redirect',
            method: 'GET', redirect: 'follow',
        })).rejects.toMatchObject({ code: 'plugin_fetch_redirect_follow_unavailable' });
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(revalidateFinalPolicy).toHaveBeenCalledTimes(1);
        expect(revalidateFinalPolicy).toHaveBeenLastCalledWith(expect.objectContaining({
            request: expect.objectContaining({ method: 'GET' }),
        }));
    });

    it('removes invocation abort listeners after a completed stable request', async () => {
        const invocationAbort = new AbortController();
        const requestAbort = new AbortController();
        const addEventListener = vi.spyOn(invocationAbort.signal, 'addEventListener');
        const removeEventListener = vi.spyOn(invocationAbort.signal, 'removeEventListener');
        const host = createStablePluginFetchHost({
            adapter: async () => Object.freeze({
                ...createResponse('ok'),
                finalUrl: 'https://api.example.test/status',
                arrayBuffer: async () => new Uint8Array([111, 107]).buffer,
            }),
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-listeners', [{
            required: true,
            request: {
                id: 'api',
                capability: 'network',
                reason: 'API access',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
                    methods: ['GET'],
                },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7',
            correlationId: 'correlation-listeners',
            surface: 'agent',
            signal: invocationAbort.signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        }, { signal: requestAbort.signal })).resolves.toMatchObject({ status: 200 });

        expect(addEventListener).toHaveBeenCalledTimes(1);
        expect(removeEventListener).toHaveBeenCalledTimes(1);
        expect(removeEventListener).toHaveBeenCalledWith(
            'abort',
            addEventListener.mock.calls[0]?.[1],
        );
    });

    it('keeps interceptor recursion fencing across independently bound stable services', async () => {
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => Object.freeze({
            ...createResponse(request.url),
            finalUrl: request.url,
            arrayBuffer: async () => new ArrayBuffer(0),
        }));
        let nestedService: ReturnType<ReturnType<typeof createStablePluginFetchHost>['bind']>;
        const invoke = vi.fn(async (request: PluginInterceptedRequest): Promise<PluginInterceptorResult> => {
            if (invoke.mock.calls.length > 1) {
                throw new Error('recursive interceptor invocation');
            }
            await nestedService.request({
                url: 'https://api.example.test/nested',
                method: 'GET',
                redirect: 'error',
            });
            return Object.freeze({ decision: 'continue', request });
        });
        const declaration: PluginRequestInterceptorContributionV1 = {
            id: 'shared',
            origins: ['https://api.example.test'],
        };
        const host = createStablePluginFetchHost({
            adapter,
            interceptorRegistry: Object.freeze({
                declarations: Object.freeze([
                    Object.freeze({ pluginId: 'acme.policy', contribution: declaration }),
                ]),
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => Object.freeze([
                    Object.freeze({
                        pluginId: 'acme.policy',
                        contribution: declaration,
                        invoke,
                    }),
                ]),
            }),
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-7',
            'binding-shared-recursion',
            [{
                required: true,
                request: {
                    id: 'api',
                    capability: 'network',
                    reason: 'API access',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
                        methods: ['GET'],
                    },
                },
            }],
        );
        const createSeed = (qualifiedId: string) => Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: qualifiedId.split('/').at(-1)!, qualifiedId }),
            generation: 'generation-7',
            correlationId: qualifiedId,
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        nestedService = host.bind(createSeed('caller.plugin/actions/nested'), binding);
        const outerService = host.bind(createSeed('caller.plugin/actions/outer'), binding);

        await expect(outerService.request({
            url: 'https://api.example.test/outer',
            method: 'GET',
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(adapter.mock.calls.map(([request]) => request.url)).toEqual([
            'https://api.example.test/nested',
            'https://api.example.test/outer',
        ]);
    });

    it('activates only matching qualified interceptor demand and re-reads bindings before dispatch', async () => {
        const activationOrder: string[] = [];
        const bindings: Array<{
            pluginId: string;
            generation: string;
            contribution: { id: string; origins: string[]; methods: ['GET']; priority: number };
            invoke(request: PluginInterceptedRequest): Promise<PluginInterceptorResult>;
        }> = [];
        const activateContributionsOnDemand = vi.fn(async (demands: readonly Readonly<{
            pluginId: string;
            family: string;
            localId: string;
        }>[]) => {
            activationOrder.push(`activate:${demands.map((demand) => demand.pluginId).join(',')}`);
            bindings.push({
                pluginId: 'matching.policy',
                generation: '7',
                contribution: {
                    id: 'rewrite',
                    origins: ['https://api.example.test'],
                    methods: ['GET'],
                    priority: 10,
                },
                invoke: async (request) => {
                    activationOrder.push('handler');
                    return {
                        decision: 'continue',
                        request: Object.freeze({
                            ...request,
                            headers: Object.freeze({ ...request.headers, 'x-demanded': 'yes' }),
                        }),
                    };
                },
            });
            return Object.freeze([]);
        });
        const adapter = vi.fn(async (request: FetchRuntimeRequestV1) => {
            activationOrder.push('adapter');
            return createResponse(request.headers?.['x-demanded']);
        });
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: Object.freeze([
                    {
                        pluginId: 'matching.policy',
                        contribution: {
                            id: 'rewrite',
                            origins: ['https://api.example.test'],
                            methods: ['GET'],
                            priority: 10,
                        },
                    },
                    {
                        pluginId: 'other.policy',
                        contribution: {
                            id: 'other',
                            origins: ['https://other.example.test'],
                            methods: ['GET'],
                            priority: 0,
                        },
                    },
                ]),
                activateContributionsOnDemand,
                readBindings: () => Object.freeze([...bindings]),
            },
        } as Parameters<typeof createPluginFetchService>[0] & Readonly<Record<string, unknown>>);

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'GET',
            headers: {},
        })).resolves.toMatchObject({ body: 'yes' });

        expect(activateContributionsOnDemand).toHaveBeenCalledWith([{
            pluginId: 'matching.policy',
            family: 'requestInterceptors',
            localId: 'rewrite',
        }]);
        expect(activationOrder).toEqual([
            'activate:matching.policy',
            'handler',
            'adapter',
        ]);
    });

    it('fails closed when exact qualified demand does not publish its declared binding', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: Object.freeze([{
                    pluginId: 'missing.policy',
                    contribution: { id: 'required', origins: ['https://api.example.test'] },
                }]),
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => Object.freeze([]),
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not borrow a same-local-id binding from another plugin', async () => {
        const borrowed = vi.fn(async (request: PluginInterceptedRequest): Promise<PluginInterceptorResult> => ({
            decision: 'continue',
            request,
        }));
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'shared',
            origins: ['https://api.example.test'],
        };
        const service = createProductionPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [{ pluginId: 'owner.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{ pluginId: 'borrower.policy', contribution, invoke: borrowed }],
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(borrowed).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects duplicate current bindings instead of applying interceptor effects twice', async () => {
        const invoke = vi.fn(async (request: PluginInterceptedRequest): Promise<PluginInterceptorResult> => ({
            decision: 'continue',
            request,
        }));
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'once',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const binding = { ...declaration, invoke };
        const service = createProductionPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [binding, binding],
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(invoke).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('detects in-place mutation of the public Uint8Array request body', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'body',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const service = createProductionPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: async (request): Promise<PluginInterceptorResult> => {
                        request.body![0] = 9;
                        return { decision: 'continue', request };
                    },
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'POST',
            body: new Uint8Array([1, 2, 3]),
        })).rejects.toMatchObject({ code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED' });
        expect(adapter).not.toHaveBeenCalled();
    });

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
                        priority: 20,
                        origins: ['https://example.test'],
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
                        priority: 10,
                        origins: ['https://example.test'],
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
                        priority: 10,
                        origins: ['https://example.test'],
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
                contribution: { id: 'never', origins: ['https://example.test'] },
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

    it('does not admit a late interceptor result after an in-flight request is aborted', async () => {
        const controller = new AbortController();
        let releaseInterceptor: (() => void) | undefined;
        let markInterceptorStarted: (() => void) | undefined;
        const interceptorStarted = new Promise<void>((resolve) => {
            markInterceptorStarted = resolve;
        });
        const interceptorRelease = new Promise<void>((resolve) => {
            releaseInterceptor = resolve;
        });
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'waiting',
            origins: ['https://example.test'],
        };
        const invoke = vi.fn(async (
            request: PluginInterceptedRequest,
            signal: AbortSignal | undefined,
        ): Promise<PluginInterceptorResult> => {
            expect(signal).toBe(controller.signal);
            markInterceptorStarted?.();
            await interceptorRelease;
            return { decision: 'continue', request };
        });
        const service = createProductionPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            interceptorRegistry: {
                declarations: [{ pluginId: 'acme.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{ pluginId: 'acme.policy', contribution, invoke }],
            },
        });

        const pending = service({
            url: 'https://example.test/waiting',
            signal: controller.signal,
        });
        await interceptorStarted;
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(adapter).not.toHaveBeenCalled();
        releaseInterceptor?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
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
                contribution: { id: 'rewrite', origins: ['https://api.example.test'] },
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

    it('revalidates current policy against the rewritten request immediately before every network attempt', async () => {
        const order: string[] = [];
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'rewrite', origins: ['https://example.test'], methods: ['GET'],
        };
        const adapter = vi.fn(async () => {
            order.push('adapter');
            if (adapter.mock.calls.length === 1) {
                throw Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
            }
            return createResponse('ok');
        });
        const revalidateFinalPolicy = vi.fn(async ({ request, attempt }) => {
            order.push(`policy:${attempt}:${request.headers?.['x-rewritten'] ?? 'missing'}`);
        });
        const service = createProductionPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            retry: { maxAttempts: 2 },
            revalidateFinalPolicy,
            interceptorRegistry: {
                declarations: [{ pluginId: 'acme.policy', contribution }],
                activateContributionsOnDemand: async () => {},
                readBindings: () => [{
                    pluginId: 'acme.policy', contribution,
                    invoke: async (request) => ({
                        decision: 'continue',
                        request: { ...request, headers: { ...request.headers, 'x-rewritten': 'yes' } },
                    }),
                }],
            },
        });

        await expect(service({ url: 'https://example.test/retry' })).resolves.toMatchObject({ body: 'ok' });
        expect(order).toEqual([
            'policy:1:yes', 'adapter',
            'policy:2:yes', 'adapter',
        ]);
        expect(revalidateFinalPolicy).toHaveBeenCalledTimes(2);
    });

    it('does not reach the network when final policy is revoked after interception', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const denial = new PluginFetchError('PLUGIN_FETCH_PERMISSION_DENIED', 'revoked');
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            revalidateFinalPolicy: async () => { throw denial; },
        });

        await expect(service({ url: 'https://example.test/data' })).rejects.toBe(denial);
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not duplicate interceptor effects when the terminal adapter retries', async () => {
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const adapter = vi.fn(async () => {
            if (adapter.mock.calls.length === 1) {
                throw Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
            }
            return createResponse('ok');
        });
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            retry: { maxAttempts: 2 },
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'once', origins: ['https://api.example.test'] },
                registration: { id: 'once', handle: interceptor },
            }],
        });

        await expect(service({ url: 'https://api.example.test/data' })).resolves.toMatchObject({ body: 'ok' });
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(interceptor).toHaveBeenCalledTimes(1);
    });

    it('redacts protected credentials from interceptor input and rejects credential replacement', async () => {
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
                contribution: { id: 'credential-policy', origins: ['https://api.example.test'] },
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
                'chatgpt-account-id': 'account-1',
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
        })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(adapter).not.toHaveBeenCalled();

        expect(seen).toEqual([
            expect.objectContaining({
                url: 'https://api.example.test/status?token=%5Bredacted%5D&visible=yes',
                headers: expect.objectContaining({
                    authorization: '[redacted]',
                    'chatgpt-account-id': '[redacted]',
                    'x-user-id': '[redacted]',
                    'x-forwarded-for': '[redacted]',
                    'x-forwarded-email': '[redacted]',
                    'x-real-ip': '[redacted]',
                    accept: 'application/json',
                }),
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    authorization: '[redacted]',
                    'chatgpt-account-id': '[redacted]',
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
                contribution: { id: 'body-policy', origins: ['https://api.example.test'] },
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
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });

    it('maps deny and thrown request-policy handlers to distinct host failures', async () => {
        const denied = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'deny', origins: ['https://api.example.test'] },
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
                contribution: { id: 'throw', origins: ['https://api.example.test'] },
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
        await expect(failed({ url: 'https://api.example.test/status' })).rejects.not.toThrow('handler exploded');
    });

    it('rejects method rewrites outside the interceptor declaration', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'get-only', origins: ['https://api.example.test'], methods: ['GET'] },
                registration: {
                    id: 'get-only',
                    handle: async () => ({ kind: 'allow', request: { method: 'POST' } }),
                },
            }],
        });

        await expect(service({ url: 'https://api.example.test/data', method: 'GET' })).rejects.toMatchObject({
            code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies malformed request-policy results as interceptor failures', async () => {
        const malformed = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'malformed', origins: ['https://api.example.test'] },
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

    it('rejects a continued public request that omits its required method', async () => {
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'missing-method',
            origins: ['https://api.example.test'],
        };
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createProductionPluginFetchService({
            networkAllowed: true,
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [{ pluginId: 'acme.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    pluginId: 'acme.policy',
                    contribution,
                    invoke: async (request) => ({
                        decision: 'continue',
                        request: {
                            url: request.url,
                            headers: request.headers,
                        },
                    }) as unknown as PluginInterceptorResult,
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/status',
            method: 'GET',
        })).rejects.toMatchObject({ code: 'PLUGIN_FETCH_INTERCEPTOR_FAILED' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies invalid allow request patches as interceptor failures', async () => {
        const invalidPatch = createPluginFetchService({
            networkAllowed: true,
            adapter: async () => createResponse('unused'),
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'invalid-patch', origins: ['https://api.example.test'] },
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
                contribution: { id: 'body-patch', origins: ['https://api.example.test'] },
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
                contribution: { id: 'response-patch', origins: ['https://api.example.test'] },
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
                contribution: { id: 'operation-policy', origins: ['https://api.example.test'] },
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
                contribution: { id: 'self', origins: ['https://api.example.test'] },
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
                contribution: { id: 'self', origins: ['https://api.example.test'] },
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
