import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as databases from './index.js';
import { openMysqlConnection } from './connection/mysql.js';

// Replace only the external MySQL boundary, retaining the real planning and execution paths.
const driver = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock('mysql2', () => ({ createConnection: driver.createConnection }));

function nativeFrame(names: string[], rows: (string | number | null)[][]) {
    return [rows, names.map(name => ({ name, columnType: 253, characterSet: 45 }))];
}

describe('managed database read role setup', () => {
    const role = 'happier_ro_0123456789abcdef';

    it('reviews a PostgreSQL login restricted to read grants in the selected database', () => {
        const plan = databases.planDatabaseReadRoleSetup({
            engine: 'postgresql', database: 'prod"db', role, schemas: ['app"data'],
        });
        expect(plan).toEqual({
            engine: 'postgresql',
            database: 'prod"db',
            role,
            statements: [
                'CREATE ROLE "happier_ro_0123456789abcdef" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD <generated SCRAM verifier>',
                'GRANT CONNECT ON DATABASE "prod""db" TO "happier_ro_0123456789abcdef"',
                'GRANT USAGE ON SCHEMA "app""data" TO "happier_ro_0123456789abcdef"',
                'GRANT SELECT ON ALL TABLES IN SCHEMA "app""data" TO "happier_ro_0123456789abcdef"',
                'ALTER ROLE "happier_ro_0123456789abcdef" SET default_transaction_read_only = on',
            ],
        });
    });

    it.each([
        { partialRevokes: false, grantDatabase: '`sales\\_data\\%`' },
        { partialRevokes: true, grantDatabase: '`sales_data%`' },
    ])('reviews an exact-database MySQL grant with partial_revokes=$partialRevokes', ({ partialRevokes, grantDatabase }) => {
        const plan = databases.planDatabaseReadRoleSetup({
            engine: 'mysql', database: 'sales_data%', role, partialRevokes,
        });
        expect(plan).toEqual({
            engine: 'mysql',
            database: 'sales_data%',
            role,
            statements: [
                "CREATE USER 'happier_ro_0123456789abcdef'@'%' IDENTIFIED BY RANDOM PASSWORD REQUIRE SSL ACCOUNT LOCK",
                `GRANT SELECT, SHOW VIEW ON ${grantDatabase}.* TO 'happier_ro_0123456789abcdef'@'%'`,
                "ALTER USER 'happier_ro_0123456789abcdef'@'%' ACCOUNT UNLOCK",
            ],
        });
    });

    it('refuses a role operand that could select an existing or privileged account', () => {
        expect(() => databases.planDatabaseReadRoleSetup({
            engine: 'mysql', database: 'railway', role: "root'@'%", partialRevokes: false,
        })).toThrow(/read role name/u);
    });

    it('round-trips charset punctuation in a server-generated password through the private URL', () => {
        const password = 'fixture-%r@:/?#[]';
        const url = databases.withDatabaseConnectionLogin('mysql://writer:previous@host/native_fixture', role, password);
        expect(databases.parseDatabaseConnectionUrl(url)).toMatchObject({ username: role, password });
        expect(databases.maskDatabaseConnectionUrl(url)).toBe('mysql://host/native_fixture');
    });

    it('applies only regenerated reviewed SQL and keeps an unproven MySQL account locked', async () => {
        const query = vi.fn(async (sql: string) => {
            if (sql.startsWith('SELECT @@GLOBAL.partial_revokes')) return nativeFrame(['partial_revokes', 'mandatory_roles'], [[0, '']]);
            if (sql.startsWith('CREATE USER')) return nativeFrame(['user', 'host', 'generated password', 'auth_factor'], [[role, '%', 'fixture-private-result', 1]]);
            if (sql.startsWith('SHOW GRANTS FOR')) return nativeFrame(['Grants'], [[`GRANT ALL PRIVILEGES ON *.* TO \`${role}\`@\`%\``]]);
            if (sql.startsWith('GRANT SELECT')) return [{ affectedRows: 0 }, []];
            throw new Error('The account must remain locked');
        });
        const execute = vi.fn(async () => nativeFrame(['version', 'sql_mode', 'database', 'current_user', 'server_hostname', 'server_port'],
            [['8.4.7', 'NO_BACKSLASH_ESCAPES,ANSI_QUOTES', 'native_fixture', 'writer@localhost', 'native-server', 3306]]));
        driver.createConnection.mockReturnValue(Object.assign(new EventEmitter(), {
            connect(callback: (error: Error | null) => void) { callback(null); },
            promise() { return { query, execute }; },
            destroy() {},
        }));
        const connection = await openMysqlConnection('mysql://writer:private@unreachable.invalid/native_fixture');
        try {
            const plan = await connection.prepareReadRole(role);
            expect(await connection.setupReadRole({ ...plan, statements: ['DROP DATABASE native_fixture'] })).toMatchObject({
                ok: false, code: 'database_read_role_plan_changed',
            });
            expect(query.mock.calls.flat()).not.toContain('DROP DATABASE native_fixture');
            const failure = await connection.setupReadRole(plan);
            expect(failure).toMatchObject({ ok: false, code: 'database_read_role_setup_incomplete' });
            expect(JSON.stringify(failure)).not.toContain('fixture-private-result');
            expect(query.mock.calls.flat()).toContain(plan.statements[1]);
            expect(query.mock.calls.flat()).not.toContain(plan.statements[2]);
        } finally { await connection.close(); }
    });
});
