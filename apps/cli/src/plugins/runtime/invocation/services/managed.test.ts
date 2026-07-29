import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ManagedServerSpec,
    PluginExecService,
    PluginProcessHandle,
    PluginProcessResult,
} from '@happier-dev/plugin-sdk/runtime';

import { createStablePluginManagedServersHost } from './managed';
import type { ManagedServerDurabilityOwner } from './managedServerDurability';

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
    return Object.freeze({
        pid,
        write: vi.fn(async () => undefined),
        closeStdin: vi.fn(async () => undefined),
        wait: vi.fn(async () => await result.promise),
        onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
        dispose,
    });
}

function createExec(processes: PluginProcessHandle[] = []): Pick<PluginExecService, 'spawn' | 'run'> & {
    spawn: ReturnType<typeof vi.fn>;
} {
    return {
        spawn: vi.fn(async () => processes.shift() ?? createProcess()),
        run: vi.fn(async () => CLEAN_EXIT),
    };
}

function managedSpec(id: string, overrides: Partial<ManagedServerSpec> = {}): ManagedServerSpec {
    return {
        id,
        mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49152 },
        launch: { executable: { kind: 'systemTool', id: 'fixture.server' }, args: ['serve'] },
        ...overrides,
    } as ManagedServerSpec;
}

function externalSpec(id: string, port = 49152): ManagedServerSpec {
    return { id, mode: { kind: 'externalAttach', baseUrl: `http://127.0.0.1:${port}` } };
}

function createHarness(processes: PluginProcessHandle[] = []) {
    const exec = createExec(processes);
    let nextId = 0;
    const host = createStablePluginManagedServersHost({
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

function createDurability(): ManagedServerDurabilityOwner & {
    claim: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
    openLog: ReturnType<typeof vi.fn>;
    writes: string[];
} {
    const writes: string[] = [];
    return {
        claim: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
        reconcile: vi.fn(async () => ({ reaped: 0, absent: 0, identityMismatch: 0, failed: 0, corrupt: 0 })),
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

describe('createStablePluginManagedServersHost', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reconciles durable custody before launch and records only host-owned incarnation facts', async () => {
        const durability = createDurability();
        const process = createProcess(4242);
        const exec = createExec([process]);
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-durable',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-secret-name',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        const handle = await servers.supervise(managedSpec('server', {
            launch: {
                executable: { kind: 'systemTool', id: 'fixture.server' },
                args: ['serve', '--token=raw-secret'],
                env: { AUTH_TOKEN: 'raw-secret' },
            },
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
                port: 49152,
                credential: { environment: { name: 'AUTH_TOKEN', value: 'raw-secret' } },
            },
            durableLog: { enabled: true, keepCount: 3 },
        }));

        expect(durability.reconcile).toHaveBeenCalledTimes(1);
        expect(durability.claim).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            instanceId: 'opaque-durable',
            pid: 4242,
            processStartIdentity: 'os-start-token',
            endpoint: { host: '127.0.0.1', port: 49152 },
            generationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
            serverFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }));
        expect(JSON.stringify(durability.claim.mock.calls[0]?.[0])).not.toContain('raw-secret');
        expect(durability.openLog).toHaveBeenCalledWith(expect.objectContaining({
            instanceId: 'opaque-durable',
            keepCount: 3,
            secretValues: expect.arrayContaining(['raw-secret', '--token=raw-secret']),
        }));
        expect(exec.spawn).toHaveBeenCalledWith(expect.objectContaining({
            maxStdoutBytes: 64 * 1024,
            maxStderrBytes: 64 * 1024,
        }), expect.anything());

        await handle.dispose();
        expect(durability.release).toHaveBeenCalledWith('opaque-durable');
    });

    it('fails closed and terminates the spawned process when durable custody cannot be established', async () => {
        const durability = createDurability();
        durability.claim.mockRejectedValueOnce(new Error('disk unavailable'));
        const process = createProcess(4242);
        const exec = createExec([process]);
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-durable-failure',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-7',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(managedSpec('server')))
            .rejects.toMatchObject({ code: 'plugin_managed_server_custody_failed' });
        expect(process.dispose).toHaveBeenCalledTimes(1);
        expect(durability.release).not.toHaveBeenCalled();
    });

    it('fails closed before spawn when durable reconciliation finds corrupt custody', async () => {
        const durability = createDurability();
        durability.reconcile.mockResolvedValueOnce({
            reaped: 0,
            absent: 0,
            identityMismatch: 0,
            failed: 0,
            corrupt: 1,
        });
        const exec = createExec();
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-corrupt-custody',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-corrupt-custody',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        await expect(servers.supervise(managedSpec('server'))).rejects.toMatchObject({
            code: 'plugin_managed_server_recovery_failed',
        });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('releases an established custody claim when durable log setup fails', async () => {
        const durability = createDurability();
        durability.openLog.mockRejectedValueOnce(new Error('log unavailable'));
        const process = createProcess(4242);
        const host = createStablePluginManagedServersHost({
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
            durableLog: { enabled: true },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_custody_failed' });
        expect(process.dispose).toHaveBeenCalledTimes(1);
        expect(durability.release).toHaveBeenCalledWith('opaque-log-failure');
    });

    it('tracks, redacts, and retries partial cleanup without skipping sibling cleanup steps', async () => {
        const durability = createDurability();
        const closeLog = vi.fn()
            .mockRejectedValueOnce(new Error('/private/log/path'))
            .mockResolvedValue(undefined);
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
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-cleanup-retry',
            durability,
            captureProcessStartIdentity: async () => 'os-start-token',
        });
        const servers = host.bind({
            generation: 'generation-cleanup-retry',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec: createExec([process]),
        });
        const handle = await servers.supervise(managedSpec('server', {
            durableLog: { enabled: true },
        }));

        const first = await handle.dispose().then(
            () => null,
            (error: unknown) => error,
        );
        expect(first).toMatchObject({ code: 'plugin_managed_server_cleanup_failed' });
        expect(String(first)).not.toMatch(/private|path/u);
        expect(process.dispose).toHaveBeenCalledTimes(1);
        expect(closeLog).toHaveBeenCalledTimes(1);
        expect(durability.release).not.toHaveBeenCalled();

        await expect(handle.dispose()).resolves.toBeUndefined();
        expect(process.dispose).toHaveBeenCalledTimes(2);
        expect(closeLog).toHaveBeenCalledTimes(2);
        expect(durability.release).toHaveBeenCalledWith('opaque-cleanup-retry');
    });

    it('joins a generation-qualified id only for the same canonical spec', async () => {
        const { exec, servers } = createHarness();
        const first = await servers.supervise(managedSpec('server', {
            launch: {
                executable: { kind: 'systemTool', id: 'fixture.server' },
                env: { B: '2', A: '1' },
                args: ['serve'],
            },
        }));
        const joined = await servers.supervise(managedSpec('server', {
            launch: {
                args: ['serve'],
                env: { A: '1', B: '2' },
                executable: { kind: 'systemTool', id: 'fixture.server' },
            },
        }));

        expect(joined).toBe(first);
        expect(joined.snapshot().instanceId).toBe(first.snapshot().instanceId);
        expect(exec.spawn).toHaveBeenCalledTimes(1);

        await expect(servers.supervise(managedSpec('server', {
            launch: { executable: { kind: 'systemTool', id: 'fixture.server' }, args: ['different'] },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_spec_conflict' });
        expect(exec.spawn).toHaveBeenCalledTimes(1);
        await first.dispose();
    });

    it('uses the invocation-scoped exec authority instead of one ambient host exec owner', async () => {
        const firstExec = createExec([createProcess(101)]);
        const secondExec = createExec([createProcess(202)]);
        const host = createStablePluginManagedServersHost({
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
        await host.retireGeneration('generation-scoped', 'fixture.plugin');
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
        const host = createStablePluginManagedServersHost({ createInstanceId: () => '   ' });
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

    it('shares one concurrent external establishment but rotates identity after release', async () => {
        const { exec, servers } = createHarness();
        const [first, joined] = await Promise.all([
            servers.supervise(externalSpec('external')),
            servers.supervise(externalSpec('external')),
        ]);

        expect(joined).toBe(first);
        expect(first.snapshot().instanceId).toBe('opaque-1');
        await expect(first.stop()).resolves.toEqual({ status: 'detached' });
        expect(exec.spawn).not.toHaveBeenCalled();

        const later = await servers.supervise(externalSpec('external'));
        expect(later.snapshot().instanceId).toBe('opaque-2');
        await later.dispose();
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

    it('retires a generation only after every process-tree disposal joins', async () => {
        const first = createProcess(1);
        const second = createProcess(2);
        const { host, servers } = createHarness([first, second]);
        const one = await servers.supervise(managedSpec('one'));
        const two = await servers.supervise(managedSpec('two', {
            mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49153 },
        }));

        await host.retireGeneration('generation-7', 'fixture.plugin');

        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(second.dispose).toHaveBeenCalledTimes(1);
        expect(one.snapshot().state).toBe('stopped');
        expect(two.snapshot().state).toBe('stopped');
        await expect(servers.supervise(managedSpec('after-retirement'))).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
    });

    it('bounds retired-generation tombstones while retaining the newest stale-publication fences', async () => {
        const exec = createExec();
        const host = createStablePluginManagedServersHost({ maxRetiredGenerationKeys: 2 });
        const bindings = ['generation-a', 'generation-b', 'generation-c'].map((generation) => ({
            generation,
            servers: host.bind({
                generation,
                pluginId: 'fixture.plugin',
                contributionId: 'fixture.agent',
                isGenerationCurrent: () => true,
                exec,
            }),
        }));

        for (const binding of bindings) {
            await host.retireGeneration(binding.generation, 'fixture.plugin');
        }

        for (const binding of bindings.slice(1)) {
            await expect(binding.servers.supervise(externalSpec('stale'))).rejects.toMatchObject({
                code: 'plugin_generation_stale',
            });
        }
    });

    it('still retires established handles when a concurrent establishment fails', async () => {
        const process = createProcess(1);
        const exec = createExec([process]);
        const launch = deferred<PluginProcessHandle>();
        exec.spawn.mockImplementationOnce(async () => await launch.promise);
        exec.spawn.mockResolvedValueOnce(process);
        const host = createStablePluginManagedServersHost({
            createInstanceId: (() => {
                let next = 0;
                return () => `opaque-retire-${++next}`;
            })(),
        });
        const servers = host.bind({
            generation: 'generation-retire',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const failed = servers.supervise(managedSpec('failed'));
        const retained = await servers.supervise(managedSpec('retained', {
            mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49153 },
        }));

        const retirement = host.retireGeneration('generation-retire', 'fixture.plugin');
        launch.reject(new Error('launch failed'));
        await expect(failed).rejects.toThrow('launch failed');
        await expect(retirement).resolves.toBeUndefined();
        expect(process.dispose).toHaveBeenCalledTimes(1);
        expect(retained.snapshot().state).toBe('stopped');
    });

    it('accepts exactly 32 retained handles and rejects 33 before launch', async () => {
        const { exec, servers } = createHarness();
        const handles = await Promise.all(Array.from({ length: 32 }, (_, index) => servers.supervise(
            managedSpec(`server-${index}`, {
                mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49200 + index },
            }),
        )));

        await expect(servers.supervise(managedSpec('overflow', {
            mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49300 },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_capacity_exceeded' });
        expect(exec.spawn).toHaveBeenCalledTimes(32);
        await Promise.all(handles.map(async (handle) => await handle.dispose()));
    });

    it('includes credentials and launch configuration in a non-exported fingerprint', async () => {
        const secret = 'credential-must-not-escape';
        const { exec, servers } = createHarness();
        const handle = await servers.supervise(managedSpec('server', {
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
                port: 49152,
                credential: {
                    environment: { name: 'SERVER_PASSWORD', value: secret },
                    httpHeader: { name: 'Authorization', value: `Bearer ${secret}` },
                },
            },
        }));

        expect(JSON.stringify(handle.snapshot())).not.toContain(secret);
        expect(exec.spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                env: expect.objectContaining({ SERVER_PASSWORD: secret }),
            }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        await expect(servers.supervise(managedSpec('server', {
            mode: {
                kind: 'managedSpawn',
                host: '127.0.0.1',
                port: 49152,
                credential: { environment: { name: 'SERVER_PASSWORD', value: 'rotated-secret' } },
            },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_spec_conflict' });
        await expect(servers.supervise(managedSpec('server', {
            launch: { executable: { kind: 'systemTool', id: 'fixture.server' }, args: ['serve'], env: { CONFIG: 'changed' } },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_spec_conflict' });
        await handle.dispose();
    });

    it('rejects non-loopback endpoints and stale generation lifetime before launch or attach', async () => {
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
            id: 'remote',
            mode: { kind: 'externalAttach', baseUrl: 'https://example.com:443' },
        })).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        await expect(current.supervise({
            id: 'query-secret',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49152?token=must-not-snapshot' },
        })).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_invalid' });
        await expect(current.supervise(managedSpec('wildcard', {
            mode: { kind: 'managedSpawn', host: '0.0.0.0', port: 49152 },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('rejects invalid watchdog bounds before launch', async () => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            watchdog: { intervalMs: 0, missedIntervals: 1 },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_watchdog_invalid' });
        expect(exec.spawn).not.toHaveBeenCalled();
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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
        }));
        const waiting = handle.waitUntilHealthy();

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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
            watchdog: { intervalMs: 10, missedIntervals: 1 },
        }));
        await handle.waitUntilHealthy();

        vi.advanceTimersByTime(10);
        await Promise.resolve();
        exit.resolve(CLEAN_EXIT);
        await Promise.resolve();
        watchdogHealth.resolve(new Response('', { status: 503 }));
        await Promise.resolve();
        await Promise.resolve();

        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            code: 'plugin_managed_server_process_exited',
        });
        await handle.dispose();
    });

    it('derives the managed port from an explicit base URL before asking for host selection', async () => {
        const exec = createExec();
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-base-url',
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
        expect(exec.spawn).toHaveBeenCalledTimes(1);
        await handle.dispose();
    });

    it('rejects a health target outside the supervised endpoint before launching', async () => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            healthCheck: {
                kind: 'http',
                target: { kind: 'url', url: 'http://127.0.0.1:49153/health' },
            },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('keeps a rejected process waiter terminal over later healthy probes', async () => {
        const processResult = deferred<PluginProcessResult>();
        const process = createProcess(42, processResult);
        const exec = createExec([process]);
        const fetch = vi.fn(async () => new Response('', { status: 200 }));
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
        }));

        processResult.reject(new Error('waiter failed'));
        await vi.waitFor(() => expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            code: 'plugin_managed_server_process_failed',
        }));

        await expect(handle.waitUntilHealthy()).rejects.toMatchObject({
            code: 'plugin_managed_server_process_failed',
        });
        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            code: 'plugin_managed_server_process_failed',
        });
        expect(fetch).not.toHaveBeenCalled();
        await handle.dispose();
    });

    it('does not join a handle after its stop has begun', async () => {
        const processResult = deferred<PluginProcessResult>();
        const releaseDisposal = deferred<void>();
        const process: PluginProcessHandle = Object.freeze({
            pid: 42,
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await processResult.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                await releaseDisposal.promise;
                processResult.resolve(CLEAN_EXIT);
            }),
        });
        const { servers } = createHarness([process]);
        const first = await servers.supervise(managedSpec('server'));

        const stopping = first.stop();
        await vi.waitFor(() => expect(process.dispose).toHaveBeenCalledTimes(1));
        await expect(servers.supervise(managedSpec('server'))).rejects.toMatchObject({
            code: 'plugin_managed_server_not_reusable',
        });

        releaseDisposal.resolve();
        await expect(stopping).resolves.toEqual({ status: 'stopped' });
        const replacement = await servers.supervise(managedSpec('server'));
        expect(replacement.snapshot().instanceId).not.toBe(first.snapshot().instanceId);
        await replacement.dispose();
    });

    it('bounds an unresponsive HTTP probe by the requested startup deadline', async () => {
        const exec = createExec();
        const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }));
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
        }));

        current = false;
        await expect(handle.waitUntilHealthy()).rejects.toMatchObject({ code: 'plugin_generation_stale' });
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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
        }));
        const waiting = handle.waitUntilHealthy();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

        current = false;
        health.resolve(new Response('', { status: 200 }));

        await expect(waiting).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(handle.snapshot().state).not.toBe('healthy');
        await handle.dispose();
    });

    it('waits for every retirement cleanup before reporting one cleanup failure', async () => {
        const firstWait = deferred<PluginProcessResult>();
        const secondWait = deferred<PluginProcessResult>();
        const secondRelease = deferred<void>();
        const first: PluginProcessHandle = Object.freeze({
            pid: 1,
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await firstWait.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                throw new Error('first cleanup failed');
            }),
        });
        const second: PluginProcessHandle = Object.freeze({
            pid: 2,
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await secondWait.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                await secondRelease.promise;
                secondWait.resolve(CLEAN_EXIT);
            }),
        });
        const { host, servers } = createHarness([first, second]);
        await servers.supervise(managedSpec('one'));
        await servers.supervise(managedSpec('two', {
            mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49153 },
        }));

        const retirement = host.retireGeneration('generation-7', 'fixture.plugin');
        let retirementSettled = false;
        const observedRetirement = retirement.then(
            () => undefined,
            (error: unknown) => error,
        ).finally(() => {
            retirementSettled = true;
        });
        await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(second.dispose).toHaveBeenCalledTimes(1));
        expect(retirementSettled).toBe(false);

        secondRelease.resolve();
        await expect(observedRetirement).resolves.toMatchObject({
            code: 'plugin_managed_server_retirement_failed',
        });
    });

    it.each([
        '//example.com/health',
        '/\\example.com/health',
    ])('rejects protocol-relative server health path %s before launch', async (path) => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path } },
        }))).rejects.toMatchObject({ code: 'plugin_managed_server_endpoint_denied' });
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('joins semantically identical canonical health URLs', async () => {
        const { servers } = createHarness();
        const first = await servers.supervise({
            id: 'external',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:80' },
            healthCheck: {
                kind: 'http',
                target: { kind: 'url', url: 'http://127.0.0.1:80/a/../health' },
            },
        });
        const joined = await servers.supervise({
            id: 'external',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1/' },
            healthCheck: {
                kind: 'http',
                target: { kind: 'url', url: 'http://127.0.0.1/health' },
            },
        });

        expect(joined).toBe(first);
        await first.dispose();
    });

    it('rejects a fragment-bearing health URL before launch', async () => {
        const { exec, servers } = createHarness();

        await expect(servers.supervise(managedSpec('server', {
            healthCheck: {
                kind: 'http',
                target: { kind: 'url', url: 'http://127.0.0.1:49152/health#credential' },
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

    it('detaches an aborted supervise caller without cancelling the shared establishment', async () => {
        const launch = deferred<PluginProcessHandle>();
        const process = createProcess();
        const exec = createExec();
        exec.spawn.mockImplementationOnce(async () => await launch.promise);
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-shared-establishment',
        });
        const servers = host.bind({
            generation: 'generation-shared-establishment',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });
        const controller = new AbortController();
        const first = servers.supervise(managedSpec('server'), { signal: controller.signal });
        await vi.waitFor(() => expect(exec.spawn).toHaveBeenCalledTimes(1));

        controller.abort();
        await expect(first).rejects.toMatchObject({ code: 'plugin_managed_server_aborted' });

        const joined = servers.supervise(managedSpec('server'));
        launch.resolve(process);
        const handle = await joined;
        expect(handle.snapshot().instanceId).toBe('opaque-shared-establishment');
        expect(exec.spawn).toHaveBeenCalledTimes(1);
        await handle.dispose();
    });

    it('never follows a health redirect beyond the validated loopback endpoint', async () => {
        const fetch = vi.fn(async () => new Response('', {
            status: 302,
            headers: { location: 'https://example.com/escape' },
        }));
        const exec = createExec();
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
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
            pid: 42,
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await processResult.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                await releaseDisposal.promise;
                processResult.resolve(CLEAN_EXIT);
            }),
        });
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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
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
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
            watchdog: { intervalMs: 10, missedIntervals: 1 },
        }));
        await handle.waitUntilHealthy();
        expect(vi.getTimerCount()).toBe(1);

        processResult.resolve(CLEAN_EXIT);
        await vi.waitFor(() => expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            code: 'plugin_managed_server_process_exited',
        }));

        expect(vi.getTimerCount()).toBe(0);
        await handle.dispose();
    });

    it('rejects an invalid caller health deadline without mutating shared health state', async () => {
        const fetch = vi.fn(async () => new Response('', { status: 200 }));
        const exec = createExec();
        const host = createStablePluginManagedServersHost({
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
            healthCheck: { kind: 'http', target: { kind: 'serverPath', path: '/health' } },
        }));

        await expect(handle.waitUntilHealthy({ timeoutMs: Number.NaN })).rejects.toMatchObject({
            code: 'plugin_managed_server_timeout_invalid',
        });
        expect(handle.snapshot().state).toBe('starting');
        expect('code' in handle.snapshot()).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        await handle.dispose();
    });

    it('aborts an in-flight managed launch when its generation retires', async () => {
        const launchStarted = deferred<void>();
        const launchResult = deferred<PluginProcessHandle>();
        let launchSignal: AbortSignal | undefined;
        const exec = createExec();
        exec.spawn.mockImplementation(async (_request, options?: { signal?: AbortSignal }) => {
            launchSignal = options?.signal;
            launchStarted.resolve();
            options?.signal?.addEventListener(
                'abort',
                () => launchResult.reject(new Error('launch aborted')),
                { once: true },
            );
            return await launchResult.promise;
        });
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-retired-launch',
        });
        const servers = host.bind({
            generation: 'generation-retired-launch',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        const establishment = servers.supervise(managedSpec('server'));
        await launchStarted.promise;
        const retirement = host.retireGeneration('generation-retired-launch', 'fixture.plugin');
        if (!launchSignal) launchResult.reject(new Error('launch was not generation-cancellable'));

        await expect(establishment).rejects.toThrow(/launch (?:aborted|was not generation-cancellable)/u);
        await expect(retirement).resolves.toBeUndefined();
        expect(launchSignal?.aborted).toBe(true);
    });

    it('reports and retains a late-launched process whose retirement cleanup fails', async () => {
        const launchStarted = deferred<void>();
        const launchResult = deferred<PluginProcessHandle>();
        const processResult = deferred<PluginProcessResult>();
        const process: PluginProcessHandle = Object.freeze({
            pid: 42,
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await processResult.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose: () => undefined })),
            dispose: vi.fn(async () => {
                throw new Error('process cleanup failed');
            }),
        });
        const exec = createExec();
        exec.spawn.mockImplementation(async () => {
            launchStarted.resolve();
            return await launchResult.promise;
        });
        const host = createStablePluginManagedServersHost({
            createInstanceId: () => 'opaque-retired-cleanup-failure',
        });
        const servers = host.bind({
            generation: 'generation-retired-cleanup-failure',
            pluginId: 'fixture.plugin',
            contributionId: 'fixture.agent',
            isGenerationCurrent: () => true,
            exec,
        });

        const establishment = servers.supervise(managedSpec('server'));
        await launchStarted.promise;
        const retirement = host.retireGeneration('generation-retired-cleanup-failure', 'fixture.plugin');
        const retirementAssertion = expect(retirement).rejects.toMatchObject({
            code: 'plugin_managed_server_retirement_failed',
        });
        launchResult.resolve(process);

        await expect(establishment).rejects.toMatchObject({
            code: 'plugin_managed_server_retirement_failed',
        });
        await retirementAssertion;
        await expect(host.retireGeneration(
            'generation-retired-cleanup-failure',
            'fixture.plugin',
        )).rejects.toMatchObject({ code: 'plugin_managed_server_retirement_failed' });
        expect(process.dispose).toHaveBeenCalledTimes(1);
    });
});
