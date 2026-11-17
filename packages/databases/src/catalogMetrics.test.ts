import { describe, expect, it } from 'vitest';
import { DatabaseOperationResultV1Schema } from '@happier-dev/database-protocol';
import { executePostgresqlOperation, type PostgresqlQuery } from './postgresql/operations.js';
import { executeMysqlOperation, type MysqlQuery } from './mysql/operations.js';

const target = { kind: 'manual', accountId: 'a', installationId: 'i', projectKey: 'p', savedSecretId: 's',
    workspace: { serverId: 'h', machineId: 'm', workspaceId: 'w', rootPath: '/project' } } as const;
const input = { operation: 'relations.list', target, schema: 'app', page: { rows: 3 } } as const;

describe('catalog directory metrics', () => {
    it('returns PostgreSQL heap/table/index/total bytes and leaves unknown estimates absent in one catalog read', async () => {
        let reads = 0;
        // The native query is the process boundary; the operation and schema stay real.
        const query: PostgresqlQuery = async () => {
            reads++;
            return { fields: [], command: 'SELECT', rowCount: 2,
                rows: [['known', 'r', '9007199254740993', '10', '20', '30', '50'], ['unknown', 'v', null, null, null, null, null]] };
        };
        const result = DatabaseOperationResultV1Schema.parse(await executePostgresqlOperation(input, query));
        expect(result).toMatchObject({ ok: true, relations: [
            { estimatedRows: '9007199254740993', size: { bytes: '50', relationBytes: '10', tableBytes: '20', indexBytes: '30', measurement: 'database_bytes' } },
            { relation: { name: 'unknown' } },
        ] });
        if (!result.ok || result.operation !== 'relations.list') throw new Error('Expected relations');
        expect(result.relations[1]).not.toHaveProperty('estimatedRows');
        expect(result.relations[1]).not.toHaveProperty('size');
        expect(reads).toBe(1);
    });

    it('labels MySQL table-byte estimates and preserves unknown sizes and row counts', async () => {
        let reads = 0;
        const query: MysqlQuery = async () => {
            reads++;
            return { fields: [], rows: [['known', 'BASE TABLE', '0', '9007199254740993', '7', '9007199254741000'], ['unknown', 'VIEW', null, null, null, null]] };
        };
        const result = DatabaseOperationResultV1Schema.parse(await executeMysqlOperation(input, query));
        expect(result).toMatchObject({ ok: true, relations: [
            { estimatedRows: '0', size: { bytes: '9007199254741000', tableBytes: '9007199254740993', indexBytes: '7', measurement: 'table_bytes_estimate' } },
            { relation: { name: 'unknown' } },
        ] });
        if (!result.ok || result.operation !== 'relations.list') throw new Error('Expected relations');
        expect(result.relations[1]).not.toHaveProperty('estimatedRows');
        expect(result.relations[1]).not.toHaveProperty('size');
        expect(reads).toBe(1);
    });
});
