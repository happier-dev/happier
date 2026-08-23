import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ManagedExecutableRef,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ManagedServiceLocalId,
    ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ExecService,
    PluginProcessHandle,
    PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';

import {
    createManagedServiceProcessSupervisorHost,
    type ManagedServiceProcessHandle,
    type ManagedServiceProcessSupervisorHost,
} from './managedProcessSupervisor';
import type {
    ManagedProviderRuntimeInvocationBinding,
} from './managedServicesAdapter';
import { createManagedServicesOwner } from './managedServicesOwner';
import { associateSupervisedPluginProcessHandleForHost } from '../../exec/processSupervisor';

const CLEAN_EXIT: PluginProcessResult = Object.freeze({
    termination: Object.freeze({
        observed: Object.freeze({ kind: 'exit', exitCode: 0 }),
        requestedBy: Object.freeze({ kind: 'none' }),
    }),
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
});

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return Object.freeze({ promise, resolve });
}

function createProcess(
    pid: number,
    onDispose?: () => void | Promise<void>,
): PluginProcessHandle & Readonly<{
    dispose: ReturnType<typeof vi.fn>;
}> {
    const exit = deferred<PluginProcessResult>();
    const dispose = vi.fn(async () => {
        await onDispose?.();
        exit.resolve(CLEAN_EXIT);
    });
    const process = Object.freeze({
        write: vi.fn(async () => undefined),
        closeStdin: vi.fn(async () => undefined),
        wait: vi.fn(async () => await exit.promise),
        onOutput: vi.fn(() => Object.freeze({ dispose() {} })),
        dispose,
    });
    associateSupervisedPluginProcessHandleForHost(process, { pid });
    return process;
}

function createExec(input: Readonly<{
    spawn?: ExecService['spawn'];
    run?: ExecService['run'];
}> = {}): ExecService & Readonly<{
    spawn: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
}> {
    const spawn = vi.fn<ExecService['spawn']>(
        input.spawn ?? (async () => createProcess(8_700)),
    );
    const run = vi.fn<ExecService['run']>(
        input.run ?? (async () => CLEAN_EXIT),
    );
    // This is the genuine process boundary fixture; SVC09 exercises only spawn/run.
    return Object.freeze({ spawn, run }) as unknown as ExecService &
        Readonly<{
            spawn: ReturnType<typeof vi.fn>;
            run: ReturnType<typeof vi.fn>;
        }>;
}

type Placement = 'daemon' | 'runner';
type ReservePort = NonNullable<
    Parameters<typeof createManagedServiceProcessSupervisorHost>[0][
        'reservePort'
    ]
>;

function publicScope(placement: Placement) {
    return Object.freeze({
        generation: 'generation-public-features',
        pluginId: 'acme.providers',
        contributionQualifiedId:
            'acme.providers/providers/gateway',
        ...(placement === 'runner'
            ? { sessionId: 'session-public-features' }
            : { operationId: 'catalog-probe-public-features' }),
        isGenerationCurrent: () => true,
    });
}

function createPublicHarness(input: Readonly<{
    placement?: Placement;
    exec?: ExecService;
    fetch?: typeof globalThis.fetch;
    reservePort?: ReservePort;
}> = {}) {
    const placement = input.placement ?? 'daemon';
    const exec = input.exec ?? createExec();
    const processSupervisorHost = createManagedServiceProcessSupervisorHost({
        custodyOwner: placement === 'runner'
            ? 'sessionRunner'
            : 'daemon',
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.reservePort ? { reservePort: input.reservePort } : {}),
        ...(placement === 'runner'
            ? {
                authorizeRunnerSupervision: async (request) =>
                    request.mode === 'externalAttach'
                        ? Object.freeze({
                            mode: 'externalAttach' as const,
                        })
                        : Object.freeze({
                            mode: 'managedSpawn' as const,
                            launch: Object.freeze({
                                kind: 'daemonResolved' as const,
                                value: Object.freeze({
                                    command:
                                        '/fixture/managed-service',
                                }),
                            }),
                        }),
                installPreauthorizedSpawn: () => Object.freeze({
                    dispose() {},
                }),
            }
            : {}),
    });
    const owner = createManagedServicesOwner({
        processSupervisorHost,
        dependencies: Object.freeze({}) as never,
        resolveScope: (scope) => scope,
        ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    return Object.freeze({
        exec,
        owner,
        services: owner.bindScope(publicScope(placement), exec),
    });
}

const COMMAND_HEALTH_EXECUTABLE = Object.freeze({
    kind: 'managedDependency' as const,
    id: 'gateway-health',
}) satisfies ManagedExecutableRef;

describe('managed-services SVC09 public feature completeness', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    describe('external attach, command health, observation, and sharing', () => {
        it.each([
            ['daemon', 'attach'],
            ['runner', 'attach'],
            ['daemon', 'command'],
            ['runner', 'command'],
        ] as const)('keeps %s custody %s supervision on one public handle', async (
            placement,
            behavior,
        ) => {
            const process = createProcess(
                placement === 'runner' ? 8_711 : 8_710,
            );
            const exec = createExec({
                spawn: async () => process,
            });
            const harness = createPublicHarness({ placement, exec });
            const replacementBinding = harness.owner.bindScope(
                publicScope(placement),
                exec,
            );
            const spec: ManagedServiceSpec = behavior === 'attach'
                ? Object.freeze({
                    id: `attached-${placement}`,
                    mode: Object.freeze({
                        kind: 'attach' as const,
                        baseUrl: 'http://127.0.0.1:43120',
                    }),
                })
                : Object.freeze({
                    id: `command-${placement}`,
                    mode: Object.freeze({
                        kind: 'spawn' as const,
                        launch: Object.freeze({
                            executable: Object.freeze({
                                kind: 'systemTool' as const,
                                id: 'fixture-server',
                            }),
                            args: Object.freeze(['serve']),
                        }),
                        endpoint: Object.freeze({
                            kind: 'assignAndInject' as const,
                            port: Object.freeze({
                                kind: 'fixed' as const,
                                port: 43_121,
                            }),
                        }),
                    }),
                    healthCheck: Object.freeze({
                        kind: 'command' as const,
                        executable: COMMAND_HEALTH_EXECUTABLE,
                        args: Object.freeze(['probe', '--json']),
                        timeoutMs: 1_250,
                    }),
                });

            const [first, joined] = await Promise.all([
                harness.services.supervise(spec),
                replacementBinding.supervise(spec),
            ]);
            const observer = vi.fn();
            const currentAtSubscription = joined.snapshot();
            const observation = joined.observe(observer);

            expect(joined).toBe(first);
            expect(observer).toHaveBeenCalledOnce();
            expect(observer).toHaveBeenCalledWith(currentAtSubscription);
            expect(currentAtSubscription).toMatchObject({
                id: spec.id,
                state: behavior === 'attach' ? 'healthy' : 'starting',
                mode: behavior === 'attach' ? 'attach' : 'spawn',
            });

            const healthy = await joined.waitUntilHealthy();
            expect(healthy).toMatchObject({
                id: spec.id,
                state: 'healthy',
                mode: behavior === 'attach' ? 'attach' : 'spawn',
            });
            observation.dispose();

            const stopResult = await first.stop();
            expect(stopResult).toEqual({
                status: behavior === 'attach' ? 'detached' : 'stopped',
            });
            if (behavior === 'attach') {
                expect(exec.spawn).not.toHaveBeenCalled();
                expect(exec.run).not.toHaveBeenCalled();
            } else {
                expect(exec.spawn).toHaveBeenCalledOnce();
                expect(exec.run).toHaveBeenCalledWith({
                    executable: COMMAND_HEALTH_EXECUTABLE,
                    args: ['probe', '--json'],
                    timeoutMs: 1_250,
                }, expect.objectContaining({
                    signal: expect.any(AbortSignal),
                }));
                expect(process.dispose).toHaveBeenCalledOnce();
            }
        });
    });

    describe('owned-tree endpoint detection', () => {
        it('delegates the public detect-after-launch mode to the sole SVC09 owner', async () => {
            const legacySnapshot = Object.freeze({
                id: 'detected',
                instanceId: 'detected-instance',
                state: 'healthy' as const,
                mode: 'managedSpawn' as const,
                baseUrl: 'http://127.0.0.1:45120',
                port: 45_120,
                pid: 300,
                startedAtMs: 10,
                lastHealthyAtMs: 11,
                diagnostics: Object.freeze([]),
                diagnosticsTruncated: false,
            });
            const handle = Object.freeze({
                snapshot: () => legacySnapshot,
                observe: vi.fn((listener) => {
                    listener(legacySnapshot);
                    return Object.freeze({ dispose() {} });
                }),
                waitUntilHealthy: vi.fn(async () => legacySnapshot),
                stop: vi.fn(async () => Object.freeze({
                    status: 'stopped' as const,
                })),
                dispose: vi.fn(async () => undefined),
            }) satisfies ManagedServiceProcessHandle;
            const supervise = vi.fn(async () => handle);
            const processSupervisorHost = Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: vi.fn(() => Object.freeze({ supervise })),
            }) satisfies ManagedServiceProcessSupervisorHost;
            const owner = createManagedServicesOwner({
                processSupervisorHost,
                dependencies: Object.freeze({}) as never,
                resolveScope: (scope) => scope,
            });
            const services = owner.bindScope(
                publicScope('daemon'),
                createExec(),
            );

            const publicHandle = await services.supervise({
                id: 'detected',
                mode: {
                    kind: 'spawn',
                    launch: {
                        executable: {
                            kind: 'systemTool',
                            id: 'fixture-server',
                        },
                    },
                    endpoint: { kind: 'detectAfterLaunch' },
                },
            });

            expect(supervise).toHaveBeenCalledOnce();
            expect(publicHandle.snapshot()).toMatchObject({
                state: 'healthy',
                baseUrl: 'http://127.0.0.1:45120',
            });
            await publicHandle.dispose();
        });

    });

    describe('fixed and allocated port collision policy', () => {
        type SpawnSpec = Extract<
            ManagedServiceSpec,
            Readonly<{ mode: Readonly<{ kind: 'spawn' }> }>
        >;
        type AssignEndpoint = Extract<
            SpawnSpec['mode']['endpoint'],
            Readonly<{ kind: 'assignAndInject' }>
        >;

        function portSpec(
            id: string,
            port: AssignEndpoint['port'],
            host: '127.0.0.1' | '::1',
        ): ManagedServiceSpec {
            return Object.freeze({
                id,
                mode: Object.freeze({
                    kind: 'spawn' as const,
                    launch: Object.freeze({
                        executable: Object.freeze({
                            kind: 'systemTool' as const,
                            id: 'fixture-server',
                        }),
                    }),
                    endpoint: Object.freeze({
                        kind: 'assignAndInject' as const,
                        host,
                        port,
                        inject: Object.freeze({
                            portEnvironmentKey: 'PORT',
                        }),
                    }),
                }),
            });
        }

        it.each([
            [
                'fixed IPv4',
                'fixed-ipv4' satisfies ManagedServiceLocalId,
                'daemon' as const,
                '127.0.0.1' as const,
                {
                    kind: 'fixed' as const,
                    port: 43_130,
                    onCollision: 'fallback' as const,
                },
            ],
            [
                'fixed IPv6',
                'fixed-ipv6' satisfies ManagedServiceLocalId,
                'runner' as const,
                '::1' as const,
                {
                    kind: 'fixed' as const,
                    port: 43_130,
                    onCollision: 'fallback' as const,
                },
            ],
            [
                'allocated preferred IPv4',
                'allocated-preferred-ipv4' satisfies ManagedServiceLocalId,
                'runner' as const,
                '127.0.0.1' as const,
                {
                    kind: 'allocated' as const,
                    preferredPort: 43_130,
                    onCollision: 'fallback' as const,
                },
            ],
            [
                'allocated preferred IPv6',
                'allocated-preferred-ipv6' satisfies ManagedServiceLocalId,
                'daemon' as const,
                '::1' as const,
                {
                    kind: 'allocated' as const,
                    preferredPort: 43_130,
                    onCollision: 'fallback' as const,
                },
            ],
        ] as const)('falls back from a colliding %s port before spawn', async (
            _label,
            fixtureId,
            placement,
            host,
            policy,
        ) => {
            const occupiedPort = 43_130;
            const fallbackPort = 53_130;
            let nextPid = 8_720;
            const spawnedPorts: number[] = [];
            const processes: ReturnType<typeof createProcess>[] = [];
            const exec = createExec({
                spawn: async (request) => {
                    const port = Number(request.env?.PORT);
                    spawnedPorts.push(port);
                    const process = createProcess(++nextPid);
                    processes.push(process);
                    return process;
                },
            });
            const releases: ReturnType<typeof vi.fn>[] = [];
            const reservePort = vi.fn(async (
                candidateHost: '127.0.0.1' | '::1',
                preferredPort?: number,
            ) => {
                if (preferredPort === occupiedPort) {
                    throw Object.assign(new Error('occupied'), {
                        code: 'EADDRINUSE',
                    });
                }
                const release = vi.fn(async () => undefined);
                releases.push(release);
                return Object.freeze({
                    host: candidateHost,
                    port: fallbackPort,
                    release,
                });
            });
            const harness = createPublicHarness({
                exec,
                placement,
                reservePort,
            });

            const first = await harness.services.supervise(
                portSpec(`${fixtureId}-fallback`, policy, host),
            );
            const expectedBaseUrl = host === '::1'
                ? `http://[::1]:${fallbackPort}`
                : `http://127.0.0.1:${fallbackPort}`;
            expect(first.snapshot()).toMatchObject({
                state: 'healthy',
                baseUrl: expectedBaseUrl,
            });
            await first.dispose();

            const reused = await harness.services.supervise(
                portSpec(`${fixtureId}-fallback-reused`, policy, host),
            );
            expect(reused.snapshot()).toMatchObject({
                state: 'healthy',
                baseUrl: expectedBaseUrl,
            });
            await reused.dispose();

            expect(reservePort).toHaveBeenCalledTimes(4);
            expect(reservePort).toHaveBeenCalledWith(
                host,
                occupiedPort,
                expect.any(AbortSignal),
            );
            expect(releases).toHaveLength(2);
            for (const release of releases) {
                expect(release).toHaveBeenCalledOnce();
            }
            expect(spawnedPorts).toEqual([fallbackPort, fallbackPort]);
            expect(processes).toHaveLength(2);
            for (const process of processes) {
                expect(process.dispose).toHaveBeenCalledOnce();
            }
        });

        it.each([
            [
                'fixed IPv4',
                'fixed-ipv4' satisfies ManagedServiceLocalId,
                'daemon' as const,
                '127.0.0.1' as const,
                {
                    kind: 'fixed' as const,
                    port: 43_131,
                    onCollision: 'fail' as const,
                },
            ],
            [
                'fixed IPv6',
                'fixed-ipv6' satisfies ManagedServiceLocalId,
                'runner' as const,
                '::1' as const,
                {
                    kind: 'fixed' as const,
                    port: 43_131,
                    onCollision: 'fail' as const,
                },
            ],
            [
                'allocated preferred IPv4',
                'allocated-preferred-ipv4' satisfies ManagedServiceLocalId,
                'runner' as const,
                '127.0.0.1' as const,
                {
                    kind: 'allocated' as const,
                    preferredPort: 43_131,
                    onCollision: 'fail' as const,
                },
            ],
            [
                'allocated preferred IPv6',
                'allocated-preferred-ipv6' satisfies ManagedServiceLocalId,
                'daemon' as const,
                '::1' as const,
                {
                    kind: 'allocated' as const,
                    preferredPort: 43_131,
                    onCollision: 'fail' as const,
                },
            ],
        ] as const)('does not fall back from a colliding %s port when policy is fail', async (
            _label,
            fixtureId,
            placement,
            host,
            policy,
        ) => {
            const exec = createExec();
            const reservePort = vi.fn(async () => {
                throw Object.assign(new Error('occupied'), {
                    code: 'EADDRINUSE',
                });
            });
            const harness = createPublicHarness({
                exec,
                placement,
                reservePort,
            });

            await expect(harness.services.supervise(
                portSpec(`${fixtureId}-fail`, policy, host),
            )).rejects.toMatchObject({
                code: 'plugin_managed_service_establishment_failed',
            });
            expect(exec.spawn).not.toHaveBeenCalled();
            expect(reservePort).toHaveBeenCalledWith(
                host,
                43_131,
                expect.any(AbortSignal),
            );
        });
    });

    describe('managed Provider request-header leases', () => {
        it.each([
            [
                'providerRequests',
                'provider-requests' satisfies ManagedServiceLocalId,
                null,
            ],
            [
                'healthAndProviderRequests',
                'health-and-provider-requests' satisfies ManagedServiceLocalId,
                'Bearer credential-a',
            ],
        ] as const)('rotates %s without restarting the owned service', async (
            target,
            fixtureId,
            initialHealthAuthorization,
        ) => {
            vi.useFakeTimers();
            const requests: Array<Readonly<{
                url: string;
                authorization: string | null;
            }>> = [];
            const hostFetch = vi.fn<typeof globalThis.fetch>(async (
                request: string | URL | Request,
                init?: RequestInit,
            ) => {
                requests.push(Object.freeze({
                    url: request.toString(),
                    authorization: new Headers(init?.headers)
                        .get('authorization'),
                }));
                return new Response('{}', { status: 200 });
            });
            const process = createProcess(8_730);
            const exec = createExec({ spawn: async () => process });
            const credentialLease = createRotatingHeaderLease();
            const harness = createPublicHarness({
                exec,
                fetch: hostFetch as unknown as typeof globalThis.fetch,
            });
            const managedProvider = Object.freeze({
                realm: 'managedProviderStart' as const,
                providerLocalId: 'gateway',
                isCurrent: () => true,
            }) satisfies ManagedProviderRuntimeInvocationBinding;
            const services = harness.owner.bindScope(
                publicScope('daemon'),
                exec,
                {
                    managedProvider,
                    connectedAccounts: credentialLease.service,
                },
            );
            const handle = await services.supervise({
                id: `gateway-${fixtureId}`,
                credentialBindings: [{
                    purpose: 'provider.inference',
                    request: {
                        kind: 'httpHeaders',
                        origin: 'http://127.0.0.1:43140',
                        headerNames: ['authorization'],
                    },
                    injection: {
                        kind: 'httpHeaders',
                        target,
                    },
                }],
                mode: {
                    kind: 'spawn',
                    launch: {
                        executable: {
                            kind: 'systemTool',
                            id: 'fixture-server',
                        },
                    },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 43_140 },
                    },
                },
                healthCheck: {
                    kind: 'http',
                    target: {
                        kind: 'servicePath',
                        path: '/healthz',
                    },
                },
                healthPolicy: {
                    intervalMs: 250,
                    consecutiveFailures: 2,
                },
            });
            const projection = await harness.owner
                .projectManagedProviderEndpointAccess!({
                    service: handle,
                    endpoints: [{
                        endpointTemplateId: 'models',
                        servicePath: '/v1',
                    }],
                    signal: new AbortController().signal,
                    isCurrent: () => true,
                });

            expect(projection).not.toBeNull();
            if (!projection) return;
            await projection.access.request({
                pathAndQuery: '/v1/models',
                method: 'GET',
                timeoutMs: 5_000,
            });
            expect(latestAuthorization(requests, '/healthz')).toBe(
                initialHealthAuthorization,
            );
            expect(latestAuthorization(requests, '/v1/models')).toBe(
                'Bearer credential-a',
            );

            await credentialLease.rotate('credential-b');
            await vi.advanceTimersByTimeAsync(251);
            await projection.access.request({
                pathAndQuery: '/v1/models?after=rotation',
                method: 'GET',
                timeoutMs: 5_000,
            });

            expect(credentialLease.materialize).toHaveBeenCalledTimes(2);
            expect(latestAuthorization(requests, '/healthz')).toBe(
                target === 'providerRequests'
                    ? null
                    : 'Bearer credential-b',
            );
            expect(latestAuthorization(requests, '/v1/models')).toBe(
                'Bearer credential-b',
            );
            expect(process.dispose).not.toHaveBeenCalled();

            await projection.cleanup();
            await handle.dispose();
            expect(process.dispose).toHaveBeenCalledOnce();
        });
    });
});

function createRotatingHeaderLease() {
    let credential = 'credential-a';
    const listeners = new Set<
        Parameters<ConnectedAccountsService['watch']>[1]
    >();
    const materialize = vi.fn<ConnectedAccountsService['materialize']>(
        async () => Object.freeze({
            kind: 'httpHeaders' as const,
            headers: Object.freeze({
                authorization: `Bearer ${credential}`,
            }),
        }),
    );
    const service = Object.freeze({
        getBinding: vi.fn(),
        requestSelection: vi.fn(),
        materialize,
        listAccounts: async () => {
            throw new Error('Connected Account listing is outside this fixture');
        },
        materializeListedAccount: async () => {
            throw new Error('Exact-listed Connected Account materialization is outside this fixture');
        },
        watch: vi.fn((_purpose, listener) => {
            listeners.add(listener);
            listener(Object.freeze({ kind: 'resync' }));
            return Object.freeze({
                dispose() {
                    listeners.delete(listener);
                },
            });
        }),
    }) satisfies ConnectedAccountsService;
    return Object.freeze({
        materialize,
        service,
        async rotate(nextCredential: string): Promise<void> {
            credential = nextCredential;
            for (const listener of listeners) {
                listener(Object.freeze({ kind: 'resync' }));
            }
            await Promise.resolve();
            await Promise.resolve();
        },
    });
}

function latestAuthorization(
    requests: readonly Readonly<{
        url: string;
        authorization: string | null;
    }>[],
    pathname: string,
): string | null | undefined {
    return [...requests]
        .reverse()
        .find(({ url }) => new URL(url).pathname === pathname)
        ?.authorization;
}
