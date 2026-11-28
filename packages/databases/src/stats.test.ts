import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compilePostgresqlStatsV1 } from './postgresql/stats.js';
import { compileMysqlStatsV1 } from './mysql/stats.js';
import { compileSqliteStatsV1 } from './sqlite/stats.js';
import type { DatabaseStatsNativeRowV1, DatabaseStatsSqlPlanV1 } from './stats.js';
import { executeSqliteOperation } from './sqlite/operations.js';

const context = { observedAtMs: 1000, database: 'main', intervalBasis: { bindingKey: 'one', databaseIdentity: 'main', selectionKey: 'size' } };
function compiled(plan: DatabaseStatsSqlPlanV1) {
    expect(plan.status).toBe('compiled');
    if (plan.status !== 'compiled') throw new Error(plan.reason);
    return plan;
}
function executeSqlite(plan: DatabaseStatsSqlPlanV1) {
    const operation = compiled(plan);
    const statement = operation.statements[0]!;
    const bindings = statement.parameters.flatMap((value, index) => ['-cmd', `.parameter set ?${index + 1} '${String(value).replaceAll("'", "''")}'`]);
    const setup = 'CREATE TABLE selected(first TEXT, second TEXT); CREATE INDEX selected_reverse ON selected(second,first); CREATE TABLE neighbor(private TEXT);';
    const rows = JSON.parse(execFileSync('sqlite3', [...bindings, ':memory:', '-json', `${setup} ${statement.sql}`], { encoding: 'utf8' })) as DatabaseStatsNativeRowV1[];
    return operation.decode([rows], context);
}
describe('shared stats dialects', () => {
    it('retains PostgreSQL automatic maintenance timestamps independently from manual maintenance', () => {
        const plan = compiled(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'tables', selection: { relation: { schema: 'public', name: 'items' } } }));
        const result = plan.decode([[{ key: '1', schema_name: 'public', relation_name: 'items', size_bytes: '0',
            last_vacuum: null, last_analyze: 'manual', last_autovacuum: 'automatic-vacuum', last_autoanalyze: 'automatic-analyze' }]], context);
        expect(result).toMatchObject({ status: 'available', data: [{ lastAnalyze: 'manual', lastAutovacuum: 'automatic-vacuum', lastAutoanalyze: 'automatic-analyze' }] });
    });
    it('leaves unavailable MySQL table sizes and estimates absent without inventing zero', () => {
        const plan = compiled(compileMysqlStatsV1({ kind: 'stats.read', group: 'tables', selection: { relation: { schema: 'app', name: 'items' } } }));
        const result = plan.decode([[{ key: 'app:items', schema_name: 'app', relation_name: 'items', estimated_rows: null,
            size_bytes: null, table_bytes: null, index_bytes: null }]], context);
        expect(result).toMatchObject({ status: 'available', data: [{ relation: { schema: 'app', name: 'items' } }] });
        if (result.status !== 'available' || result.group !== 'tables') throw new Error('Expected table evidence');
        expect(result.data[0]).not.toHaveProperty('estimatedRows');
        expect(result.data[0]).not.toHaveProperty('size');
    });
    it('executes SQLite stats through the shared operation owner and preserves typed unsupported groups', () => {
        const target = { kind: 'manual', accountId: 'a', installationId: 'i', projectKey: 'p', savedSecretId: 's',
            workspace: { serverId: 'h', machineId: 'm', workspaceId: 'w', rootPath: '/project' } } as const;
        const query: Parameters<typeof executeSqliteOperation>[1] = statement => {
            const bindings = statement.values.flatMap((value, index) => ['-cmd', `.parameter set ?${index + 1} '${String(value).replaceAll("'", "''")}'`]);
            const objects = JSON.parse(execFileSync('sqlite3', [...bindings, ':memory:', '-json', `CREATE TABLE selected(id INTEGER); ${statement.text}`], { encoding: 'utf8' })) as Record<string, unknown>[];
            const columns = Object.keys(objects[0] ?? {}).map(name => ({ name, type: null }));
            return { columns, rows: objects.map(row => columns.map(column => row[column.name] as string | number | null)), changes: null };
        };
        const options = { stats: { database: 'main', intervalBasis: context.intervalBasis } };
        expect(executeSqliteOperation({ operation: 'stats.read', target, request: { kind: 'stats.read', group: 'size', selection: {} } }, query, options))
            .toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'available', data: { bytes: '8192', measurement: 'page_allocation' } } });
        expect(executeSqliteOperation({ operation: 'stats.read', target, request: { kind: 'stats.read', group: 'statements', selection: { page: { rows: 1 }, order: 'calls' } } }, query, options))
            .toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'unavailable', reason: 'unsupported_group' } });
    });
    it('reads allocated SQLite bytes in one statement while unsupported statement counters stay unavailable', () => {
        const plan = compiled(compileSqliteStatsV1({ kind: 'stats.read', group: 'size', selection: {} }));
        expect(plan.statements).toHaveLength(1);
        const sql = plan.statements[0]!;
        const bindings = sql.parameters.flatMap((value, index) => ['-cmd', `.parameter set ?${index + 1} '${String(value).replaceAll("'", "''")}'`]);
        const rows = JSON.parse(execFileSync('sqlite3', [...bindings, ':memory:', '-json', `CREATE TABLE sample(id INTEGER PRIMARY KEY); ${sql.sql}`], { encoding: 'utf8' })) as DatabaseStatsNativeRowV1[];
        expect(plan.decode([rows], context)).toMatchObject({ status: 'available', group: 'size', data: { measurement: 'page_allocation', bytes: '8192' } });
        expect(compileSqliteStatsV1({ kind: 'stats.read', group: 'statements', selection: { page: { rows: 20 }, order: 'totalTime' } }))
            .toEqual({ status: 'unavailable', reason: 'unsupported_group' });
    });
    it('compiles a selected relation as bound values and retains lossless PostgreSQL size bytes', () => {
        const plan = compiled(compilePostgresqlStatsV1({ kind: 'stats.read', group: 'size', selection: { relation: { schema: 'public', name: 'name\";DROP TABLE private' } } }));
        expect(plan.statements).toHaveLength(1);
        expect(plan.statements[0]!.sql).not.toContain('DROP TABLE');
        expect(plan.statements[0]!.parameters).toEqual(['public', 'name\";DROP TABLE private']);
        expect(plan.decode([[{ size_bytes: '9007199254740993', relation_bytes: '100', table_bytes: '200', index_bytes: '300' }]], context))
            .toMatchObject({ data: { bytes: '9007199254740993', measurement: 'database_bytes' } });
    });
    it('reads selected SQLite structure and ordered index columns without inventing workload counters', () => {
        const tables = executeSqlite(compileSqliteStatsV1({ kind: 'stats.read', group: 'tables', selection: { relation: { schema: 'main', name: 'selected' } } }));
        expect(tables).toMatchObject({ status: 'available', group: 'tables', coverage: { status: 'partial', reasons: ['dbstat_unavailable'] },
            data: [{ relation: { schema: 'main', name: 'selected' } }] });
        if (tables.status === 'available' && tables.group === 'tables') {
            expect(tables.data).toHaveLength(1);
            expect(tables.data[0]).not.toHaveProperty('liveRows');
        }
        const indexes = executeSqlite(compileSqliteStatsV1({ kind: 'stats.read', group: 'indexes', selection: { relation: { schema: 'main', name: 'selected' } } }));
        expect(indexes).toMatchObject({ data: [{ name: 'selected_reverse', columns: ['second', 'first'], primary: false }] });
    });
    it('uses held PostgreSQL extension namespace/version without per-read catalog discovery', () => {
        const operation = { kind: 'stats.read', group: 'statements', selection: { page: { rows: 12, offset: 24 }, order: 'totalTime' } } as const;
        const plan = compiled(compilePostgresqlStatsV1(operation, { pgStatStatements: { schema: 'custom stats', version: '1.11' } }));
        expect(plan.statements).toHaveLength(1);
        expect(plan.statements[0]!.sql).toContain('"custom stats"."pg_stat_statements"');
        expect(plan.statements[0]!.sql).not.toContain('pg_catalog.pg_extension');
        expect(plan.statements[0]!.parameters).toEqual(expect.arrayContaining([13, 24, '1.11']));
        const result = plan.decode([[{ key: '7:8:9:true', database: 'main', user_id: '8', top_level: true, calls: '9007199254740993', total_time_ms: '120', rows: '40', blocks_read: '10', blocks_hit: '90', query: "ALTER USER me PASSWORD 'secret'", extension_version: '1.11', stats_reset: 'today', deallocated: '0', engine_started_at: 'boot' }]], context);
        expect(result).toMatchObject({ status: 'available', data: [{ key: '7:8:9:true', calls: '9007199254740993', totalTimeMs: 120, blocksRead: '10', blocksHit: '90' }] });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(compilePostgresqlStatsV1(operation, { pgStatStatements: null })).toEqual({ status: 'unavailable', reason: 'extension_missing' });
    });
    it('normalizes MySQL picoseconds and keeps schema in digest identity without reading query samples', () => {
        const plan = compiled(compileMysqlStatsV1({ kind: 'stats.read', group: 'statements', selection: { page: { rows: 20 }, order: 'totalTime' } }));
        expect(plan.statements).toHaveLength(1);
        expect(plan.statements[0]!.sql).not.toContain('QUERY_SAMPLE_TEXT');
        const result = plan.decode([[{ key: 'main:digest', database: 'main', calls: '123', total_time_ps: '1500000000', rows: '14', rows_examined: '21' }]], context);
        expect(result).toMatchObject({ status: 'available', data: [{ totalTimeMs: 1.5, nativeTimeUnit: 'picoseconds' }] });
    });
});
