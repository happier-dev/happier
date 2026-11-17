import { describe, expect, it } from 'vitest';
import { createCaptureReader } from './read.js';
import { captureMigrations, createCaptureStore, type CaptureEvent } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { attributeDatabaseExecutions, type DatabaseExecutionEvidence, type RequestSpanEvidence } from './analysis/requests.js';

const worktree = 'selected';
function root(id: string, traceId: string, at: number): CaptureEvent {
    return { id, worktree, kind: 'span', source: 'otlp', at, traceId, spanId: id, spanKind: 2,
        serviceName: 'api', endpointMethod: 'GET', endpointRoute: '/users/:id', durationMs: 20, outcome: 'ok' };
}
function query(id: string, parameterIdentity: string): CaptureEvent {
    return { id, worktree, kind: 'query', source: 'otlp', at: 11, traceId: 'trace-a', spanId: id,
        parentSpanId: 'request-a', spanKind: 3, shape: 'select name from users where id = ?', statementKind: 'select',
        parameterIdentity, durationMs: 2, detail: { sql: 'masked SQL detail', parameters: ['masked'] } };
}

describe('selected capture reads through SQLite', () => {
    it('pages only server requests and reads a selected trace for cautious repeated-query evidence without loading bodies', async () => {
        const f = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(f.db);
            const store = createCaptureStore(f.db, () => {});
            await store.write([
                root('request-a', 'trace-a', 10), root('request-b', 'trace-b', 20),
                { ...root('ungrouped', 'trace-c', 30), endpointMethod: null, endpointRoute: null },
                { ...root('internal', 'trace-c', 40), spanKind: 1, parentSpanId: 'ungrouped' },
                { ...query('query-a', 'a'), executionIdentity: 'execution-a' },
                { ...query('wire-a', 'a'), source: 'wire', spanId: 'query-a', executionIdentity: 'execution-a' },
                query('query-b', 'b'),
                ...Array.from({ length: 1000 }, (_, index) => ({ ...root(`other-${index}`, 'trace-a', 50), worktree: `other-${index}` })),
            ]);
            const read = createCaptureReader(store);
            const requests = await read.requests({ worktree, limit: 2 });
            expect(requests.map(item => item.id)).toEqual(['ungrouped', 'request-b']);
            const last = requests.at(-1);
            if (!last) throw new Error('Missing request page');
            expect((await read.requests({ worktree, limit: 2, before: { at: last.at, id: last.id } })).map(item => item.id)).toEqual(['request-a']);
            f.statements.length = 0;
            f.queryRows.length = 0;
            const trace = await read.trace({ worktree, traceId: 'trace-a', pageSize: 2 });
            expect(trace.summaries.map(item => item.id).sort()).toEqual(['query-a', 'query-b', 'request-a', 'wire-a']);
            expect(trace.repeatedQueries).toEqual([expect.objectContaining({ kind: 'suspected_n_plus_one', repetitionCount: 2, totalDatabaseTimeMs: 4 })]);
            expect(f.statements.some(statement => statement.includes('captureDetails'))).toBe(false);
            expect(f.queryRows.reduce((total, count) => total + count, 0)).toBe(4);
            expect(JSON.stringify(trace)).not.toContain('masked SQL detail');
            expect(await read.detail(worktree, 'query-a')).toMatchObject({ sql: 'masked SQL detail' });
            expect(await read.detail('another-account', 'query-a')).toBeNull();
        } finally { f.close(); }
    });

    it('groups endpoints from server route templates, counts errors and database contribution, and uses a stable endpoint cursor', async () => {
        const f = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(f.db);
            const store = createCaptureStore(f.db, () => {});
            await store.write([
                root('request-a', 'trace-a', 10),
                { ...root('request-b', 'trace-b', 20), httpStatusCode: 500, durationMs: 40 },
                { ...root('request-c', 'trace-c', 30), endpointRoute: '/widgets/:id' },
                { ...root('ungrouped', 'trace-raw', 40), endpointMethod: null, endpointRoute: null },
                query('query-a', 'a'), query('query-b', 'b'),
                { ...query('query-c', 'c'), traceId: 'trace-b', parentSpanId: 'request-b', durationMs: 5 },
                { ...root('unrelated', 'trace-other', 99), worktree: 'unrelated' },
            ]);
            f.statements.length = 0;
            const read = createCaptureReader(store);
            const first = await read.endpoints({ worktree, limit: 1, pageSize: 2 });
            expect(first).toEqual([expect.objectContaining({ serviceName: 'api', method: 'GET', route: '/users/:id',
                requestCount: 2, errorCount: 1, totalDurationMs: 60, databaseTimeMs: 9 })]);
            const next = await read.endpoints({ worktree, limit: 1, pageSize: 2, before: { serviceName: 'api', method: 'GET', route: '/users/:id' } });
            expect(next).toEqual([expect.objectContaining({ route: '/widgets/:id', requestCount: 1 })]);
            expect(f.statements.some(statement => statement.includes('captureDetails'))).toBe(false);
        } finally { f.close(); }
    });

    it('attributes database time to the nearest server request when one trace crosses several endpoints', async () => {
        const f = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(f.db);
            const store = createCaptureStore(f.db, () => {});
            await store.write([
                root('request-a', 'trace-a', 10),
                { ...root('request-b', 'trace-a', 20), parentSpanId: 'request-a', endpointRoute: '/widgets/:id' },
                { ...root('middle', 'trace-a', 21), parentSpanId: 'request-b', spanKind: 1 },
                query('query-a', 'a'),
                { ...query('query-b', 'b'), parentSpanId: 'middle', durationMs: 5 },
            ]);
            const endpoints = await createCaptureReader(store).endpoints({ worktree, limit: 20, pageSize: 2 });
            expect(endpoints).toEqual([
                expect.objectContaining({ route: '/users/:id', databaseTimeMs: 2 }),
                expect.objectContaining({ route: '/widgets/:id', databaseTimeMs: 5 }),
            ]);
        } finally { f.close(); }
    });

    it('keeps endpoint page reads independent of unrelated endpoints and selected request history', async () => {
        const f = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(f.db);
            const store = createCaptureStore(f.db, () => {}), reader = createCaptureReader(store);
            await store.write([root('request-a', 'trace-a', 10), query('query-a', 'a')]);
            const measure = async () => {
                f.statements.length = 0; f.queryRows.length = 0;
                const endpoints = await reader.endpoints({ worktree, limit: 1, pageSize: 2, since: 0 });
                return { endpoints, statements: f.statements.length, rows: f.queryRows.reduce((sum, rows) => sum + rows, 0) };
            };
            const baseline = await measure();
            await store.write(Array.from({ length: 1000 }, (_, index) => [
                { ...root(`unrelated-${index}`, `unrelated-trace-${index}`, 20), endpointRoute: `/z/${index}` },
                { ...query(`unrelated-query-${index}`, 'a'), traceId: `unrelated-trace-${index}`, parentSpanId: `unrelated-${index}` },
                root(`old-${index}`, `old-trace-${index}`, -index - 1),
                { ...query(`old-query-${index}`, 'a'), traceId: `old-trace-${index}`, parentSpanId: `old-${index}` },
            ]).flat());
            const loaded = await measure();
            expect(loaded.endpoints).toEqual(baseline.endpoints);
            expect(loaded.endpoints).toEqual([expect.objectContaining({ route: '/users/:id', requestCount: 1, databaseTimeMs: 2 })]);
            expect(loaded.statements).toBe(baseline.statements);
            expect(loaded.rows).toBe(baseline.rows);
            expect(f.statements.some(statement => statement.includes('captureDetails'))).toBe(false);
            await store.write(Array.from({ length: 1000 }, (_, index) => [
                root(`selected-${index}`, `selected-trace-${index}`, 20),
                { ...query(`selected-query-${index}`, 'a'), traceId: `selected-trace-${index}`, parentSpanId: `selected-${index}` },
            ]).flat());
            const history = await measure();
            expect(history.endpoints).toEqual([expect.objectContaining({ route: '/users/:id', requestCount: 1001, databaseTimeMs: 2002 })]);
            expect(history.statements).toBe(baseline.statements);
            expect(history.rows).toBe(baseline.rows);
        } finally { f.close(); }
    });

    it('matches the analysis owner across linked sources, timing precedence, nested roots, cycles and time bounds', async () => {
        const f = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(f.db);
            const store = createCaptureStore(f.db, () => {});
            await store.write([
                root('request-a', 'trace-a', 10),
                { ...root('request-b', 'trace-a', 20), parentSpanId: 'request-a', endpointRoute: '/widgets/:id' },
                { ...root('middle', 'trace-a', 21), parentSpanId: 'request-b', spanKind: 1 },
                { ...root('cycle-a', 'trace-a', 21), parentSpanId: 'cycle-b', spanKind: 1 },
                { ...root('cycle-b', 'trace-a', 21), parentSpanId: 'cycle-a', spanKind: 1 },
                { ...root('shadow-request', 'trace-a', 50), spanId: 'request-a', endpointRoute: '/zz-shadow' },
                root('old-request', 'trace-a', 5),
                { ...query('application', 'a'), spanId: 'linked-span', parentSpanId: 'middle', executionIdentity: 'linked', at: 40, durationMs: 20 },
                { ...query('wire', 'a'), source: 'wire', spanKind: undefined, spanId: 'linked-span', parentSpanId: undefined, executionIdentity: 'linked', at: 41, durationMs: 3 },
                { ...query('wire-only', 'a'), source: 'wire', spanKind: undefined, parentSpanId: 'middle', durationMs: 7 },
                { ...query('older', 'a'), spanId: 'repeated-span', parentSpanId: 'middle', executionIdentity: 'repeated', at: 30, durationMs: 2 },
                { ...query('newer', 'a'), spanId: 'repeated-span', executionIdentity: 'repeated', at: 31, durationMs: 9 },
                { ...query('older-wire', 'a'), source: 'wire', spanKind: undefined, spanId: 'repeated-span', executionIdentity: 'repeated', at: 32, durationMs: 1 },
                { ...query('newer-wire', 'a'), source: 'wire', spanKind: undefined, spanId: 'repeated-span', executionIdentity: 'repeated', at: 33, durationMs: 4 },
                { ...query('cycle-query', 'a'), parentSpanId: 'cycle-a', durationMs: 100 },
                { ...query('unlinked-query', 'a'), parentSpanId: 'missing', durationMs: 100 },
                { ...query('old-query', 'a'), parentSpanId: 'old-request', durationMs: 100 },
                { ...query('other-worktree', 'a'), worktree: 'other', durationMs: 100 },
                query('concurrent', 'a'),
            ]);
            const summaries = await store.list({ worktree, traceId: 'trace-a', limit: 100 });
            const spans: RequestSpanEvidence[] = summaries.filter(row => row.spanId && row.spanKind != null).map(row => ({ traceId: row.traceId!, spanId: row.spanId!, kind: row.spanKind!, parentSpanId: row.parentSpanId ?? undefined }));
            const queries: DatabaseExecutionEvidence[] = summaries.filter(row => row.kind === 'query' && row.source !== 'capture').map(row => ({ observationId: row.id, source: row.source as 'wire' | 'otlp', traceId: row.traceId!, spanId: row.spanId ?? undefined, parentSpanId: row.parentSpanId ?? undefined, executionIdentity: row.executionIdentity ?? undefined, durationMs: row.durationMs ?? 0, shape: null, statementKind: 'unknown' }));
            const expected = new Map<string, number>([['request-a', 0], ['request-b', 0]]);
            for (const logical of attributeDatabaseExecutions(spans, queries)) if (logical.request && expected.has(logical.request.spanId)) expected.set(logical.request.spanId, expected.get(logical.request.spanId)! + logical.evidence.durationMs);
            const reader = createCaptureReader(store);
            const first = await reader.endpoints({ worktree, since: 10, limit: 1, pageSize: 2 });
            expect(first).toEqual([expect.objectContaining({ route: '/users/:id', databaseTimeMs: expected.get('request-a') })]);
            const next = await reader.endpoints({ worktree, since: 10, limit: 1, pageSize: 2, before: { serviceName: 'api', method: 'GET', route: '/users/:id' } });
            expect(next).toEqual([expect.objectContaining({ route: '/widgets/:id', databaseTimeMs: expected.get('request-b') })]);
            const shadow = await reader.endpoints({ worktree, since: 10, limit: 1, pageSize: 2, before: { serviceName: 'api', method: 'GET', route: '/widgets/:id' } });
            expect(shadow).toEqual([expect.objectContaining({ route: '/zz-shadow', databaseTimeMs: 0 })]);
            expect([...expected.values()]).toEqual([2, 14]);
        } finally { f.close(); }
    });
});
