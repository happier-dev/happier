import { describe, expect, it, vi } from 'vitest';

import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createBackgroundServiceRunnerHost, type PluginBackgroundServiceRunnerRegistration } from './backgroundServices';

function registration(
    runner: PluginBackgroundServiceRunnerRegistration['runner'],
) {
    return Object.freeze({
        pluginId: 'acme.indexer',
        pluginVersion: '1.0.0',
        occurrenceId: 'generation-one',
        localId: 'retired-during-context-creation',
        runner,
    });
}

function inertBackgroundContext(input: Readonly<{
    pluginId: string;
    pluginVersion: string;
    localId: string;
    signal: AbortSignal;
}>): BackgroundServiceContext {
    return Object.freeze({
        plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
        contribution: Object.freeze({ id: input.localId, qualifiedId: input.localId }),
        surface: 'background' as const,
        invokedAtMs: 1,
        signal: input.signal,
        // The test asserts that this context never crosses the runner boundary.
        services: Object.freeze({}) as BackgroundServiceContext['services'],
    });
}

describe('background service runner host currentness', () => {
    it('does not acknowledge a placement cleanup failure first observed while definitive disposal joins its run', async () => {
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        let finish!: () => void;
        const finishing = new Promise<void>((resolve) => { finish = resolve; });
        const failure = new Error('Final placement release failed');
        let releaseAllowed = false;
        const host = createBackgroundServiceRunnerHost({
            registrations: [{ ...registration(async () => {}), activation: 'demand', placement: 'process', createExecution() {
                return { async run() { entered(); await finishing; }, async dispose() {
                    if (!releaseAllowed) throw failure;
                } };
            } }],
            createContext(input) { return { context: inertBackgroundContext(input), complete() {} }; },
        });
        const handle = host.demand({ pluginId: 'acme.indexer', localId: 'retired-during-context-creation' });
        const cancelled = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        await started;
        const disposal = host.dispose();
        finish();
        try {
            await expect(disposal).rejects.toBe(failure);
            await expect(host.settle(['acme.indexer'])).rejects.toBe(failure);
            releaseAllowed = true;
            await expect(host.dispose()).resolves.toBeUndefined();
        } finally {
            releaseAllowed = true;
            finish();
            await host.dispose();
            await cancelled;
        }
    });

    it('retains failed normal placement cleanup and refuses another birth until explicit release', async () => {
        const failure = new Error('Unconfirmed child cleanup');
        let releaseAllowed = false;
        let births = 0;
        let releases = 0;
        const host = createBackgroundServiceRunnerHost({
            registrations: [{ ...registration(async () => {}), activation: 'demand', placement: 'process', createExecution() {
                births += 1;
                return { async run() {}, async dispose() {
                    if (!releaseAllowed) throw failure;
                    releases += 1;
                } };
            } }],
            createContext(input) { return { context: inertBackgroundContext(input), complete() {} }; },
        });
        const target = { pluginId: 'acme.indexer', localId: 'retired-during-context-creation' };
        await expect(host.demand(target).settlement).rejects.toBe(failure);
        await expect(host.settle(['acme.indexer'])).rejects.toBe(failure);
        expect(() => host.demand(target)).toThrow(failure);
        expect(births).toBe(1);
        releaseAllowed = true;
        await host.dispose();
        expect(releases).toBe(1);
    });

    it('retries failed definitive process release on the same closed owner', async () => {
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        let release!: () => void;
        const stopped = new Promise<void>((resolve) => { release = resolve; });
        const failure = new Error('Process custody unavailable');
        let attempts = 0;
        const host = createBackgroundServiceRunnerHost({
            registrations: [{ ...registration(async () => {}), activation: 'demand', placement: 'process', createExecution() {
                return { async run() { entered(); await stopped; }, async dispose() {}, async stop() {
                    attempts += 1;
                    if (attempts === 1) throw failure;
                    release();
                } };
            } }],
            createContext(input) { return { context: inertBackgroundContext(input), complete() {} }; },
        });
        const target = { pluginId: 'acme.indexer', localId: 'retired-during-context-creation' };
        const handle = host.demand(target);
        const cancelled = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        await started;
        try {
            await expect(host.dispose()).rejects.toBe(failure);
            expect(() => host.demand(target)).toThrow();
            await expect(host.dispose()).resolves.toBeUndefined();
            expect(attempts).toBe(2);
        } finally { release(); await host.settle(['acme.indexer']); await cancelled; }
    });

    it('rejects demand settlement and reports a genuine asynchronous context cleanup failure', async () => {
        const failure = new Error('Background context cleanup failed');
        const diagnostics: unknown[] = [];
        const host = createBackgroundServiceRunnerHost({
            registrations: [{ ...registration(async () => {}), activation: 'demand' }],
            createContext(input) {
                return { context: inertBackgroundContext(input), async complete() { throw failure; } };
            },
            onDiagnostic(event) { diagnostics.push(event); },
        });
        await expect(host.demand({ pluginId: 'acme.indexer', localId: 'retired-during-context-creation' }).settlement).rejects.toBe(failure);
        expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'background_service_failed', error: failure }));
        await host.dispose();
    });

    it('joins asynchronous context cleanup before disposing a process execution and settling its demand', async () => {
        let entered!: () => void;
        const cleaning = new Promise<void>((resolve) => { entered = resolve; });
        let release!: () => void;
        const drained = new Promise<void>((resolve) => { release = resolve; });
        let cleaned = false;
        let disposed = false;
        const host = createBackgroundServiceRunnerHost({
            registrations: [{ ...registration(async () => {}), activation: 'demand', placement: 'process', createExecution() {
                return { async run() {}, async dispose() {
                    expect(cleaned).toBe(true);
                    disposed = true;
                } };
            } }],
            createContext(input) {
                return { context: inertBackgroundContext(input), async complete() {
                    entered();
                    await drained;
                    cleaned = true;
                } };
            },
        });
        const handle = host.demand({ pluginId: 'acme.indexer', localId: 'retired-during-context-creation' });
        const settlement = expect(handle.settlement).resolves.toBeUndefined();
        await cleaning;
        release();
        await settlement;
        expect(disposed).toBe(true);
        await host.dispose();
    });

    it('settles normal completion without a failure or same-generation restart', async () => {
        const diagnostics = vi.fn();
        const runner = vi.fn(async () => {});
        const complete = vi.fn();
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration(runner)],
            createContext(input) {
                return Object.freeze({
                    context: inertBackgroundContext(input),
                    complete,
                });
            },
            onDiagnostic: diagnostics,
        });

        host.start();
        await host.settle(['acme.indexer']);

        host.start();
        await host.settle(['acme.indexer']);
        expect(runner).toHaveBeenCalledOnce();
        expect(complete).toHaveBeenCalledOnce();
        expect(diagnostics).not.toHaveBeenCalled();
        await host.dispose();
    });

    it('reports rejection as stopped with its exact contribution identity', async () => {
        const failure = new Error('observer stopped');
        const diagnostics = vi.fn();
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration(async () => { throw failure; })],
            createContext(input) {
                return Object.freeze({
                    context: inertBackgroundContext(input),
                    complete() {},
                });
            },
            onDiagnostic: diagnostics,
        });

        host.start();
        await host.settle(['acme.indexer']);

        expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.indexer',
            occurrenceId: 'generation-one',
            localId: 'retired-during-context-creation',
            code: 'background_service_failed',
            error: failure,
        }));
        await host.dispose();
    });

    it('does not enter a runner retired while its context is being created', async () => {
        const runner = vi.fn(async () => {});
        const complete = vi.fn();
        let host!: ReturnType<typeof createBackgroundServiceRunnerHost>;
        host = createBackgroundServiceRunnerHost({
            registrations: [registration(runner)],
            createContext(input) {
                host.retire([input.pluginId]);
                return Object.freeze({
                    context: inertBackgroundContext(input),
                    complete,
                });
            },
        });

        host.start();
        await host.settle(['acme.indexer']);
        await host.dispose();

        expect(runner).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledOnce();
    });

    it('does not diagnose an unavailable context after its generation retires', async () => {
        const runner = vi.fn(async () => {});
        const diagnostics = vi.fn();
        let host!: ReturnType<typeof createBackgroundServiceRunnerHost>;
        host = createBackgroundServiceRunnerHost({
            registrations: [registration(runner)],
            createContext(input) {
                host.retire([input.pluginId]);
                return Object.freeze({
                    unavailable: Object.freeze({
                        code: 'plugin_host_access_service_unavailable',
                        hostAccessId: 'network',
                        status: 'unavailable' as const,
                    }),
                });
            },
            onDiagnostic: diagnostics,
        });

        host.start();
        await host.settle(['acme.indexer']);

        expect(runner).not.toHaveBeenCalled();
        expect(diagnostics).not.toHaveBeenCalled();
    });

    it('does not report expected retirement as a failure', async () => {
        const diagnostics = vi.fn();
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration(async (context) => {
                await new Promise<void>((resolve) => {
                    context.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            })],
            createContext(input) {
                return Object.freeze({
                    context: inertBackgroundContext(input),
                    complete() {},
                });
            },
            onDiagnostic: diagnostics,
        });

        host.start();
        await Promise.resolve();
        host.retire(['acme.indexer']);
        await host.settle(['acme.indexer']);

        expect(diagnostics).not.toHaveBeenCalled();
    });

});
