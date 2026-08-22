import { describe, expect, it, vi } from 'vitest';

import {
    PluginHostAccessRequestV2Schema,
    type PluginRequestInterceptorContributionV1,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
    HttpService,
    PluginWebSocketClose,
    PluginWebSocketConnection,
} from '@happier-dev/plugin-sdk/http';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
    TargetPluginInterceptorResult as PluginInterceptorResult,
} from '../lifecycle/contributions/targetRequestInterceptors';
import { createLoggerAndEventsAvailablePluginInvocationServiceBinding } from '../invocation/services/factory';
import {
    createStablePluginHttpHost as createProductionStablePluginHttpHost,
    createPluginHttpService as createProductionPluginHttpService,
    isLiteralPrivateNetworkHostname,
    type PluginHttpRuntimeAdapter,
    type CreatePluginHttpServiceParams,
    type PluginRequestInterceptorRegistryV1,
} from './service';

type CanonicalFetchRequest = Parameters<HttpService['request']>[0];
type TestFetchRequest = Omit<CanonicalFetchRequest, 'body' | 'redirect'> & Readonly<{
    body?: unknown;
    redirect?: CanonicalFetchRequest['redirect'];
    signal?: AbortSignal;
    metadata?: Readonly<Record<string, unknown>>;
}>;
type TestFetchResponse = Awaited<ReturnType<HttpService['request']>>;
type TestFetchAdapter = (request: TestFetchRequest) => Promise<TestFetchResponse>;
type TestHttpServiceParams = Omit<CreatePluginHttpServiceParams, 'adapter'> & Readonly<{
    adapter?: TestFetchAdapter | null;
}>;

type TestWebSocketOpenInput = Readonly<{
    url: string;
    protocols?: readonly string[];
}>;
type WebSocketCapableHttpService = HttpService & Readonly<{
    openWebSocket(
        input: TestWebSocketOpenInput,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<unknown>;
}>;

type LegacyPolicyInput = Readonly<{
    originalRequest: TestFetchRequest;
    effectiveRequest: TestFetchRequest;
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

function createPluginHttpService(
    params: TestHttpServiceParams & Readonly<{ interceptors?: readonly LegacyTestInterceptor[] }>,
) {
    const { adapter, interceptors, interceptorRegistry, ...productionParams } = params;
    const service = createProductionPluginHttpService({
        ...productionParams,
        ...(adapter ? {
            adapter: Object.freeze({
                request: async (
                    request: CanonicalFetchRequest,
                    options: Parameters<HttpService['request']>[1] = {},
                ) => await adapter({
                    ...request,
                    signal: options.signal,
                }),
            }),
        } : {}),
        ...(interceptorRegistry
            ? { interceptorRegistry }
            : interceptors
                ? { interceptorRegistry: legacyInterceptorRegistry(interceptors) }
                : {}),
    });
    return async (request: TestFetchRequest, options: Readonly<{ signal?: AbortSignal }> = {}) => {
        const { body, metadata: _metadata, signal, redirect = 'error', ...input } = request;
        const encodedBody = body === undefined
            ? undefined
            : body instanceof Uint8Array
                ? body
                : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
        return await service.request({ ...input, ...(encodedBody ? { body: encodedBody } : {}), redirect }, {
            signal: options.signal ?? signal,
        });
    };
}

function createStablePluginHttpHost(
    params: Omit<Parameters<typeof createProductionStablePluginHttpHost>[0], 'adapter'> & Readonly<{
        adapter: TestFetchAdapter;
    }>,
) {
    return createProductionStablePluginHttpHost({
        ...params,
        adapter: Object.freeze({
            request: async (
                request: CanonicalFetchRequest,
                options: Parameters<HttpService['request']>[1] = {},
            ) => await params.adapter({
                ...request,
                signal: options.signal,
            }),
            async openWebSocket(): Promise<never> {
                throw new Error('WebSocket is unavailable in this HTTP request fixture');
            },
        }),
    });
}

function createResponse(body: unknown): TestFetchResponse {
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? ''));
    return Object.freeze({
        status: 200,
        finalUrl: 'https://api.example.test/result',
        headers: Object.freeze({}),
        body: bytes,
    });
}

describe('createPluginHttpService', () => {
    it('requires the exact network.client websocket grant instead of inheriting generic HTTP network authority', async () => {
        const connection: PluginWebSocketConnection = Object.freeze({
            url: 'wss://gateway.example.test/socket',
            protocol: 'gateway-v1',
            closed: Promise.resolve(Object.freeze({ kind: 'remote' as const, wasClean: true })),
            send: async () => undefined,
            receive: async () => Object.freeze({ kind: 'closed' as const, close: {
                kind: 'remote' as const,
                wasClean: true,
            } }),
            close: () => undefined,
            dispose: () => undefined,
        });
        const openWebSocket = vi.fn(async () => connection);
        const adapter = Object.freeze({
            request: async () => createResponse('unexpected HTTP request'),
            openWebSocket,
        }) as unknown as HttpService;
        const host = createProductionStablePluginHttpHost({ adapter });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'caller.plugin/actions/run' }),
            generation: 'generation-websocket',
            correlationId: 'correlation-websocket',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const httpOnly = host.bind(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-websocket',
            'binding-http-only',
            [{
                required: true,
                request: {
                    id: 'http-api',
                    capability: 'network',
                    reason: 'Call the HTTPS API',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                        methods: ['GET'],
                    },
                },
            }],
        )) as WebSocketCapableHttpService;
        const webSocket = host.bind(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-websocket',
            'binding-websocket',
            [{
                required: true,
                request: {
                    id: 'gateway',
                    capability: 'network.client',
                    reason: 'Maintain the declared gateway connection',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                        transports: ['websocket'],
                        privateNetwork: false,
                    },
                },
            }],
        )) as WebSocketCapableHttpService;

        await expect(httpOnly.openWebSocket({ url: 'wss://gateway.example.test/socket' }))
            .rejects.toMatchObject({ code: 'plugin_websocket_permission_denied' });
        await expect(webSocket.openWebSocket({ url: 'wss://gateway.example.test/socket' }))
            .resolves.toBe(connection);
        expect(openWebSocket).toHaveBeenCalledOnce();
    });

    it('admits loopback ws only through explicit network.client private-network intent', async () => {
        const connection: PluginWebSocketConnection = Object.freeze({
            url: 'ws://127.0.0.1:4311/socket',
            protocol: '',
            closed: Promise.resolve(Object.freeze({ kind: 'remote' as const, wasClean: true })),
            send: async () => undefined,
            receive: async () => Object.freeze({ kind: 'closed' as const, close: {
                kind: 'remote' as const,
                wasClean: true,
            } }),
            close: () => undefined,
            dispose: () => undefined,
        });
        const openWebSocket = vi.fn(async () => connection);
        const host = createProductionStablePluginHttpHost({
            adapter: Object.freeze({
                request: async () => createResponse('unexpected HTTP request'),
                openWebSocket,
            }),
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'loopback', qualifiedId: 'caller.plugin/actions/loopback' }),
            generation: 'generation-websocket-loopback',
            correlationId: 'correlation-websocket-loopback',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const bind = (id: string, origin: string, privateNetwork?: boolean) => host.bind(
            seed,
            createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                'generation-websocket-loopback',
                id,
                [{
                    required: true,
                    request: PluginHostAccessRequestV2Schema.parse({
                        id,
                        capability: 'network.client',
                        reason: 'Maintain the declared gateway connection',
                        scope: {
                            targets: [{ kind: 'fixedOrigin', origin }],
                            transports: ['websocket'],
                            ...(privateNetwork === true ? { privateNetwork: true } : {}),
                        },
                    }),
                }],
            ),
        );

        await expect(bind('loopback-allowed', 'http://127.0.0.1:4311', true).openWebSocket({
            url: 'ws://127.0.0.1:4311/socket',
        })).resolves.toBe(connection);
        await expect(bind('loopback-denied', 'http://127.0.0.1:4311').openWebSocket({
            url: 'ws://127.0.0.1:4311/socket',
        })).rejects.toMatchObject({ code: 'plugin_websocket_permission_denied' });
        await expect(bind('public-wss', 'https://gateway.example.test').openWebSocket({
            url: 'wss://gateway.example.test/socket',
        })).resolves.toBe(connection);

        expect(openWebSocket).toHaveBeenCalledTimes(2);
    });

    it('passes the immutable admitted WebSocket target to the adapter instead of rereading caller input', async () => {
        const connection: PluginWebSocketConnection = Object.freeze({
            url: 'wss://gateway.example.test/socket',
            protocol: '',
            closed: Promise.resolve(Object.freeze({ kind: 'remote' as const, wasClean: true })),
            send: async () => undefined,
            receive: async () => Object.freeze({ kind: 'closed' as const, close: {
                kind: 'remote' as const,
                wasClean: true,
            } }),
            close: () => undefined,
            dispose: () => undefined,
        });
        let adapterInput: Parameters<HttpService['openWebSocket']>[0] | null = null;
        const host = createProductionStablePluginHttpHost({
            adapter: Object.freeze({
                request: async () => createResponse('unexpected HTTP request'),
                async openWebSocket(input) {
                    adapterInput = input;
                    return connection;
                },
            }),
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'snapshot', qualifiedId: 'caller.plugin/actions/snapshot' }),
            generation: 'generation-websocket-snapshot',
            correlationId: 'correlation-websocket-snapshot',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const service = host.bind(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-websocket-snapshot',
            'binding-websocket-snapshot',
            [{
                required: true,
                request: {
                    id: 'gateway',
                    capability: 'network.client',
                    reason: 'Maintain the declared gateway connection',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                        transports: ['websocket'],
                        privateNetwork: false,
                    },
                },
            }],
        ));
        let reads = 0;
        const mutableInput = Object.defineProperty({}, 'url', {
            enumerable: true,
            get: () => {
                reads += 1;
                return reads <= 3
                    ? 'wss://gateway.example.test/socket'
                    : 'wss://unadmitted.example.test/socket';
            },
        }) as Parameters<HttpService['openWebSocket']>[0];

        await expect(service.openWebSocket(mutableInput)).resolves.toBe(connection);

        expect(Object.isFrozen(adapterInput)).toBe(true);
        expect(adapterInput).toEqual({ url: 'wss://gateway.example.test/socket' });
        await expect(service.openWebSocket(null as unknown as Parameters<HttpService['openWebSocket']>[0]))
            .rejects.toMatchObject({ code: 'plugin_websocket_invalid_url' });
    });

    it('maps exact configured-origin revocation during a pending socket open to the canonical retirement error', async () => {
        let markOpenStarted!: () => void;
        const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
        const adapter: PluginHttpRuntimeAdapter = Object.freeze({
            request: async () => createResponse('unexpected HTTP request'),
            openWebSocket: async (_input, options = {}) => await new Promise<never>((_resolve, reject) => {
                markOpenStarted();
                options.lifecycleSignal?.addEventListener('abort', () => {
                    reject(new PluginError({
                        code: 'plugin_websocket_lifecycle_closed',
                        message: 'The adapter observed its host lifecycle signal',
                    }));
                }, { once: true });
            }),
        });
        const revocation = new AbortController();
        const host = createProductionStablePluginHttpHost({ adapter });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'pending-open', qualifiedId: 'caller.plugin/actions/pending-open' }),
            generation: 'generation-pending-open',
            correlationId: 'correlation-pending-open',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const binding = Object.freeze({
            ...createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                'generation-pending-open',
                'binding-pending-open',
                [{
                    required: true,
                    request: {
                        id: 'gateway',
                        capability: 'network.client' as const,
                        reason: 'Maintain the declared gateway connection',
                        scope: {
                            targets: [{ kind: 'fixedOrigin' as const, origin: 'https://gateway.example.test' }],
                            transports: ['websocket' as const],
                            privateNetwork: false,
                        },
                    },
                }],
            ),
            networkCurrentness: () => true,
            networkRevocationSignal: revocation.signal,
        });
        const opening = host.bind(seed, binding).openWebSocket({ url: 'wss://gateway.example.test/socket' });
        await openStarted;
        revocation.abort(Object.freeze({ kind: 'configurationReplaced' as const }));

        await expect(opening).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
    });

    it('revokes only the exact configured-origin socket and composes with caller, generation, and remote closure', async () => {
        type OpenedConnection = Readonly<{
            connection: PluginWebSocketConnection;
            terminal(): PluginWebSocketClose | null;
            lifecycleAbortCalls(): number;
            closeRemote(): void;
        }>;
        const opened: OpenedConnection[] = [];
        const adapter: PluginHttpRuntimeAdapter = Object.freeze({
            request: async () => createResponse('unexpected HTTP request'),
            async openWebSocket(_input, options = {}) {
                let terminal: PluginWebSocketClose | null = null;
                let lifecycleAbortCalls = 0;
                let resolveClosed!: (close: PluginWebSocketClose) => void;
                const closed = new Promise<PluginWebSocketClose>((resolve) => { resolveClosed = resolve; });
                const finish = (close: PluginWebSocketClose) => {
                    if (terminal) return;
                    terminal = close;
                    resolveClosed(close);
                };
                const onLifecycleAbort = () => {
                    lifecycleAbortCalls += 1;
                    const reason = options.lifecycleSignal?.reason;
                    const kind = (
                        reason
                        && typeof reason === 'object'
                        && 'kind' in reason
                        && (reason.kind === 'generationRetired' || reason.kind === 'hostShutdown')
                    )
                        ? reason.kind
                        : 'aborted' as const;
                    finish(Object.freeze({ kind, wasClean: false }));
                };
                const onCallerAbort = () => {
                    finish(Object.freeze({ kind: 'aborted' as const, wasClean: false }));
                };
                options.lifecycleSignal?.addEventListener('abort', onLifecycleAbort, { once: true });
                options.signal?.addEventListener('abort', onCallerAbort, { once: true });
                const connection: PluginWebSocketConnection = Object.freeze({
                    url: 'wss://gateway.example.test/socket',
                    protocol: 'gateway-v1',
                    closed,
                    async send() {
                        if (terminal) throw new Error('WebSocket is closed');
                    },
                    async receive() {
                        return terminal
                            ? Object.freeze({ kind: 'closed' as const, close: terminal })
                            : Object.freeze({ kind: 'text' as const, text: 'still-open' });
                    },
                    close() {
                        finish(Object.freeze({ kind: 'local' as const, wasClean: false }));
                    },
                    dispose() {
                        finish(Object.freeze({ kind: 'local' as const, wasClean: false }));
                    },
                });
                opened.push(Object.freeze({
                    connection,
                    terminal: () => terminal,
                    lifecycleAbortCalls: () => lifecycleAbortCalls,
                    closeRemote() {
                        finish(Object.freeze({ kind: 'remote' as const, wasClean: true }));
                    },
                }));
                return connection;
            },
        });
        const host = createProductionStablePluginHttpHost({ adapter });
        const createBinding = (id: string, networkRevocationSignal: AbortSignal) => Object.freeze({
            ...createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                'generation-websocket',
                id,
                [{
                    required: true,
                    request: {
                        id,
                        capability: 'network.client' as const,
                        reason: 'Maintain the declared gateway connection',
                        scope: {
                            targets: [{ kind: 'fixedOrigin' as const, origin: 'https://gateway.example.test' }],
                            transports: ['websocket' as const],
                            privateNetwork: false,
                        },
                    },
                }],
            ),
            networkCurrentness: () => true,
            networkRevocationSignal,
        });
        const createSeed = (
            id: string,
            signal: AbortSignal,
            isGenerationCurrent: () => boolean = () => true,
        ) => Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id, qualifiedId: `caller.plugin/actions/${id}` }),
            generation: 'generation-websocket',
            correlationId: id,
            surface: 'agent' as const,
            signal,
            isGenerationCurrent,
        });

        const configurationA = new AbortController();
        const configurationB = new AbortController();
        const serviceA = host.bind(
            createSeed('configured-a', new AbortController().signal),
            createBinding('configured-a', configurationA.signal),
        );
        const serviceB = host.bind(
            createSeed('configured-b', new AbortController().signal),
            createBinding('configured-b', configurationB.signal),
        );
        const connectionA = await serviceA.openWebSocket({ url: 'wss://gateway.example.test/socket' });
        const connectionB = await serviceB.openWebSocket({ url: 'wss://gateway.example.test/socket' });

        configurationA.abort(Object.freeze({ kind: 'configurationReplaced' as const }));
        expect(opened[0]?.terminal()).toMatchObject({ kind: 'aborted', wasClean: false });
        expect(opened[1]?.terminal()).toBeNull();
        await expect(connectionA.closed).resolves.toMatchObject({ kind: 'aborted', wasClean: false });
        await expect(connectionA.send({ kind: 'text', text: 'after-revocation' })).rejects.toThrow(/closed/i);
        await expect(connectionA.receive()).resolves.toMatchObject({ kind: 'closed' });
        await expect(connectionB.send({ kind: 'text', text: 'unrelated-binding' })).resolves.toBeUndefined();
        await expect(connectionB.receive()).resolves.toEqual({ kind: 'text', text: 'still-open' });

        const callerAbort = new AbortController();
        const caller = await host.bind(
            createSeed('caller-abort', new AbortController().signal),
            createBinding('caller-abort', new AbortController().signal),
        ).openWebSocket({ url: 'wss://gateway.example.test/socket' }, { signal: callerAbort.signal });
        callerAbort.abort();
        await expect(caller.closed).resolves.toMatchObject({ kind: 'aborted', wasClean: false });

        let generationCurrent = true;
        const generationAbort = new AbortController();
        const generation = await host.bind(
            createSeed('generation-retired', generationAbort.signal, () => generationCurrent),
            createBinding('generation-retired', new AbortController().signal),
        ).openWebSocket({ url: 'wss://gateway.example.test/socket' });
        generationCurrent = false;
        generationAbort.abort();
        await expect(generation.closed).resolves.toMatchObject({ kind: 'generationRetired', wasClean: false });

        const remoteConfiguration = new AbortController();
        const remote = await host.bind(
            createSeed('remote-close', new AbortController().signal),
            createBinding('remote-close', remoteConfiguration.signal),
        ).openWebSocket({ url: 'wss://gateway.example.test/socket' });
        const remoteRecord = opened.at(-1)!;
        remoteRecord.closeRemote();
        await expect(remote.closed).resolves.toMatchObject({ kind: 'remote', wasClean: true });
        await Promise.resolve();
        remoteConfiguration.abort(Object.freeze({ kind: 'configurationReplaced' as const }));
        expect(remoteRecord.lifecycleAbortCalls()).toBe(0);
    });

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
        const adapter = vi.fn(async (request: TestFetchRequest) => Object.freeze({
            ...createResponse(null),
            status: request.url.endsWith('/start') ? 302 : 200,
            headers: request.url.endsWith('/start')
                ? Object.freeze({ location: 'https://next.example.test/result' })
                : Object.freeze({}),
            finalUrl: request.url,
        }));
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const revalidateFinalPolicy = vi.fn(async () => {});
        const host = createStablePluginHttpHost({
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

    it('redacts an invocation secret in an interceptor URL and withholds the body without changing terminal I/O', async () => {
        const token = '123456:telegram-secret';
        const rawUrl = `https://api.telegram.org/bot${token}/getMe`;
        const body = new TextEncoder().encode('chat text must remain terminal-only');
        const adapter = vi.fn(async (request: TestFetchRequest) => {
            expect(request.url).toBe(rawUrl);
            expect(request.body).toEqual(body);
            return createResponse('ok');
        });
        const interceptor = vi.fn(async (_input: LegacyPolicyInput) => ({ kind: 'allow' as const }));
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: { id: 'observe', origins: ['https://api.telegram.org'] },
                registration: { id: 'observe', handle: interceptor },
            }]),
            redactInterceptorText: ({ value }) => value.replace(token, '[REDACTED]'),
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-redacted-path', [{
            required: true,
            request: {
                id: 'telegram-api', capability: 'network', reason: 'Telegram API access',
                scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.telegram.org' }], methods: ['POST'] },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'correlation-redacted-path', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: rawUrl,
            method: 'POST',
            body,
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });

        const intercepted = interceptor.mock.calls[0]?.[0].originalRequest;
        expect(intercepted).toMatchObject({
            url: 'https://api.telegram.org/bot[REDACTED]/getMe',
        });
        expect(intercepted?.body).toBeUndefined();
        expect(intercepted?.url).not.toContain(token);
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('refuses an interceptor URL mutation after an invocation secret was redacted from the path', async () => {
        const token = '123456:telegram-secret';
        const rawUrl = `https://api.telegram.org/bot${token}/getMe`;
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: { id: 'mutate', origins: ['https://api.telegram.org'] },
                registration: {
                    id: 'mutate',
                    handle: async ({ effectiveRequest }) => ({
                        kind: 'allow',
                        request: { url: `${effectiveRequest.url}?audit=1` },
                    }),
                },
            }]),
            redactInterceptorText: ({ value }) => value.replace(token, '[REDACTED]'),
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-redacted-path-mutation', [{
            required: true,
            request: {
                id: 'telegram-api', capability: 'network', reason: 'Telegram API access',
                scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.telegram.org' }], methods: ['GET'] },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'correlation-redacted-path-mutation', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: rawUrl,
            method: 'GET',
            redirect: 'error',
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('fails closed if invocation URL redaction fails before interceptor dispatch', async () => {
        const token = '123456:telegram-secret';
        const rawUrl = `https://api.telegram.org/bot${token}/getMe`;
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: { id: 'observe', origins: ['https://api.telegram.org'] },
                registration: { id: 'observe', handle: interceptor },
            }]),
            redactInterceptorText: () => {
                throw new Error(token);
            },
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-redaction-failure', [{
            required: true,
            request: {
                id: 'telegram-api', capability: 'network', reason: 'Telegram API access',
                scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.telegram.org' }], methods: ['GET'] },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'correlation-redaction-failure', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        let failure: unknown;
        try {
            await service.request({ url: rawUrl, method: 'GET', redirect: 'error' });
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(String(failure)).not.toContain(token);
        expect(interceptor).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('enforces a bound host deadline when a terminal adapter never settles', async () => {
        const adapter = vi.fn(async () => await new Promise<TestFetchResponse>(() => undefined));
        const host = createStablePluginHttpHost({ adapter });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('generation-7', 'binding-never-settles', [{
            required: true,
            request: {
                id: 'telegram-api', capability: 'network', reason: 'Telegram API access',
                scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.telegram.org' }], methods: ['GET'] },
            },
        }]);
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'correlation-never-settles', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.telegram.org/slow',
            method: 'GET',
            timeoutMs: 5,
            redirect: 'error',
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('applies current installation-wide interceptor policy while retaining private callback separation', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://api.example.test/status',
        }));
        const interceptor = vi.fn(async () => ({
            kind: 'deny' as const,
            code: 'current_callback_must_not_run',
        }));
        const revalidateFinalPolicy = vi.fn(async () => {
            throw new Error('current policy callback must not run');
        });
        const credentialBindingHost = {
            request: vi.fn(async () => {
                throw new Error('current credential callback must not run');
            }),
        };
        const host = createStablePluginHttpHost({
            adapter,
            revalidateFinalPolicy,
            credentialBindingHost,
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-g',
            'binding-retained',
            [{
                required: true,
                request: {
                    id: 'api',
                    capability: 'network',
                    reason: 'Retained API access',
                    scope: {
                        targets: [{
                            kind: 'fixedOrigin',
                            origin: 'https://api.example.test',
                        }],
                        methods: ['GET'],
                    },
                },
            }],
        );
        const service = host.bind({
            plugin: { id: 'retained.plugin', version: '1.0.0' },
            contribution: {
                id: 'run',
                qualifiedId: 'retained.plugin/agents/run',
            },
            generation: 'generation-g',
            correlationId: 'correlation-retained',
            surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding, {
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'current.policy',
                contribution: {
                    id: 'deny',
                    origins: ['https://api.example.test'],
                },
                registration: {
                    id: 'deny',
                    handle: interceptor,
                },
            }]),
            revalidateFinalPolicy: null,
            credentialBindingHost: null,
        });

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_denied',
        });
        expect(adapter).not.toHaveBeenCalled();
        expect(interceptor).toHaveBeenCalledOnce();
        expect(revalidateFinalPolicy).not.toHaveBeenCalled();
        expect(credentialBindingHost.request).not.toHaveBeenCalled();
    });

    it('revalidates connected-account configuration currentness before terminal I/O', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://api.example.test/status',
        }));
        const host = createStablePluginHttpHost({ adapter });
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

    it('keeps exact selected-resource network scopes enforceable', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://selected.example.test/status',
        }));
        const host = createStablePluginHttpHost({ adapter });
        const baseBinding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-7',
            'binding-selected-resource',
            [{
                required: true,
                request: {
                    id: 'account-origin',
                    capability: 'network',
                    reason: 'Selected Connected Account origin',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://selected.example.test' }],
                        methods: ['GET'],
                    },
                },
            }],
        );
        const binding = Object.freeze({
            ...baseBinding,
            networkScopes: Object.freeze([Object.freeze({
                authority: 'selectedResource' as const,
                accessId: 'account-origin',
                required: true,
                origins: Object.freeze(['https://selected.example.test']),
                methods: Object.freeze(['GET' as const]),
                privateNetwork: false,
            })]),
        });
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            generation: 'generation-7', correlationId: 'selected-resource', surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://outside.example.test/status',
            method: 'GET',
            redirect: 'error',
        })).rejects.toMatchObject({ code: 'plugin_final_resource_not_selected' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('revalidates connected-account configuration currentness before every retry attempt', async () => {
        const adapter = vi.fn(async () => {
            throw Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
        });
        const host = createStablePluginHttpHost({
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

    it('binds the stable HTTP service and denies an interceptor-rewritten method before terminal I/O', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://api.example.test/result',
            headers: Object.freeze({ 'content-type': 'text/plain' }),
            arrayBuffer: async () => new Uint8Array([111, 107]).buffer,
        }));
        const revalidateFinalPolicy = vi.fn(async (effect: Readonly<{
            request: TestFetchRequest;
        }>) => {
            if (effect.request.method === 'POST') {
                throw new PluginError({
                    code: 'plugin_final_resource_not_selected',
                    message: 'Method was not selected',
                });
            }
        });
        const host = createStablePluginHttpHost({
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
        expect(revalidateFinalPolicy).toHaveBeenCalledTimes(2);
        expect(revalidateFinalPolicy).toHaveBeenLastCalledWith(expect.objectContaining({
            request: expect.objectContaining({ method: 'POST' }),
        }));
    });

    it('removes invocation abort listeners after a completed stable request', async () => {
        const invocationAbort = new AbortController();
        const requestAbort = new AbortController();
        const addEventListener = vi.spyOn(invocationAbort.signal, 'addEventListener');
        const removeEventListener = vi.spyOn(invocationAbort.signal, 'removeEventListener');
        const host = createStablePluginHttpHost({
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
        const adapter = vi.fn(async (request: TestFetchRequest) => Object.freeze({
            ...createResponse(request.url),
            finalUrl: request.url,
            arrayBuffer: async () => new ArrayBuffer(0),
        }));
        let nestedService: ReturnType<ReturnType<typeof createStablePluginHttpHost>['bind']>;
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
        const host = createStablePluginHttpHost({
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
        const adapter = vi.fn(async (request: TestFetchRequest) => {
            activationOrder.push('adapter');
            return createResponse(request.headers?.['x-demanded']);
        });
        const service = createPluginHttpService({
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
        } as Parameters<typeof createPluginHttpService>[0] & Readonly<Record<string, unknown>>);

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'GET',
            headers: {},
        })).resolves.toMatchObject({ body: new TextEncoder().encode('yes') });

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
        const service = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
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
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [{ pluginId: 'owner.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{ pluginId: 'borrower.policy', contribution, invoke: borrowed }],
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
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
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [binding, binding],
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(invoke).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects a body supplied by a request-policy interceptor', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'body',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: async (request): Promise<PluginInterceptorResult> => {
                        return {
                            decision: 'continue',
                            request: { ...request, body: new Uint8Array([9, 2, 3]) },
                        } as unknown as PluginInterceptorResult;
                    },
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'POST',
            body: new Uint8Array([1, 2, 3]),
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects an interceptor result that declares even an undefined body field', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'body-shape',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: async (request) => ({
                        decision: 'continue',
                        request: { ...request, body: undefined },
                    }) as PluginInterceptorResult,
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'POST',
            body: new Uint8Array([1, 2, 3]),
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('reports unavailable host transport without describing it as a permission denial', async () => {
        const service = createPluginHttpService({
        });

        const failure = await service({ url: 'https://example.test/blocked' }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_fetch_adapter_unavailable',
        });
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
        const service = createPluginHttpService({
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
        })).resolves.toMatchObject({ status: 200 });

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
        const service = createPluginHttpService({
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
        const service = createPluginHttpService({
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

    it('diagnoses a narrower URL-origin disclosure and continues to the adapter', async () => {
        const adapter = vi.fn(async () => createResponse('ok'));
        const mismatches: unknown[] = [];
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            recordDisclosureMismatch(mismatch) {
                mismatches.push(mismatch);
                throw new Error('diagnostic sink failed');
            },
        });

        await expect(service({ url: 'https://blocked.example.test/status' })).resolves.toMatchObject({ status: 200 });
        expect(mismatches).toEqual([{
            capability: 'network',
            origin: 'https://blocked.example.test',
            method: 'GET',
        }]);
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('diagnoses an absent URL-origin disclosure and continues to the adapter', async () => {
        const adapter = vi.fn(async () => createResponse('ok'));
        const mismatches: unknown[] = [];
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: [],
            recordDisclosureMismatch: (mismatch) => { mismatches.push(mismatch); },
        });

        await expect(service({ url: 'https://api.example.test/status' })).resolves.toMatchObject({ status: 200 });
        expect(mismatches).toEqual([{
            capability: 'network',
            origin: 'https://api.example.test',
            method: 'GET',
        }]);
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('rejects interceptor rewrites to undeclared URL origins before adapter execution', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const service = createPluginHttpService({
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
            code: 'plugin_fetch_url_scope_denied',
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
        const service = createPluginHttpService({
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
        const service = createPluginHttpService({
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

    it('retries transient adapter failures while keeping attempt state host-private', async () => {
        const attempts: number[] = [];
        const adapter = vi.fn(async () => {
            if (adapter.mock.calls.length === 1) {
                throw Object.assign(new Error('temporarily unavailable'), {
                    code: 'ETIMEDOUT',
                });
            }
            return createResponse('ok');
        });
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://example.test'],
            retry: {
                maxAttempts: 2,
                baseDelayMs: 0,
            },
            revalidateFinalPolicy: ({ attempt }) => {
                attempts.push(attempt);
            },
        });

        await expect(service({ url: 'https://example.test/retry' })).resolves.toBeDefined();
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(attempts).toEqual([1, 2]);
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
        const service = createPluginHttpService({
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

        await expect(service({ url: 'https://example.test/retry' }))
            .resolves.toMatchObject({ body: new TextEncoder().encode('ok') });
        expect(order).toEqual([
            'policy:1:yes', 'adapter',
            'policy:2:yes', 'adapter',
        ]);
        expect(revalidateFinalPolicy).toHaveBeenCalledTimes(2);
    });

    it('does not reach the network when final policy is revoked after interception', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const denial = new PluginError({
            code: 'plugin_fetch_interceptor_denied',
            message: 'revoked',
        });
        const service = createPluginHttpService({
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
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            retry: { maxAttempts: 2 },
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'once', origins: ['https://api.example.test'] },
                registration: { id: 'once', handle: interceptor },
            }],
        });

        await expect(service({ url: 'https://api.example.test/data' }))
            .resolves.toMatchObject({ body: new TextEncoder().encode('ok') });
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(interceptor).toHaveBeenCalledTimes(1);
    });

    it('redacts the closed v1 security-sensitive header set from interceptor input and rejects credential replacement', async () => {
        const seen: TestFetchRequest[] = [];
        const adapter = vi.fn(async (request) => createResponse({
            authorization: request.headers?.authorization,
            user: request.headers?.['x-user-id'],
            safe: request.headers?.accept,
            url: request.url,
            body: request.body,
        }));
        const service = createPluginHttpService({
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
            url: [
                'https://api.example.test/status?token=secret&visible=yes',
                'authorization=authorization-secret&accessToken=access-token-secret',
                'refresh_token=refresh-token-secret&api_key=api-key-secret',
                'clientSecret=client-secret&password=password-secret&cookie=cookie-secret',
                'jwt=jwt-secret&private_key=private-key-secret&passphrase=passphrase-secret',
                'sessionCount=7&tokenCount=8&secretary=meeting-notes',
            ].join('&'),
            headers: {
                authorization: 'Bearer original',
                accessToken: 'access-token-secret',
                refresh_token: 'refresh-token-secret',
                apiKey: 'api-key-secret',
                client_secret: 'client-secret',
                password: 'password-secret',
                cookie: 'cookie-secret',
                jwt: 'jwt-secret',
                privateKey: 'private-key-secret',
                passphrase: 'passphrase-secret',
                sessionCount: 'seven-sessions',
                tokenCount: 'eight-tokens',
                secretary: 'meeting-notes',
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
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();

        expect(seen).toEqual([
            expect.objectContaining({
                url: expect.stringContaining('https://api.example.test/status?token=%5Bredacted%5D&visible=yes'),
                headers: expect.objectContaining({
                    authorization: '[redacted]',
                    cookie: '[redacted]',
                    'x-forwarded-for': '[redacted]',
                    'x-forwarded-email': '[redacted]',
                    'x-real-ip': '[redacted]',
                    'chatgpt-account-id': 'account-1',
                    'x-user-id': 'user-1',
                    accessToken: 'access-token-secret',
                    refresh_token: 'refresh-token-secret',
                    apiKey: 'api-key-secret',
                    client_secret: 'client-secret',
                    password: 'password-secret',
                    jwt: 'jwt-secret',
                    privateKey: 'private-key-secret',
                    passphrase: 'passphrase-secret',
                    accept: 'application/json',
                }),
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    authorization: '[redacted]',
                    cookie: '[redacted]',
                    'x-forwarded-for': '[redacted]',
                    'x-forwarded-email': '[redacted]',
                    'x-real-ip': '[redacted]',
                    'chatgpt-account-id': 'account-1',
                    'x-user-id': 'user-1',
                    accessToken: 'access-token-secret',
                    refresh_token: 'refresh-token-secret',
                    apiKey: 'api-key-secret',
                    client_secret: 'client-secret',
                    password: 'password-secret',
                    jwt: 'jwt-secret',
                    privateKey: 'private-key-secret',
                    passphrase: 'passphrase-secret',
                    accept: 'application/json',
                }),
            }),
        ]);

        const interceptorUrl = new URL(seen[0]?.url ?? 'https://invalid.test');
        for (const key of [
            'authorization',
            'accessToken',
            'refresh_token',
            'api_key',
            'clientSecret',
            'password',
            'cookie',
            'jwt',
            'private_key',
            'passphrase',
        ]) {
            expect(interceptorUrl.searchParams.get(key)).toBe('[redacted]');
        }
        for (const key of ['authorization', 'cookie']) {
            expect(seen[0]?.headers?.[key]).toBe('[redacted]');
        }
        expect(interceptorUrl.searchParams.get('sessionCount')).toBe('7');
        expect(interceptorUrl.searchParams.get('tokenCount')).toBe('8');
        expect(interceptorUrl.searchParams.get('secretary')).toBe('meeting-notes');
        expect(seen[0]?.headers).toMatchObject({
            sessionCount: 'seven-sessions',
            tokenCount: 'eight-tokens',
            secretary: 'meeting-notes',
        });
    });

    it('allows a matching trusted interceptor to inspect and rewrite caller headers outside the closed v1 set', async () => {
        const seen: TestFetchRequest[] = [];
        const adapter = vi.fn(async (request) => createResponse(request.headers?.['x-tenant-token'] ?? 'missing'));
        const service = createPluginHttpService({
            adapter,
            allowedUrlOrigins: ['https://api.example.test'],
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'tenant-policy', origins: ['https://api.example.test'] },
                registration: {
                    id: 'tenant-policy',
                    handle: async ({ effectiveRequest }) => {
                        seen.push(effectiveRequest);
                        return {
                            kind: 'allow',
                            request: {
                                headers: {
                                    set: {
                                        'x-tenant-token': 'tenant-rewritten-by-policy',
                                    },
                                },
                            },
                        };
                    },
                },
            }],
        });

        await expect(service({
            url: 'https://api.example.test/status',
            headers: {
                authorization: 'Bearer host-owned',
                'x-forwarded-for': '203.0.113.10',
                'x-tenant-token': 'tenant-caller-value',
            },
        })).resolves.toMatchObject({
            body: new TextEncoder().encode('tenant-rewritten-by-policy'),
        });

        expect(seen).toEqual([expect.objectContaining({
            headers: {
                authorization: '[redacted]',
                'x-forwarded-for': '[redacted]',
                'x-tenant-token': 'tenant-caller-value',
            },
        })]);
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            headers: {
                authorization: 'Bearer host-owned',
                'x-forwarded-for': '203.0.113.10',
                'x-tenant-token': 'tenant-rewritten-by-policy',
            },
        }));
    });

    it('withholds opaque request bodies from request-policy handlers without changing terminal bytes', async () => {
        const seenBodies: unknown[] = [];
        const service = createPluginHttpService({
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
            body: new TextEncoder().encode('{"access_token":"secret","visible":true}'),
        });

        await expect(service({
            url: 'https://api.example.test/token',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'client_secret=secret&visible=yes',
        })).resolves.toMatchObject({
            body: new TextEncoder().encode('client_secret=secret&visible=yes'),
        });

        expect(seenBodies).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('maps deny and thrown request-policy handlers to distinct host failures', async () => {
        const denied = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_denied',
        });

        const failed = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
        });
        await expect(failed({ url: 'https://api.example.test/status' })).rejects.not.toThrow('handler exploded');
    });

    it('rejects method rewrites outside the interceptor declaration', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies malformed request-policy results as interceptor failures', async () => {
        const malformed = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
        });
    });

    it('rejects a continued public request that omits its required method', async () => {
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'missing-method',
            origins: ['https://api.example.test'],
        };
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createPluginHttpService({
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
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies invalid allow request patches as interceptor failures', async () => {
        const invalidPatch = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
        });
    });

    it('classifies request body patches as invalid V1 policy results', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const bodyPatch = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies response patches as invalid V1 policy results', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const responsePatch = createPluginHttpService({
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
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not derive operation ids from raw request URLs or query strings', async () => {
        const operationIds: string[] = [];
        const service = createPluginHttpService({
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
        let service: ReturnType<typeof createPluginHttpService>;
        const adapter = vi.fn(async (request) => {
            calls.push(`adapter:${request.url}`);
            return createResponse(request.url);
        });
        service = createPluginHttpService({
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
        const service = createPluginHttpService({
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
                .toMatchObject({ body: new TextEncoder().encode('https://api.example.test/two') });
            expect(seen).toEqual([
                'https://api.example.test/one',
                'https://api.example.test/two',
            ]);
        } finally {
            releaseFirst();
        }
        await expect(first)
            .resolves.toMatchObject({ body: new TextEncoder().encode('https://api.example.test/one') });
    });

});
