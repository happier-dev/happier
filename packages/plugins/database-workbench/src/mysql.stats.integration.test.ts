import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import type { DatabaseStatsReadV1 } from '@happier-dev/plugin-sdk/database';
import { executeMysqlOperation, quoteMysqlIdentifier } from '@happier-dev/databases/mysql';
import { mysqlConnectionOptions, mysqlNativeResult } from './mysql.js';

const address = process.env.HAPPIER_TEST_MYSQL_URL;
/** Creates/drops only its own databases; no global instrumentation mutation. */
describe.skipIf(!address)('MySQL stats against a real engine', () => {
    let connection: Connection;
    const database = `dbw_stats_${process.pid}`;
    const neighbor = `dbw_stats_neighbor_${process.pid}`;
    const owned: string[] = [];

    async function read(request: DatabaseStatsReadV1) {
        const target = { kind: 'manual', accountId: 'a', installationId: 'i', projectKey: 'p', savedSecretId: 's',
            workspace: { serverId: 'h', machineId: 'm', workspaceId: 'w', rootPath: '/project' } } as const;
        const result = await executeMysqlOperation({ operation: 'stats.read', target, request }, async statement => {
            const [rows, fields] = await connection.execute(statement.text, statement.values);
            return mysqlNativeResult(rows, fields);
        }, { stats: { database, intervalBasis: { bindingKey: database, databaseIdentity: database, selectionKey: JSON.stringify(request.selection) } } });
        if (!result.ok || result.operation !== 'stats.read') throw new Error('Expected typed shared stats result');
        return result.observation;
    }

    beforeAll(async () => {
        connection = await createConnection(mysqlConnectionOptions(address!));
        for (const name of [database, neighbor]) {
            await connection.query(`CREATE DATABASE ${quoteMysqlIdentifier(name)}`);
            owned.push(name);
            await connection.query(`CREATE TABLE ${quoteMysqlIdentifier(name)}.items (id BIGINT PRIMARY KEY, first_col VARCHAR(40), second_col VARCHAR(40), INDEX reversed(second_col,first_col)) ENGINE=InnoDB`);
        }
        await connection.query(`USE ${quoteMysqlIdentifier(database)}`);
        await connection.execute('INSERT INTO items VALUES (?,?,?)', [1, 'private-stats-value', 'visible']);
        await connection.execute('SELECT id FROM items WHERE first_col=?', ['private-stats-value']);
        await connection.query(`SELECT id FROM ${quoteMysqlIdentifier(neighbor)}.items`);
    });
    afterAll(async () => {
        if (!connection) return;
        try { for (const name of owned) await connection.query(`DROP DATABASE ${quoteMysqlIdentifier(name)}`); }
        finally { await connection.end(); }
    });

    it('returns scoped cumulative digests with explicit reset uncertainty and no raw query samples', async () => {
        const observation = await read({ kind: 'stats.read', group: 'statements', selection: { page: { rows: 100 }, order: 'calls' } });
        expect(observation).toMatchObject({ status: 'available', group: 'statements', coverage: { status: 'partial', reasons: ['reset_marker_unavailable'] } });
        if (observation.status === 'available' && observation.group === 'statements') {
            expect(observation.data.length).toBeGreaterThan(0);
            expect(observation.data.every(row => row.database === database && row.key.startsWith(`${database}:`))).toBe(true);
            expect(observation.data.every(row => row.nativeTimeUnit === 'picoseconds' && row.shape === undefined && row.omittedTextReason)).toBe(true);
        }
        expect(JSON.stringify(observation)).not.toContain('private-stats-value');
        expect(await read({ kind: 'stats.read', group: 'statements', selection: { statementKey: 'missing-digest', page: { rows: 10 }, order: 'calls' } }))
            .toMatchObject({ status: 'available', group: 'statements', data: [], coverage: { status: 'partial', reasons: ['reset_marker_unavailable'] } });
    });
    it('keeps table and index metadata selected and preserves composite index order', async () => {
        const relation = { schema: database, name: 'items' };
        const tables = await read({ kind: 'stats.read', group: 'tables', selection: { relation } });
        expect(tables).toMatchObject({ status: 'available', group: 'tables', data: [{ relation }] });
        if (tables.status === 'available' && tables.group === 'tables') expect(tables.data).toHaveLength(1);
        const indexes = await read({ kind: 'stats.read', group: 'indexes', selection: { relation } });
        expect(indexes).toMatchObject({ status: 'available', group: 'indexes' });
        if (indexes.status === 'available' && indexes.group === 'indexes') {
            expect(indexes.data.find(row => row.name === 'reversed')).toMatchObject({ relation, columns: ['second_col', 'first_col'], unique: false });
        }
    });
    it('labels estimated allocation and scopes active threads to the selected database', async () => {
        const size = await read({ kind: 'stats.read', group: 'size', selection: {} });
        expect(size).toMatchObject({ status: 'available', group: 'size', data: { measurement: 'table_bytes_estimate' } });
        if (size.status === 'available' && size.group === 'size') expect(BigInt(size.data.bytes)).toBeGreaterThan(0n);
        const activity = await read({ kind: 'stats.read', group: 'activity', selection: { page: { rows: 100 } } });
        expect(activity).toMatchObject({ status: 'available', group: 'activity', scope: { database } });
        if (activity.status === 'available' && activity.group === 'activity') expect(activity.data.length).toBeGreaterThan(0);
    });
});
