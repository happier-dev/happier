import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSqliteOperation, type SqliteNativeValue } from '@happier-dev/databases/sqlite';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type {
    DatabaseDescriptorV1,
    DatabaseManualTargetV1,
    DatabaseOperationInputV1,
} from '@happier-dev/plugin-sdk/database';

export const target: DatabaseManualTargetV1 = { kind: 'manual', accountId: 'alice', installationId: 'installation',
    projectKey: 'project', savedSecretId: 'selected', workspace: { serverId: 'server', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } };
const descriptor: DatabaseDescriptorV1 = { target, label: 'Selected', engine: 'sqlite', origin: { label: 'Manual' }, capabilities: [],
    placement: { serverId: 'server', accountId: 'alice', machineId: 'machine', installationId: 'installation' } };
export const invocation = { chosenMachine: { machineId: 'machine', installationId: 'installation' } };

export async function createNativeFindingFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'dbw-findings-'));
    const path = join(directory, 'selected.sqlite');
    const db = openSqliteDatabaseSync(path);
    db.exec('CREATE TABLE first(id INTEGER); CREATE TABLE second(id INTEGER); CREATE INDEX first_a ON first(id); CREATE INDEX first_b ON first(id)');
    db.close();
    let sqlReads = 0;
    const resolve = async () => {
        const connection = openSqliteDatabaseSync(path);
        return { descriptor, connection: { async execute(input: DatabaseOperationInputV1) {
            // Genuine SQLite boundary, keeping the production compiler and decoder intact.
            return executeSqliteOperation(input, statement => {
                sqlReads++;
                const prepared = connection.prepare(statement.text);
                return { columns: prepared.columns(), rows: prepared.values(...statement.values) as SqliteNativeValue[][], changes: null };
            }, input.operation === 'stats.read' ? { stats: { database: path, intervalBasis: {
                databaseIdentity: path, bindingKey: JSON.stringify(target), selectionKey: JSON.stringify(input.request),
            } } } : {});
        }, async close() { connection.close(); } } };
    };
    return { resolve, sqlReads: () => sqlReads, async dispose() { await rm(directory, { recursive: true, force: true }); } };
}
