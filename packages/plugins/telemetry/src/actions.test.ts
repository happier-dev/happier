import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AccountKvTransaction, DaemonDatabaseService, PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureActionProducers, createCaptureActions, createCaptureSelectedSourceReaders } from './actions.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as database from '@happier-dev/database-protocol';
import { createCaptureBackgroundOwner } from './background.js';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

const project = { serverId: 'home', machineId: 'machine', projectId: 'project' };

function accountStorageFixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE preferences(key TEXT PRIMARY KEY,value TEXT,version INTEGER)');
    const transaction: AccountKvTransaction = {
        async get(key) {
            const row = sqlite.prepare('SELECT value,version FROM preferences WHERE key=?').get(key);
            return row ? { version: Number(row.version), value: JSON.parse(String(row.value)) } : null;
        },
        async set(key, value, options) {
            const row = sqlite.prepare('SELECT version FROM preferences WHERE key=?').get(key);
            expect(row ? Number(row.version) : 'absent').toBe(options.expectedVersion);
            const version = row ? Number(row.version) + 1 : 1;
            sqlite.prepare('INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=excluded.version')
                .run(key, JSON.stringify(value), version);
            return { version };
        },
        async delete() { throw new Error('Unused persistence operation'); },
    };
    // Account KV is the persistence boundary; real SQLite enforces its CAS and transaction contract.
    const storage: PluginAccountStorageScope = {
        kv: { ...transaction, async list() { return { items: [] }; }, async transaction(run) {
            sqlite.exec('BEGIN');
            try { const result = await run(transaction); sqlite.exec('COMMIT'); return result; }
            catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        } },
        collection() { throw new Error('Unused persistence operation'); },
    };
    return { storage, close: () => sqlite.close() };
}

describe('capture Action producer bindings', () => {
    it('registers canonical public Actions over the real SQLite reader and excludes demanded bodies from summaries', async () => {
        const fixture = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(fixture.db);
            const runtime = createCaptureRuntime({ database: fixture.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish() {} });
            const source = { kind: 'worktree' as const, ...project, workspaceId: 'workspace' };
            await runtime.store.write([{ id: 'query', worktree: 'selected', kind: 'query', source: 'wire', at: 1,
                shape: 'select ?', detail: { sql: 'select ?', parameters: ['masked'] } },
                { id: 'request', worktree: 'selected', kind: 'span', source: 'otlp', at: 2, traceId: 'trace', spanId: 'root', spanKind: 2, durationMs: 30, endpointMethod: 'GET', endpointRoute: '/items', outcome: 'error' },
                { id: 'child', worktree: 'selected', kind: 'span', source: 'otlp', at: 3, traceId: 'trace', spanId: 'child', parentSpanId: 'root', spanKind: 3, durationMs: 20 },
                { id: 'log', worktree: 'selected', kind: 'log', source: 'otlp', at: 4, traceId: 'trace', spanId: 'child' },
            ]);
            // This declaration test exercises the reader callback; source admission has its own host boundary.
            const plugin = definePlugin({ id: database.DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, version: '0.0.0', displayName: 'Capture control',
                actions: createCaptureActions(createCaptureSelectedSourceReaders({ source, partition: 'selected', runtime })),
            });
            const host = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
            try {
                const status = await host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1), { source });
                expect(status).toEqual({ ok: true, source, coverage: { lostObservations: 0, reason: null } });
                const list = await host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1), { source, page: { limit: 1 } });
                expect(database.DatabaseCaptureQueriesListResultV1Schema.parse(list)).toMatchObject({ ok: true, items: [{ id: 'query', shape: 'select ?' }] });
                expect(JSON.stringify(list)).not.toContain('parameters');
                expect(await host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1), { source, id: 'query' }))
                    .toEqual({ ok: true, source, detail: { sql: 'select ?', parameters: ['masked'] } });
                const trace = await host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1), { source, traceId: 'trace', page: { limit: 2 } });
                expect(database.DatabaseCaptureTraceGetResultV1Schema.parse(trace)).toMatchObject({ ok: true,
                    slowChildSpans: [{ id: 'child', parentSpanId: 'root', durationMs: 20 }],
                    logCorrelations: [{ logId: 'log', traceId: 'trace', spanId: 'child', spanObservationId: 'child' }],
                });
                const endpoints = await host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1), { source, page: { limit: 2 } });
                expect(database.DatabaseCaptureEndpointsListResultV1Schema.parse(endpoints)).toMatchObject({ ok: true,
                    items: [{ requestCount: 1, errorCount: 1, errorRate: 1 }],
                });
                await expect(host.invokeAction(database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1), { source, page: { limit: 0 } })).rejects.toThrow();
            } finally { await host.dispose(); }
        } finally { fixture.close(); }
    });

    it('reads selected summaries before demanded detail and clears through the shared writer without clearing other partitions', async () => {
        const fixture = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(fixture.db);
            const runtime = createCaptureRuntime({ database: fixture.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish() {} });
            const producers = createCaptureActionProducers({ runtime, stopProjectCapture: createCaptureBackgroundOwner().stopProjectCapture });
            await runtime.store.write([
                { id: 'query', worktree: 'selected', kind: 'query', source: 'wire', at: 3, shape: 'select ?', detail: { sql: 'select ?', parameters: ['masked'] } },
                { id: 'request', worktree: 'selected', kind: 'span', source: 'otlp', at: 2, traceId: 'trace', spanId: 'request', spanKind: 2 },
                { id: 'log', worktree: 'selected', kind: 'log', source: 'otlp', at: 1, detail: { log: { body: 'selected log' } } },
                { id: 'other', worktree: 'other', kind: 'query', source: 'wire', at: 4, detail: { sql: 'other' } },
            ]);
            fixture.statements.length = 0;
            expect((await producers.queriesList({ worktree: 'selected', limit: 2 })).map(row => row.id)).toEqual(['query']);
            expect((await producers.tracesList({ worktree: 'selected', limit: 2 })).map(row => row.id)).toEqual(['request']);
            expect((await producers.logsList({ worktree: 'selected', limit: 2 })).map(row => row.id)).toEqual(['log']);
            expect((await producers.traceGet({ worktree: 'selected', traceId: 'trace', pageSize: 2 })).summaries.map(row => row.id)).toEqual(['request']);
            expect(fixture.statements.some(statement => statement.includes('captureDetails'))).toBe(false);
            expect(await producers.queryGet({ worktree: 'selected', id: 'query' })).toEqual({ sql: 'select ?', parameters: ['masked'] });
            expect(await producers.queryGet({ worktree: 'other', id: 'query' })).toBeNull();
            runtime.recordCoverage('selected', 'unsupported_frame');
            runtime.recordCoverage('other', 'store_busy');
            expect(await producers.status({ worktree: 'selected' })).toEqual({ coverage: { lostObservations: 1, reason: 'unsupported_frame' } });
            await producers.clear({ worktree: 'selected' });
            expect(await producers.queriesList({ worktree: 'selected', limit: 2 })).toEqual([]);
            expect(await producers.queryGet({ worktree: 'selected', id: 'query' })).toBeNull();
            expect((await producers.queriesList({ worktree: 'other', limit: 2 })).map(row => row.id)).toEqual(['other']);
            expect((await producers.status({ worktree: 'selected' })).coverage.lostObservations).toBe(0);
            expect((await producers.status({ worktree: 'other' })).coverage.lostObservations).toBe(1);
        } finally { fixture.close(); }
    });

    it('keeps actual writer I/O failure through ordinary configuration and resumes real HTTP writes only after explicit Retry', async () => {
        const fixture = createCaptureSqliteFixture(), account = accountStorageFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const runtime = createCaptureRuntime({ database: fixture.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish() {} });
        const producers = createCaptureActionProducers({ runtime, accountStorage: account.storage, stopProjectCapture: createCaptureBackgroundOwner().stopProjectCapture });
        const receiver = await runtime.acquireReceiver({ port: 0, context: { partition: 'selected' } });
        const send = (index: number) => fetch(`${receiver.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: String(index), body: { stringValue: `log-${index}` } }] }] }] }) });
        try {
            await producers.configure({ project, enabled: true });
            expect((await send(1)).status).toBe(200);
            await runtime.ingest.settled();
            expect(await runtime.store.list({ worktree: 'selected', kind: 'log', limit: 10 })).toHaveLength(1);
            fixture.failWrites('SQLITE_IOERR');
            expect((await send(2)).status).toBe(200);
            await runtime.ingest.settled();
            fixture.failWrites(null);
            expect(runtime.ingest.coverage('selected').reason).toBe('SQLITE_IOERR');
            await producers.configure({ project, enabled: true });
            expect(await (await send(3)).json()).toMatchObject({ partialSuccess: { rejectedLogRecords: '1' } });
            expect(runtime.ingest.coverage('selected').reason).toBe('SQLITE_IOERR');
            await producers.configure({ project, enabled: true, retry: true });
            expect(await (await send(4)).json()).toEqual({});
            await runtime.ingest.settled();
            expect(await runtime.store.list({ worktree: 'selected', kind: 'log', limit: 10 })).toHaveLength(2);
        } finally { fixture.failWrites(null); await receiver.release(); await runtime.ingest.settled(); fixture.close(); account.close(); }
    });

    it('persists project capture preference before stopping its real receiver and preserves another project', async () => {
        const fixture = createCaptureSqliteFixture(), account = accountStorageFixture();
        const owner = createCaptureBackgroundOwner(), lifetime = new AbortController();
        const storage: DaemonDatabaseService = { async database(_id, definition) {
            for (const migration of definition?.migrations ?? []) await migration.up(fixture.db);
            return fixture.db;
        } };
        const running = owner.run({ signal: lifetime.signal, services: { storage: { daemon: storage, account: account.storage }, events: { host: { subscribe: () => ({ dispose() {} }) } } } });
        let lease: Awaited<ReturnType<typeof owner.acquireLocalCapture>> | undefined;
        try {
            await vi.waitFor(() => expect(owner.readRuntime()).not.toBeNull());
            const runtime = owner.readRuntime();
            if (!runtime) throw new Error('Missing running capture runtime');
            const producers = createCaptureActionProducers({ runtime, accountStorage: account.storage, stopProjectCapture: owner.stopProjectCapture });
            expect(await producers.configure({ project, enabled: true })).toEqual({ enabled: true });
            lease = await vi.waitFor(() => owner.acquireLocalCapture({ enabled: true, projectScope: project, physicalRootIdentity: '/physical/selected', partition: 'selected', urls: [], otlpPort: 0, signal: lifetime.signal }));
            expect((await fetch(`${lease.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
            expect(await producers.configure({ project: { ...project, projectId: 'other' }, enabled: false })).toEqual({ enabled: false });
            expect((await fetch(`${lease.endpoint}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
            expect(await producers.configure({ project, enabled: false })).toEqual({ enabled: false });
            expect(await owner.readEnabled(project)).toBe(false);
            await expect(fetch(`${lease.endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();
            await expect(createCaptureActionProducers({ runtime, stopProjectCapture: owner.stopProjectCapture }).configure({ project, enabled: true }))
                .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        } finally { await lease?.release(); lifetime.abort(); await running; fixture.close(); account.close(); }
    });
});
