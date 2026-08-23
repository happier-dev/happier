import { describe, expect, it, vi } from 'vitest';

import type {
    ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import {
    PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
    ProviderConnectionIdSchema,
} from '@happier-dev/protocol';

import type {
    ManagedDependenciesService,
    ManagedServiceHandle,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import type {
    ManagedProviderRuntimeContext,
    ManagedProviderStartRequest,
    ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';

import {
    RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
    RunnerManagedServicesCustodyRequestV1Schema,
    RunnerManagedServicesCustodyResultV1Schema,
    createRunnerManagedServicesClient,
    createRunnerManagedServicesCustodyPort as createProductionRunnerManagedServicesCustodyPort,
    registerRunnerManagedServicesCustodyRpcHandler,
    type RunnerManagedProviderCustodyClaimV1,
    type RunnerManagedProviderCustodyScopeV1,
    type RunnerManagedServicesCustodyDispatchV1,
} from './runnerManagedServicesCustody';
import {
    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS,
} from './managedServiceEndpointReadProtocol';
import {
    startPublicManagedProviderRuntime,
} from '@/providers/lifecycle/publicManagedProviderRuntimeStart';
import type { ResolvedManagedProviderRuntime } from '@/plugins/projection/registry/types';
import type { ManagedProviderEndpointHttpAccess } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import {
    createProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';

type TestRunnerManagedServicesCustodyPortInput = Omit<
    Parameters<typeof createProductionRunnerManagedServicesCustodyPort>[0],
    'readCurrentProviderImmutableGenerationIntegrityCurrentness'
> & Partial<Pick<
    Parameters<typeof createProductionRunnerManagedServicesCustodyPort>[0],
    'readCurrentProviderImmutableGenerationIntegrityCurrentness'
>>;

function createRunnerManagedServicesCustodyPort(
    input: TestRunnerManagedServicesCustodyPortInput,
) {
    return createProductionRunnerManagedServicesCustodyPort({
        ...input,
        readCurrentProviderImmutableGenerationIntegrityCurrentness:
            input
                .readCurrentProviderImmutableGenerationIntegrityCurrentness
            ?? (() => true),
    });
}

type CustodyRpcHandler = (
    raw: unknown,
    context?: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return Object.freeze({ promise, resolve });
}

function snapshot(id: string): ManagedServiceSnapshot {
    return Object.freeze({
        id,
        state: 'healthy',
        mode: 'attach',
        baseUrl: 'http://127.0.0.1:4312',
        startedAtMs: 1_000,
        lastHealthyAtMs: 1_001,
        diagnostics: Object.freeze([]),
        diagnosticsTruncated: false,
    });
}

function handle(id: string): ManagedServiceHandle {
    const current = snapshot(id);
    return Object.freeze({
        snapshot: () => current,
        observe: () => Object.freeze({ dispose() {} }),
        waitUntilHealthy: async () => current,
        request: async () => Object.freeze({
            ok: true,
            status: 204,
            statusText: 'No Content',
            headers: Object.freeze({}),
            body: null,
        }),
        stop: async () => Object.freeze({ status: 'stopped' as const }),
        async dispose() {},
    });
}

function sanitizedCleanupAggregate(errorCount: number) {
    return expect.objectContaining({
        code: 'plugin_managed_service_establishment_failed',
        errors: Array.from({ length: errorCount }, () =>
            expect.objectContaining({
                code: 'plugin_managed_service_establishment_failed',
                message: 'Runner managed-service cleanup failed',
            })),
    });
}

function managedRuntimeBindingBasis(
    pluginId: string,
    providerLocalId: string,
    connectionId: string,
): ProviderRuntimeBindingBasisV1 {
    return {
        v: 1,
        deployment: {
            kind: 'managedLocal',
            implementationIdentity: {
                pluginId,
                localId: providerLocalId,
            },
            managedRuntime: {
                kind: 'managed',
                dependencies: [],
                endpointTemplateIds: ['messages'],
                connectedAccounts: [],
                requestAuthUses: [],
            },
            purposeBindings: { v: 1, bindings: [] },
        },
        agentTargetKey: 'backend:claude',
        connectionId: ProviderConnectionIdSchema.parse(connectionId),
        contributionKey: `${pluginId}/${providerLocalId}`,
        endpoint: {
            endpointTemplateId: 'messages',
            protocol: 'anthropic',
            publicHeaders: {},
        },
        runtimeCredentialTransport: null,
        prepared: { v: 1, materialization: 'spawnEnv' },
        adapterVersion: 1,
        credentialAuthorization: {
            connectionSecurityFingerprint: 'connection-security',
            grantFingerprint: 'grant',
        },
        agentSupport: {
            acceptsProtocols: ['anthropic'],
            required: { streaming: true },
            credentialSupport: {
                supportsNoAuth: true,
                apiKeyTransports: [],
            },
            authIsolation: {
                suppressConnectedServiceIds: [],
                ownedEnvKeys: [],
            },
            materialization: 'spawnEnv',
            applyPolicy: 'restart_session',
            supportsFreeformModelIds: true,
        },
    };
}

function providerScope(
    sessionId: string,
    immutableGenerationId: string,
    manifestAuthority: 'external' | 'bundled_first_party' = 'external',
): RunnerManagedProviderCustodyScopeV1 {
    const pluginId = 'acme.providers';
    const providerLocalId = 'gateway';
    return Object.freeze({
        v: 1,
        sessionId,
        runtimeBindingBasis: managedRuntimeBindingBasis(
            pluginId,
            providerLocalId,
            `connection-${immutableGenerationId}`,
        ),
        pluginId,
        providerLocalId,
        activationGeneration: immutableGenerationId,
        immutableGenerationId,
        manifestAuthority,
        operationClaimId:
            `session-demand:${sessionId}:${immutableGenerationId}`,
    });
}

function providerClaim(
    scope: RunnerManagedProviderCustodyScopeV1,
): RunnerManagedProviderCustodyClaimV1 {
    return Object.freeze({ ...scope });
}

const spec = Object.freeze({
    id: 'provider-wrapper',
    mode: Object.freeze({
        kind: 'attach' as const,
        baseUrl: 'http://127.0.0.1:4312',
    }),
    healthCheck: Object.freeze({ kind: 'none' as const }),
}) satisfies ManagedServiceSpec;

function supervisionAdmission(
    services: ManagedServices,
    revision = 0,
) {
    return Object.freeze({
        services,
        providerPluginHardRevocationRevisionAtAdmission: revision,
    });
}

function registerCustodyHandler(
    runner: ReturnType<typeof createRunnerManagedServicesCustodyPort>,
): CustodyRpcHandler {
    let handler: CustodyRpcHandler | null = null;
    registerRunnerManagedServicesCustodyRpcHandler({
        registerHandler(_method, registered) {
            handler = registered as CustodyRpcHandler;
        },
    }, runner);
    if (!handler) throw new Error('custody RPC handler was not registered');
    return handler;
}

function jsonRpcDispatch(
    handler: CustodyRpcHandler,
) {
    return async (
        request: Parameters<ReturnType<
            typeof createRunnerManagedServicesCustodyPort
        >['dispatch']>[0],
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => await handler(
        JSON.parse(JSON.stringify(request)),
        options?.signal ? { signal: options.signal } : undefined,
    ) as Awaited<ReturnType<ReturnType<
        typeof createRunnerManagedServicesCustodyPort
    >['dispatch']>>;
}

describe('runner managed-services Provider custody', () => {
    it('accepts the approved public managed-service snapshot at the result wire boundary', () => {
        const scope = providerScope(
            'session-public-snapshot-wire',
            'provider-p',
        );

        expect(RunnerManagedServicesCustodyResultV1Schema.parse({
            v: 1,
            kind: 'handle',
            custodyScope: scope,
            snapshot: snapshot('gateway'),
        })).toEqual({
            v: 1,
            kind: 'handle',
            custodyScope: scope,
            snapshot: snapshot('gateway'),
        });
    });

    it('routes requests only to the exact custody handle and aborts them when currentness is fenced', async () => {
        let hardRevocationRevision = 0;
        let requestSignal: AbortSignal | undefined;
        const request = vi.fn(async (input: Parameters<
            ManagedServiceHandle['request']
        >[0]) => {
            requestSignal = input.signal;
            return Object.freeze({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: Object.freeze({
                    'content-type': 'text/event-stream',
                }),
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode('event: ready\n\n'),
                        );
                    },
                }),
            });
        });
        const service = Object.freeze({
            ...handle(spec.id),
            request,
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as ManagedDependenciesService,
                    supervise: async () => service,
                })),
            readCurrentProviderPluginHardRevocationRevision: () =>
                hardRevocationRevision,
        });
        const scope = providerScope(
            'session-exact-handle-request',
            'provider-p',
        );
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: {} as ManagedDependenciesService,
            dispatch: runner.dispatch,
        });
        await client.services.supervise(spec);

        const response = await runner.exactHandleRequestPort.request({
            claim: providerClaim(scope),
            serviceId: spec.id,
            request: {
                pathAndQuery: '/session/message?stream=true',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: new TextEncoder().encode('{"hello":true}'),
                timeoutMs: 10_000,
            },
        });
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0]?.[0]).toMatchObject({
            pathAndQuery: '/session/message?stream=true',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            timeoutMs: 10_000,
        });
        expect(new TextDecoder().decode(
            (await response.body!.getReader().read()).value,
        )).toBe('event: ready\n\n');

        await expect(runner.exactHandleRequestPort.request({
            claim: providerClaim(providerScope(
                'session-other-exact-handle',
                'provider-p',
            )),
            serviceId: spec.id,
            request: { pathAndQuery: '/session' },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(request).toHaveBeenCalledOnce();

        hardRevocationRevision = 1;
        await runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        });
        expect(requestSignal?.aborted).toBe(true);
        await expect(runner.exactHandleRequestPort.isCurrent({
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).resolves.toBe(false);
        await runner.dispose();
    });

    it('rejects an exact P request when hard revocation advances during its integrity check', async () => {
        let hardRevocationRevision = 0;
        let advanceDuringIntegrityCheck = false;
        const request = vi.fn(async () => Object.freeze({
            ok: true,
            status: 204,
            statusText: 'No Content',
            headers: Object.freeze({}),
            body: null,
        }));
        const service = Object.freeze({
            ...handle(spec.id),
            request,
        }) satisfies ManagedServiceHandle;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as ManagedDependenciesService,
                    supervise: async () => service,
                })),
            readCurrentProviderPluginHardRevocationRevision: () =>
                hardRevocationRevision,
            readCurrentProviderImmutableGenerationIntegrityCurrentness:
                async () => {
                    if (advanceDuringIntegrityCheck) {
                        await Promise.resolve();
                        hardRevocationRevision = 1;
                    }
                    return true;
                },
        });
        const scope = providerScope(
            'session-exact-p-final-hard-revocation',
            'provider-p',
        );
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: {} as ManagedDependenciesService,
            dispatch: runner.dispatch,
        });
        await client.services.supervise(spec);

        advanceDuringIntegrityCheck = true;
        await expect(runner.exactHandleRequestPort.request({
            claim: providerClaim(scope),
            serviceId: spec.id,
            request: { pathAndQuery: '/session' },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(request).not.toHaveBeenCalled();
        await expect(runner.exactHandleRequestPort.isCurrent({
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).resolves.toBe(false);
        await runner.dispose();
    });

    it('streams exact-handle responses and cancels on caller abort, iterator cancel, stop, and dispose', async () => {
        const scope = providerScope(
            'session-exact-handle-client',
            'provider-p',
        );
        const nextCountByRequest = new Map<string, number>();
        const cancel = vi.fn(async () => undefined);
        const endpointReadRpc = Object.freeze({
            async call(input: Readonly<{
                method: string;
                request: unknown;
                timeoutMs: number;
            }>) {
                const request = input.request as {
                    requestId: string;
                    route: unknown;
                };
                if (
                    input.method
                        === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
                ) {
                    expect(request.route).toMatchObject({
                        kind: 'exactHandle',
                        claim: providerClaim(scope),
                        serviceId: spec.id,
                    });
                    return {
                        v: 1,
                        requestId: request.requestId,
                        status: 'opened',
                        response: {
                            status: 200,
                            statusText: 'OK',
                            headers: [
                                ['content-type', 'text/event-stream'],
                            ],
                            hasBody: true,
                        },
                    };
                }
                if (
                    input.method
                        === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.NEXT
                ) {
                    const count = nextCountByRequest.get(request.requestId)
                        ?? 0;
                    nextCountByRequest.set(request.requestId, count + 1);
                    return count === 0
                        ? {
                            v: 1,
                            requestId: request.requestId,
                            status: 'chunk',
                            dataBase64: Buffer.from(
                                'event: ready\n\n',
                            ).toString('base64'),
                        }
                        : {
                            v: 1,
                            requestId: request.requestId,
                            status: 'end',
                        };
                }
                await cancel();
                return {
                    v: 1,
                    requestId: request.requestId,
                    status: 'cancelled',
                    cancelled: true,
                };
            },
        });
        const createDispatch = () => vi.fn(async (request: Parameters<
            ReturnType<typeof createRunnerManagedServicesCustodyPort>[
                'dispatch'
            ]
        >[0]) => {
            if (request.kind === 'adopt') {
                return {
                    v: 1 as const,
                    kind: 'handle' as const,
                    custodyScope: scope,
                    snapshot: snapshot(request.serviceId),
                };
            }
            if (request.kind === 'stop') {
                return {
                    v: 1 as const,
                    kind: 'stop' as const,
                    result: { status: 'detached' as const },
                    snapshot: Object.freeze({
                        ...snapshot(request.serviceId),
                        state: 'stopped' as const,
                    }),
                };
            }
            if (request.kind === 'dispose') {
                return { v: 1 as const, kind: 'disposed' as const };
            }
            throw new Error(`Unexpected custody request: ${request.kind}`);
        });
        const dispatch = createDispatch();
        const client = createRunnerManagedServicesClient({
            claim: providerClaim(scope),
            dependencies: {} as ManagedDependenciesService,
            dispatch,
            endpointReadRpc,
        });
        const service = await client.adopt(spec.id);

        const streamed = await service.request({
            pathAndQuery: '/events',
        });
        const streamedReader = streamed.body!.getReader();
        expect(new TextDecoder().decode(
            (await streamedReader.read()).value,
        )).toBe('event: ready\n\n');
        await expect(streamedReader.read()).resolves.toEqual({
            done: true,
            value: undefined,
        });

        const caller = new AbortController();
        await service.request({
            pathAndQuery: '/caller-abort',
            signal: caller.signal,
        });
        caller.abort();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

        const iterated = await service.request({
            pathAndQuery: '/iterator-cancel',
        });
        await iterated.body!.cancel();
        expect(cancel).toHaveBeenCalledTimes(2);

        await service.request({ pathAndQuery: '/stop-cancel' });
        await service.stop();
        expect(cancel).toHaveBeenCalledTimes(3);

        const disposeDispatch = createDispatch();
        const disposable = await createRunnerManagedServicesClient({
            claim: providerClaim(scope),
            dependencies: {} as ManagedDependenciesService,
            dispatch: disposeDispatch,
            endpointReadRpc,
        }).adopt(spec.id);
        await disposable.request({ pathAndQuery: '/dispose-cancel' });
        await disposable.dispose();
        expect(cancel).toHaveBeenCalledTimes(4);
        expect(disposeDispatch).toHaveBeenCalledWith({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        });
    });

    it('keeps a streamed exact-handle response readable beyond its establishment timeout while caller abort still cancels', async () => {
        vi.useFakeTimers();
        const scope = providerScope(
            'session-exact-handle-delayed-chunk',
            'provider-p',
        );
        const cancel = vi.fn(async () => undefined);
        let nextCount = 0;
        try {
            const endpointReadRpc = Object.freeze({
                async call(input: Readonly<{
                    method: string;
                    request: unknown;
                    timeoutMs: number;
                    signal?: AbortSignal;
                }>) {
                    const request = input.request as { requestId: string };
                    if (
                        input.method
                            === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
                    ) {
                        return {
                            v: 1,
                            requestId: request.requestId,
                            status: 'opened',
                            response: {
                                status: 200,
                                statusText: 'OK',
                                headers: [],
                                hasBody: true,
                            },
                        };
                    }
                    if (
                        input.method
                            === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.NEXT
                    ) {
                        expect(input.timeoutMs).toBe(2_147_483_647);
                        nextCount += 1;
                        return await new Promise<unknown>((resolve, reject) => {
                            const transportTimeout = setTimeout(
                                () => reject(new Error('RPC call timeout')),
                                input.timeoutMs,
                            );
                            const chunk = nextCount === 1
                                ? setTimeout(() => resolve({
                                    v: 1,
                                    requestId: request.requestId,
                                    status: 'chunk',
                                    dataBase64: Buffer.from('delayed')
                                        .toString('base64'),
                                }), 6_000)
                                : null;
                            const abort = (): void => {
                                clearTimeout(transportTimeout);
                                if (chunk) clearTimeout(chunk);
                                reject(input.signal?.reason);
                            };
                            input.signal?.addEventListener(
                                'abort',
                                abort,
                                { once: true },
                            );
                            if (input.signal?.aborted) abort();
                        });
                    }
                    await cancel();
                    return {
                        v: 1,
                        requestId: request.requestId,
                        status: 'cancelled',
                        cancelled: true,
                    };
                },
            });
            const dispatch: RunnerManagedServicesCustodyDispatchV1 =
                async (request) => {
                    if (request.kind === 'adopt') {
                        return {
                            v: 1,
                            kind: 'handle',
                            custodyScope: scope,
                            snapshot: snapshot(request.serviceId),
                        };
                    }
                    throw new Error(
                        `Unexpected custody request: ${request.kind}`,
                    );
                };
            const service = await createRunnerManagedServicesClient({
                claim: providerClaim(scope),
                dependencies: {} as ManagedDependenciesService,
                dispatch,
                endpointReadRpc,
            }).adopt(spec.id);
            const caller = new AbortController();
            const response = await service.request({
                pathAndQuery: '/events',
                timeoutMs: 1,
                signal: caller.signal,
            });
            const reader = response.body!.getReader();
            const delayed = reader.read().then(
                (value) => Object.freeze({ ok: true as const, value }),
                (error: unknown) => Object.freeze({
                    ok: false as const,
                    error,
                }),
            );

            await vi.advanceTimersByTimeAsync(6_000);

            await expect(delayed).resolves.toEqual({
                ok: true,
                value: {
                    done: false,
                    value: Buffer.from('delayed'),
                },
            });

            const pending = reader.read();
            caller.abort('caller canceled');
            await expect(pending).rejects.toBeDefined();
            await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts an in-flight exact-handle NEXT RPC before dispatching handle stop', async () => {
        const scope = providerScope(
            'session-exact-handle-in-flight-next',
            'provider-p',
        );
        const events: string[] = [];
        const nextSignalObserved = deferred<AbortSignal>();
        const endpointReadRpc = Object.freeze({
            async call(input: Readonly<{
                method: string;
                request: unknown;
                timeoutMs: number;
                signal?: AbortSignal;
            }>) {
                const request = input.request as { requestId: string };
                if (
                    input.method
                        === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
                ) {
                    return {
                        v: 1,
                        requestId: request.requestId,
                        status: 'opened',
                        response: {
                            status: 200,
                            statusText: 'OK',
                            headers: [],
                            hasBody: true,
                        },
                    };
                }
                if (
                    input.method
                        === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.NEXT
                ) {
                    if (!input.signal) {
                        throw new Error('Expected observe.next cancellation signal');
                    }
                    nextSignalObserved.resolve(input.signal);
                    return await new Promise<never>((_resolve, reject) => {
                        const abort = () => {
                            events.push('next-aborted');
                            reject(input.signal?.reason);
                        };
                        input.signal?.addEventListener(
                            'abort',
                            abort,
                            { once: true },
                        );
                        if (input.signal?.aborted) abort();
                    });
                }
                events.push('cancel');
                return {
                    v: 1,
                    requestId: request.requestId,
                    status: 'cancelled',
                    cancelled: true,
                };
            },
        });
        const dispatch: RunnerManagedServicesCustodyDispatchV1 =
            async (request) => {
                if (request.kind === 'adopt') {
                    return {
                        v: 1,
                        kind: 'handle',
                        custodyScope: scope,
                        snapshot: snapshot(request.serviceId),
                    };
                }
                if (request.kind === 'stop') {
                    events.push('stop');
                    return {
                        v: 1,
                        kind: 'stop',
                        result: { status: 'detached' },
                        snapshot: Object.freeze({
                            ...snapshot(request.serviceId),
                            state: 'stopped' as const,
                        }),
                    };
                }
                throw new Error(
                    `Unexpected custody request: ${request.kind}`,
                );
            };
        const service = await createRunnerManagedServicesClient({
            claim: providerClaim(scope),
            dependencies: {} as ManagedDependenciesService,
            dispatch,
            endpointReadRpc,
        }).adopt(spec.id);
        const response = await service.request({ pathAndQuery: '/events' });
        const pendingRead = response.body!.getReader().read().then(
            () => null,
            (error: unknown) => error,
        );
        const observedNextSignal = await nextSignalObserved.promise;

        await service.stop();

        expect(observedNextSignal.aborted).toBe(true);
        expect(await pendingRead).not.toBeNull();
        expect(events).toEqual(['next-aborted', 'cancel', 'stop']);
    });

    it('rejects forged attach request-auth at the custody wire boundary', () => {
        const forged = {
            v: 1,
            kind: 'supervise',
            scope: providerScope('session-forged-attach', 'provider-p'),
            spec: {
                id: 'attached',
                mode: {
                    kind: 'attach',
                    baseUrl: 'http://127.0.0.1:4312',
                },
                requestAuth: {
                    kind: 'connectedAccountCapabilityPath',
                    injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
                },
            },
        };

        expect(RunnerManagedServicesCustodyRequestV1Schema.safeParse(forged).success)
            .toBe(false);
    });

    it('admits host Basic only for an owned spawn at the custody wire boundary', () => {
        const base = {
            v: 1 as const,
            kind: 'supervise' as const,
            scope: providerScope('session-host-basic', 'provider-p'),
            spec: {
                id: 'gateway',
                clientAccess: {
                    kind: 'hostBasic' as const,
                    username: 'happier',
                    injectPasswordEnvironmentKey: 'HAPPIER_GATEWAY_PASSWORD',
                },
            },
        };

        expect(RunnerManagedServicesCustodyRequestV1Schema.safeParse({
            ...base,
            spec: {
                ...base.spec,
                mode: {
                    kind: 'spawn',
                    launch: { executable: { kind: 'systemTool', id: 'gateway' } },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'allocated' },
                    },
                },
            },
        }).success).toBe(true);
        expect(RunnerManagedServicesCustodyRequestV1Schema.safeParse({
            ...base,
            spec: {
                ...base.spec,
                mode: {
                    kind: 'attach',
                    baseUrl: 'http://127.0.0.1:4312',
                },
            },
        }).success).toBe(false);
    });

    it.each([
        ['non-empty', new Uint8Array([0, 255, 17])],
        ['empty', new Uint8Array()],
    ])('round-trips %s launch stdin through the JSON RPC wire as bytes', async (
        _label,
        stdin,
    ) => {
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => handle('spawned'),
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const handler = registerCustodyHandler(runner);
        const client = createRunnerManagedServicesClient({
            scope: providerScope('session-stdin', 'provider-p'),
            dependencies: {} as never,
            dispatch: jsonRpcDispatch(handler),
        });
        const spawnSpec = Object.freeze({
            id: 'spawned',
            mode: Object.freeze({
                kind: 'spawn' as const,
                launch: Object.freeze({
                    executable: Object.freeze({
                        kind: 'systemTool' as const,
                        id: 'gateway',
                    }),
                    stdin,
                }),
                endpoint: Object.freeze({
                    kind: 'detectAfterLaunch' as const,
                }),
            }),
            healthCheck: Object.freeze({ kind: 'none' as const }),
        }) satisfies ManagedServiceSpec;

        await client.services.supervise(spawnSpec);

        expect(supervise).toHaveBeenCalledOnce();
        const received = supervise.mock.calls[0]?.[0];
        expect(received?.mode.kind).toBe('spawn');
        if (received?.mode.kind !== 'spawn') {
            throw new Error('expected spawn mode');
        }
        expect(received.mode.launch.stdin).toBeInstanceOf(Uint8Array);
        expect([...received.mode.launch.stdin!]).toEqual([...stdin]);
    });

    it('round-trips only the public request-auth injection target through runner custody', async () => {
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => handle('spawned'),
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const handler = registerCustodyHandler(runner);
        const client = createRunnerManagedServicesClient({
            scope: providerScope('session-request-auth', 'provider-p'),
            dependencies: {} as never,
            dispatch: jsonRpcDispatch(handler),
        });
        const spawnSpec = Object.freeze({
            id: 'spawned',
            requestAuth: Object.freeze({
                kind: 'connectedAccountCapabilityPath' as const,
                injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
            }),
            mode: Object.freeze({
                kind: 'spawn' as const,
                launch: Object.freeze({
                    executable: Object.freeze({
                        kind: 'systemTool' as const,
                        id: 'gateway',
                    }),
                }),
                endpoint: Object.freeze({
                    kind: 'detectAfterLaunch' as const,
                }),
            }),
        }) satisfies ManagedServiceSpec;

        await client.services.supervise(spawnSpec);

        expect(supervise).toHaveBeenCalledOnce();
        const supervisedSpec = supervise.mock.calls[0]?.[0];
        expect(
            supervisedSpec && 'requestAuth' in supervisedSpec
                ? supervisedSpec.requestAuth
                : undefined,
        ).toEqual({
            kind: 'connectedAccountCapabilityPath',
            injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
        });
        expect(JSON.stringify(supervise.mock.calls[0]?.[0]))
            .not.toContain('capabilityPath');
    });

    it('joins concurrent omitted and explicit equivalent defaults through one canonical establishment', async () => {
        const releaseEstablishment = deferred<void>();
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => {
                await releaseEstablishment.promise;
                return handle('canonical-defaults');
            },
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const client = createRunnerManagedServicesClient({
            scope: providerScope('session-canonical-defaults', 'provider-p'),
            dependencies: {} as never,
            dispatch: runner.dispatch,
        });
        const omittedDefaults = Object.freeze({
            id: 'canonical-defaults',
            mode: Object.freeze({
                kind: 'spawn' as const,
                launch: Object.freeze({
                    executable: Object.freeze({
                        kind: 'systemTool' as const,
                        id: 'gateway',
                    }),
                }),
                endpoint: Object.freeze({
                    kind: 'assignAndInject' as const,
                    port: Object.freeze({
                        kind: 'fixed' as const,
                        port: 4_312,
                    }),
                }),
            }),
            healthCheck: Object.freeze({ kind: 'http' as const }),
            durableLog: Object.freeze({ enabled: true }),
        }) satisfies ManagedServiceSpec;
        const explicitDefaults = Object.freeze({
            ...omittedDefaults,
            startupTimeoutMs: 30_000,
            healthCheck: Object.freeze({
                kind: 'http' as const,
                timeoutMs: 5_000,
            }),
            healthPolicy: Object.freeze({
                intervalMs: 5_000,
                consecutiveFailures: 2,
            }),
            durableLog: Object.freeze({
                enabled: true,
                keepCount: 50,
            }),
        }) satisfies ManagedServiceSpec;

        const omitted = client.services.supervise(omittedDefaults);
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
        const explicit = client.services.supervise(explicitDefaults);
        releaseEstablishment.resolve();

        await expect(Promise.all([omitted, explicit])).resolves.toHaveLength(2);
        expect(supervise).toHaveBeenCalledOnce();
        expect(supervise.mock.calls[0]?.[0]).toEqual(explicitDefaults);
        await runner.dispose();
    });

    it('rejects bare attach durable logging before downstream effects', async () => {
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => handle('invalid-attach-durable-log'),
        );
        const resolveAuthorizedServicesForSupervise = vi.fn(() =>
            supervisionAdmission(Object.freeze({
                dependencies: {} as never,
                supervise,
            })),
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise,
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const dispatch = vi.fn(runner.dispatch);
        const client = createRunnerManagedServicesClient({
            scope: providerScope(
                'session-invalid-attach-durable-log',
                'provider-p',
            ),
            dependencies: {} as never,
            dispatch,
        });
        // Intentional public-input boundary cast: runtime JavaScript can violate
        // the attach branch's `durableLog?: never` discriminated contract.
        const invalidAttachSpec = Object.freeze({
            id: 'invalid-attach-durable-log',
            mode: Object.freeze({
                kind: 'attach' as const,
                baseUrl: 'http://127.0.0.1:4312',
            }),
            durableLog: Object.freeze({ enabled: true }),
        }) as unknown as ManagedServiceSpec;

        await expect(client.services.supervise(invalidAttachSpec)).rejects
            .toMatchObject({
                code: 'plugin_managed_service_spec_invalid',
            });
        expect(dispatch).not.toHaveBeenCalled();
        expect(resolveAuthorizedServicesForSupervise).not.toHaveBeenCalled();
        expect(supervise).not.toHaveBeenCalled();
        await runner.dispose();
    });

    it('retains every exact same-scope SVC09 wrapper when a sequential supervise response is lost', async () => {
        const firstDispose = vi.fn(async () => {});
        const secondDispose = vi.fn(async () => {});
        const wrappers = [
            Object.freeze({
                ...handle(spec.id),
                dispose: firstDispose,
            }),
            Object.freeze({
                ...handle(spec.id),
                dispose: secondDispose,
            }),
        ] satisfies ManagedServiceHandle[];
        let nextWrapper = 0;
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => wrappers[nextWrapper++]!,
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        let superviseResponses = 0;
        const lostResponse = new Error('custody response lost');
        const client = createRunnerManagedServicesClient({
            scope: providerScope('session-sequential', 'provider-p'),
            dependencies: {} as never,
            dispatch: async (request, options) => {
                const result = await runner.dispatch(request, options);
                if (
                    request.kind === 'supervise'
                    && ++superviseResponses === 2
                ) throw lostResponse;
                return result;
            },
        });

        await client.services.supervise(spec);
        await expect(client.services.supervise(spec))
            .rejects.toBe(lostResponse);
        expect(supervise).toHaveBeenCalledTimes(2);
        expect(firstDispose).not.toHaveBeenCalled();
        expect(secondDispose).not.toHaveBeenCalled();

        await runner.dispose();
        await runner.dispose();
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();
    });

    it('cleans unadopted P after a lost supervise response before starting current Q', async () => {
        const lostResponse = new Error('daemon A lost the Provider start response');
        const pDispose = vi.fn(async () => {});
        const qDispose = vi.fn(async () => {});
        const pChild = Object.freeze({
            ...handle(spec.id),
            dispose: pDispose,
        }) satisfies ManagedServiceHandle;
        const qChild = Object.freeze({
            ...handle(spec.id),
            dispose: qDispose,
        }) satisfies ManagedServiceHandle;
        let superviseCount = 0;
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => ++superviseCount === 1 ? pChild : qChild,
        );
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
        });
        const scope = providerScope('session-lost-response', 'provider-p');
        const daemonA = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: async (request, options) => {
                const result = await runner.dispatch(request, options);
                if (request.kind === 'supervise') throw lostResponse;
                return result;
            },
        });
        const pStart = vi.fn<ManagedProviderRuntime['start']>(
            async (_request, context) => Object.freeze({
                service: await context.managedServices.supervise(spec),
                endpoints: Object.freeze([]),
            }),
        );
        const qStart = vi.fn<ManagedProviderRuntime['start']>();

        await expect(pStart({
            reason: 'sessionDemand',
            connectionId: ProviderConnectionIdSchema.parse('connection-p'),
            connectionRevision: 1,
            endpointTemplateIds: Object.freeze(['chat']),
        }, {
            connectedAccounts: {} as never,
            managedServices: daemonA.services,
            signal: new AbortController().signal,
        })).rejects.toBe(lostResponse);

        await expect(
            runner.readCurrentManagedProviderRetention(),
        ).resolves.toBeNull();
        expect(pDispose).toHaveBeenCalledOnce();

        const qScope = Object.freeze({
            ...providerScope('session-lost-response', 'provider-q'),
            runtimeBindingBasis: scope.runtimeBindingBasis,
        });
        const daemonB = createRunnerManagedServicesClient({
            scope: qScope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        qStart.mockImplementationOnce(async (_request, context) =>
            Object.freeze({
                service: await context.managedServices.supervise(spec),
                endpoints: Object.freeze([]),
            }));
        await qStart({
            reason: 'sessionDemand',
            connectionId: ProviderConnectionIdSchema.parse('connection-q'),
            connectionRevision: 1,
            endpointTemplateIds: Object.freeze(['chat']),
        }, {
            connectedAccounts: {} as never,
            managedServices: daemonB.services,
            signal: new AbortController().signal,
        });
        expect(pStart).toHaveBeenCalledOnce();
        expect(qStart).toHaveBeenCalledOnce();
        expect(supervise).toHaveBeenCalledTimes(2);

        await runner.dispose();
        expect(pDispose).toHaveBeenCalledOnce();
        expect(qDispose).toHaveBeenCalledOnce();
    });

    it('aborts and cleans an establishing unadopted P before reporting no retained custody to current Q', async () => {
        const establishment = deferred<ManagedServiceHandle>();
        const pDispose = vi.fn(async () => {});
        let establishmentSignal: AbortSignal | undefined;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (
                _requested: ManagedServiceSpec,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) => {
                establishmentSignal = options?.signal;
                return await establishment.promise;
            }),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
        });
        const scope = providerScope(
            'session-establishing-unadopted',
            'provider-p',
        );
        const pendingP = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() =>
            expect(services.supervise).toHaveBeenCalledOnce());

        const retirement = runner.readCurrentManagedProviderRetention();
        await vi.waitFor(() =>
            expect(establishmentSignal?.aborted).toBe(true));
        establishment.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: pDispose,
        }));

        await expect(retirement).resolves.toBeNull();
        await expect(pendingP).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(pDispose).toHaveBeenCalledOnce();
    });

    it('rejects a new unadopted establishment while current retention is retiring its snapshot', async () => {
        const pEstablishment = deferred<ManagedServiceHandle>();
        const lateEstablishment = deferred<ManagedServiceHandle>();
        const pDispose = vi.fn(async () => {});
        const lateDispose = vi.fn(async () => {});
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) =>
                requested.id === spec.id
                    ? await pEstablishment.promise
                    : await lateEstablishment.promise),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
        });
        const scope = providerScope(
            'session-retention-interleaving',
            'provider-p',
        );
        const pendingP = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() =>
            expect(services.supervise).toHaveBeenCalledOnce());

        const retention = runner.readCurrentManagedProviderRetention();
        const lateSpec = Object.freeze({
            ...spec,
            id: 'late-unadopted',
        }) satisfies ManagedServiceSpec;
        const lateStart = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec: lateSpec,
        });
        pEstablishment.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: pDispose,
        }));

        await expect(retention).resolves.toBeNull();
        await expect(pendingP).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        lateEstablishment.resolve(Object.freeze({
            ...handle(lateSpec.id),
            dispose: lateDispose,
        }));
        const lateOutcome = await lateStart.then(
            () => Object.freeze({ status: 'fulfilled' as const }),
            (reason: unknown) => Object.freeze({
                status: 'rejected' as const,
                reason,
            }),
        );

        await runner.dispose();
        expect(lateOutcome).toMatchObject({
            status: 'rejected',
            reason: {
                code: 'plugin_managed_service_not_reusable',
            },
        });
        expect(services.supervise).toHaveBeenCalledOnce();
        expect(pDispose).toHaveBeenCalledOnce();
        expect(lateDispose).not.toHaveBeenCalled();
    });

    it('does not expose a reused wrapper after exact custody disposal wins its final admission race', async () => {
        const finalRevisionRead = deferred<number>();
        let finalRevisionReadRequested = false;
        let deferFinalRevisionRead = false;
        const firstDispose = vi.fn(async () => {});
        const secondDispose = vi.fn(async () => {});
        const wrappers = [
            Object.freeze({
                ...handle(spec.id),
                dispose: firstDispose,
            }),
            Object.freeze({
                ...handle(spec.id),
                dispose: secondDispose,
            }),
        ] satisfies ManagedServiceHandle[];
        let nextWrapper = 0;
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => wrappers[nextWrapper++]!,
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => {
                if (deferFinalRevisionRead) {
                    deferFinalRevisionRead = false;
                    finalRevisionReadRequested = true;
                    return finalRevisionRead.promise;
                }
                return 0;
            },
            readCurrentProviderImmutableGenerationIntegrityCurrentness: () => {
                if (nextWrapper === 2) {
                    deferFinalRevisionRead = true;
                }
                return true;
            },
        });
        const scope = providerScope('session-reuse-race', 'provider-p');
        await runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));

        let disposalSettled = false;
        const disposal = runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }).finally(() => {
            disposalSettled = true;
        });
        await vi.waitFor(() =>
            expect(finalRevisionReadRequested).toBe(true));
        expect(disposalSettled).toBe(false);
        finalRevisionRead.resolve(0);

        await expect(disposal).resolves.toMatchObject({ kind: 'disposed' });
        await expect(reusing).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();
        await runner.dispose();
    });

    it('settles exact disposal after deferred initial and late reuse cleanup both succeed', async () => {
        const initialCleanup = deferred<void>();
        const reusedHandle = deferred<ManagedServiceHandle>();
        const firstDispose = vi.fn(async () => {
            await initialCleanup.promise;
        });
        const secondDispose = vi.fn(async () => undefined);
        let superviseCount = 0;
        const supervise = vi.fn(async () => {
            superviseCount += 1;
            if (superviseCount === 1) {
                return Object.freeze({
                    ...handle(spec.id),
                    dispose: firstDispose,
                });
            }
            return await reusedHandle.promise;
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope(
            'session-deferred-successful-reuse-cleanup',
            'provider-p',
        );
        await runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));

        const disposal = runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        });
        await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledOnce());
        reusedHandle.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: secondDispose,
        }));
        initialCleanup.resolve(undefined);

        await expect(disposal).resolves.toEqual({ v: 1, kind: 'disposed' });
        await expect(reusing).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();

        await expect(runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('awaits and retries failed late reuse cleanup during exact adopted-custody disposal', async () => {
        const reusedHandle = deferred<ManagedServiceHandle>();
        const reusedCleanupFailure = new Error(
            'exact-dispose reused handle cleanup failed',
        );
        const firstDispose = vi.fn(async () => undefined);
        const secondDispose = vi.fn()
            .mockRejectedValueOnce(reusedCleanupFailure)
            .mockResolvedValueOnce(undefined);
        const projectionCleanup = vi.fn(async () => undefined);
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        let superviseCount = 0;
        const supervise = vi.fn(async () => {
            superviseCount += 1;
            if (superviseCount === 1) {
                return Object.freeze({
                    ...handle(spec.id),
                    dispose: firstDispose,
                });
            }
            return await reusedHandle.promise;
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        let currentRevision = 0;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-exact-dispose-reuse-cleanup-retry',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));

        currentRevision = 1;
        let disposalSettled = false;
        const disposal = runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }).finally(() => {
            disposalSettled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(disposalSettled).toBe(false);

        reusedHandle.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: secondDispose,
        }));
        await expect(disposal).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        await expect(reusing).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();

        await expect(runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).resolves.toEqual({ v: 1, kind: 'disposed' });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledTimes(2);
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
    });

    it('fences ordinary exact disposal before awaiting a late reused handle', async () => {
        const reusedHandle = deferred<ManagedServiceHandle>();
        const reusedCleanupFailure = new Error(
            'ordinary exact-dispose reused cleanup failed',
        );
        const firstDispose = vi.fn(async () => undefined);
        const secondDispose = vi.fn()
            .mockRejectedValueOnce(reusedCleanupFailure)
            .mockResolvedValueOnce(undefined);
        let superviseCount = 0;
        const supervise = vi.fn(async () => {
            superviseCount += 1;
            if (superviseCount === 1) {
                return Object.freeze({
                    ...handle(spec.id),
                    dispose: firstDispose,
                });
            }
            if (superviseCount === 2) {
                return await reusedHandle.promise;
            }
            throw new Error('supervision entered after exact disposal');
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope(
            'session-ordinary-exact-dispose-reuse',
            'provider-p',
        );
        await runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));

        let disposalSettled = false;
        const disposal = runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }).finally(() => {
            disposalSettled = true;
        });
        await Promise.resolve();
        expect(disposalSettled).toBe(false);
        await expect(runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_not_reusable',
        });
        expect(supervise).toHaveBeenCalledTimes(2);

        const reusingOutcome = reusing.catch((error: unknown) => error);
        reusedHandle.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: secondDispose,
        }));
        await expect(disposal).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        await expect(reusingOutcome).resolves.toEqual(
            sanitizedCleanupAggregate(1),
        );
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();

        await expect(runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).resolves.toEqual({ v: 1, kind: 'disposed' });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledTimes(2);
        expect(supervise).toHaveBeenCalledTimes(2);
    });

    it('defers retry of failed exact cleanup until the next owner disposal', async () => {
        const reusedHandle = deferred<ManagedServiceHandle>();
        const initialCleanupFailure = new Error(
            'ordinary exact-dispose initial cleanup failed',
        );
        const firstDispose = vi.fn()
            .mockRejectedValueOnce(initialCleanupFailure)
            .mockResolvedValueOnce(undefined);
        const secondDispose = vi.fn(async () => undefined);
        let superviseCount = 0;
        const supervise = vi.fn(async () => {
            superviseCount += 1;
            if (superviseCount === 1) {
                return Object.freeze({
                    ...handle(spec.id),
                    dispose: firstDispose,
                });
            }
            if (superviseCount === 2) {
                return await reusedHandle.promise;
            }
            throw new Error('supervision entered after exact disposal');
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope(
            'session-ordinary-exact-dispose-stale-failure',
            'provider-p',
        );
        await runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));

        let disposalSettled = false;
        const disposal = runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }).finally(() => {
            disposalSettled = true;
        });
        await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledOnce());
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(disposalSettled).toBe(false);

        const reusingOutcome = expect(reusing).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        reusedHandle.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: secondDispose,
        }));

        await expect(disposal).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        await reusingOutcome;
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).not.toHaveBeenCalled();

        await expect(runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).resolves.toEqual({ v: 1, kind: 'disposed' });
        expect(firstDispose).toHaveBeenCalledTimes(2);
        expect(secondDispose).toHaveBeenCalledOnce();

        await expect(runner.dispatch({
            v: 1,
            kind: 'dispose',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('awaits and retries failed late reuse cleanup while permanently disposing adopted custody', async () => {
        const reusedHandle = deferred<ManagedServiceHandle>();
        const reusedCleanupFailure = new Error(
            'reused handle cleanup failed',
        );
        const firstDispose = vi.fn(async () => undefined);
        const projectionCleanup = vi.fn(async () => undefined);
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const secondDispose = vi.fn()
            .mockRejectedValueOnce(reusedCleanupFailure)
            .mockResolvedValueOnce(undefined);
        let superviseCount = 0;
        const supervise = vi.fn(async () => {
            superviseCount += 1;
            if (superviseCount === 1) {
                return Object.freeze({
                    ...handle(spec.id),
                    dispose: firstDispose,
                });
            }
            return await reusedHandle.promise;
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-reused-cleanup-retry',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));
        let disposalSettled = false;
        const disposal = runner.dispose().finally(() => {
            disposalSettled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(disposalSettled).toBe(false);

        reusedHandle.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: secondDispose,
        }));
        await expect(disposal).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        await expect(reusing).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).not.toHaveBeenCalled();

        await expect(runner.dispose()).resolves.toBeUndefined();
        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledTimes(2);
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
    });

    it('awaits and retries failed late reuse cleanup while hard-revoking adopted custody', async () => {
        const reusedHandle = deferred<ManagedServiceHandle>();
        const reusedCleanupFailure = new Error(
            'hard-revoked reused handle cleanup failed',
        );
        const firstDispose = vi.fn(async () => undefined);
        const projectionCleanup = vi.fn(async () => undefined);
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const secondDispose = vi.fn()
            .mockRejectedValueOnce(reusedCleanupFailure)
            .mockResolvedValueOnce(undefined);
        let superviseCount = 0;
        const supervise = vi.fn(async () => {
            superviseCount += 1;
            if (superviseCount === 1) {
                return Object.freeze({
                    ...handle(spec.id),
                    dispose: firstDispose,
                });
            }
            return await reusedHandle.promise;
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        let currentRevision = 0;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-hard-revoked-reuse-cleanup-retry',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        const reusing = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));

        currentRevision = 1;
        let revocationSettled = false;
        const revocation = runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        }).finally(() => {
            revocationSettled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(revocationSettled).toBe(false);

        reusedHandle.resolve(Object.freeze({
            ...handle(spec.id),
            dispose: secondDispose,
        }));
        await expect(revocation).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        await expect(reusing).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).not.toHaveBeenCalled();

        await expect(runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        })).resolves.toEqual({
            v: 1,
            kind: 'hardRevocationFenced',
            fencedServiceCount: 1,
        });
        expect(firstDispose).toHaveBeenCalledOnce();
        expect(secondDispose).toHaveBeenCalledTimes(2);
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
    });

    it('rejects malformed launch stdin wire values before SVC09 supervision', async () => {
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => handle('spawned'),
        );
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const handler = registerCustodyHandler(runner);
        const scope = providerScope('session-stdin-invalid', 'provider-p');
        const wireSpec = {
            id: 'spawned',
            mode: {
                kind: 'spawn',
                launch: {
                    executable: { kind: 'systemTool', id: 'gateway' },
                    stdin: { t: 'bytes', base64: 'not-base64!' },
                },
                endpoint: { kind: 'detectAfterLaunch' },
            },
            healthCheck: { kind: 'none' },
        };

        await expect(handler({
            v: 1,
            kind: 'supervise',
            scope,
            spec: wireSpec,
        })).rejects.toMatchObject({ name: 'ZodError' });
        await expect(handler({
            v: 1,
            kind: 'supervise',
            scope,
            spec: {
                ...wireSpec,
                mode: {
                    ...wireSpec.mode,
                    launch: {
                        ...wireSpec.mode.launch,
                        stdin: { t: 'binary', base64: 'AA==' },
                    },
                },
            },
        })).rejects.toMatchObject({ name: 'ZodError' });
        await expect(handler({
            v: 1,
            kind: 'supervise',
            scope,
            spec: {
                ...wireSpec,
                mode: {
                    ...wireSpec.mode,
                    launch: {
                        ...wireSpec.mode.launch,
                        stdin: { t: 'bytes', base64: 'AB==' },
                    },
                },
            },
        })).rejects.toMatchObject({ name: 'ZodError' });
        expect(supervise).not.toHaveBeenCalled();
    });

    it('streams authoritative handle transitions without wait or stop', async () => {
        let current = snapshot(spec.id);
        const underlyingListeners = new Set<
            (value: ManagedServiceSnapshot) => void
        >();
        const observationDispose = vi.fn();
        const ownedHandle: ManagedServiceHandle = Object.freeze({
            snapshot: () => current,
            observe(listener: (value: ManagedServiceSnapshot) => void) {
                underlyingListeners.add(listener);
                listener(current);
                return Object.freeze({
                    dispose() {
                        underlyingListeners.delete(listener);
                        observationDispose();
                    },
                });
            },
            waitUntilHealthy: async () => current,
            async request() {
                throw new Error('Unexpected managed service request');
            },
            stop: async () => Object.freeze({ status: 'stopped' as const }),
            async dispose() {},
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => ownedHandle,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const client = createRunnerManagedServicesClient({
            scope: providerScope('session-observe', 'provider-p'),
            dependencies: {} as never,
            dispatch: jsonRpcDispatch(registerCustodyHandler(runner)),
        });
        const service = await client.services.supervise(spec);
        const observed = vi.fn();
        const observation = service.observe(observed);
        expect(observed).toHaveBeenCalledWith(current);
        await vi.waitFor(() => expect(underlyingListeners.size).toBe(1));

        current = Object.freeze({
            ...current,
            state: 'unhealthy',
            diagnostics: Object.freeze([Object.freeze({
                code: 'health_failed',
                severity: 'error' as const,
            })]),
        });
        for (const listener of underlyingListeners) listener(current);

        await vi.waitFor(() => expect(observed).toHaveBeenLastCalledWith(
            current,
        ));
        observation.dispose();
        await vi.waitFor(() => expect(observationDispose).toHaveBeenCalledOnce());
        await runner.dispose();
    });

    it('cancels one blocked observe.next and closes observation custody exactly once', async () => {
        const observationDispose = vi.fn();
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            observe(listener: (value: ManagedServiceSnapshot) => void) {
                listener(snapshot(spec.id));
                return Object.freeze({ dispose: observationDispose });
            },
        }) satisfies ManagedServiceHandle;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => ownedHandle,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const handler = registerCustodyHandler(runner);
        const scope = providerScope('session-observe-cancel', 'provider-p');
        await handler(JSON.parse(JSON.stringify({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })));
        const opened = await handler({
            v: 1,
            kind: 'observe.open',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }) as { observationId: string };
        const nextAbort = new AbortController();
        const next = handler({
            v: 1,
            kind: 'observe.next',
            claim: providerClaim(scope),
            serviceId: spec.id,
            observationId: opened.observationId,
        }, { signal: nextAbort.signal });
        nextAbort.abort();
        await expect(next).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        await expect(handler({
            v: 1,
            kind: 'observe.close',
            claim: providerClaim(scope),
            serviceId: spec.id,
            observationId: opened.observationId,
        })).resolves.toMatchObject({
            kind: 'observe.close',
            closed: true,
        });
        await expect(handler({
            v: 1,
            kind: 'observe.close',
            claim: providerClaim(scope),
            serviceId: spec.id,
            observationId: opened.observationId,
        })).resolves.toMatchObject({
            kind: 'observe.close',
            closed: false,
        });
        expect(observationDispose).toHaveBeenCalledOnce();
        await runner.dispose();
    });

    it('bounds observation backpressure by coalescing to the latest authoritative snapshot', async () => {
        let emit: (value: ManagedServiceSnapshot) => void = () => undefined;
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            observe(listener: (value: ManagedServiceSnapshot) => void) {
                emit = listener;
                listener(snapshot(spec.id));
                return Object.freeze({ dispose() {} });
            },
        }) satisfies ManagedServiceHandle;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => ownedHandle,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const handler = registerCustodyHandler(runner);
        const scope = providerScope('session-observe-backpressure', 'provider-p');
        await handler(JSON.parse(JSON.stringify({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })));
        const opened = await handler({
            v: 1,
            kind: 'observe.open',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }) as { observationId: string };
        emit(Object.freeze({ ...snapshot(spec.id), state: 'unhealthy' }));
        const latest = Object.freeze({
            ...snapshot(spec.id),
            state: 'healthy' as const,
            lastHealthyAtMs: 2_000,
        });
        emit(latest);

        await expect(handler({
            v: 1,
            kind: 'observe.next',
            claim: providerClaim(scope),
            serviceId: spec.id,
            observationId: opened.observationId,
        })).resolves.toEqual({
            v: 1,
            kind: 'observe.next',
            status: 'snapshot',
            snapshot: latest,
        });
        await runner.dispose();
    });

    it('rejects every post-revocation observation exposure and disposes observations before handles', async () => {
        let currentRevision = 4;
        const cleanupOrder: string[] = [];
        let emit: (value: ManagedServiceSnapshot) => void = () => undefined;
        const ownedHandle: ManagedServiceHandle = Object.freeze({
            ...handle(spec.id),
            observe(listener: (value: ManagedServiceSnapshot) => void) {
                emit = listener;
                listener(snapshot(spec.id));
                return Object.freeze({
                    dispose() {
                        cleanupOrder.push('observation');
                        emit = () => undefined;
                    },
                });
            },
            async dispose() {
                cleanupOrder.push('handle');
            },
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => ownedHandle,
                }), 4),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
        });
        const handler = registerCustodyHandler(runner);
        const scope = providerScope('session-observe-revoke', 'provider-p');
        await handler(JSON.parse(JSON.stringify({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })));
        const opened = await handler({
            v: 1,
            kind: 'observe.open',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }) as { observationId: string };
        emit(Object.freeze({
            ...snapshot(spec.id),
            state: 'unhealthy',
        }));
        currentRevision = 5;

        await expect(handler({
            v: 1,
            kind: 'observe.next',
            claim: providerClaim(scope),
            serviceId: spec.id,
            observationId: opened.observationId,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(handler({
            v: 1,
            kind: 'observe.open',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });

        await runner.dispose();
        await runner.dispose();
        expect(cleanupOrder).toEqual(['observation', 'handle']);
    });

    it('does not open an observation after runner disposal wins the exposure race', async () => {
        const revisionRead = deferred<number>();
        let blockRevisionRead = false;
        const observe = vi.fn(handle(spec.id).observe);
        const dispose = vi.fn(async () => {});
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            observe,
            dispose,
        }) satisfies ManagedServiceHandle;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => ownedHandle,
                })),
            readCurrentProviderPluginHardRevocationRevision: () =>
                blockRevisionRead ? revisionRead.promise : 0,
        });
        const handler = registerCustodyHandler(runner);
        const scope = providerScope('session-observe-dispose-race', 'provider-p');
        await handler(JSON.parse(JSON.stringify({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })));
        blockRevisionRead = true;
        const opening = handler({
            v: 1,
            kind: 'observe.open',
            claim: providerClaim(scope),
            serviceId: spec.id,
        });
        await Promise.resolve();

        const ownerDisposal = runner.dispose();
        revisionRead.resolve(0);

        await expect(opening).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await ownerDisposal;
        expect(observe).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('does not strand observation custody when observe.open is cancelled during admission', async () => {
        const revisionRead = deferred<number>();
        let blockRevisionRead = false;
        const observationDispose = vi.fn();
        const observe = vi.fn((listener: (value: ManagedServiceSnapshot) => void) => {
            listener(snapshot(spec.id));
            return Object.freeze({ dispose: observationDispose });
        });
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            observe,
        }) satisfies ManagedServiceHandle;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => ownedHandle,
                })),
            readCurrentProviderPluginHardRevocationRevision: () =>
                blockRevisionRead ? revisionRead.promise : 0,
        });
        const handler = registerCustodyHandler(runner);
        const scope = providerScope('session-observe-open-cancel', 'provider-p');
        await handler(JSON.parse(JSON.stringify({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })));
        blockRevisionRead = true;
        const controller = new AbortController();
        const opening = handler({
            v: 1,
            kind: 'observe.open',
            claim: providerClaim(scope),
            serviceId: spec.id,
        }, { signal: controller.signal });
        await Promise.resolve();

        controller.abort();
        revisionRead.resolve(0);

        await expect(opening).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(observe).not.toHaveBeenCalled();
        expect(observationDispose).not.toHaveBeenCalled();
        await runner.dispose();
    });

    it('registers one strict, abort-aware daemon-to-runner custody RPC', async () => {
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () => null,
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        await expect(runner.dispatch({
            v: 1,
            kind: 'adopt',
            claim: {
                ...providerClaim(
                    providerScope('session-existing', 'provider-p'),
                ),
                sessionId: ' session-existing',
            },
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        const mismatchedClaim = providerClaim(
            providerScope('session-existing', 'provider-p'),
        );
        await expect(runner.dispatch({
            v: 1,
            kind: 'adopt',
            claim: {
                ...mismatchedClaim,
                pluginId: 'another.plugin',
            },
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        const dispatch = vi.fn(runner.dispatch);
        const registerHandler = vi.fn();
        registerRunnerManagedServicesCustodyRpcHandler(
            { registerHandler },
            { dispatch },
        );

        expect(registerHandler).toHaveBeenCalledTimes(1);
        expect(registerHandler.mock.calls[0]?.[0]).toBe(
            RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
        );
        const handler = registerHandler.mock.calls[0]?.[1] as (
            raw: unknown,
            context?: Readonly<{ signal: AbortSignal }>,
        ) => Promise<unknown>;
        await expect(handler({
            v: 1,
            kind: 'adopt',
            claim: providerClaim(
                providerScope('session-existing', 'provider-p'),
            ),
            serviceId: spec.id,
            unexpected: true,
        })).rejects.toMatchObject({ name: 'ZodError' });
        expect(dispatch).not.toHaveBeenCalled();

        const signal = new AbortController().signal;
        await expect(handler({
            v: 1,
            kind: 'adopt',
            claim: providerClaim(
                providerScope('session-existing', 'provider-p'),
            ),
            serviceId: spec.id,
        }, { signal })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'adopt',
        }), { signal });
    });

    it('keeps adopted P across daemon A to B while a fresh Session starts Q', async () => {
        const childDispose = vi.fn(async () => {});
        const child = Object.freeze({
            ...handle(spec.id),
            dispose: childDispose,
        }) satisfies ManagedServiceHandle;
        const supervise = vi.fn(async () => child);
        const projectionCleanup = vi.fn(async () => {});
        const projectEndpointAccess = vi.fn(async () => Object.freeze({
            access: Object.freeze({
                endpointUrl: () =>
                    'http://127.0.0.1:4312/v1/chat/completions',
                request: vi.fn(),
            }),
            isCurrent: () => true,
            cleanup: projectionCleanup,
        }));
        const retainAdoptedProviderAuthority = vi.fn(async () => true);
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const runnerServices = Object.freeze({
            dependencies: Object.freeze({
                status: vi.fn(),
                ensure: vi.fn(),
                update: vi.fn(),
                remove: vi.fn(),
            }),
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(runnerServices),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess,
            retainAdoptedProviderAuthority,
            releaseAdoptedProviderAuthority,
        });
        const dependencies = runnerServices.dependencies;
        const p = providerScope('session-existing', 'provider-p');
        const q = Object.freeze({
            ...providerScope('session-existing', 'provider-q'),
            // Ordinary P -> Q replacement can retain the same semantic
            // Provider authorization basis. Exact P facts still prevent a
            // new Q supervise from joining P by service-id equality.
            runtimeBindingBasis: p.runtimeBindingBasis,
        });
        const daemonA = createRunnerManagedServicesClient({
            scope: p,
            dependencies,
            dispatch: runner.dispatch,
        });
        const pStart = vi.fn<ManagedProviderRuntime['start']>(
            async (_request, context) => Object.freeze({
                service: await context.managedServices.supervise(spec),
                endpoints: Object.freeze([{
                    endpointTemplateId: 'chat',
                    endpoint: Object.freeze({
                        kind: 'servicePath' as const,
                        path: '/v1/chat/completions',
                    }),
                }]),
            }),
        );
        const qStart = vi.fn<ManagedProviderRuntime['start']>();

        const adoptedByA = await pStart({
            reason: 'sessionDemand',
            connectionId: ProviderConnectionIdSchema.parse('connection-one'),
            connectionRevision: 1,
            endpointTemplateIds: Object.freeze(['chat']),
        }, {
            connectedAccounts: {} as never,
            managedServices: daemonA.services,
            signal: new AbortController().signal,
        });
        const childSnapshot = adoptedByA.service.snapshot();
        const projectedByA = await daemonA.projectEndpointAccess({
            service: adoptedByA.service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        expect(projectedByA).not.toBeNull();
        await daemonA.commitAdoption(spec.id);
        await expect(runner.readAdoptedPublicOutcome()).resolves.toEqual({
            operationClaimId: p.operationClaimId,
            serviceId: spec.id,
            endpointTemplateIds: ['chat'],
            endpoints: [{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
                endpointUrl:
                    'http://127.0.0.1:4312/v1/chat/completions',
            }],
            endpointAccess: 'runnerProjected',
        });

        // Daemon B reattests the exact adopted P facts and adopts the runner
        // handle. It never invokes either P or desired Q to reconstruct it.
        const daemonB = createRunnerManagedServicesClient({
            claim: providerClaim(p),
            dependencies,
            dispatch: runner.dispatch,
        });
        await expect(daemonB.readAdoptedPublicOutcome()).resolves.toEqual({
            operationClaimId: p.operationClaimId,
            serviceId: spec.id,
            endpointTemplateIds: ['chat'],
            endpoints: [{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
                endpointUrl:
                    'http://127.0.0.1:4312/v1/chat/completions',
            }],
            endpointAccess: 'runnerProjected',
        });
        const adoptedByB = await daemonB.adopt(spec.id);
        const observed = vi.fn();
        adoptedByB.observe(observed);
        expect(observed).toHaveBeenCalledWith(childSnapshot);
        await expect(adoptedByB.waitUntilHealthy()).resolves.toEqual(
            childSnapshot,
        );
        // Replacement daemon B has explicitly adopted exact P. Retiring
        // daemon A may now release its remote wrapper without ending the
        // runner-owned Session-P child custody.
        await adoptedByA.service.dispose();
        expect(childDispose).not.toHaveBeenCalled();
        await expect(adoptedByB.waitUntilHealthy()).resolves.toEqual(
            childSnapshot,
        );
        expect(pStart).toHaveBeenCalledTimes(1);
        expect(qStart).not.toHaveBeenCalled();
        expect(supervise).toHaveBeenCalledTimes(1);
        const daemonQ = createRunnerManagedServicesClient({
            scope: q,
            dependencies,
            dispatch: runner.dispatch,
        });
        await expect(daemonQ.services.supervise(spec)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(daemonQ.adopt(spec.id)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        const differentClaim = Object.freeze({
            ...p,
            operationClaimId:
                'session-demand:session-existing:provider-q',
        });
        const daemonDifferentClaim = createRunnerManagedServicesClient({
            scope: differentClaim,
            dependencies,
            dispatch: runner.dispatch,
        });
        await expect(
            daemonDifferentClaim.services.supervise(spec),
        ).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(
            daemonDifferentClaim.adopt(spec.id),
        ).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(createRunnerManagedServicesClient({
            claim: providerClaim(
                providerScope('session-existing', 'provider-other'),
            ),
            dependencies,
            dispatch: runner.dispatch,
        }).adopt(spec.id)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(supervise).toHaveBeenCalledTimes(1);

        // A new Session has independent runner custody and starts current Q.
        const freshChild = handle(spec.id);
        const freshSupervise = vi.fn(async () => freshChild);
        const freshRunner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                dependencies,
                supervise: freshSupervise,
            })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const freshQ = providerScope('session-fresh', 'provider-q');
        const freshClient = createRunnerManagedServicesClient({
            scope: freshQ,
            dependencies,
            dispatch: freshRunner.dispatch,
        });
        qStart.mockImplementationOnce(async (_request, context) =>
            Object.freeze({
                service: await context.managedServices.supervise(spec),
                endpoints: Object.freeze([]),
            }));
        await qStart({
            reason: 'sessionDemand',
            connectionId: ProviderConnectionIdSchema.parse('connection-two'),
            connectionRevision: 1,
            endpointTemplateIds: Object.freeze(['chat']),
        }, {
            connectedAccounts: {} as never,
            managedServices: freshClient.services,
            signal: new AbortController().signal,
        });

        expect(pStart).toHaveBeenCalledTimes(1);
        expect(qStart).toHaveBeenCalledTimes(1);
        expect(freshSupervise).toHaveBeenCalledTimes(1);
        await runner.dispose();
        expect(childDispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(retainAdoptedProviderAuthority).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
        await freshRunner.dispose();
    });

    it('settles retained P when desired Q changes immediately after the exact runner commit', async () => {
        let desiredQCurrent = true;
        const childDispose = vi.fn(async () => {});
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => Object.freeze({
                ...handle(spec.id),
                dispose: childDispose,
            })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async ({ isCurrent }) => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => isCurrent()
                        ? 'http://127.0.0.1:4312/v1'
                        : null,
                    request: vi.fn(),
                }),
                isCurrent,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority: async () => true,
        });
        const scope = providerScope(
            'session-q-change-after-commit',
            'provider-p',
        );
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const runtime = Object.freeze({
            runtime: Object.freeze({
                start: async (
                    _request: ManagedProviderStartRequest,
                    context: ManagedProviderRuntimeContext,
                ) => Object.freeze({
                    service: await context.managedServices.supervise(spec),
                    endpoints: Object.freeze([Object.freeze({
                        endpointTemplateId: 'chat',
                        endpoint: Object.freeze({
                            kind: 'servicePath' as const,
                            path: '/v1',
                        }),
                    })]),
                }),
            }),
            activationGeneration: scope.activationGeneration,
            immutableGenerationId: scope.immutableGenerationId,
            isCurrent: () => desiredQCurrent,
        }) satisfies ResolvedManagedProviderRuntime;
        const launchResourceScope = createProviderLaunchResourceScope();

        const result = await startPublicManagedProviderRuntime<
            ManagedProviderEndpointHttpAccess
        >({
            identity: Object.freeze({
                pluginId: scope.pluginId,
                localId: scope.providerLocalId,
            }),
            request: Object.freeze({
                reason: 'sessionDemand' as const,
                connectionId: scope.runtimeBindingBasis.connectionId,
                connectionRevision: 1,
                endpointTemplateIds: Object.freeze(['chat']),
            }),
            acquireRuntime: async () => runtime,
            connectedAccounts: {} as never,
            custody: Object.freeze({
                managedServices: client.services,
                projectEndpointAccess: client.projectEndpointAccess,
                adoptService: async (serviceId) => {
                    await client.commitAdoption(serviceId);
                    desiredQCurrent = false;
                },
                readAdoptedPublicOutcome:
                    client.readAdoptedPublicOutcome,
            }),
            isAuthorizationCurrent: () => desiredQCurrent,
            revalidateAuthorization: async () => desiredQCurrent,
            signal: new AbortController().signal,
            launchResourceScope,
        });

        expect(result).toMatchObject({ ok: true });
        await expect(client.readAdoptedPublicOutcome()).resolves.toMatchObject({
            operationClaimId: scope.operationClaimId,
            serviceId: spec.id,
            endpointTemplateIds: ['chat'],
        });
        await launchResourceScope.transfer()?.();
        expect(childDispose).not.toHaveBeenCalled();
        await runner.dispose();
        expect(childDispose).toHaveBeenCalledOnce();
    });

    it('settles through the exact adopted public outcome when the runner commit response is lost', async () => {
        const childDispose = vi.fn(async () => {});
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => Object.freeze({
                ...handle(spec.id),
                dispose: childDispose,
            })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async ({ isCurrent }) => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => isCurrent()
                        ? 'http://127.0.0.1:4312/v1'
                        : null,
                    request: vi.fn(),
                }),
                isCurrent,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority: async () => true,
        });
        const scope = providerScope(
            'session-lost-commit-response',
            'provider-p',
        );
        const dispatch = vi.fn<
            Parameters<typeof createRunnerManagedServicesClient>[0]['dispatch']
        >(async (request, options) => {
            const response = await runner.dispatch(request, options);
            if (request.kind === 'commitAdoption') {
                throw new Error('runner response lost after exact commit');
            }
            return response;
        });
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch,
        });
        const runtime = Object.freeze({
            runtime: Object.freeze({
                start: async (
                    _request: ManagedProviderStartRequest,
                    context: ManagedProviderRuntimeContext,
                ) => Object.freeze({
                    service: await context.managedServices.supervise(spec),
                    endpoints: Object.freeze([Object.freeze({
                        endpointTemplateId: 'chat',
                        endpoint: Object.freeze({
                            kind: 'servicePath' as const,
                            path: '/v1',
                        }),
                    })]),
                }),
            }),
            activationGeneration: scope.activationGeneration,
            immutableGenerationId: scope.immutableGenerationId,
            isCurrent: () => true,
        }) satisfies ResolvedManagedProviderRuntime;
        const launchResourceScope = createProviderLaunchResourceScope();

        const result = await startPublicManagedProviderRuntime({
            identity: Object.freeze({
                pluginId: scope.pluginId,
                localId: scope.providerLocalId,
            }),
            request: Object.freeze({
                reason: 'sessionDemand' as const,
                connectionId: scope.runtimeBindingBasis.connectionId,
                connectionRevision: 1,
                endpointTemplateIds: Object.freeze(['chat']),
            }),
            acquireRuntime: async () => runtime,
            connectedAccounts: {} as never,
            custody: Object.freeze({
                managedServices: client.services,
                projectEndpointAccess: client.projectEndpointAccess,
                adoptService: client.commitAdoption,
                readAdoptedPublicOutcome:
                    client.readAdoptedPublicOutcome,
            }),
            isAuthorizationCurrent: () => true,
            revalidateAuthorization: async () => true,
            signal: new AbortController().signal,
            launchResourceScope,
        });

        expect(result).toMatchObject({ ok: true });
        expect(dispatch.mock.calls.map(([request]) => request.kind)).toContain(
            'readAdoptedPublicOutcome',
        );
        await launchResourceScope.transfer()?.();
        expect(childDispose).not.toHaveBeenCalled();
        await runner.dispose();
        expect(childDispose).toHaveBeenCalledOnce();
    });

    it('cleans a proven pre-commit failure without adopting the Provider service', async () => {
        const childDispose = vi.fn(async () => {});
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => Object.freeze({
                ...handle(spec.id),
                dispose: childDispose,
            })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async ({ isCurrent }) => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => isCurrent()
                        ? 'http://127.0.0.1:4312/v1'
                        : null,
                    request: vi.fn(),
                }),
                isCurrent,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority: async () => false,
            releaseAdoptedProviderAuthority: async () => true,
        });
        const scope = providerScope(
            'session-pre-commit-failure',
            'provider-p',
        );
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const readAdoptedPublicOutcome = vi.fn(
            client.readAdoptedPublicOutcome,
        );
        const runtime = Object.freeze({
            runtime: Object.freeze({
                start: async (
                    _request: ManagedProviderStartRequest,
                    context: ManagedProviderRuntimeContext,
                ) => Object.freeze({
                    service: await context.managedServices.supervise(spec),
                    endpoints: Object.freeze([Object.freeze({
                        endpointTemplateId: 'chat',
                        endpoint: Object.freeze({
                            kind: 'servicePath' as const,
                            path: '/v1',
                        }),
                    })]),
                }),
            }),
            activationGeneration: scope.activationGeneration,
            immutableGenerationId: scope.immutableGenerationId,
            isCurrent: () => true,
        }) satisfies ResolvedManagedProviderRuntime;

        const result = await startPublicManagedProviderRuntime({
            identity: Object.freeze({
                pluginId: scope.pluginId,
                localId: scope.providerLocalId,
            }),
            request: Object.freeze({
                reason: 'sessionDemand' as const,
                connectionId: scope.runtimeBindingBasis.connectionId,
                connectionRevision: 1,
                endpointTemplateIds: Object.freeze(['chat']),
            }),
            acquireRuntime: async () => runtime,
            connectedAccounts: {} as never,
            custody: Object.freeze({
                managedServices: client.services,
                projectEndpointAccess: client.projectEndpointAccess,
                adoptService: client.commitAdoption,
                readAdoptedPublicOutcome,
            }),
            isAuthorizationCurrent: () => true,
            revalidateAuthorization: async () => true,
            signal: new AbortController().signal,
            launchResourceScope: createProviderLaunchResourceScope(),
        });

        expect(result).toEqual({
            ok: false,
            code: 'managed_provider_custody_adoption_failed',
        });
        expect(readAdoptedPublicOutcome).toHaveBeenCalledOnce();
        await expect(client.readAdoptedPublicOutcome()).resolves.toBeNull();
        expect(childDispose).toHaveBeenCalledOnce();
        await runner.dispose();
        expect(childDispose).toHaveBeenCalledOnce();
    });

    it('admits only one exact managed Provider adoption across distinct services and scopes', async () => {
        const disposeByServiceId = new Map<string, ReturnType<typeof vi.fn>>();
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) => {
                const dispose = vi.fn(async () => {});
                disposeByServiceId.set(requested.id, dispose);
                return Object.freeze({
                    ...handle(requested.id),
                    dispose,
                });
            }),
        }) satisfies ManagedServices;
        const retainAdoptedProviderAuthority = vi.fn(async () => true);
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async ({ service }) => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () =>
                        `http://127.0.0.1:4312/${service.snapshot().id}`,
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority,
            releaseAdoptedProviderAuthority: async () => true,
        });
        const p = providerScope(
            'session-single-provider',
            'provider-p',
            'bundled_first_party',
        );
        const q = providerScope('session-single-provider', 'provider-q');
        const pSpec = spec;
        const qSpec = Object.freeze({
            ...spec,
            id: 'provider-wrapper-q',
        });
        const pClient = createRunnerManagedServicesClient({
            scope: p,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const qClient = createRunnerManagedServicesClient({
            scope: q,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });

        const pService = await pClient.services.supervise(pSpec);
        await pClient.projectEndpointAccess({
            service: pService,
            endpoints: Object.freeze([{
                endpointTemplateId: 'messages',
                servicePath: '/v1/messages',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await pClient.commitAdoption(pSpec.id);

        const qService = await qClient.services.supervise(qSpec);
        await qClient.projectEndpointAccess({
            service: qService,
            endpoints: Object.freeze([{
                endpointTemplateId: 'messages',
                servicePath: '/v1/messages',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await expect(qClient.commitAdoption(qSpec.id)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });

        expect(retainAdoptedProviderAuthority).toHaveBeenCalledOnce();
        expect(retainAdoptedProviderAuthority).toHaveBeenCalledWith({
            pluginId: p.pluginId,
            immutableGenerationId: p.immutableGenerationId,
            manifestAuthority: 'bundled_first_party',
            hardRevocationRevisionAtAdmission: 0,
        });
        await expect(
            runner.readCurrentManagedProviderRetention(),
        ).resolves.toMatchObject({
            scope: {
                manifestAuthority: 'bundled_first_party',
            },
        });
        await expect(runner.readAdoptedPublicOutcome()).resolves.toMatchObject({
            operationClaimId: p.operationClaimId,
            serviceId: pSpec.id,
        });
        expect(disposeByServiceId.get(pSpec.id)).not.toHaveBeenCalled();
        expect(disposeByServiceId.get(qSpec.id)).toHaveBeenCalledOnce();
    });

    it('adopts every endpoint the Protocol lets one Provider declare', async () => {
        const endpointTemplateIds = Object.freeze(
            Array.from(
                {
                    length: PROVIDER_WIRE_PROTOCOL_LIMITS_V1
                        .maxProtocolsPerDeclaration,
                },
                (_unused, index) => `endpoint-${index}`,
            ),
        );
        const endpoints = Object.freeze(endpointTemplateIds.map(
            (endpointTemplateId) => Object.freeze({
                endpointTemplateId,
                servicePath: `/${endpointTemplateId}`,
            }),
        ));
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) =>
                handle(requested.id)),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: (endpointTemplateId: string): string | null =>
                        `http://127.0.0.1:4312/${endpointTemplateId}`,
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority: async () => true,
        });
        const scope = providerScope('session-wide-fan', 'provider-wide');
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });

        const service = await client.services.supervise(spec);
        const projected = await client.projectEndpointAccess({
            service,
            endpoints,
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await client.commitAdoption(spec.id);

        const outcome = await runner.readAdoptedPublicOutcome();

        expect(endpointTemplateIds.length).toBeGreaterThan(4);
        expect(projected).not.toBeNull();
        expect(outcome).toMatchObject({
            serviceId: spec.id,
            endpointTemplateIds: [...endpointTemplateIds],
            endpoints: endpoints.map((endpoint) => ({
                ...endpoint,
                endpointUrl: `http://127.0.0.1:4312${endpoint.servicePath}`,
            })),
            endpointAccess: 'runnerProjected',
        });
        // The custody wire is the boundary the daemon actually crosses, so the
        // full-width projection request and adopted outcome must survive it.
        expect(RunnerManagedServicesCustodyRequestV1Schema.safeParse({
            v: 1,
            kind: 'projectEndpointAccess',
            claim: providerClaim(scope),
            serviceId: spec.id,
            endpoints,
        }).success).toBe(true);
        expect(RunnerManagedServicesCustodyResultV1Schema.safeParse({
            v: 1,
            kind: 'adoptedPublicOutcome',
            outcome,
        }).success).toBe(true);
    });

    it('linearizes concurrent adoption claims that share one retained authority tuple', async () => {
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) =>
                handle(requested.id)),
        }) satisfies ManagedServices;
        const firstRetentionEntered = deferred<void>();
        const releaseFirstRetention = deferred<void>();
        let retentionCalls = 0;
        const retainAdoptedProviderAuthority = vi.fn(async () => {
            retentionCalls += 1;
            if (retentionCalls === 1) {
                firstRetentionEntered.resolve();
                await releaseFirstRetention.promise;
            }
            return true;
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
            projectEndpointAccess: async ({ service }) => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () =>
                        `http://127.0.0.1:4312/${service.snapshot().id}`,
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority,
            releaseAdoptedProviderAuthority: async () => true,
        });
        const p = providerScope(
            'session-concurrent-provider',
            'shared-generation',
        );
        const q = Object.freeze({
            ...p,
            runtimeBindingBasis: managedRuntimeBindingBasis(
                p.pluginId,
                p.providerLocalId,
                'connection-concurrent-q',
            ),
            operationClaimId:
                'session-demand:session-concurrent-provider:q',
        });
        const pSpec = Object.freeze({ ...spec, id: 'provider-wrapper-p' });
        const qSpec = Object.freeze({ ...spec, id: 'provider-wrapper-q' });
        const pClient = createRunnerManagedServicesClient({
            scope: p,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const qClient = createRunnerManagedServicesClient({
            scope: q,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const prepare = async (
            client: typeof pClient,
            requestedSpec: ManagedServiceSpec,
        ) => {
            const service = await client.services.supervise(requestedSpec);
            await client.projectEndpointAccess({
                service,
                endpoints: Object.freeze([{
                    endpointTemplateId: 'messages',
                    servicePath: '/v1/messages',
                }]),
                signal: new AbortController().signal,
                isCurrent: () => true,
            });
        };
        await prepare(pClient, pSpec);
        await prepare(qClient, qSpec);

        const pCommit = pClient.commitAdoption(pSpec.id);
        await firstRetentionEntered.promise;
        const qCommit = qClient.commitAdoption(qSpec.id);
        await Promise.resolve();
        releaseFirstRetention.resolve();
        const outcomes = await Promise.allSettled([pCommit, qCommit]);

        expect(outcomes.filter((outcome) =>
            outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) =>
            outcome.status === 'rejected')).toEqual([
            expect.objectContaining({
                reason: expect.objectContaining({
                    code: 'plugin_managed_service_unavailable',
                }),
            }),
        ]);
        expect(retainAdoptedProviderAuthority).toHaveBeenCalledOnce();
        await runner.dispose();
    });

    it('does not publish adoption when P hard-revokes during successful authority retention', async () => {
        let hardRevocationRevision = 0;
        const retainAdoptedProviderAuthority = vi.fn(async () => {
            await Promise.resolve();
            hardRevocationRevision = 1;
            return true;
        });
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => handle(spec.id)),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () =>
                hardRevocationRevision,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: vi.fn(async () => {}),
            }),
            retainAdoptedProviderAuthority,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-adoption-final-hard-revocation',
            'provider-p',
        );
        const client = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await client.services.supervise(spec);
        await client.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'messages',
                servicePath: '/v1/messages',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });

        await expect(client.commitAdoption(spec.id)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(retainAdoptedProviderAuthority).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledWith({
            pluginId: scope.pluginId,
            immutableGenerationId: scope.immutableGenerationId,
            manifestAuthority: scope.manifestAuthority,
            hardRevocationRevisionAtAdmission: 0,
        });
        await expect(runner.readCurrentManagedProviderRetention())
            .resolves.toBeNull();
        await expect(runner.readAdoptedPublicOutcome()).resolves.toBeNull();
        await runner.dispose();
    });

    it('rejects terminal reuse and settles runner-lifetime cleanup exactly once', async () => {
        let current = snapshot(spec.id);
        const dispose = vi.fn(async () => {});
        const ownedHandle: ManagedServiceHandle = Object.freeze({
            snapshot: () => current,
            observe(listener: (snapshot: ManagedServiceSnapshot) => void) {
                listener(current);
                return Object.freeze({ dispose() {} });
            },
            waitUntilHealthy: async () => current,
            async request() {
                throw new Error('Unexpected managed service request');
            },
            async stop() {
                current = Object.freeze({ ...current, state: 'stopped' });
                return Object.freeze({ status: 'stopped' as const });
            },
            dispose,
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                dependencies: {} as never,
                supervise: async () => ownedHandle,
            })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope('session-existing', 'provider-p');
        const established = await runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        expect(established).toMatchObject({
            kind: 'handle',
            custodyScope: scope,
        });
        await runner.dispatch({
            v: 1,
            kind: 'stop',
            claim: providerClaim(scope),
            serviceId: spec.id,
        });
        await expect(runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_not_reusable',
        });

        await runner.dispose();
        await runner.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
        await expect(runner.dispatch({
            v: 1,
            kind: 'adopt',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('aggregates permanent cleanup failures and retries only retained failed entries', async () => {
        const firstFailure = new Error('first retained cleanup failed');
        const secondFailure = new Error('second retained cleanup failed');
        const firstDispose = vi.fn()
            .mockRejectedValueOnce(firstFailure)
            .mockResolvedValueOnce(undefined);
        const secondDispose = vi.fn()
            .mockRejectedValueOnce(secondFailure)
            .mockResolvedValueOnce(undefined);
        const successfulDispose = vi.fn(async () => undefined);
        const disposals = new Map([
            ['provider-one', firstDispose],
            ['provider-two', secondDispose],
            ['provider-three', successfulDispose],
        ]);
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) =>
                Object.freeze({
                    ...handle(requested.id),
                    dispose: disposals.get(requested.id)!,
                })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope(
            'session-cleanup-retry',
            'provider-generation',
        );

        for (const id of disposals.keys()) {
            await runner.dispatch({
                v: 1,
                kind: 'supervise',
                scope,
                spec: Object.freeze({ ...spec, id }),
            });
        }

        let firstError: unknown;
        try {
            await runner.dispose();
        } catch (error) {
            firstError = error;
        }
        expect(firstError).toBeInstanceOf(AggregateError);
        expect(firstError).toEqual(sanitizedCleanupAggregate(2));

        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(firstDispose).toHaveBeenCalledTimes(2);
        expect(secondDispose).toHaveBeenCalledTimes(2);
        expect(successfulDispose).toHaveBeenCalledOnce();
    });

    it('fences hard-revoked handle exposure while preserving exact cleanup', async () => {
        let currentRevision = 7;
        const dispose = vi.fn(async () => {});
        const stop = vi.fn(async () =>
            Object.freeze({ status: 'stopped' as const }));
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            stop,
            dispose,
        }) satisfies ManagedServiceHandle;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => ownedHandle),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
        });
        const scope = providerScope('session-existing', 'provider-p');
        const daemonA = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemonA.services.supervise(spec);

        currentRevision = 8;
        const daemonB = createRunnerManagedServicesClient({
            claim: providerClaim(scope),
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        await expect(daemonB.adopt(spec.id)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(service.waitUntilHealthy()).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });

        await expect(service.stop()).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await service.dispose();
        await service.dispose();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('checks retained Provider generation integrity under its exact manifest authority', async () => {
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) =>
                handle(requested.id)),
        }) satisfies ManagedServices;
        const expectedAuthorityByGeneration = new Map<
            string,
            'external' | 'bundled_first_party'
        >([
            ['bundled-provider-p', 'bundled_first_party'],
            ['external-provider-p', 'external'],
        ]);
        const readGenerationCurrentness = vi.fn((authority: Readonly<{
            pluginId: string;
            immutableGenerationId: string;
            manifestAuthority: 'external' | 'bundled_first_party';
        }>) => expectedAuthorityByGeneration.get(
            authority.immutableGenerationId,
        ) === authority.manifestAuthority);
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            readCurrentProviderImmutableGenerationIntegrityCurrentness:
                readGenerationCurrentness,
        });
        const bundledScope = providerScope(
            'session-bundled-provider-p',
            'bundled-provider-p',
            'bundled_first_party',
        );
        const externalScope = providerScope(
            'session-external-provider-p',
            'external-provider-p',
            'external',
        );
        const mismatchedExternalScope = providerScope(
            'session-mismatched-provider-p',
            'bundled-provider-p',
            'external',
        );

        await expect(runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope: bundledScope,
            spec: Object.freeze({ ...spec, id: 'bundled-wrapper' }),
        })).resolves.toMatchObject({ kind: 'handle' });
        await expect(runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope: externalScope,
            spec: Object.freeze({ ...spec, id: 'external-wrapper' }),
        })).resolves.toMatchObject({ kind: 'handle' });
        await expect(runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope: mismatchedExternalScope,
            spec: Object.freeze({ ...spec, id: 'mismatched-wrapper' }),
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(readGenerationCurrentness).toHaveBeenCalledWith(
            {
                pluginId: bundledScope.pluginId,
                immutableGenerationId:
                    bundledScope.immutableGenerationId,
                manifestAuthority: bundledScope.manifestAuthority,
            },
        );
        expect(readGenerationCurrentness).toHaveBeenCalledWith(
            {
                pluginId: externalScope.pluginId,
                immutableGenerationId:
                    externalScope.immutableGenerationId,
                manifestAuthority: externalScope.manifestAuthority,
            },
        );
    });

    it('proactively fences an adopted Provider on the authenticated hard-revocation channel', async () => {
        let currentRevision = 7;
        const childDispose = vi.fn(async () => {});
        const projectionCleanup = vi.fn(async () => {});
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            dispose: childDispose,
        }) satisfies ManagedServiceHandle;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => ownedHandle),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-proactive-hard-revocation',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        const handler = registerCustodyHandler(runner);

        await expect(handler({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        })).resolves.toEqual({
            v: 1,
            kind: 'hardRevocationFenced',
            fencedServiceCount: 0,
        });
        expect(childDispose).not.toHaveBeenCalled();

        currentRevision = 8;
        await expect(handler({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        })).resolves.toEqual({
            v: 1,
            kind: 'hardRevocationFenced',
            fencedServiceCount: 1,
        });
        await expect(runner.readAdoptedPublicOutcome()).resolves.toBeNull();
        await expect(
            runner.readCurrentManagedProviderRetention(),
        ).resolves.toBeNull();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(childDispose).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
        await expect(service.waitUntilHealthy()).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('fences the exact retained Provider after daemon-observed live-policy revocation', async () => {
        const childDispose = vi.fn(async () => {});
        const projectionCleanup = vi.fn(async () => {});
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            dispose: childDispose,
        }) satisfies ManagedServiceHandle;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => ownedHandle),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-retained-policy-revocation',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        const handler = registerCustodyHandler(runner);

        await expect(handler({
            v: 1,
            kind: 'fenceRetainedProviderPolicy',
            claim: providerClaim(scope),
        })).resolves.toEqual({
            v: 1,
            kind: 'retainedProviderPolicyFenced',
            fencedServiceCount: 1,
        });

        await expect(runner.readAdoptedPublicOutcome()).resolves.toBeNull();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(childDispose).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
        await expect(service.waitUntilHealthy()).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('retries only unfinished retained-Provider policy-fence cleanup', async () => {
        const childDispose = vi.fn(async () => undefined);
        const projectionCleanup = vi.fn(async () => undefined);
        const releaseAdoptedProviderAuthority = vi.fn(async () =>
            releaseAdoptedProviderAuthority.mock.calls.length > 1);
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            dispose: childDispose,
        }) satisfies ManagedServiceHandle;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => ownedHandle),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-retained-policy-fence-cleanup-retry',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        const handler = registerCustodyHandler(runner);
        const request = {
            v: 1 as const,
            kind: 'fenceRetainedProviderPolicy' as const,
            claim: providerClaim(scope),
        };

        await expect(handler(request)).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        expect(childDispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();

        await expect(handler(request)).resolves.toEqual({
            v: 1,
            kind: 'retainedProviderPolicyFenced',
            fencedServiceCount: 1,
        });
        expect(childDispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledTimes(2);
        await expect(runner.readAdoptedPublicOutcome()).resolves.toBeNull();
        await expect(
            runner.readCurrentManagedProviderRetention(),
        ).resolves.toBeNull();
    });

    it('fences only the named immutable Provider generation when plugin-wide authority remains current', async () => {
        const disposeG1 = vi.fn(async () => {});
        const disposeG2 = vi.fn(async () => {});
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requestedSpec) => Object.freeze({
                ...handle(requestedSpec.id),
                dispose: requestedSpec.id === 'provider-g1'
                    ? disposeG1
                    : disposeG2,
            })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            readCurrentProviderImmutableGenerationIntegrityCurrentness:
                () => true,
        });
        const scopeG1 = providerScope(
            'session-exact-provider-hard-revocation',
            'provider-g1',
        );
        const scopeG2 = {
            ...scopeG1,
            activationGeneration: '2',
            immutableGenerationId: 'provider-g2',
            operationClaimId:
                'session-provider-claim-provider-g2',
        };
        const daemonG1 = createRunnerManagedServicesClient({
            scope: scopeG1,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const daemonG2 = createRunnerManagedServicesClient({
            scope: scopeG2,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const specG1 = { ...spec, id: 'provider-g1' };
        const specG2 = { ...spec, id: 'provider-g2' };
        const serviceG1 = await daemonG1.services.supervise(specG1);
        const serviceG2 = await daemonG2.services.supervise(specG2);
        await expect(runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scopeG1.pluginId,
            immutableGenerationId: scopeG1.immutableGenerationId,
        })).resolves.toEqual({
            v: 1,
            kind: 'hardRevocationFenced',
            fencedServiceCount: 1,
        });

        expect(disposeG1).toHaveBeenCalledOnce();
        expect(disposeG2).not.toHaveBeenCalled();
        await expect(serviceG1.waitUntilHealthy()).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(serviceG2.waitUntilHealthy()).resolves.toMatchObject({
            id: specG2.id,
            state: 'healthy',
        });
    });

    it('aggregates hard-revocation cleanup failures and retries only retained entries', async () => {
        const firstFailure = new Error(
            'first hard-revoked cleanup failed',
        );
        const secondFailure = new Error(
            'second hard-revoked cleanup failed',
        );
        const firstDispose = vi.fn()
            .mockRejectedValueOnce(firstFailure)
            .mockResolvedValueOnce(undefined);
        const secondDispose = vi.fn()
            .mockRejectedValueOnce(secondFailure)
            .mockResolvedValueOnce(undefined);
        const successfulDispose = vi.fn(async () => undefined);
        const disposals = new Map([
            ['hard-revoked-one', firstDispose],
            ['hard-revoked-two', secondDispose],
            ['hard-revoked-three', successfulDispose],
        ]);
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async (requested: ManagedServiceSpec) =>
                Object.freeze({
                    ...handle(requested.id),
                    dispose: disposals.get(requested.id)!,
                })),
        }) satisfies ManagedServices;
        let currentRevision = 0;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 0),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
        });
        const scope = providerScope(
            'session-hard-revocation-cleanup',
            'provider-p',
        );
        for (const id of disposals.keys()) {
            await runner.dispatch({
                v: 1,
                kind: 'supervise',
                scope,
                spec: Object.freeze({ ...spec, id }),
            });
        }

        currentRevision = 1;
        await expect(runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        })).rejects.toEqual(sanitizedCleanupAggregate(2));

        await expect(runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        })).resolves.toEqual({
            v: 1,
            kind: 'hardRevocationFenced',
            fencedServiceCount: 2,
        });
        expect(firstDispose).toHaveBeenCalledTimes(2);
        expect(secondDispose).toHaveBeenCalledTimes(2);
        expect(successfulDispose).toHaveBeenCalledOnce();
    });

    it('proactively cleans an idle direct-access Provider before adoption', async () => {
        let currentRevision = 7;
        const childDispose = vi.fn(async () => {});
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            dispose: childDispose,
        }) satisfies ManagedServiceHandle;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => ownedHandle),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
        });
        const scope = providerScope(
            'session-idle-hard-revocation',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        expect(service.snapshot()).toMatchObject({
            id: spec.id,
        });

        currentRevision = 8;
        await expect(runner.dispatch({
            v: 1,
            kind: 'fenceHardRevocation',
            pluginId: scope.pluginId,
        })).resolves.toEqual({
            v: 1,
            kind: 'hardRevocationFenced',
            fencedServiceCount: 1,
        });
        expect(childDispose).toHaveBeenCalledOnce();
        await expect(service.waitUntilHealthy()).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(daemon.adopt(spec.id)).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('retries only the failed retained-P release after owner cleanup closes custody', async () => {
        let authorityRetained = false;
        const projectionCleanup = vi.fn(async () => {});
        const releaseAdoptedProviderAuthority = vi.fn(async () => {
            if (releaseAdoptedProviderAuthority.mock.calls.length === 1) {
                return false;
            }
            authorityRetained = false;
            return true;
        });
        const dispose = vi.fn(async () => {});
        const ownedHandle = Object.freeze({
            ...handle(spec.id),
            dispose,
        }) satisfies ManagedServiceHandle;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => ownedHandle),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => {
                authorityRetained = true;
                return true;
            },
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope('session-cleanup-retry', 'provider-p');
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);
        expect(authorityRetained).toBe(true);

        await expect(runner.dispose()).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        expect(authorityRetained).toBe(true);
        expect(dispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();

        await expect(runner.dispose()).resolves.toBeUndefined();
        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(authorityRetained).toBe(false);
        expect(dispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledTimes(2);
        const retainedAuthority = {
            pluginId: scope.pluginId,
            immutableGenerationId: scope.immutableGenerationId,
            manifestAuthority: scope.manifestAuthority,
            hardRevocationRevisionAtAdmission: 7,
        };
        expect(releaseAdoptedProviderAuthority)
            .toHaveBeenNthCalledWith(1, retainedAuthority);
        expect(releaseAdoptedProviderAuthority)
            .toHaveBeenNthCalledWith(2, retainedAuthority);
    });

    it('retains P until every earlier cleanup phase succeeds', async () => {
        const cleanupFailure = new Error('owned process termination failed');
        const projectionCleanup = vi.fn(async () => {});
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const dispose = vi.fn(async () => {
            if (dispose.mock.calls.length === 1) throw cleanupFailure;
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => Object.freeze({
                ...handle(spec.id),
                dispose,
            })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-cleanup-before-release',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);

        await expect(runner.dispose()).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        expect(dispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).not.toHaveBeenCalled();

        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledWith({
            pluginId: scope.pluginId,
            immutableGenerationId: scope.immutableGenerationId,
            manifestAuthority: scope.manifestAuthority,
            hardRevocationRevisionAtAdmission: 7,
        });
    });

    it('flattens and sanitizes every failed cleanup while retrying only incomplete steps', async () => {
        const projectionFailure = new Error(
            'secret endpoint projection cleanup detail',
        );
        const handleFailure = new Error(
            'secret owned handle cleanup detail',
        );
        const projectionCleanup = vi.fn()
            .mockRejectedValueOnce(new AggregateError([
                projectionFailure,
            ], 'secret projection aggregate detail'))
            .mockResolvedValueOnce(undefined);
        const successfulDispose = vi.fn(async () => undefined);
        const failedDispose = vi.fn()
            .mockRejectedValueOnce(new AggregateError([
                handleFailure,
            ], 'secret handle aggregate detail'))
            .mockResolvedValueOnce(undefined);
        let superviseCount = 0;
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => Object.freeze({
                ...handle(spec.id),
                dispose: ++superviseCount === 1
                    ? successfulDispose
                    : failedDispose,
            })),
        }) satisfies ManagedServices;
        const releaseAdoptedProviderAuthority = vi.fn(async () => true);
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services, 7),
            readCurrentProviderPluginHardRevocationRevision: () => 7,
            projectEndpointAccess: async () => Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:4312/v1',
                    request: vi.fn(),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
            retainAdoptedProviderAuthority: async () => true,
            releaseAdoptedProviderAuthority,
        });
        const scope = providerScope(
            'session-multiple-cleanup-failures',
            'provider-p',
        );
        const daemon = createRunnerManagedServicesClient({
            scope,
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await daemon.services.supervise(spec);
        await daemon.services.supervise(spec);
        await daemon.projectEndpointAccess({
            service,
            endpoints: Object.freeze([{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }]),
            signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await daemon.commitAdoption(spec.id);

        let retirementError: unknown;
        try {
            await runner.dispose();
        } catch (error) {
            retirementError = error;
        }
        expect(retirementError).toBeInstanceOf(AggregateError);
        const cleanupErrors = (retirementError as AggregateError).errors;
        expect(cleanupErrors).toEqual([
            expect.objectContaining({
                code: 'plugin_managed_service_establishment_failed',
                message: 'Runner managed-service cleanup failed',
            }),
            expect.objectContaining({
                code: 'plugin_managed_service_establishment_failed',
                message: 'Runner managed-service cleanup failed',
            }),
        ]);
        expect(JSON.stringify(cleanupErrors)).not.toContain('secret');
        expect(successfulDispose).toHaveBeenCalledOnce();
        expect(releaseAdoptedProviderAuthority).not.toHaveBeenCalled();

        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(projectionCleanup).toHaveBeenCalledTimes(2);
        expect(successfulDispose).toHaveBeenCalledOnce();
        expect(failedDispose).toHaveBeenCalledTimes(2);
        expect(releaseAdoptedProviderAuthority).toHaveBeenCalledOnce();
    });

    it('retries a failed client-handle disposal dispatch', async () => {
        const cleanupFailure = new Error('owned process termination failed');
        const dispose = vi.fn(async () => {
            if (dispose.mock.calls.length === 1) throw cleanupFailure;
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise: vi.fn(async () => Object.freeze({
                ...handle(spec.id),
                dispose,
            })),
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const client = createRunnerManagedServicesClient({
            scope: providerScope('session-client-cleanup-retry', 'provider-p'),
            dependencies: services.dependencies,
            dispatch: runner.dispatch,
        });
        const service = await client.services.supervise(spec);

        await expect(service.dispose()).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        await expect(service.dispose()).resolves.toBeUndefined();
        await expect(service.dispose()).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(2);
        await runner.dispose();
    });

    it('cleans a late establishment when its only caller abandons the result', async () => {
        const establishment = deferred<ManagedServiceHandle>();
        const dispose = vi.fn(async () => {});
        let establishmentSignal: AbortSignal | undefined;
        const lateHandle = Object.freeze({
            ...handle(spec.id),
            dispose,
        }) satisfies ManagedServiceHandle;
        const supervise = vi.fn(async (
            _spec: ManagedServiceSpec,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            establishmentSignal = options?.signal;
            return await establishment.promise;
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                dependencies: {} as never,
                supervise,
            })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope('session-existing', 'provider-p');
        const caller = new AbortController();
        const pending = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        }, { signal: caller.signal });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
        caller.abort();
        await expect(pending).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(establishmentSignal?.aborted).toBe(true);

        establishment.resolve(lateHandle);
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
        await expect(runner.dispatch({
            v: 1,
            kind: 'adopt',
            claim: providerClaim(scope),
            serviceId: spec.id,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('retains a failed late-handle cleanup for permanent-disposal retry', async () => {
        const establishment = deferred<ManagedServiceHandle>();
        const lateCleanupFailure = new Error(
            'late handle cleanup failed',
        );
        const lateDispose = vi.fn()
            .mockRejectedValueOnce(lateCleanupFailure)
            .mockResolvedValueOnce(undefined);
        const successfulDispose = vi.fn(async () => undefined);
        const supervise = vi.fn(async (requested: ManagedServiceSpec) => {
            if (requested.id === 'late-provider') {
                return await establishment.promise;
            }
            return Object.freeze({
                ...handle(requested.id),
                dispose: successfulDispose,
            });
        });
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope(
            'session-late-cleanup-retry',
            'provider-p',
        );
        await runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec: Object.freeze({ ...spec, id: 'successful-provider' }),
        });
        const caller = new AbortController();
        const pending = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec: Object.freeze({ ...spec, id: 'late-provider' }),
        }, { signal: caller.signal });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledTimes(2));
        caller.abort();
        await expect(pending).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });

        const retirement = runner.dispose();
        establishment.resolve(Object.freeze({
            ...handle('late-provider'),
            dispose: lateDispose,
        }));
        await expect(retirement).rejects.toEqual(
            sanitizedCleanupAggregate(1),
        );
        expect(successfulDispose).toHaveBeenCalledOnce();
        expect(lateDispose).toHaveBeenCalledOnce();

        await expect(runner.dispose()).resolves.toBeUndefined();
        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(successfulDispose).toHaveBeenCalledOnce();
        expect(lateDispose).toHaveBeenCalledTimes(2);
    });

    it('retains a failed authority-fenced handle cleanup before exposure', async () => {
        const establishment = deferred<ManagedServiceHandle>();
        const cleanupFailure = new Error(
            'authority-fenced handle cleanup failed',
        );
        const dispose = vi.fn()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        let currentRevision = 0;
        const supervise = vi.fn(async () =>
            await establishment.promise);
        const services = Object.freeze({
            dependencies: {} as ManagedDependenciesService,
            supervise,
        }) satisfies ManagedServices;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(services),
            readCurrentProviderPluginHardRevocationRevision: () =>
                currentRevision,
        });
        const scope = providerScope(
            'session-authority-cleanup-retry',
            'provider-p',
        );
        const pending = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
        currentRevision = 1;
        establishment.resolve(Object.freeze({
            ...handle(spec.id),
            dispose,
        }));

        let establishmentError: unknown;
        try {
            await pending;
        } catch (error) {
            establishmentError = error;
        }
        expect(establishmentError).toBeInstanceOf(AggregateError);
        expect((establishmentError as AggregateError).errors).toEqual([
            expect.objectContaining({
                code: 'plugin_managed_service_unavailable',
            }),
            expect.objectContaining({
                code: 'plugin_managed_service_establishment_failed',
                message: 'Runner managed-service cleanup failed',
            }),
        ]);

        await expect(runner.dispose()).resolves.toBeUndefined();
        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('aggregates rejected post-supervise authority cleanup during permanent disposal', async () => {
        const postSuperviseRevision = deferred<number>();
        const cleanupFailure = new Error(
            '/private/authority-cleanup-token',
        );
        const dispose = vi.fn()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        let superviseReturned = false;
        let deferFinalRevisionRead = false;
        let finalRevisionReadRequested = false;
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise: async () => {
                        superviseReturned = true;
                        return Object.freeze({
                            ...handle(spec.id),
                            dispose,
                        });
                    },
                })),
            readCurrentProviderPluginHardRevocationRevision: () => {
                if (deferFinalRevisionRead) {
                    deferFinalRevisionRead = false;
                    finalRevisionReadRequested = true;
                    return postSuperviseRevision.promise;
                }
                return 0;
            },
            readCurrentProviderImmutableGenerationIntegrityCurrentness: () => {
                if (superviseReturned) {
                    deferFinalRevisionRead = true;
                }
                return true;
            },
        });
        const scope = providerScope(
            'session-authority-permanent-cleanup',
            'provider-p',
        );
        const pending = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        });
        await vi.waitFor(() =>
            expect(finalRevisionReadRequested).toBe(true));

        const firstDisposal = runner.dispose();
        postSuperviseRevision.resolve(1);

        await expect(pending).rejects.toBeInstanceOf(AggregateError);
        await expect(firstDisposal).rejects.toEqual(
            sanitizedCleanupAggregate(2),
        );
        expect(dispose).toHaveBeenCalledOnce();

        await expect(runner.dispose()).resolves.toBeUndefined();
        await expect(runner.dispose()).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('keeps a shared establishment alive while another waiter still owns it', async () => {
        const establishment = deferred<ManagedServiceHandle>();
        let establishmentSignal: AbortSignal | undefined;
        const supervise = vi.fn(async (
            _spec: ManagedServiceSpec,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            establishmentSignal = options?.signal;
            return await establishment.promise;
        });
        const runner = createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: () =>
                supervisionAdmission(Object.freeze({
                    dependencies: {} as never,
                    supervise,
                })),
            readCurrentProviderPluginHardRevocationRevision: () => 0,
        });
        const scope = providerScope('session-existing', 'provider-p');
        const first = new AbortController();
        const second = new AbortController();
        const pendingFirst = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        }, { signal: first.signal });
        const pendingSecond = runner.dispatch({
            v: 1,
            kind: 'supervise',
            scope,
            spec,
        }, { signal: second.signal });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());

        first.abort();
        await expect(pendingFirst).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(establishmentSignal?.aborted).toBe(false);

        establishment.resolve(handle(spec.id));
        await expect(pendingSecond).resolves.toMatchObject({
            kind: 'handle',
            custodyScope: scope,
        });
        expect(establishmentSignal?.aborted).toBe(false);
        await runner.dispose();
    });
});
