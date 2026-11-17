import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseOperationResultV1Schema } from '@happier-dev/database-protocol';
import { builtinDatabaseCapabilities } from '../capabilities.js';
import { openMysqlConnection } from './mysql.js';

// mysql2 is the external native driver boundary; compilation and decoding stay real.
const driver = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock('mysql2', () => ({ createConnection: driver.createConnection }));
afterEach(() => vi.clearAllMocks());

const target = { kind: 'manual', accountId: 'account', installationId: 'installation', projectKey: 'project',
    workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' }, savedSecretId: 'fixture' } as const;

function nativeFrame(names: string[], rows: (string | number | null)[][]) {
    return [rows, names.map(name => ({ name, columnType: 253, characterSet: 45 }))];
}

function nativeConnection(database: string | null = 'native_fixture', version = '8.4.7') {
    const executions: string[] = [];
    const execute = vi.fn(async (sql: string) => {
        executions.push(sql);
        if (sql.startsWith('SELECT VERSION()')) {
            return nativeFrame(['version', 'sql_mode', 'database', 'current_user', 'server_hostname', 'server_port'],
                [[version, 'NO_BACKSLASH_ESCAPES,ANSI_QUOTES', database, 'happier_ro@localhost', 'native-server', '3306']]);
        }
        if (sql.includes('AS size_bytes')) return nativeFrame(['size_bytes', 'table_bytes', 'index_bytes'], [['9007199254740993', '9007199254740992', '1']]);
        if (sql.includes('instrumentation_enabled')) return nativeFrame(['key', 'instrumentation_enabled'], [[null, 0]]);
        throw new Error('Unexpected native SQL');
    });
    const query = vi.fn(async (_sql: string) => [[], []]);
    const core = Object.assign(new EventEmitter(), {
        connect(callback: (error: Error | null) => void) { callback(null); },
        promise() { return { execute, query }; },
        destroy: vi.fn(),
    });
    driver.createConnection.mockReturnValue(core);
    return { core, executions };
}

it('opens native MySQL stats with held setup facts and no per-read metadata probes', async () => {
    const native = nativeConnection();
    const connection = await openMysqlConnection('mysql://happier_ro:private@unreachable.invalid/native_fixture');
    try {
        const request = { kind: 'stats.read', group: 'size', selection: {} } as const;
        const result = await connection.execute({ operation: 'stats.read', target, request });
        expect(result).toMatchObject({ ok: true, operation: 'stats.read', observation: {
            status: 'available', engineId: 'mysql', scope: { database: 'native_fixture' },
            data: { bytes: '9007199254740993', measurement: 'table_bytes_estimate' },
            intervalBasis: { bindingKey: expect.any(String), databaseIdentity: expect.any(String), selectionKey: JSON.stringify(request) },
        } });
        expect(DatabaseOperationResultV1Schema.safeParse(result).success).toBe(true);
        expect(await connection.execute({ operation: 'stats.read', target, request })).toMatchObject({ ok: true,
            observation: { status: 'available', data: { bytes: '9007199254740993' } } });
        expect(native.executions).toHaveLength(3); // One setup query, one demanded query per read.
        expect(native.executions.filter(sql => sql.startsWith('SELECT VERSION()'))).toHaveLength(1);
        expect(await connection.execute({ operation: 'stats.read', target, request: {
            kind: 'stats.read', group: 'indexAdvice', selection: { statementKey: 'native_fixture:digest' },
        } })).toMatchObject({ ok: true, observation: { status: 'unavailable', reason: 'unsupported_group' } });
        expect(native.executions).toHaveLength(3);
        expect(await connection.execute({ operation: 'stats.read', target, request: {
            kind: 'stats.read', group: 'statements', selection: { page: { rows: 10 }, order: 'calls' },
        } })).toMatchObject({ ok: true, observation: { status: 'unavailable', reason: 'instrumentation_disabled' } });
    } finally { await connection.close(); }
    expect(native.core.destroy).toHaveBeenCalledOnce();
});

it('keeps absent selected-database facts unavailable and preserves MariaDB refusal', async () => {
    nativeConnection(null);
    const connection = await openMysqlConnection('mysql://happier_ro:private@unreachable.invalid');
    try {
        expect(await connection.execute({ operation: 'stats.read', target, request: { kind: 'stats.read', group: 'size', selection: {} } }))
            .toMatchObject({ ok: false, status: 'unavailable', code: 'database_operation_unavailable' });
    } finally { await connection.close(); }
    const maria = nativeConnection('native_fixture', '11.4.5-MariaDB');
    await expect(openMysqlConnection('mysql://happier_ro:private@unreachable.invalid/native_fixture'))
        .rejects.toMatchObject({ failure: { status: 'unavailable', code: 'database_engine_unavailable' } });
    expect(maria.core.destroy).toHaveBeenCalledOnce();
});

it('advertises implemented builtin statistics while execution owns group availability', () => {
    for (const engine of ['postgresql', 'mysql', 'sqlite'] as const) {
        expect(builtinDatabaseCapabilities(engine).find(capability => capability.operation === 'stats.read'))
            .toEqual({ operation: 'stats.read', available: true });
    }
});
