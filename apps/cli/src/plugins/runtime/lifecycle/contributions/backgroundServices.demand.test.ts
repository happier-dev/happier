import { describe, expect, it } from 'vitest';

import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { activatePluginRuntimeRegistry } from '../manager';
import { createPluginRuntimeOccurrenceId } from '../../runtimeSlots';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { BackgroundServiceContributionSchema } from '@happier-dev/protocol';
import { createBackgroundServiceRunnerHost, type HostBackgroundServiceContext, type PluginBackgroundServiceRunnerRegistration } from './backgroundServices';
import { createBackgroundServiceProcessExecution } from './backgroundServiceProcessExecution';
import { channelBoundary } from './backgroundServiceProcessChannel.testkit';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function createHost(registration: PluginBackgroundServiceRunnerRegistration) {
    return createBackgroundServiceRunnerHost({
        registrations: [registration],
        createContext(input) {
            return {
                context: {
                    plugin: { id: input.pluginId, version: input.pluginVersion },
                    contribution: { id: input.localId, qualifiedId: `${input.pluginId}/backgroundServices/${input.localId}` },
                    surface: 'background',
                    invokedAtMs: 1,
                    signal: input.signal,
                    services: createUnavailablePluginServices(),
                },
                complete() {},
            };
        },
    });
}

const identity = { pluginId: 'acme.indexer', pluginVersion: '1.0.0', occurrenceId: 'one', localId: 'index' };
const target = { pluginId: identity.pluginId, occurrenceId: identity.occurrenceId, localId: identity.localId };

describe('background service demand lifecycle', () => {
    it('keeps omitted declaration fields intact and accepts explicit placement and activation at the strict protocol boundary', () => {
        expect(BackgroundServiceContributionSchema.parse({ id: 'index' })).toEqual({ id: 'index' });
        const explicit = { id: 'index', placement: 'process', activation: 'demand' };
        expect(BackgroundServiceContributionSchema.parse(explicit)).toEqual(explicit);
        expect(BackgroundServiceContributionSchema.safeParse({ id: 'index', placement: 'elsewhere' }).success).toBe(false);
        expect(BackgroundServiceContributionSchema.safeParse({ ...explicit, extra: true }).success).toBe(false);
    });

    it('definitively stops a process execution that ignores run cancellation before joining disposal', async () => {
        const started = deferred();
        const release = deferred();
        let stops = 0;
        const host = createHost({ ...identity, activation: 'demand', placement: 'process', async runner() {}, createExecution() {
            return {
                async run() { started.resolve(); await release.promise; },
                async stop() { stops += 1; release.resolve(); },
                async dispose() {},
            };
        } });
        const handle = host.demand(target);
        const cancellation = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        await started.promise;
        const disposal = host.dispose();
        let observedStops = 0;
        try {
            await Promise.resolve();
            observedStops = stops;
        } finally { release.resolve(); }
        await disposal;
        await cancellation;
        expect(observedStops).toBe(1);
    });

    it('does not allocate a process execution for a demand cancelled before its run begins', async () => {
        let births = 0;
        const host = createHost({ ...identity, placement: 'process', activation: 'demand', async runner() {}, createExecution() {
            births += 1;
            return { async run() {}, async dispose() {} };
        } });
        const handle = host.demand(target);
        const cancellation = expect(handle.settlement).rejects.toMatchObject({ name: 'AbortError' });
        handle.cancel();
        await cancellation;
        await host.settle([identity.pluginId]);
        expect(births).toBe(0);
        await host.dispose();
    });

    it('retires active and queued demands together without entering the follow-up run', async () => {
        const started = deferred();
        let runs = 0;
        const host = createHost({ ...identity, activation: 'demand', async runner(context) {
            runs += 1;
            started.resolve();
            await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        } });
        const active = host.demand(target);
        await started.promise;
        const queued = host.demand(target);
        const activeCancellation = expect(active.settlement).rejects.toMatchObject({ name: 'AbortError' });
        const queuedCancellation = expect(queued.settlement).rejects.toMatchObject({ name: 'AbortError' });
        host.retire([identity.pluginId]);
        await Promise.all([activeCancellation, queuedCancellation]);
        await host.settle([identity.pluginId]);
        expect(runs).toBe(1);
        await host.dispose();
    });

    it('joins execution disposal before settlement and gives a demand during disposal a fresh execution', async () => {
        const disposing = deferred();
        const allowDisposal = deferred();
        let births = 0;
        let settled = false;
        const host = createHost({ ...identity, activation: 'demand', placement: 'process', async runner() {}, createExecution() {
            const birth = ++births;
            return { async run() {}, async dispose() {
                if (birth === 1) { disposing.resolve(); await allowDisposal.promise; }
            } };
        } });
        const first = host.demand(target);
        void first.settlement.then(() => { settled = true; });
        await disposing.promise;
        expect(settled).toBe(false);
        const second = host.demand(target);
        expect(births).toBe(1);
        allowDisposal.resolve();
        await Promise.all([first.settlement, second.settlement]);
        expect(births).toBe(2);
        await host.dispose();
    });

    it.each([false, true])('lazily activates a demand-only plugin and binds demand to its daemon invocation services (adopted: %s)', async (adopted) => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: identity.pluginId, version: '1.0.0', displayName: 'Demand indexer',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { backgroundServices: [{ id: 'index', activation: 'demand' }, { id: 'followup', activation: 'demand' }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Demand service manifest must be admitted');
        const contributes = {
            agents: [], actions: [], resources: [], activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: identity.pluginId,
                manifestPath: '/virtual/happier.plugin.json', daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-demand', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }], catalogEntriesById: {}, agentDefinitionsById: new Map(), pluginDiagnosticsByPluginId: {},
        } as unknown as ResolvedContributionRegistry;
        const services = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        let activations = 0;
        let runs = 0;
        const adoptedRegistries: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>>[] = [];
        const peerPluginId = 'acme.unrelated';
        const occurrenceIdsByPluginId = new Map([
            [identity.pluginId, createPluginRuntimeOccurrenceId(identity.pluginId)],
            [peerPluginId, createPluginRuntimeOccurrenceId(peerPluginId)],
        ]);
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1, invocationServices: services,
            occurrenceIdsByPluginId,
            ...(adopted ? { adoptActivationComponent: ({ registry }: { registry: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> }) => {
                adoptedRegistries.push(registry);
            } } : {}),
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@happier-dev/plugins-demand/${adopted ? 'adopted-' : ''}daemon`, load: async () => ({
                activate(api: { backgroundServices: { register(id: string, runner: PluginBackgroundServiceRunnerRegistration['runner']): void } }) {
                    activations += 1;
                    api.backgroundServices.register('index', async (context) => {
                        expect(context.services.availability('backgroundServices').status).toBe('available');
                        await context.services.backgroundServices.demand('followup').settlement;
                    });
                    api.backgroundServices.register('followup', async () => { runs += 1; });
                },
            }) }),
        });
        try {
            registry.startAdoptedBackgroundServices();
            expect(activations).toBe(0);
            await registry.demandBackgroundService({ pluginId: identity.pluginId, localId: 'index' }).settlement;
            expect(activations).toBe(1);
            expect(runs).toBe(1);
            if (adopted) {
                expect(adoptedRegistries).toHaveLength(1);
                expect(adoptedRegistries[0]!.readPluginOccurrenceId(identity.pluginId))
                    .toBe(occurrenceIdsByPluginId.get(identity.pluginId));
                expect(adoptedRegistries[0]!.readPluginOccurrenceId(peerPluginId)).toBeNull();
            }
        } finally {
            await registry.dispose();
            for (const adoptedRegistry of adoptedRegistries) await adoptedRegistry.dispose();
            await services.dispose();
        }
    });

    it('registers a host service in the same owner without constructing plugin context', async () => {
        let hostRuns = 0;
        const host = createBackgroundServiceRunnerHost({ registrations: [], createContext() { throw new Error('Host services have no plugin context'); } });
        host.start();
        host.register({ owner: { kind: 'host', serviceId: 'memory-indexer' }, occurrenceId: 'host-one', localId: 'index', activation: 'demand', async runner(context: HostBackgroundServiceContext) {
            expect(context.isOccurrenceCurrent()).toBe(true);
            expect(context).not.toHaveProperty('plugin');
            hostRuns += 1;
        } });
        await host.demand({ serviceId: 'memory-indexer' }).settlement;
        expect(hostRuns).toBe(1);
        await host.dispose();
    });

    it('does no idle work and coalesces arrivals during a run into exactly one follow-up', async () => {
        const firstStarted = deferred();
        const releaseFirst = deferred();
        let runs = 0;
        const host = createHost({
            ...identity,
            activation: 'demand',
            async runner() {
                runs += 1;
                if (runs === 1) { firstStarted.resolve(); await releaseFirst.promise; }
            },
        });
        host.start();
        await Promise.resolve();
        expect(runs).toBe(0);
        const first = host.demand(target);
        await firstStarted.promise;
        const arrivals = Array.from({ length: 1000 }, () => host.demand(target));
        releaseFirst.resolve();
        await Promise.all([first.settlement, ...arrivals.map((handle) => handle.settlement)]);
        await host.settle([identity.pluginId]);
        expect(runs).toBe(2);
        await host.dispose();
    });

    it('cancels only its caller and preserves another coalesced caller', async () => {
        const started = deferred();
        const release = deferred();
        const signals: AbortSignal[] = [];
        const host = createHost({ ...identity, activation: 'demand', async runner(context) {
            signals.push(context.signal);
            if (signals.length === 1) { started.resolve(); await release.promise; }
        } });
        host.start();
        const first = host.demand(target);
        await started.promise;
        const cancelled = host.demand(target);
        const survivor = host.demand(target);
        const rejection = expect(cancelled.settlement).rejects.toMatchObject({ name: 'AbortError' });
        cancelled.cancel();
        await rejection;
        expect(signals[0]!.aborted).toBe(false);
        release.resolve();
        await Promise.all([first.settlement, survivor.settlement]);
        expect(signals).toHaveLength(2);
        await host.dispose();
    });

    describe.each(['plugin', 'host'] as const)('%s demand/process lifetime', kind => {
        function setup(onRun?: (child: ReturnType<typeof channelBoundary>, id: string, run: number) => void, abortFails = false) {
            const children: ReturnType<typeof channelBoundary>[] = [];
            const diagnostics: unknown[] = [];
            let runs = 0;
            const options = { occurrenceId: identity.occurrenceId, localId: identity.localId,
                placement: 'process' as const, activation: 'demand' as const,
                async runner() { throw new Error('Process placement must use its admitted execution'); },
                createExecution: () => createBackgroundServiceProcessExecution({
                    bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null }, serviceId: identity.pluginId,
                    spawnChannel: async () => {
                        const child = channelBoundary();
                        children.push(child);
                        const send = child.channel.send;
                        return { ...child.channel, send(frame: Buffer) {
                            send(frame);
                            const message = child.messages.at(-1);
                            if (message?.kind === 'run') {
                                runs++;
                                if (onRun) onRun(child, message.id, runs);
                                else child.emit({ kind: 'settled', id: message.id });
                            } else if (message?.kind === 'abort') child.emit(abortFails
                                ? { kind: 'failed', id: message.id, error: { code: 'background_service_run_cancelled', message: 'Fixture cancellation' } }
                                : { kind: 'settled', id: message.id });
                        } };
                    },
                }),
            };
            const host = createBackgroundServiceRunnerHost({
                registrations: [kind === 'plugin' ? { ...identity, ...options }
                    : { owner: { kind: 'host', serviceId: identity.pluginId }, ...options }],
                createContext(input) {
                    return { context: { plugin: { id: input.pluginId, version: input.pluginVersion },
                        contribution: { id: input.localId, qualifiedId: input.localId }, surface: 'background',
                        invokedAtMs: 1, signal: input.signal, services: createUnavailablePluginServices() }, complete() {} };
                },
                onDiagnostic: event => { diagnostics.push(event); },
            });
            const demand = () => host.demand(kind === 'plugin' ? target : { serviceId: identity.pluginId });
            host.start();
            return { host, demand, children, diagnostics, get runs() { return runs; } };
        }

        it('exits after each settled demand: 1000 demands cause 1000 births and zero resident children', async () => {
            const state = setup();
            try {
                expect(state.children).toHaveLength(0);
                for (let index = 1; index <= 1000; index++) {
                    await state.demand().settlement;
                    expect(state.children).toHaveLength(index);
                    expect(state.children.filter(child => !child.terminated)).toHaveLength(0);
                }
                expect(state.runs).toBe(1000);
            } finally { await state.host.dispose(); }
        });

        it('coalesces 1000 demands during a run into one followup in the same child, then exits', async () => {
            const started = deferred();
            const state = setup((child, id, run) => {
                if (run === 1) started.resolve();
                else child.emit({ kind: 'settled', id });
            });
            try {
                const first = state.demand();
                await started.promise;
                const followups = Array.from({ length: 1000 }, () => state.demand());
                state.children[0]!.emit({ kind: 'settled', id: '1' });
                await Promise.all([first.settlement, ...followups.map(handle => handle.settlement)]);
                expect(state.runs).toBe(2);
                expect(state.children).toHaveLength(1);
                expect(state.children[0]!.terminated).toBe(true);
            } finally { await state.host.dispose(); }
        });

        it('exits when retired during a run without entering a queued followup', async () => {
            const started = deferred();
            const state = setup(() => { started.resolve(); });
            const first = state.demand();
            const rejected = expect(first.settlement).rejects.toMatchObject({ name: 'AbortError' });
            try {
                await started.promise;
                const queued = state.demand();
                const queuedRejection = expect(queued.settlement).rejects.toMatchObject({ name: 'AbortError' });
                state.host.retire([identity.pluginId]);
                await Promise.all([rejected, queuedRejection, state.host.settle([identity.pluginId])]);
                expect(state.runs).toBe(1);
                expect(state.children).toHaveLength(1);
                expect(state.children[0]!.terminated).toBe(true);
            } finally { await state.host.dispose(); }
        });

        it('preserves a new demand arriving while the last caller cancellation settles', async () => {
            const started = deferred();
            const state = setup((child, id, run) => {
                if (run === 1) started.resolve();
                else child.emit({ kind: 'settled', id });
            }, true);
            try {
                const first = state.demand();
                const cancelled = expect(first.settlement).rejects.toMatchObject({ name: 'AbortError' });
                await started.promise;
                first.cancel();
                const next = state.demand();
                await Promise.all([cancelled, next.settlement]);
                expect(state.children).toHaveLength(2);
                expect(state.children.every(child => child.terminated)).toBe(true);
            } finally { await state.host.dispose(); }
        });

        it('reports unexpected exit visibly and creates no replacement until the next demand', async () => {
            const started = deferred();
            const state = setup((child, id, run) => {
                if (run === 1) started.resolve();
                else child.emit({ kind: 'settled', id });
            });
            try {
                const failed = expect(state.demand().settlement).rejects.toMatchObject({ code: 'background_service_process_exited' });
                await started.promise;
                const queuedFailure = expect(state.demand().settlement).rejects.toMatchObject({ code: 'background_service_process_exited' });
                state.children[0]!.finish({ type: 'exited', code: 23 });
                await Promise.all([failed, queuedFailure]);
                await state.host.settle([identity.pluginId]);
                expect(state.diagnostics).toContainEqual(expect.objectContaining({ code: 'background_service_failed' }));
                expect(state.children).toHaveLength(1);
                expect(state.children[0]!.terminated).toBe(true);
                await state.demand().settlement;
                expect(state.children).toHaveLength(2);
                expect(state.children.every(child => child.terminated)).toBe(true);
            } finally { await state.host.dispose(); }
        });
    });

    it('rejects a failed demand and permits a later demand without an idle retry', async () => {
        let runs = 0;
        const failure = new Error('index failed');
        const host = createHost({ ...identity, activation: 'demand', async runner() {
            runs += 1;
            if (runs === 1) throw failure;
        } });
        host.start();
        await expect(host.demand(target).settlement).rejects.toBe(failure);
        await host.settle([identity.pluginId]);
        expect(runs).toBe(1);
        await host.demand(target).settlement;
        expect(runs).toBe(2);
        await host.dispose();
    });
});
