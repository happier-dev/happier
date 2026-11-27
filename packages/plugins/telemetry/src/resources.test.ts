import { describe, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import { PluginServiceListFieldResourceResultV1Schema } from '@happier-dev/plugin-sdk/ui';
import * as database from '@happier-dev/database-protocol';
import { createCaptureActions, createCaptureSelectedSourceReaders } from './actions.js';
import { createCaptureResourceRuntime } from './resources.js';
import { createCaptureBackgroundOwner, localCaptureBackground } from './background.js';
import { captureSourcePartition } from './partition.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { captureMigrations } from './store/capture.js';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import type { ExceptionIssueRecord } from './exceptions/issueRecord.js';

const source = { kind: 'worktree' as const, serverId: 'home', machineId: 'machine', projectId: 'project', workspaceId: 'workspace' };
const unavailable = () => { throw new Error('Unused public host service'); };

it('follows the issue count and last occurrence across the bounded own and Team reads', async () => {
    const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN });
    try {
        const resource = host.registration('resources', 'environment-open-issues');
        expect(resource).toBeDefined();
        if (!resource) throw new Error('The Environment issue read is not registered');
        const row = (rowId: string, status: ExceptionIssueRecord['status'], lastSeenAtMs: number) => ({
            rowId, revision: 1, value: { id: rowId, environmentId: 'app', fingerprint: rowId, title: rowId, status,
                count: 1, firstSeenAtMs: 1, lastSeenAtMs, asOfMs: lastSeenAtMs, createdAtMs: 1, updatedAtMs: lastSeenAtMs },
        });
        let resolvedLastSeenAtMs = 4;
        const own = vi.fn(async (_query: { cursor?: string }) => _query.cursor === 'own-next'
            ? { rows: [row('resolved', 'resolved', resolvedLastSeenAtMs)], changeCursor: 2 }
            : { rows: [row('same-id', 'open', 3)], nextCursor: 'own-next', changeCursor: 2 });
        const sharedRow = (ownerAccountId: string, rowId: string, access: 'owner' | 'view') => ({
            ...row(rowId, 'open', access === 'owner' ? 10 : 7), ownerAccountId, access,
        });
        const shared = vi.fn(async ({ query }: { query: { cursor?: string } }) => query.cursor === 'team-next'
            ? { rows: [sharedRow('other', 'same-id', 'view')] }
            : { rows: [sharedRow('own', 'same-id', 'owner'), sharedRow('other', 'same-id', 'view')], nextCursor: 'team-next' });
        const dispose = vi.fn();
        let invalidated: (() => void) | undefined;
        const watch = vi.fn((_query: unknown, callback: () => void) => {
            invalidated = callback;
            return { dispose };
        });
        // The SDK Account Collection is the transport and envelope boundary.
        const accountStorage = { collection: () => ({ query: own, sharing: { sharedWithMe: shared }, watch }) } as unknown as
            NonNullable<PluginDynamicResourceInvocationOptionsV1['accountStorage']>;
        const options = createTestResourceInvocationContext({ accountStorage, context: {
            kind: 'surface', mountInstanceKey: 'services', launchInput: {
                entity: 'service', serverId: 'home', environmentIds: ['app', 'empty'], includeTrend: false,
            },
        } });
        const notify = vi.fn();
        const observation = await resource.observe(notify, options);
        const value = await resource.read(options);
        const snapshot = PluginServiceListFieldResourceResultV1Schema.parse(JSON.parse(String(value)));
        expect(snapshot.items).toEqual([
            { environmentId: 'app', value: null, facts: { 'open-issues': { value: 2 }, 'last-issue-seen': { value: 7 } } },
            { environmentId: 'empty', value: null, facts: { 'open-issues': { value: 0 }, 'last-issue-seen': { value: null } } },
        ]);
        const index = { index: 'by-environment', prefixes: [['app'], ['empty']], order: 'asc' };
        expect(own.mock.calls.map(([query]) => query)).toEqual([index, { ...index, cursor: 'own-next' }]);
        expect(shared.mock.calls.map(([request]) => request)).toEqual([{ query: index }, { query: { ...index, cursor: 'team-next' } }]);
        resolvedLastSeenAtMs = 8;
        invalidated?.();
        expect(notify).toHaveBeenCalledOnce();
        const refreshed = PluginServiceListFieldResourceResultV1Schema.parse(JSON.parse(String(await resource.read(options))));
        expect(refreshed.items[0]?.facts).toMatchObject({ 'open-issues': { value: 2 }, 'last-issue-seen': { value: 8 } });
        await observation.dispose();
        expect(dispose).toHaveBeenCalledOnce();
    } finally { await host.dispose(); }
});

describe('capture demanded Resource through real public Actions', () => {
    it('reads one mounted Environment batch and releases its selected push subscriptions', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        // The daemon SQL handle and host Environment admission are SDK boundaries.
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const admitTelemetryRead = vi.fn(async (input: { environmentId: string }) => ({
            environment: { serverId: 'home', environmentId: input.environmentId, revision: 1 }, collectorMachineId: 'collector',
            capabilities: { metrics: true },
        }));
        const deploymentDatabases = { admitTelemetryRead } as unknown as PluginServices['deploymentDatabases'];
        const lifetime = new AbortController();
        const lease = await localCaptureBackground.acquireRuntime({ signal: lifetime.signal, services: { storage } });
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN });
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: lifetime.signal, deploymentDatabases,
            daemonStorage: storage.daemon,
            context: { kind: 'surface', mountInstanceKey: 'requests', launchInput: {
                entity: 'service', serverId: 'home', environmentIds: ['app', 'empty'],
            } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            observeAction: unavailable,
            async readAction() { return { ok: false, errorCode: 'deployment_target_role_unavailable',
                error: 'The nested Action has no original collector admission' }; },
        };
        try {
            const until = database.TELEMETRY_REQUESTS_WINDOW_MS_V1 + 1000;
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            vi.setSystemTime(until);
            await lease.runtime.store.write(['web', 'worker'].map((serviceName, index) => ({ id: serviceName,
                kind: 'span' as const, spanKind: 2, source: 'otlp' as const, worktree: 'environment:app', at: 1500 + index,
                serviceName, durationMs: index + 1 })));
            const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
            if (!resource?.createProducer) throw new Error('Resource registration missing');
            const producer = await resource.createProducer(options);
            let invalidations = 0;
            const observation = await producer.observe(() => { invalidations++; }, options);
            try {
                const first = PluginServiceListFieldResourceResultV1Schema.parse(JSON.parse(String(await producer.read(options))));
                expect(first).toMatchObject({ items: [
                    { environmentId: 'app', value: 2, provenance: { basis: 'sampled_spans', window: { since: 1000, until } },
                        facts: { 'http-p95': { value: 2, provenance: { basis: 'sampled_spans' } },
                            'http-error-rate': { value: 0, provenance: { basis: 'sampled_spans' } } } },
                    { environmentId: 'empty', value: null, provenance: { completeness: 'unknown' }, trend: [],
                        facts: { 'http-p95': { value: null }, 'http-error-rate': { value: null } } },
                ] });
                expect(admitTelemetryRead.mock.calls.map(([input]) => input.environmentId)).toEqual(['app', 'empty']);
                await vi.advanceTimersByTimeAsync(60_000);
                expect(admitTelemetryRead).toHaveBeenCalledTimes(2);
                expect(invalidations).toBe(0);
                await lease.runtime.store.write([{ id: 'elsewhere', kind: 'span', source: 'otlp', worktree: 'environment:elsewhere', at: 1500 }]);
                expect(invalidations).toBe(0);
                const batch = ['app', 'empty'].map(environmentId => ({ id: 'more', kind: 'span' as const, spanKind: 2,
                    source: 'otlp' as const, worktree: `environment:${environmentId}`, serviceName: 'third', durationMs: 1, at: 2100 }));
                await lease.runtime.store.write(batch);
                expect(invalidations).toBe(1);
                await lease.runtime.store.write(batch);
                expect(invalidations).toBe(1);
                vi.setSystemTime(until + 200);
                expect(JSON.parse(String(await producer.read(options)))).toMatchObject({ items: [
                    { environmentId: 'app', value: 3, provenance: { window: { since: 1200, until: until + 200 } } },
                    { environmentId: 'empty', value: 1 },
                ] });
                expect(admitTelemetryRead).toHaveBeenCalledTimes(2);
                const summaryOptions: PluginDynamicResourceInvocationOptionsV1 = { ...options, context: {
                    kind: 'surface', mountInstanceKey: 'summary', launchInput: {
                        entity: 'service', serverId: 'home', environmentIds: ['app'], includeTrend: false,
                    },
                } };
                const summary = await resource.createProducer(summaryOptions);
                try {
                    expect(JSON.parse(String(await summary.read(summaryOptions)))).toMatchObject({ items: [{
                        environmentId: 'app', value: 3, trend: [], facts: {
                            'http-p95': { value: 2 }, 'http-error-rate': { value: 0 },
                        },
                    }] });
                    expect(admitTelemetryRead.mock.calls.map(([input]) => input.environmentId)).toEqual(['app', 'empty', 'app']);
                } finally { await summary.dispose(); }
                await observation.dispose(); await producer.dispose();
                await lease.runtime.clear('environment:app');
                expect(invalidations).toBe(1);
            } finally { await observation.dispose(); await producer.dispose(); }
        } finally { vi.useRealTimers(); lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
    });

    it.each(['environment', 'worktree'] as const)('keeps one admitted rolling capture list live for %s', async kind => {
        const fixture = createCaptureSqliteFixture();
        const lifetime = new AbortController();
        const consumer = new AbortController();
        const selected = kind === 'worktree' ? source : { kind, serverId: 'home', environmentId: 'app' };
        const partition = captureSourcePartition(selected, 'requester');
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const daemonStorage = { database: async () => fixture.db };
        const lease = await localCaptureBackground.acquireRuntime({ signal: lifetime.signal, services: { storage: { daemon: daemonStorage } } });
        const admitTelemetryRead = vi.fn(async ({ environmentId }: { environmentId: string }) => {
            expect(environmentId).toBe('app');
            return { environment: { serverId: 'home', environmentId, revision: 1 }, collectorMachineId: 'machine',
                capabilities: { logs: true } };
        });
        const deploymentDatabases = { admitTelemetryRead } as unknown as PluginServices['deploymentDatabases'];
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN });
        const options = { signal: consumer.signal, requesterAccount: { accountId: 'requester' },
            chosenMachine: { machineId: 'machine', installationId: 'installation' }, daemonStorage, deploymentDatabases,
            context: { kind: 'surface' as const, mountInstanceKey: 'rolling-logs', launchInput: { view: 'logs', windowMs: 100,
                input: { source: selected, page: { limit: 10 } } } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            observeAction: unavailable, readAction: unavailable,
        };
        try {
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            vi.setSystemTime(1_000);
            const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
            if (!resource?.createProducer) throw new Error('Capture Resource is missing');
            const log = (id: string, at: number, worktree = partition) => ({ id, at, worktree, kind: 'log' as const, source: 'otlp' as const });
            await lease.runtime.store.write([log('old-window', 925)]);
            const producer = await resource.createProducer(options);
            const snapshots: Promise<unknown>[] = [];
            const read = async () => database.DatabaseCaptureResourceSnapshotV1Schema.parse(JSON.parse(String(await producer.read(options))));
            const observation = await producer.observe(() => { snapshots.push(read()); }, options);
            try {
                expect(await read()).toMatchObject({ view: 'logs', window: { since: 900, until: 1_000 },
                    result: { source: selected, items: [{ id: 'old-window' }] } });
                const queryCount = fixture.queryRows.length;
                await vi.advanceTimersByTimeAsync(60_000);
                expect(snapshots).toHaveLength(0);
                expect(fixture.queryRows).toHaveLength(queryCount);
                expect(admitTelemetryRead).toHaveBeenCalledTimes(kind === 'environment' ? 1 : 0);
                vi.setSystemTime(1_050);
                await lease.runtime.store.write([log('other', 1_028, 'environment:unrelated')]);
                expect(snapshots).toHaveLength(0);
                await lease.runtime.store.write([log('new', 1_025)]);
                expect(await Promise.all(snapshots)).toMatchObject([{ view: 'logs', window: { since: 950, until: 1_050 },
                    result: { source: selected, items: [{ id: 'new' }] } }]);
                expect(fixture.queryRows).toHaveLength(queryCount + 1);
                lease.runtime.recordCoverage('environment:unrelated', 'invalid_telemetry');
                expect(snapshots).toHaveLength(1);
                lease.runtime.recordCoverage(partition, 'invalid_telemetry');
                expect(await snapshots.at(-1)).toMatchObject({
                    coverage: { lostObservations: 1, reason: 'invalid_telemetry' },
                    result: { source: selected, items: [{ id: 'new' }] },
                });
                expect(fixture.queryRows).toHaveLength(queryCount + 2);
                expect(admitTelemetryRead).toHaveBeenCalledTimes(kind === 'environment' ? 1 : 0);
                await observation.dispose(); await producer.dispose();
                await lease.runtime.store.write([log('after-close', 1_040)]);
                expect(snapshots).toHaveLength(2);
            } finally { await observation.dispose(); await producer.dispose(); }
        } finally { vi.useRealTimers(); consumer.abort(); lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
    });


    it.each(['finite', 'rolling'] as const)('pushes %s cost operands and stops on disposal', async mode => {
        const fixture = createCaptureSqliteFixture(), owner = localCaptureBackground;
        const lifetime = new AbortController(), consumer = new AbortController();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const selectedSource = { kind: 'environment' as const, serverId: 'home', environmentId: 'app' };
        const admitTelemetryRead = vi.fn(async () => ({
            environment: { serverId: 'home', environmentId: 'app', revision: 1 }, collectorMachineId: 'collector',
            capabilities: { queries: true, traces: true, appLlmCost: true },
        }));
        const deploymentDatabases = { admitTelemetryRead } as unknown as PluginServices['deploymentDatabases'];
        const lease = await owner.acquireRuntime({ signal: lifetime.signal, services: { storage } });
        const partition = captureSourcePartition(selectedSource, undefined);
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, deploymentDatabases } });
        const options = { signal: consumer.signal, requesterAccount: { accountId: 'requester' },
            chosenMachine: { machineId: 'collector', installationId: 'installation' }, daemonStorage: storage.daemon, deploymentDatabases,
            context: { kind: 'surface', mountInstanceKey: 'costs', launchInput: mode === 'rolling'
                ? { view: 'costs', windowMs: 100, input: { source: selectedSource, serviceName: 'api', groupByRoute: true } }
                : { view: 'costs', input: { source: selectedSource, since: 0, until: 100 } } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            observeAction: unavailable,
            async readAction(ref, input) {
                if (mode === 'rolling') throw new Error('admitted rolling reads must use their selected source');
                return { ok: true, result: await host.invokeAction(ref.localId, input) };
            },
        } satisfies PluginDynamicResourceInvocationOptionsV1;
        try {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(100);
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
                await lease.runtime.store.write([{ id: 'call', kind: 'span', source: 'otlp', worktree: partition, at: 1, serviceName: 'api',
                    genAi: { provider: null, modelId: 'model', requestedModel: 'model', operation: 'chat', tokens,
                        tokenCategories: tokens, reportedCost: null } }]);
                expect(invalidations).toBe(1);
                const snapshot = database.DatabaseCaptureResourceSnapshotV1Schema.parse(JSON.parse(String(await producer.read(options))));
                expect(snapshot).toMatchObject({ view: 'costs', result: { ok: true, coverage: { callCount: 1 }, items: [{ tokens }] } });
                if (mode === 'rolling') expect(admitTelemetryRead).toHaveBeenCalledTimes(1);
                await observation.dispose(); await producer.dispose();
                await lease.runtime.clear(partition);
                expect(invalidations).toBe(1);
            } finally { await observation.dispose(); await producer.dispose(); }
        } finally { vi.useRealTimers(); consumer.abort(); lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
    });

    it('pushes the selected Metrics overview only on collector changes until the viewer closes it', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const lifetime = new AbortController();
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const admitTelemetryRead = vi.fn(async () => ({
            collectorMachineId: 'collector', capabilities: { metrics: true },
        }));
        const deploymentDatabases = { admitTelemetryRead } as unknown as PluginServices['deploymentDatabases'];
        const lease = await localCaptureBackground.acquireRuntime({ signal: lifetime.signal, services: { storage } });
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, deploymentDatabases } });
        try {
            const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
            if (!resource?.createProducer) throw new Error('Resource registration missing');
            const options = {
                signal: lifetime.signal, requesterAccount: { accountId: 'requester' },
                chosenMachine: { machineId: 'collector', installationId: 'installation' },
                daemonStorage: storage.daemon, deploymentDatabases,
                context: { kind: 'surface', mountInstanceKey: 'metrics', launchInput: { view: 'metrics', windowMs: 100_000,
                    input: { view: 'overview', serverId: 'home', environmentId: 'app' } } },
                resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
                observeAction: unavailable, readAction: unavailable,
            } satisfies PluginDynamicResourceInvocationOptionsV1;
            const producer = await resource.createProducer(options);
            let invalidations = 0;
            const watch = await producer.observe(() => { invalidations++; }, options);
            const span = (environment: string) => ({ id: environment, kind: 'span' as const, spanKind: 2, source: 'otlp' as const,
                worktree: `environment:${environment}`, at: Date.now() - 10, serviceName: 'api', durationMs: 18 });
            try {
                expect(JSON.parse(String(await producer.read(options)))).toMatchObject({ view: 'metrics', result: { services: [], selected: null } });
                await lease.runtime.store.write([span('unrelated')]);
                expect(invalidations).toBe(0);
                await lease.runtime.store.write([span('app')]);
                expect(invalidations).toBe(1);
                const snapshot = database.DatabaseCaptureResourceSnapshotV1Schema.parse(JSON.parse(String(await producer.read(options))));
                expect(snapshot).toMatchObject({ view: 'metrics', result: { selected: { serviceName: 'api' } } });
                expect(admitTelemetryRead).toHaveBeenCalledTimes(1);
            } finally { await watch.dispose(); await producer.dispose(); }
            await lease.runtime.clear('environment:app');
            expect(invalidations).toBe(1);
        } finally { lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
    });

    it('pushes the latest retained exception without writing Account issue metadata', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const lifetime = new AbortController();
        const storage = { daemon: { database: async () => fixture.db } } as unknown as PluginServices['storage'];
        const admitTelemetryRead = vi.fn(async () => ({ collectorMachineId: 'collector', capabilities: { exceptions: true } }));
        const deploymentDatabases = { admitTelemetryRead } as unknown as PluginServices['deploymentDatabases'];
        const lease = await localCaptureBackground.acquireRuntime({ signal: lifetime.signal, services: { storage } });
        const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
            services: { storage, deploymentDatabases } });
        try {
            const resource = host.registration('resources', database.DATABASE_CAPTURE_RESOURCE_ID_V1);
            if (!resource?.createProducer) throw new Error('Resource registration missing');
            const options = {
                signal: lifetime.signal, requesterAccount: { accountId: 'requester' },
                chosenMachine: { machineId: 'collector', installationId: 'installation' },
                daemonStorage: storage.daemon, deploymentDatabases,
                context: { kind: 'surface', mountInstanceKey: 'status', launchInput: { view: 'status',
                    input: { source: { kind: 'environment', serverId: 'home', environmentId: 'app' } } } },
                resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
                observeAction: unavailable, readAction: unavailable,
            } satisfies PluginDynamicResourceInvocationOptionsV1;
            const producer = await resource.createProducer(options);
            let invalidations = 0;
            const watch = await producer.observe(() => { invalidations++; }, options);
            const occurrence = (environment: string, at: number) => ({ id: `${environment}:${at}`, kind: 'exception' as const,
                worktree: `environment:${environment}`, at, fingerprint: 'same-issue', origin: 'span' as const,
                serviceName: 'api', type: 'TypeError', message: 'Unexpected value', detail: {} });
            try {
                const read = async () => database.DatabaseCaptureResourceSnapshotV1Schema.parse(JSON.parse(String(await producer.read(options))));
                expect(await read()).toMatchObject({ view: 'status', result: { capabilityLastSampleAt: { exceptions: null } } });
                await lease.runtime.store.write([occurrence('other', 4)]);
                expect(invalidations).toBe(0);
                await lease.runtime.store.write([occurrence('app', 5), occurrence('app', 6)]);
                expect(invalidations).toBe(1);
                expect(await read()).toMatchObject({ view: 'status', result: { capabilityLastSampleAt: { exceptions: 6 } } });
                expect(admitTelemetryRead).toHaveBeenCalledTimes(1);
            } finally { await watch.dispose(); await producer.dispose(); }
            await lease.runtime.store.write([occurrence('app', 7)]);
            expect(invalidations).toBe(1);
        } finally { lifetime.abort(); await host.dispose(); await lease.release(); fixture.close(); }
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
        const refusal = {
            ok: false, errorCode: 'plugin_service_unavailable', error: 'Action transport unavailable',
            details: { reason: 'collector_restarting' },
            failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null },
        } as const;
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
                if (transportRefused) return refusal;
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
            await expect(producer.read(options)).rejects.toMatchObject({ data: {
                code: refusal.errorCode, message: refusal.error,
                details: refusal.details, failureCause: refusal.failureCause,
            } });
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
