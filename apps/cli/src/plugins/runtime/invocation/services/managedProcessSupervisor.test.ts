import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecService,
    PluginProcessHandle,
    PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
    createManagedServiceProcessSupervisorHost as createProductionManagedServiceProcessSupervisorHost,
} from './managedProcessSupervisor';
import { retainManagedServiceDiagnostic } from './managedProcessSupervisor';
import type {
    ManagedServiceDiagnosticRetention,
    ManagedServiceProcessSnapshot,
    ManagedServiceProcessSpec,
} from './managedProcessSupervisor';
import type { ManagedServiceProcessDurabilityOwner } from './managedServiceDurability';
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

function createManagedServiceProcessSupervisorHost(
    params: Parameters<typeof createProductionManagedServiceProcessSupervisorHost>[0] = {},
) {
    return createProductionManagedServiceProcessSupervisorHost({
        reservePort: async (host, preferredPort) => Object.freeze({
            host,
            port: preferredPort ?? 49_152,
            release: async () => undefined,
        }),
        ...params,
    });
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolver, rejecter) => {
        resolve = resolver;
        reject = rejecter;
    });
    return { promise, resolve, reject };
}

function createProcess(
    pid = 42,
    result = deferred<PluginProcessResult>(),
): PluginProcessHandle & { dispose: ReturnType<typeof vi.fn> } {
    const dispose = vi.fn(async () => result.resolve(CLEAN_EXIT));
    const process = Object.freeze({
        write: vi.fn(async () => undefined),
        closeStdin: vi.fn(async () => undefined),
        wait: vi.fn(async () => await result.promise),
        onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
        dispose,
    });
    associateSupervisedPluginProcessHandleForHost(process, { pid });
    return process;
}

function createExec(processes: PluginProcessHandle[] = []): Pick<ExecService, 'spawn' | 'run'> & {
    spawn: ReturnType<typeof vi.fn>;
} {
    return {
        spawn: vi.fn(async () => processes.shift() ?? createProcess()),
        run: vi.fn(async () => CLEAN_EXIT),
    };
}

function managedSpec(id: string, overrides: Partial<ManagedServiceProcessSpec> = {}): ManagedServiceProcessSpec {
    return {
        id,
        startupTimeoutMs: 30_000,
        watchdog: { intervalMs: 5_000, missedIntervals: 2 },
        mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49152 },
        launch: { executable: { kind: 'systemTool', id: 'fixture.server' }, args: ['serve'] },
        ...overrides,
    } as ManagedServiceProcessSpec;
}

function externalSpec(id: string, port = 49152): ManagedServiceProcessSpec {
    return {
        id,
        startupTimeoutMs: 30_000,
        watchdog: { intervalMs: 5_000, missedIntervals: 2 },
        mode: { kind: 'externalAttach', baseUrl: `http://127.0.0.1:${port}` },
    };
}

function createHarness(processes: PluginProcessHandle[] = []) {
    const exec = createExec(processes);
    let nextId = 0;
    const host = createManagedServiceProcessSupervisorHost({
        createInstanceId: () => `opaque-${++nextId}`,
        fetch: vi.fn(async () => new Response('', { status: 200 })),
    });
    const servers = host.bind({
        generation: 'generation-7',
        pluginId: 'fixture.plugin',
        contributionId: 'fixture.agent',
        isGenerationCurrent: () => true,
        exec,
    });
    return { exec, host, servers };
}

function createDurability(): ManagedServiceProcessDurabilityOwner & {
    publishEndpointProjection: ReturnType<typeof vi.fn>;
    releaseEndpointProjection: ReturnType<typeof vi.fn>;
    openLog: ReturnType<typeof vi.fn>;
    writes: string[];
} {
    const writes: string[] = [];
    return {
        publishEndpointProjection: vi.fn(async () => 'c'.repeat(64)),
        releaseEndpointProjection: vi.fn(async () => true),
        openLog: vi.fn(async () => ({
            path: '/host/logs/redacted.log',
            write: (_source: 'stdout' | 'stderr', chunk: Uint8Array | string) => {
                writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
            },
            close: vi.fn(async () => {}),
        })),
        writes,
    };
}

describe('createManagedServiceProcessSupervisorHost', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('retains managed-service diagnostics in chronological insertion order', () => {
        let retained: ManagedServiceDiagnosticRetention = {
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        };

        for (const code of ['first_failure', 'second_failure', 'third_failure']) {
            retained = retainManagedServiceDiagnostic(retained, {
                code,
                severity: 'error',
            });
        }

        expect(retained).toEqual({
            diagnostics: [
                { code: 'first_failure', severity: 'error' },
                { code: 'second_failure', severity: 'error' },
                { code: 'third_failure', severity: 'error' },
            ],
            diagnosticsTruncated: false,
        });
    });

    it('evicts count and byte overflow and replaces an overlarge diagnostic', () => {
        let countBounded: ManagedServiceDiagnosticRetention = {
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        };
        for (let index = 0; index < 33; index += 1) {
            countBounded = retainManagedServiceDiagnostic(countBounded, {
                code: `count_${index}`,
                severity: 'warning',
            });
        }
        expect(countBounded.diagnostics).toHaveLength(32);
        expect(countBounded.diagnostics[0]?.code).toBe('count_1');
        expect(countBounded.diagnosticsTruncated).toBe(true);

        let byteBounded: ManagedServiceDiagnosticRetention = {
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        };
        for (let index = 0; index < 9; index += 1) {
            byteBounded = retainManagedServiceDiagnostic(byteBounded, {
                code: `byte_${index}`,
                severity: 'error',
                details: { output: 'x'.repeat(7_900) },
            });
        }
        expect(byteBounded.diagnostics.map(({ code }) => code))
            .not.toContain('byte_0');
        expect(
            new TextEncoder().encode(JSON.stringify(byteBounded.diagnostics))
                .byteLength,
        ).toBeLessThanOrEqual(65_536);
        expect(byteBounded.diagnosticsTruncated).toBe(true);

        const overlarge = retainManagedServiceDiagnostic({
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        }, {
            code: 'private_process_output_rejected',
            severity: 'error',
            details: { output: 'secret'.repeat(2_000) },
        });
        expect(overlarge).toEqual({
            diagnostics: [{
                code: 'plugin_managed_service_diagnostic_rejected',
                severity: 'warning',
                message: 'Managed-service diagnostic exceeded the entry byte limit and was omitted',
                details: { rejectedCode: 'private_process_output_rejected' },
            }],
            diagnosticsTruncated: true,
        });
        expect(JSON.stringify(overlarge)).not.toContain('secret');

        const hugeCode = retainManagedServiceDiagnostic({
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        }, {
            code: 'private'.repeat(2_000),
            severity: 'error',
        });
        expect(
            new TextEncoder().encode(JSON.stringify(hugeCode.diagnostics[0]))
                .byteLength,
        ).toBeLessThanOrEqual(8_192);
        expect(hugeCode.diagnostics[0]).toEqual({
            code: 'plugin_managed_service_diagnostic_rejected',
            severity: 'warning',
            message: 'Managed-service diagnostic exceeded the entry byte limit and was omitted',
        });
        expect(hugeCode.diagnosticsTruncated).toBe(true);

        const multibyte = retainManagedServiceDiagnostic({
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        }, {
            code: 'multibyte_diagnostic_rejected',
            severity: 'error',
            details: { output: 'é'.repeat(4_100) },
        });
        expect(multibyte.diagnostics[0]).toMatchObject({
            code: 'plugin_managed_service_diagnostic_rejected',
            details: { rejectedCode: 'multibyte_diagnostic_rejected' },
        });
        expect(JSON.stringify(multibyte)).not.toContain('é');
        expect(multibyte.diagnosticsTruncated).toBe(true);
    });

    it('replaces non-canonical diagnostics without reading unsafe values', () => {
        const cyclicDetails: Record<string, unknown> = {};
        cyclicDetails.self = cyclicDetails;

        let accessorReads = 0;
        const accessorDiagnostic = Object.defineProperty({
            code: 'accessor_diagnostic',
            severity: 'warning',
        }, 'details', {
            enumerable: true,
            get() {
                accessorReads += 1;
                throw new Error('private accessor diagnostic');
            },
        });

        class DiagnosticWithPrototype {
            readonly code = 'prototype_diagnostic';
            readonly severity = 'warning';
        }

        const invalidDiagnostics: readonly unknown[] = [
            {
                code: 'nan_diagnostic',
                severity: 'warning',
                details: { value: Number.NaN },
            },
            {
                code: 'infinite_diagnostic',
                severity: 'warning',
                details: { value: Number.POSITIVE_INFINITY },
            },
            {
                code: 'cyclic_diagnostic',
                severity: 'warning',
                details: cyclicDetails,
            },
            accessorDiagnostic,
            new DiagnosticWithPrototype(),
            {
                code: 'invalid_severity',
                severity: 'fatal',
            },
            {
                code: 'invalid_remediation',
                severity: 'warning',
                remediation: { kind: 'openSettings', path: ' ' },
            },
            {
                code: 'invalid_message',
                severity: 'warning',
                message: ' ',
            },
        ];

        for (const diagnostic of invalidDiagnostics) {
            const retained = retainManagedServiceDiagnostic({
                diagnostics: Object.freeze([]),
                diagnosticsTruncated: false,
            }, diagnostic);

            expect(retained).toEqual({
                diagnostics: [{
                    code: 'plugin_managed_service_diagnostic_rejected',
                    severity: 'warning',
                    message: 'Managed-service diagnostic exceeded the entry byte limit and was omitted',
                }],
                diagnosticsTruncated: true,
            });
        }
        expect(accessorReads).toBe(0);
    });

    it('retains a deep host-owned immutable diagnostic snapshot', () => {
        const details = {
            nested: { value: 'before' },
            entries: [{ value: 'first' }],
        };
        const remediation = {
            kind: 'selectAccount' as const,
            service: { pluginId: 'accounts.plugin', localId: 'account' },
        };
        const retained = retainManagedServiceDiagnostic({
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        }, {
            code: 'immutable_diagnostic',
            severity: 'warning',
            details,
            remediation,
        });

        details.nested.value = 'after';
        details.entries[0]!.value = 'changed';
        remediation.service.localId = 'changed';

        expect(retained.diagnostics[0]).toEqual({
            code: 'immutable_diagnostic',
            severity: 'warning',
            details: {
                nested: { value: 'before' },
                entries: [{ value: 'first' }],
            },
            remediation: {
                kind: 'selectAccount',
                service: {
                    pluginId: 'accounts.plugin',
                    localId: 'account',
                },
            },
        });
        expect(Object.isFrozen(retained.diagnostics[0])).toBe(true);
        expect(Object.isFrozen(retained.diagnostics[0]?.details)).toBe(true);
        expect(Object.isFrozen(
            (retained.diagnostics[0]?.details as { nested: object }).nested,
        )).toBe(true);
        expect(Object.isFrozen(retained.diagnostics[0]?.remediation)).toBe(true);
    });

    it('isolates and diagnoses immediate and transition observer failures without redelivery', async () => {
        const { servers } = createHarness();
        const handle = await servers.supervise(externalSpec('observer-failure'));
        const healthyObserver = vi.fn();
        const immediateFailure = vi.fn(() => {
            throw new Error('private immediate observer failure');
        });
        const transitionFailure = vi.fn((snapshot: ManagedServiceProcessSnapshot) => {
            if (snapshot.state === 'stopped') {
                throw new Error('private transition observer failure');
            }
        });

        handle.observe!(healthyObserver);
        handle.observe!(immediateFailure);
        handle.observe!(transitionFailure);
        await handle.stop();

        expect(immediateFailure).toHaveBeenCalledOnce();
        expect(transitionFailure).toHaveBeenCalledTimes(2);
        expect(handle.snapshot().diagnostics).toEqual([
            {
                code: 'plugin_managed_service_observer_failed',
                severity: 'warning',
            },
            {
                code: 'plugin_managed_service_observer_failed',
                severity: 'warning',
            },
        ]);
        expect(JSON.stringify(handle.snapshot())).not.toMatch(
            /private (?:immediate|transition) observer failure/u,
        );
        expect(healthyObserver).toHaveBeenLastCalledWith(handle.snapshot());
    });

    it('exposes its immutable custody owner', () => {
        const daemon = createManagedServiceProcessSupervisorHost({});
        const sessionRunner = createManagedServiceProcessSupervisorHost({
            custodyOwner: 'sessionRunner',
        });

        expect(daemon.custodyOwner).toBe('daemon');
        expect(sessionRunner.custodyOwner).toBe('sessionRunner');
        expect(Object.isFrozen(daemon)).toBe(true);
        expect(Object.isFrozen(sessionRunner)).toBe(true);
    });

    it('immediately publishes the current snapshot to a new observer', async () => {
        const { servers } = createHarness();
        const handle = await servers.supervise(externalSpec('attached'));
        const observe = vi.fn();

        handle.observe!(observe);

        expect(observe).toHaveBeenCalledOnce();
        expect(observe).toHaveBeenCalledWith(handle.snapshot());
    });

    it('does not dispatch a health probe after its host-private header lease becomes stale', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response('', { status: 200 }));
        const host = createManagedServiceProcessSupervisorHost({ fetch });
        const servers = host.bind({
            generation: 'generation-stale-health-lease',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: createExec(),
        });
        const isCurrent = vi.fn(async () => false);
        const handle = await servers.supervise({
            ...externalSpec('attached-stale-health-lease'),
            healthCheck: {
                kind: 'http',
                target: { kind: 'serverPath', path: '/health' },
                timeoutMs: 5_000,
                resolveHeaders: async () => Object.freeze({
                    headers: Object.freeze({ authorization: 'Basic stale' }),
                    isCurrent,
                }),
            },
        });

        await expect(handle.waitUntilHealthy({ timeoutMs: 1 })).rejects
            .toMatchObject({ code: 'plugin_managed_server_health_timeout' });
        expect(isCurrent).toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        await handle.dispose();
    });

    it('joins a concurrent endpoint publication before disposal releases its projection', async () => {
        const publication = deferred<string>();
        const durability = createDurability();
        durability.publishEndpointProjection.mockImplementationOnce(
            async () => await publication.promise,
        );
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-publication-race',
            durability,
            fetch: vi.fn(async () => new Response('', { status: 200 })),
        });
        const servers = host.bind({
            generation: 'generation-publication-race',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-publication-race',
            isGenerationCurrent: () => true,
            exec: createExec(),
        });
        const handle = await servers.supervise({
            ...externalSpec('attached-publication-race'),
            healthCheck: {
                kind: 'http',
                target: { kind: 'serverPath', path: '/health' },
                timeoutMs: 5_000,
            },
        });

        const healthy = handle.waitUntilHealthy({ timeoutMs: 30_000 });
        await vi.waitFor(() => {
            expect(durability.publishEndpointProjection).toHaveBeenCalledOnce();
        });
        const disposal = handle.dispose();
        const earlyDisposal = await Promise.race([
            disposal.then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => {
                setTimeout(() => resolve('pending'), 0);
            }),
        ]);

        expect(earlyDisposal).toBe('pending');
        expect(durability.releaseEndpointProjection).not.toHaveBeenCalled();

        publication.resolve('d'.repeat(64));
        await expect(disposal).resolves.toBeUndefined();
        await expect(healthy).rejects.toMatchObject({
            code: 'plugin_managed_server_stopped',
        });
        expect(durability.releaseEndpointProjection).toHaveBeenCalledOnce();
        expect(durability.releaseEndpointProjection).toHaveBeenCalledWith({
            instanceId: 'opaque-publication-race',
            projectionToken: 'd'.repeat(64),
            sessionId: 'session-publication-race',
            pluginId: 'fixture.plugin',
        });
        expect(handle.snapshot().state).toBe('stopped');
    });

    it('never joins equal managed-service ids across distinct Session custody scopes', async () => {
        const firstProcess = createProcess(4101);
        const secondProcess = createProcess(4102);
        const exec = createExec([firstProcess, secondProcess]);
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: (() => {
                let next = 0;
                return () => `opaque-session-${++next}`;
            })(),
        });
        const bindSession = (sessionId: string) => host.bind({
            generation: 'generation-session-scope',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.plugin/providers/gateway',
            sessionId,
            isGenerationCurrent: () => true,
            exec,
        });

        const first = await bindSession('session-one').supervise(
            managedSpec('gateway'),
        );
        const second = await bindSession('session-two').supervise(
            managedSpec('gateway'),
        );

        expect(second).not.toBe(first);
        expect(first.snapshot().instanceId).toBe('opaque-session-1');
        expect(second.snapshot().instanceId).toBe('opaque-session-2');
        expect(exec.spawn).toHaveBeenCalledTimes(2);

        await Promise.all([first.dispose(), second.dispose()]);
    });


    it('authorizes a pre-turn runner-owned launch before spawn and publishes only the exact runner process', async () => {
        const durability = createDurability();
        const process = createProcess(5151);
        const exec = createExec([process]);
        const authorizeManagedSpawn = vi.fn(async () => Object.freeze({
            mode: 'managedSpawn' as const,
            launch: Object.freeze({
                kind: 'daemonResolved' as const,
                value: Object.freeze({
                    command: '/managed/fixture-server',
                }),
            }),
        }));
        const placeholder =
            'happier_runner_placeholder_AAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const credential = 'runner-owned-secret';
        const transformRunnerManagedSpawnEnvironment = vi.fn(
            (environment: Readonly<Record<string, string>>) =>
                Object.freeze({
                    ...environment,
                    PROVIDER_KEY:
                        environment.PROVIDER_KEY === placeholder
                            ? credential
                            : environment.PROVIDER_KEY,
                }),
        );
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-runner',
            durability,
            custodyOwner: 'sessionRunner',
            authorizeRunnerSupervision: authorizeManagedSpawn,
            transformRunnerManagedSpawnEnvironment,
            installPreauthorizedSpawn: () =>
                Object.freeze({ dispose() {} }),
            captureProcessStartIdentity: async () => 'runner-process-start',
        });
        const servers = host.bind({
            generation: 'runner-generation',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.plugin/agents/fixture',
            sessionId: 'session-1',
            isGenerationCurrent: () => true,
            exec,
        });

        const handle = await servers.supervise(managedSpec(
            'runner-server',
            {
                launch: {
                    executable: {
                        kind: 'systemTool',
                        id: 'fixture.server',
                    },
                    args: ['serve'],
                    env: { PROVIDER_KEY: placeholder },
                },
            },
        ));

        expect(authorizeManagedSpawn).toHaveBeenCalledBefore(exec.spawn);
        expect(authorizeManagedSpawn).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.plugin/agents/fixture',
            serverId: 'runner-server',
            immutableGenerationId: 'runner-generation',
            executable: { kind: 'systemTool', id: 'fixture.server' },
            environmentKeys: ['PROVIDER_KEY'],
        }));
        expect(JSON.stringify(authorizeManagedSpawn.mock.calls))
            .not.toContain(credential);
        expect(transformRunnerManagedSpawnEnvironment)
            .toHaveBeenCalledOnce();
        expect(exec.spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                env: { PROVIDER_KEY: credential },
            }),
            expect.anything(),
        );
        expect(durability.publishEndpointProjection).toHaveBeenCalledWith(
            expect.objectContaining({
                custodyOwner: 'sessionRunner',
                process: {
                    pid: 5151,
                    startIdentity: 'runner-process-start',
                },
            }),
        );

        await handle.dispose();
        expect(durability.releaseEndpointProjection).toHaveBeenCalledTimes(1);
    });

    it('resolves an authorized packaged runtime from the surviving runner snapshot after daemon authorization', async () => {
        const process = createProcess(5252);
        const exec = createExec([process]);
        const executable = Object.freeze({
            kind: 'packaged-runtime-binary' as const,
            directorySegments: Object.freeze(['providers', 'gateway']),
            executableBaseName: 'gateway',
        });
        const authorizeManagedSpawn = vi.fn(async () => Object.freeze({
            mode: 'managedSpawn' as const,
            launch: Object.freeze({
                kind: 'runnerPackagedRuntime' as const,
            }),
        }));
        const resolveRunnerPackagedRuntimeExecutable = vi.fn(
            async () => '/runner-p/assets/providers/gateway/gateway',
        );
        const installPreauthorizedSpawn = vi.fn((
            _exec,
            _request,
            launch,
        ) => {
            expect(launch.command).toBe(
                '/runner-p/assets/providers/gateway/gateway',
            );
            expect(JSON.stringify(launch)).not.toContain('/daemon-q/');
            return Object.freeze({ dispose() {} });
        });
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-runner-p',
            custodyOwner: 'sessionRunner',
            authorizeRunnerSupervision: authorizeManagedSpawn,
            resolveRunnerPackagedRuntimeExecutable,
            installPreauthorizedSpawn,
            captureProcessStartIdentity: async () => 'runner-p-start',
        });
        const servers = host.bind({
            generation: 'runner-generation-p',
            pluginId: 'happier.provider.cliproxyapi',
            contributionId:
                'happier.provider.cliproxyapi/providers/cliproxyapi',
            operationId: 'provider-operation-p',
            sessionId: 'session-p',
            isGenerationCurrent: () => true,
            exec,
        });

        const handle = await servers.supervise(managedSpec(
            'cliproxyapi',
            {
                launch: {
                    executable,
                    args: ['serve'],
                },
            },
        ));

        expect(authorizeManagedSpawn).toHaveBeenCalledBefore(
            resolveRunnerPackagedRuntimeExecutable,
        );
        expect(authorizeManagedSpawn).toHaveBeenCalledWith(
            expect.objectContaining({ executable }),
        );
        expect(resolveRunnerPackagedRuntimeExecutable)
            .toHaveBeenCalledWith(executable);
        expect(installPreauthorizedSpawn).toHaveBeenCalledOnce();
        expect(exec.spawn).toHaveBeenCalledOnce();
        await handle.dispose();
    });

    it('terminates a runner-owned child exactly once when endpoint publication fails without retrying', async () => {
        const durability = createDurability();
        durability.publishEndpointProjection.mockRejectedValueOnce(
            new Error('daemon changed before publication'),
        );
        const process = createProcess(6161);
        const exec = createExec([process]);
        const authorizeManagedSpawn = vi.fn(async () => Object.freeze({
            mode: 'managedSpawn' as const,
            launch: Object.freeze({
                kind: 'daemonResolved' as const,
                value: Object.freeze({
                    command: '/managed/fixture-server',
                }),
            }),
        }));
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-runner-publication-failure',
            durability,
            custodyOwner: 'sessionRunner',
            authorizeRunnerSupervision: authorizeManagedSpawn,
            installPreauthorizedSpawn: () =>
                Object.freeze({ dispose() {} }),
            captureProcessStartIdentity: async () => 'runner-process-start',
        });
        const servers = host.bind({
            generation: 'runner-generation',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.plugin/agents/fixture',
            sessionId: 'session-1',
            isGenerationCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(managedSpec('runner-server')))
            .rejects.toThrow('daemon changed before publication');

        expect(authorizeManagedSpawn).toHaveBeenCalledTimes(1);
        expect(exec.spawn).toHaveBeenCalledTimes(1);
        expect(durability.publishEndpointProjection).toHaveBeenCalledTimes(1);
        expect(process.dispose).toHaveBeenCalledTimes(1);
    });

    it('terminates the spawned process when durable log setup fails', async () => {
        const durability = createDurability();
        durability.openLog.mockRejectedValueOnce(new Error('log unavailable'));
        const process = createProcess(4242);
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-log-failure',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-7',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: createExec([process]),
        });

        await expect(servers.supervise(managedSpec('server', {
            durableLog: { enabled: true, keepCount: 50 },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_custody_failed' });
        expect(process.dispose).toHaveBeenCalledTimes(1);
    });

    it('registers every host-Basic representation with durable-log redaction without treating the username as secret', async () => {
        const durability = createDurability();
        const process = createProcess(4_243);
        const password = 'host-private-password';
        const usernameAndPassword = `opencode:${password}`;
        const basicPayload = Buffer.from(usernameAndPassword).toString(
            'base64',
        );
        const authorization = `Basic ${basicPayload}`;
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-basic-redaction',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-basic-redaction',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: createExec([process]),
        });

        const handle = await servers.supervise(managedSpec('server', {
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
                port: 49_152,
                credential: {
                    environment: {
                        name: 'OPENCODE_SERVER_PASSWORD',
                        value: password,
                    },
                    httpHeader: {
                        name: 'authorization',
                        value: authorization,
                    },
                },
            },
            durableLog: { enabled: true, keepCount: 50 },
        }));

        const secretValues = durability.openLog.mock.calls[0]?.[0]
            ?.secretValues;
        expect(secretValues).toEqual(expect.arrayContaining([
            password,
            usernameAndPassword,
            basicPayload,
            authorization,
        ]));
        expect(secretValues).not.toContain('opencode');
        await handle.dispose();
    });

    it('aggregates bounded sibling failures and retries only incomplete cleanup phases', async () => {
        const durability = createDurability();
        const closeLog = vi.fn(async () => undefined);
        durability.openLog.mockResolvedValueOnce({
            path: '/private/log/path',
            write: () => undefined,
            close: closeLog,
        });
        const process = createProcess(4242);
        process.dispose
            .mockRejectedValueOnce(new Error('/private/process/path'))
            .mockImplementationOnce(async () => undefined);
        const disposeOutput = vi.fn()
            .mockImplementationOnce(() => { throw new Error('/private/output/path'); })
            .mockImplementation(() => undefined);
        vi.mocked(process.onOutput).mockReturnValue({ dispose: disposeOutput });
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-cleanup-retry',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-cleanup-retry',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-cleanup-retry',
            isGenerationCurrent: () => true,
            exec: createExec([process]),
        });
        const handle = await servers.supervise(managedSpec('server', {
            durableLog: { enabled: true, keepCount: 50 },
        }));

        const first = await handle.dispose().then(
            () => null,
            (error: unknown) => error,
        );
        expect(first).toBeInstanceOf(AggregateError);
        expect(first).toMatchObject({ code: 'plugin_managed_server_cleanup_failed' });
        expect((first as AggregateError).errors).toMatchObject([
            {
                code: 'plugin_managed_server_cleanup_failed',
                details: { phase: 'outputSubscription' },
            },
            {
                code: 'plugin_managed_server_cleanup_failed',
                details: { phase: 'process' },
            },
        ]);
        expect(String(first)).not.toMatch(/private|path/u);
        expect(
            (first as AggregateError).errors.map(String).join('\n'),
        ).not.toMatch(/private|path/u);
        expect(disposeOutput).toHaveBeenCalledOnce();
        expect(process.dispose).toHaveBeenCalledTimes(1);
        expect(closeLog).toHaveBeenCalledTimes(1);
        expect(durability.releaseEndpointProjection).toHaveBeenCalledTimes(1);

        await expect(handle.dispose()).resolves.toBeUndefined();
        await expect(handle.dispose()).resolves.toBeUndefined();
        expect(disposeOutput).toHaveBeenCalledTimes(2);
        expect(process.dispose).toHaveBeenCalledTimes(2);
        expect(closeLog).toHaveBeenCalledTimes(1);
        expect(durability.releaseEndpointProjection).toHaveBeenCalledTimes(1);
    });

    it('registers post-acquisition cleanup before failure and retries only failed sibling phases', async () => {
        const durability = createDurability();
        const closeLog = vi.fn()
            .mockRejectedValueOnce(new Error('/private/log-secret'))
            .mockResolvedValueOnce(undefined);
        durability.openLog.mockResolvedValueOnce({
            path: '/private/log/path',
            write: () => undefined,
            close: closeLog,
        });
        durability.publishEndpointProjection.mockRejectedValueOnce(
            new Error('/private/projection-secret'),
        );
        const process = createProcess(4_243);
        process.dispose
            .mockRejectedValueOnce(new Error('/private/process-secret'))
            .mockResolvedValueOnce(undefined);
        const disposeOutput = vi.fn()
            .mockImplementationOnce(() => {
                throw new Error('/private/output-secret');
            })
            .mockImplementation(() => undefined);
        vi.mocked(process.onOutput).mockReturnValue({
            dispose: disposeOutput,
        });
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'post-acquisition-cleanup',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-post-acquisition-cleanup',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-post-acquisition-cleanup',
            isGenerationCurrent: () => true,
            exec: createExec([process]),
        });
        let retainedCleanup: (() => Promise<void>) | null = null;
        const options = {
            registerEstablishmentCleanup(cleanup: () => Promise<void>) {
                retainedCleanup = cleanup;
                return Object.freeze({ release() {
                    retainedCleanup = null;
                } });
            },
        };

        const error = await servers.supervise(managedSpec('server', {
            durableLog: { enabled: true, keepCount: 50 },
        }), options).then(
            () => null,
            (failure: unknown) => failure,
        );

        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
            code: 'plugin_managed_server_cleanup_failed',
        });
        expect((error as AggregateError).errors).toMatchObject([
            {
                details: { phase: 'establishment' },
            },
            {
                details: { phase: 'outputSubscription' },
            },
            {
                details: { phase: 'process' },
            },
            {
                details: { phase: 'durableLog' },
            },
        ]);
        expect(String(error)).not.toMatch(/private|secret|path/u);
        expect(
            (error as AggregateError).errors.map(String).join('\n'),
        ).not.toMatch(/private|secret|path/u);
        expect(retainedCleanup).not.toBeNull();
        expect(disposeOutput).toHaveBeenCalledOnce();
        expect(process.dispose).toHaveBeenCalledOnce();
        expect(closeLog).toHaveBeenCalledOnce();

        await expect(retainedCleanup!()).resolves.toBeUndefined();
        expect(disposeOutput).toHaveBeenCalledTimes(2);
        expect(process.dispose).toHaveBeenCalledTimes(2);
        expect(closeLog).toHaveBeenCalledTimes(2);
    });


    it('uses the invocation-scoped exec authority instead of one ambient host exec owner', async () => {
        const firstExec = createExec([createProcess(101)]);
        const secondExec = createExec([createProcess(202)]);
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: (() => {
                let next = 0;
                return () => `opaque-scoped-${++next}`;
            })(),
        });
        const first = host.bind({
            generation: 'generation-scoped',
            pluginId: 'fixture.plugin',
            contributionId: 'first',
            isGenerationCurrent: () => true,
            exec: firstExec,
        });
        const second = host.bind({
            generation: 'generation-scoped',
            pluginId: 'fixture.plugin',
            contributionId: 'second',
            isGenerationCurrent: () => true,
            exec: secondExec,
        });

        const firstHandle = await first.supervise(managedSpec('server'));
        const secondHandle = await second.supervise(managedSpec('server', {
            mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49153 },
        }));

        expect(firstExec.spawn).toHaveBeenCalledTimes(1);
        expect(secondExec.spawn).toHaveBeenCalledTimes(1);
        expect(firstHandle.snapshot().pid).toBe(101);
        expect(secondHandle.snapshot().pid).toBe(202);
        await Promise.all([
            firstHandle.dispose(),
            secondHandle.dispose(),
        ]);
    });

    it('issues a new opaque id for managed replacement even when PID and endpoint are reused', async () => {
        const firstProcess = createProcess(73);
        const secondProcess = createProcess(73);
        const { servers } = createHarness([firstProcess, secondProcess]);

        const first = await servers.supervise(managedSpec('server'));
        expect(first.snapshot().instanceId).toBe('opaque-1');
        await first.dispose();

        const replacement = await servers.supervise(managedSpec('server'));
        expect(replacement.snapshot()).toMatchObject({
            instanceId: 'opaque-2',
            pid: 73,
            port: 49152,
        });
        await replacement.dispose();
    });

    it('rejects a whitespace-only host-issued instance id before launching', async () => {
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({ createInstanceId: () => '   ' });
        const servers = host.bind({
            generation: 'generation-invalid-instance',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(managedSpec('server'))).rejects.toMatchObject({
            code: 'plugin_managed_server_identity_failed',
        });
        expect(exec.spawn).not.toHaveBeenCalled();
    });


    it('joins managed stop with SVC08 disposal and makes disposal idempotent', async () => {
        const process = createProcess();
        const { servers } = createHarness([process]);
        const handle = await servers.supervise(managedSpec('server'));

        const [stop, disposeA, disposeB] = await Promise.all([
            handle.stop(),
            handle.dispose(),
            handle.dispose(),
        ]);

        expect(stop).toEqual({ status: 'stopped' });
        expect(process.dispose).toHaveBeenCalledTimes(1);
        expect(disposeA).toBeUndefined();
        expect(disposeB).toBeUndefined();
        expect(handle.snapshot().state).toBe('stopped');
    });

    it('retains managed process custody when disposal cannot prove termination', async () => {
        const terminal = deferred<PluginProcessResult>();
        let processIsTerminal = false;
        const process: PluginProcessHandle = Object.freeze({
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await terminal.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                if (!processIsTerminal) {
                    throw new PluginError({
                        code: 'plugin_exec_termination_incomplete',
                        message: 'Process tree remained live',
                    });
                }
            }),
        });
        associateSupervisedPluginProcessHandleForHost(process, { pid: 42 });
        const durability = createDurability();
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-incomplete-termination',
            durability,
            captureProcessStartIdentity: async () => 'start-42',
        });
        const servers = host.bind({
            generation: 'generation-incomplete-termination',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-incomplete-termination',
            isGenerationCurrent: () => true,
            exec: createExec([process]),
        });
        const handle = await servers.supervise(managedSpec('server'));

        await expect(handle.stop()).resolves.toEqual({
            status: 'termination_incomplete',
        });
        expect(handle.snapshot().state).not.toBe('stopped');
        expect(durability.releaseEndpointProjection).not.toHaveBeenCalled();
        await expect(handle.dispose()).rejects.toMatchObject({
            code: 'plugin_managed_server_termination_incomplete',
        });

        processIsTerminal = true;
        terminal.resolve(CLEAN_EXIT);
        await vi.waitFor(() => {
            expect(durability.releaseEndpointProjection).toHaveBeenCalledOnce();
        });
        await expect(handle.dispose()).resolves.toBeUndefined();
        expect(handle.snapshot().state).toBe('stopped');
    });






    it('rejects credential-bearing endpoints and stale generation lifetime before launch or attach', async () => {
        const { exec, host } = createHarness();
        const stale = host.bind({
            generation: 'generation-8',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => false,
            exec,
        });

        await expect(stale.supervise(externalSpec('stale'))).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        const current = host.bind({
            generation: 'generation-9',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        await expect(current.supervise({
            id: 'credential-url',
            startupTimeoutMs: 30_000,
            watchdog: { intervalMs: 5_000, missedIntervals: 2 },
            mode: { kind: 'externalAttach', baseUrl: 'https://opencode:secret@example.com' },
        })).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        await expect(current.supervise({
            id: 'query-secret',
            startupTimeoutMs: 30_000,
            watchdog: { intervalMs: 5_000, missedIntervals: 2 },
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49152?token=must-not-snapshot' },
        })).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_invalid' });
        await expect(current.supervise({
            id: 'unsupported-scheme',
            startupTimeoutMs: 30_000,
            watchdog: { intervalMs: 5_000, missedIntervals: 2 },
            mode: { kind: 'externalAttach', baseUrl: 'ftp://example.com' },
        })).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        await expect(current.supervise(managedSpec('wildcard', {
            mode: { kind: 'managedSpawn', host: '0.0.0.0', port: 49152 },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    /**
     * User-declared plaintext endpoints stay local. Remote endpoints use
     * HTTPS, while a local server may use loopback HTTP.
     */
    it.each([
        ['a loopback host over plain http', 'http://127.0.0.1:4096', 4096],
        ['a remote host over https', 'https://opencode.example.com', 443],
        ['an explicit https port', 'https://opencode.example.com:8443', 8443],
        // A declared base path is routing authority: the endpoint behind a
        // reverse proxy only answers under its prefix, so a health path resolved
        // against the origin probes a route that is not the supervised service.
        ['a reverse-proxy path prefix', 'https://opencode.example.com/reverse/proxy', 443],
        ['a reverse-proxy prefix with a trailing slash', 'https://opencode.example.com/proxy/', 443],
    ])('attaches to a user-declared endpoint on %s', async (_label, baseUrl, port) => {
        const probed: string[] = [];
        const fetch = vi.fn(async (target: string | URL | Request) => {
            probed.push(typeof target === 'string' ? target : target.toString());
            return new Response('', { status: 200 });
        });
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-attach',
            fetch,
        });
        const servers = host.bind({
            generation: 'generation-attach',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: createExec(),
        });

        const handle = await servers.supervise({
            id: 'user-server',
            startupTimeoutMs: 30_000,
            watchdog: { intervalMs: 5_000, missedIntervals: 2 },
            mode: { kind: 'externalAttach', baseUrl },
            healthCheck: {
                kind: 'http',
                target: { kind: 'serverPath', path: '/global/health' },
                timeoutMs: 5_000,
            },
        });
        const snapshot = await handle.waitUntilHealthy({ timeoutMs: 30_000 });

        const canonicalBaseUrl = baseUrl.replace(/\/+$/, '');
        expect(snapshot.state).toBe('healthy');
        expect(snapshot.baseUrl).toBe(canonicalBaseUrl);
        expect(snapshot.port).toBe(port);
        expect(probed[0]).toBe(`${canonicalBaseUrl}/global/health`);
        await handle.dispose();
    });

    it('refuses a LAN HTTP attachment before a health probe can use it', async () => {
        const fetch = vi.fn(async () => new Response('', { status: 200 }));
        const host = createManagedServiceProcessSupervisorHost({ fetch });
        const servers = host.bind({
            generation: 'generation-attach',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: createExec(),
        });

        await expect(servers.supervise({
            id: 'lan-http-server',
            startupTimeoutMs: 30_000,
            watchdog: { intervalMs: 5_000, missedIntervals: 2 },
            mode: {
                kind: 'externalAttach',
                baseUrl: 'http://192.168.1.50:4096',
            },
            healthCheck: {
                kind: 'http',
                target: { kind: 'serverPath', path: '/global/health' },
                timeoutMs: 5_000,
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_server_endpoint_denied',
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    /**
     * Proof the relaxation is scoped to attach: a spawned service's endpoint is
     * a port this host allocated on this machine, so a declared non-loopback
     * base URL remains a defect.
     */
    it('keeps a spawned service pinned to a loopback endpoint', async () => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('lan-spawn', {
            mode: { kind: 'managedSpawn', baseUrl: 'http://192.168.1.50:4096' },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        await expect(servers.supervise(managedSpec('tls-spawn', {
            mode: { kind: 'managedSpawn', baseUrl: 'https://127.0.0.1:4096' },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it.each([
        ['startup timeout', { startupTimeoutMs: 300_001 }, 'plugin_managed_server_timeout_invalid'],
        ['health timeout', {
            healthCheck: { kind: 'http' as const, timeoutMs: 60_001 },
        }, 'plugin_managed_server_health_timeout_invalid'],
        ['watchdog interval', {
            watchdog: { intervalMs: 249, missedIntervals: 1 },
        }, 'plugin_managed_server_watchdog_invalid'],
        ['watchdog failure count', {
            watchdog: { intervalMs: 250, missedIntervals: 21 },
        }, 'plugin_managed_server_watchdog_invalid'],
        ['durable-log keep count', {
            durableLog: { enabled: true, keepCount: 51 },
        }, 'plugin_managed_server_timeout_invalid'],
    ] as const)('rejects invalid %s bounds before launch', async (_label, overrides, code) => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            ...overrides,
        }))).rejects.toMatchObject({ code });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it.each([
        ['startup timeout', () => {
            const { startupTimeoutMs: _omitted, ...spec } = managedSpec('missing-startup');
            return spec;
        }, 'plugin_managed_server_timeout_invalid'],
        ['watchdog policy', () => {
            const { watchdog: _omitted, ...spec } = managedSpec('missing-watchdog');
            return spec;
        }, 'plugin_managed_server_watchdog_invalid'],
        ['health timeout', () => {
            const valid = managedSpec('missing-health-timeout', {
                healthCheck: { kind: 'http', timeoutMs: 5_000 },
            });
            if (!valid.healthCheck) throw new Error('expected health check');
            const { timeoutMs: _omitted, ...healthCheck } = valid.healthCheck;
            return { ...valid, healthCheck };
        }, 'plugin_managed_server_health_timeout_invalid'],
        ['durable-log keep count', () => {
            const valid = managedSpec('missing-log-keep-count', {
                durableLog: { enabled: true, keepCount: 50 },
            });
            if (!valid.durableLog) throw new Error('expected durable log');
            const { keepCount: _omitted, ...durableLog } = valid.durableLog;
            return { ...valid, durableLog };
        }, 'plugin_managed_server_timeout_invalid'],
    ] as const)(
        'rejects omitted lower %s before launch',
        async (_label, createSpec, code) => {
            const { exec, servers } = createHarness();

            await expect(servers.supervise(
                createSpec() as ManagedServiceProcessSpec,
            )).rejects.toMatchObject({ code });
            expect(exec.spawn).not.toHaveBeenCalled();
        },
    );

    it('rejects an omitted lower healthy-wait timeout instead of inheriting startup policy', async () => {
        const { servers } = createHarness();
        const handle = await servers.supervise(externalSpec('missing-wait-timeout'));

        const outcome = await handle.waitUntilHealthy(undefined as never).then(
            () => null,
            (error: unknown) => error,
        );
        await handle.dispose();

        expect(outcome).toMatchObject({
            code: 'plugin_managed_server_timeout_invalid',
        });
    });

    it('honors a pre-aborted stop without beginning process termination', async () => {
        const process = createProcess();
        const { servers } = createHarness([process]);
        const handle = await servers.supervise(managedSpec('server'));
        const controller = new AbortController();
        controller.abort();

        await expect(handle.stop({ signal: controller.signal })).rejects.toMatchObject({
            code: 'plugin_managed_server_aborted',
        });
        expect(process.dispose).not.toHaveBeenCalled();
        await handle.dispose();
    });

    it('does not let a late successful health check overwrite an observed exit', async () => {
        const exit = deferred<PluginProcessResult>();
        const process = createProcess(42, exit);
        const health = deferred<Response>();
        const exec = createExec([process]);
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-race',
            fetch: vi.fn(async () => await health.promise),
        });
        const servers = host.bind({
            generation: 'generation-race',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));
        const waiting = handle.waitUntilHealthy({ timeoutMs: 30_000 });

        exit.resolve(CLEAN_EXIT);
        await Promise.resolve();
        health.resolve(new Response('', { status: 200 }));

        await expect(waiting).rejects.toMatchObject({ code: 'plugin_managed_server_process_exited' });
        expect(handle.snapshot().state).toBe('unhealthy');
        await handle.dispose();
    });

    it('keeps an observed process exit authoritative over a concurrent watchdog miss', async () => {
        vi.useFakeTimers();
        const exit = deferred<PluginProcessResult>();
        const watchdogHealth = deferred<Response>();
        const process = createProcess(42, exit);
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response('', { status: 200 }))
            .mockImplementationOnce(async () => await watchdogHealth.promise);
        const exec = createExec([process]);
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-watchdog-race',
            fetch,
        });
        const servers = host.bind({
            generation: 'generation-watchdog-race',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
            watchdog: { intervalMs: 250, missedIntervals: 1 },
        }));
        await handle.waitUntilHealthy({ timeoutMs: 30_000 });

        vi.advanceTimersByTime(250);
        await Promise.resolve();
        exit.resolve(CLEAN_EXIT);
        await Promise.resolve();
        watchdogHealth.resolve(new Response('', { status: 503 }));
        await Promise.resolve();
        await Promise.resolve();

        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: [expect.objectContaining({
                code: 'plugin_managed_server_process_exited',
            })],
        });
        await handle.dispose();
    });

    it('preserves an explicit base URL port through reservation and launch', async () => {
        const exec = createExec();
        const release = vi.fn(async () => undefined);
        const reservePort = vi.fn(async (
            host: '127.0.0.1' | '::1',
            preferredPort?: number,
        ) => Object.freeze({
            host,
            port: preferredPort ?? 49_999,
            release,
        }));
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-base-url',
            reservePort,
        });
        const servers = host.bind({
            generation: 'generation-base-url',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        const handle = await servers.supervise(managedSpec('server', {
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
                baseUrl: 'http://127.0.0.1:49321',
            },
        }));

        expect(handle.snapshot()).toMatchObject({
            baseUrl: 'http://127.0.0.1:49321',
            port: 49321,
        });
        expect(reservePort).toHaveBeenCalledWith(
            '127.0.0.1',
            49_321,
            expect.any(AbortSignal),
        );
        expect(release).toHaveBeenCalledOnce();
        expect(exec.spawn).toHaveBeenCalledTimes(1);
        await handle.dispose();
    });

    it('releases an allocated port reservation exactly once when spawn fails', async () => {
        const release = vi.fn(async () => undefined);
        const reservePort = vi.fn(async () => Object.freeze({
            host: '127.0.0.1' as const,
            port: 49_321,
            release,
        }));
        const exec = createExec();
        exec.spawn.mockImplementationOnce(async () => {
            expect(release).toHaveBeenCalledOnce();
            throw new Error('synthetic spawn failure');
        });
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-reserved-spawn-failure',
            reservePort,
        });
        const servers = host.bind({
            generation: 'generation-reserved-spawn-failure',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(managedSpec('reserved-server', {
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
            },
        }))).rejects.toThrow('synthetic spawn failure');

        expect(reservePort).toHaveBeenCalledOnce();
        expect(reservePort).toHaveBeenCalledWith(
            '127.0.0.1',
            undefined,
            expect.any(AbortSignal),
        );
        expect(release).toHaveBeenCalledOnce();
        expect(exec.spawn).toHaveBeenCalledOnce();
    });

    it('releases an allocated port reservation exactly once when abort wins before runner spawn', async () => {
        const release = vi.fn(async () => undefined);
        const reservePort = vi.fn(async () => Object.freeze({
            host: '127.0.0.1' as const,
            port: 49_322,
            release,
        }));
        const authorization = deferred<{
            mode: 'managedSpawn';
            launch: {
                kind: 'daemonResolved';
                value: { command: string };
            };
        }>();
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'opaque-reserved-abort',
            custodyOwner: 'sessionRunner',
            reservePort,
            authorizeRunnerSupervision: async () =>
                await authorization.promise,
        });
        const servers = host.bind({
            generation: 'generation-reserved-abort',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            sessionId: 'session-reserved-abort',
            isGenerationCurrent: () => true,
            exec,
        });
        const controller = new AbortController();
        const outcome = servers.supervise(managedSpec('reserved-server', {
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
            },
        }), {
            signal: controller.signal,
        }).then(
            () => null,
            (error: unknown) => error,
        );

        await vi.waitFor(() => expect(reservePort).toHaveBeenCalledOnce());
        expect(release).not.toHaveBeenCalled();
        controller.abort();
        authorization.resolve({
            mode: 'managedSpawn',
            launch: {
                kind: 'daemonResolved',
                value: { command: '/managed/fixture-server' },
            },
        });

        await expect(outcome).resolves.toBeInstanceOf(Error);
        expect(release).toHaveBeenCalledOnce();
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('rejects a health target outside the supervised endpoint before launching', async () => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            healthCheck: {
                kind: 'http',
                target: { kind: 'url', url: 'http://127.0.0.1:49153/health' },
                timeoutMs: 5_000,
            },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('keeps a rejected process waiter terminal over later healthy probes', async () => {
        const processResult = deferred<PluginProcessResult>();
        const process = createProcess(42, processResult);
        const exec = createExec([process]);
        const fetch = vi.fn(async () => new Response('', { status: 200 }));
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-process-failure',
        });
        const servers = host.bind({
            generation: 'generation-process-failure',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));

        processResult.reject(new Error('waiter failed'));
        await vi.waitFor(() => expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: [expect.objectContaining({
                code: 'plugin_managed_server_process_failed',
            })],
        }));

        await expect(handle.waitUntilHealthy({ timeoutMs: 30_000 })).rejects.toMatchObject({
            code: 'plugin_managed_server_process_failed',
        });
        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: [expect.objectContaining({
                code: 'plugin_managed_server_process_failed',
            })],
        });
        expect(fetch).not.toHaveBeenCalled();
        await handle.dispose();
    });


    it('bounds an unresponsive HTTP probe by the requested startup deadline', async () => {
        const exec = createExec();
        const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }));
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-health-timeout',
        });
        const servers = host.bind({
            generation: 'generation-health-timeout',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));

        const outcome = await Promise.race([
            handle.waitUntilHealthy({ timeoutMs: 20 }).then(
                () => 'resolved' as const,
                (error: unknown) => error,
            ),
            new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
        ]);

        expect(outcome).toMatchObject({ code: 'plugin_managed_server_health_timeout' });
        await handle.dispose();
    });

    it('blocks retained health activity as soon as the generation becomes stale', async () => {
        let current = true;
        const process = createProcess();
        const exec = createExec([process]);
        const fetch = vi.fn(async () => new Response('', { status: 200 }));
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-stale-health',
        });
        const servers = host.bind({
            generation: 'generation-stale-health',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => current,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));

        current = false;
        await expect(handle.waitUntilHealthy({ timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(fetch).not.toHaveBeenCalled();
        await handle.dispose();
    });

    it('interrupts an in-flight unresponsive probe when its caller aborts', async () => {
        const probeStarted = deferred<void>();
        const fetch = vi.fn(async () => {
            probeStarted.resolve();
            return await new Promise<Response>(() => undefined);
        });
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-aborted-health',
        });
        const servers = host.bind({
            generation: 'generation-aborted-health',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));
        const controller = new AbortController();
        const waiting = handle.waitUntilHealthy({ timeoutMs: 30_000, signal: controller.signal });
        await probeStarted.promise;

        controller.abort();
        const outcome = await Promise.race([
            waiting.then(() => 'resolved' as const, (error: unknown) => error),
            new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
        ]);

        expect(outcome).toMatchObject({ code: 'plugin_managed_server_aborted' });
        await handle.dispose();
    });

    it('cannot publish a healthy result after its generation becomes stale mid-probe', async () => {
        let current = true;
        const health = deferred<Response>();
        const fetch = vi.fn(async () => await health.promise);
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-mid-probe-stale',
        });
        const servers = host.bind({
            generation: 'generation-mid-probe-stale',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => current,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));
        const waiting = handle.waitUntilHealthy({ timeoutMs: 30_000 });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

        current = false;
        health.resolve(new Response('', { status: 200 }));

        await expect(waiting).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(handle.snapshot().state).not.toBe('healthy');
        await handle.dispose();
    });


    it.each([
        '//example.com/health',
        '/\\example.com/health',
    ])('rejects protocol-relative server health path %s before launch', async (path) => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path }, timeoutMs: 5_000 },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });


    it('rejects a fragment-bearing health URL before launch', async () => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            healthCheck: {
                kind: 'http',
                target: { kind: 'url', url: 'http://127.0.0.1:49152/health#credential' },
                timeoutMs: 5_000,
            },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_invalid' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('does not retain credential-bearing invalid URL input as an error cause', async () => {
        const secret = 'credential-must-not-survive';
        const { servers } = createHarness();

        let caught: unknown;
        try {
            await servers.supervise({
                id: 'external',
                startupTimeoutMs: 30_000,
                watchdog: { intervalMs: 5_000, missedIntervals: 2 },
                mode: { kind: 'externalAttach', baseUrl: `http://%${secret}` },
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ code: 'plugin_managed_server_endpoint_invalid' });
        expect(caught).toBeInstanceOf(Error);
        const cause = (caught as Error).cause;
        const input = typeof cause === 'object' && cause !== null && 'input' in cause
            ? String(cause.input)
            : '';
        expect(input).not.toContain(secret);
    });


    it('never follows a health redirect beyond the validated loopback endpoint', async () => {
        const fetch = vi.fn(async () => new Response('', {
            status: 302,
            headers: { location: 'https://example.com/escape' },
        }));
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-manual-redirect',
        });
        const servers = host.bind({
            generation: 'generation-manual-redirect',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));

        await expect(handle.waitUntilHealthy({ timeoutMs: 1 })).rejects.toMatchObject({
            code: 'plugin_managed_server_health_timeout',
        });
        expect(fetch).toHaveBeenCalledWith(
            'http://127.0.0.1:49152/health',
            expect.objectContaining({ redirect: 'manual' }),
        );
        await handle.dispose();
    });

    it('detaches an aborted stop caller while the shared cleanup continues', async () => {
        const processResult = deferred<PluginProcessResult>();
        const releaseDisposal = deferred<void>();
        const process: PluginProcessHandle = Object.freeze({
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await processResult.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                await releaseDisposal.promise;
                processResult.resolve(CLEAN_EXIT);
            }),
        });
        associateSupervisedPluginProcessHandleForHost(process, { pid: 42 });
        const { servers } = createHarness([process]);
        const handle = await servers.supervise(managedSpec('server'));
        const controller = new AbortController();
        const stopping = handle.stop({ signal: controller.signal });
        await vi.waitFor(() => expect(process.dispose).toHaveBeenCalledTimes(1));

        controller.abort();
        await expect(stopping).rejects.toMatchObject({ code: 'plugin_managed_server_aborted' });

        releaseDisposal.resolve();
        await expect(handle.dispose()).resolves.toBeUndefined();
        expect(process.dispose).toHaveBeenCalledTimes(1);
    });

    it('interrupts an unresponsive health probe when its process exits', async () => {
        const processResult = deferred<PluginProcessResult>();
        const probeStarted = deferred<void>();
        const process = createProcess(42, processResult);
        const fetch = vi.fn(async () => {
            probeStarted.resolve();
            return await new Promise<Response>(() => undefined);
        });
        const exec = createExec([process]);
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-exit-interrupt',
        });
        const servers = host.bind({
            generation: 'generation-exit-interrupt',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));
        const waiting = handle.waitUntilHealthy({ timeoutMs: 30_000 });
        await probeStarted.promise;

        processResult.resolve(CLEAN_EXIT);
        const outcome = await Promise.race([
            waiting.then(() => 'resolved' as const, (error: unknown) => error),
            new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
        ]);

        expect(outcome).toMatchObject({ code: 'plugin_managed_server_process_exited' });
        await handle.dispose();
    });

    it('clears its watchdog interval as soon as the process becomes terminal', async () => {
        vi.useFakeTimers();
        const processResult = deferred<PluginProcessResult>();
        const process = createProcess(42, processResult);
        const exec = createExec([process]);
        const host = createManagedServiceProcessSupervisorHost({
            fetch: vi.fn(async () => new Response('', { status: 200 })),
            createInstanceId: () => 'opaque-watchdog-terminal',
        });
        const servers = host.bind({
            generation: 'generation-watchdog-terminal',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
            watchdog: { intervalMs: 250, missedIntervals: 1 },
        }));
        await handle.waitUntilHealthy({ timeoutMs: 30_000 });
        expect(vi.getTimerCount()).toBe(1);

        processResult.resolve(CLEAN_EXIT);
        await vi.waitFor(() => expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: [expect.objectContaining({
                code: 'plugin_managed_server_process_exited',
            })],
        }));

        expect(vi.getTimerCount()).toBe(0);
        await handle.dispose();
    });

    it('rejects an invalid caller health deadline without mutating shared health state', async () => {
        const fetch = vi.fn(async () => new Response('', { status: 200 }));
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-invalid-caller-timeout',
        });
        const servers = host.bind({
            generation: 'generation-invalid-caller-timeout',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
        }));

        await expect(handle.waitUntilHealthy({ timeoutMs: Number.NaN })).rejects.toMatchObject({
            code: 'plugin_managed_server_timeout_invalid',
        });
        expect(handle.snapshot().state).toBe('starting');
        expect('code' in handle.snapshot()).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        await handle.dispose();
    });

    it('settles the health response body so a status-only probe retains no socket', async () => {
        const cancelled: string[] = [];
        const healthResponse = (label: string): Response => new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"status":"ok"}'));
                },
                cancel() {
                    cancelled.push(label);
                },
            }),
            { status: 200 },
        );
        const fetch = vi.fn()
            .mockImplementationOnce(async () => healthResponse('startup'))
            .mockImplementationOnce(async () => healthResponse('watchdog'));
        vi.useFakeTimers();
        const exec = createExec();
        const host = createManagedServiceProcessSupervisorHost({
            fetch,
            createInstanceId: () => 'opaque-health-body',
        });
        const servers = host.bind({
            generation: 'generation-health-body',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const handle = await servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' }, timeoutMs: 5_000 },
            watchdog: { intervalMs: 250, missedIntervals: 2 },
        }));

        await handle.waitUntilHealthy({ timeoutMs: 30_000 });
        expect(cancelled).toEqual(['startup']);

        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(cancelled).toEqual(['startup', 'watchdog']));
        expect(handle.snapshot().state).toBe('healthy');
        await handle.dispose();
    });


});
