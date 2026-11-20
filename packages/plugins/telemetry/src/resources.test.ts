import { describe, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import * as database from '@happier-dev/database-protocol';
import { createCaptureActions, createCaptureSelectedSourceReaders } from './actions.js';
import { createCaptureResourceRuntime } from './resources.js';
import { createCaptureBackgroundOwner, localCaptureBackground } from './background.js';
import { captureSourcePartition } from './partition.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { captureMigrations } from './store/capture.js';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';

const source = { kind: 'worktree' as const, serverId: 'home', machineId: 'machine', projectId: 'project', workspaceId: 'workspace' };
const unavailable = () => { throw new Error('Unused public host service'); };

describe('capture demanded Resource through real public Actions', () => {
    it('reads one mounted Environment batch and releases its selected push subscriptions', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        // The daemon SQL handle and host Environment admission are SDK boundaries.
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const deploymentDatabases = { async admitTelemetryRead(input: { environmentId: string }) { return {
            environment: { serverId: 'home', environmentId: input.environmentId, revision: 1 }, collectorMachineId: 'collector',
            capabilities: { metrics: true },
        }; } } as unknown as PluginServices['deploymentDatabases'];
        const lifetime = new AbortController();
        const lease = await localCaptureBackground.acquireRuntime({ signal: lifetime.signal, services: { storage } });
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, deploymentDatabases } });
        let reads = 0;
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: lifetime.signal,
            context: { kind: 'surface', mountInstanceKey: 'requests', launchInput: { view: 'metrics', input: {
                serverId: 'home', environmentIds: ['app', 'empty'], windowMs: 1000,
            } } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            observeAction: unavailable,
            async readAction(ref, input) { reads++; return { ok: true, result: await host.invokeAction(ref.localId, input) }; },
        };
        try {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2000);
            await lease.runtime.store.write(['web', 'worker'].map((serviceName, index) => ({ id: serviceName,
                kind: 'span' as const, spanKind: 2, source: 'otlp' as const, worktree: 'environment:app', at: 1500 + index,
                serviceName, durationMs: 1 })));
            const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
            if (!resource?.createProducer) throw new Error('Resource registration missing');
            const producer = await resource.createProducer(options);
            let invalidations = 0;
            const observation = await producer.observe(() => { invalidations++; }, options);
            try {
                expect(JSON.parse(String(await producer.read(options)))).toMatchObject({ view: 'metrics', result: { items: [
                    { environmentId: 'app', result: { measurements: { value: 2, basis: 'sampled_spans', window: { since: 1000, until: 2000 } } } },
                    { environmentId: 'empty', result: { status: 'unknown' }, trend: [] },
                ] } });
                expect(reads).toBe(1);
                await lease.runtime.store.write([{ id: 'elsewhere', kind: 'span', source: 'otlp', worktree: 'environment:elsewhere', at: 1500 }]);
                expect(invalidations).toBe(0);
                const batch = ['app', 'empty'].map(environmentId => ({ id: 'more', kind: 'span' as const, spanKind: 2,
                    source: 'otlp' as const, worktree: `environment:${environmentId}`, serviceName: 'third', durationMs: 1, at: 2100 }));
                await lease.runtime.store.write(batch);
                expect(invalidations).toBe(1);
                await lease.runtime.store.write(batch);
                expect(invalidations).toBe(1);
                vi.setSystemTime(2200);
                expect(JSON.parse(String(await producer.read(options)))).toMatchObject({ result: { items: [
                    { environmentId: 'app', result: { measurements: { value: 3, window: { since: 1200, until: 2200 } } } },
                    { environmentId: 'empty', result: { measurements: { value: 1 } } },
                ] } });
                expect(reads).toBe(2);
                await observation.dispose(); await producer.dispose();
                await lease.runtime.clear('environment:app');
                expect(invalidations).toBe(1);
            } finally { await observation.dispose(); await producer.dispose(); }
        } finally { vi.useRealTimers(); lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
    });

    it('pushes selected cost operands through the existing demanded Resource and stops its subscription on disposal', async () => {
        const fixture = createCaptureSqliteFixture(), owner = localCaptureBackground;
        const lifetime = new AbortController(), consumer = new AbortController();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const selectedSource = { kind: 'environment' as const, serverId: 'home', environmentId: 'app' };
        const deploymentDatabases = { async admitTelemetryRead() { return {
            environment: { serverId: 'home', environmentId: 'app', revision: 1 }, collectorMachineId: 'collector',
            capabilities: { queries: true, traces: true, appLlmCost: true },
        }; } } as unknown as PluginServices['deploymentDatabases'];
        const lease = await owner.acquireRuntime({ signal: lifetime.signal, services: { storage } });
        const partition = captureSourcePartition(selectedSource, undefined);
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, deploymentDatabases } });
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: consumer.signal,
            context: { kind: 'surface', mountInstanceKey: 'costs', launchInput: { view: 'costs', input: { source: selectedSource, since: 0, until: 100 } } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            observeAction: unavailable,
            async readAction(ref, input) {
                return { ok: true, result: await host.invokeAction(ref.localId, input) };
            },
        };
        try {
            const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
            expect(resource).toBeDefined();
            if (!resource?.createProducer) throw new Error('Resource registration missing');
            const creation = resource.createProducer(options);
            await expect(creation).resolves.toBeDefined();
            const producer = await creation;
            let invalidations = 0;
            const observation = await producer.observe(() => { invalidations++; }, options);
            try {
                expect(JSON.parse(String(await producer.read(options)))).toMatchObject({ view: 'costs', result: {
                    ok: true, items: [], coverage: { callCount: 0 } } });
                const tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: null };
                await lease.runtime.store.write([{ id: 'call', kind: 'span', source: 'otlp', worktree: partition, at: 1,
                    genAi: { provider: null, modelId: 'model', requestedModel: 'model', operation: 'chat', tokens,
                        tokenCategories: tokens, reportedCost: null } }]);
                expect(invalidations).toBe(1);
                const snapshot = database.DatabaseCaptureResourceSnapshotV1Schema.parse(JSON.parse(String(await producer.read(options))));
                expect(snapshot).toMatchObject({ view: 'costs', result: { ok: true, coverage: { callCount: 1 }, items: [{ tokens }] } });
                await observation.dispose(); await producer.dispose();
                await lease.runtime.clear(partition);
                expect(invalidations).toBe(1);
            } finally { await observation.dispose(); await producer.dispose(); }
        } finally { consumer.abort(); lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
    });

    it('reads actual selected bytes, observes only after a successful baseline, and stops on typed transport refusal and disposal', async () => {
        const fixture = createCaptureSqliteFixture(), owner = createCaptureBackgroundOwner();
        const lifetime = new AbortController(), consumer = new AbortController();
        const lease = await owner.acquireRuntime({ signal: lifetime.signal, services: { storage: { daemon: { async database(_id, definition) {
            for (const migration of definition?.migrations ?? []) await migration.up(fixture.db);
            return fixture.db;
        } } } } });
        const partition = captureSourcePartition(source, 'account'), runtime = lease.runtime;
        // These are post-admission reader fixtures; ACCESS source authorization is not substituted here.
        const readers = createCaptureSelectedSourceReaders({ source, partition, runtime });
        const plugin = definePlugin({ id: 'happier.telemetry', version: '0.0.0', displayName: 'Capture Resource control',
            actions: createCaptureActions(readers), resources: { [database.DATABASE_CAPTURE_RESOURCE_ID_V1]: {
                source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', execution: { target: 'daemon' },
                runtime: createCaptureResourceRuntime({ subscribe: owner.subscribe }),
            } } });
        const host = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        let transportRefused = false;
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: consumer.signal, requesterAccount: { accountId: 'account' },
            context: { kind: 'surface', mountInstanceKey: 'selected', launchInput: { view: 'query', input: { source, id: 'older' } } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            observeAction: unavailable,
            async readAction(ref, input, invocation) {
                // The genuine public Action executor remains beneath this host transport adapter.
                expect(ref.pluginId).toBe(plugin.manifest.id);
                expect(ref.localId).toBe(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1));
                // Remote refusal is a transport boundary; testkit surface selection does not authorize requests.
                if (transportRefused) return { ok: false, errorCode: 'plugin_service_unavailable', error: 'Action transport unavailable' };
                try { return { ok: true, result: await host.invokeAction(ref.localId, input, { signal: invocation?.signal, surface: 'plugin' }) }; }
                catch (error: unknown) {
                    if (!(error instanceof PluginError)) throw error;
                    return { ok: false, errorCode: error.code, error: error.message };
                }
            },
        };
        const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
        if (!resource?.createProducer) throw new Error('Public Resource registration missing');
        const producer = await resource.createProducer(options);
        let invalidations = 0;
        const observation = await producer.observe(() => { invalidations++; }, options);
        try {
            await runtime.store.write([
                { id: 'latest', worktree: partition, kind: 'query', source: 'wire', at: 10, shape: 'select ?' },
                { id: 'older', worktree: partition, kind: 'query', source: 'wire', at: 1, shape: 'select ?', detail: { value: 'before' } },
            ]);
            expect(invalidations).toBe(0);
            expect(JSON.parse(String(await producer.read(options)))).toEqual({ view: 'query', result: { ok: true, source, detail: { value: 'before' } } });
            await runtime.store.write([{ id: 'older', worktree: partition, kind: 'query', source: 'wire', at: 1, shape: 'select ?', detail: { value: 'after' } }]);
            expect(invalidations).toBe(1);
            const after = database.DatabaseCaptureResourceSnapshotV1ProtocolSchema.parse(JSON.parse(String(await producer.read(options))));
            expect(after).toEqual({ view: 'query', result: { ok: true, source, detail: { value: 'after' } } });
            await runtime.store.write([{ id: 'unrelated', worktree: 'other', kind: 'query', source: 'wire', at: 20 }]);
            expect(invalidations).toBe(1);
            // A typed remote refusal closes this subscription. Source ACL proof awaits ACCESS.
            transportRefused = true;
            await expect(producer.read(options)).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
            await runtime.store.write([{ id: 'older', worktree: partition, kind: 'query', source: 'wire', at: 1, detail: { value: 'refused' } }]);
            expect(invalidations).toBe(1);
            consumer.abort();
            await observation.dispose();
            await producer.dispose();
            await runtime.clear(partition);
            expect(invalidations).toBe(1);
        } finally {
            consumer.abort(); await observation.dispose(); await producer.dispose(); await host.dispose();
            lifetime.abort(); await lease.release(); fixture.close();
        }
    });
});
