import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { postgresqlReadOnlyRoleGuardSql } from '@happier-dev/deployment-protocol';

export type OwnServerDataEngine = 'postgresql' | 'mysql' | 'mariadb';

function refuse(code: string, reason: string): never {
    throw new PluginError({ code, message: 'The read-only database query is unavailable', details: { reason } });
}

/** MariaDB's implicit PUBLIC authority has not been proven by bootstrap. */
export function assertOwnServerDataQuerySupportedEngine(engine: OwnServerDataEngine):
    asserts engine is 'postgresql' | 'mysql' {
    if (engine === 'mariadb') refuse('unsupported_action', 'mariadb_read_role_authority_unproven');
}

export const ownServerMysqlNativeTextLiteral = (value: string) => `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`;

/** Reviewed bootstrap owns role authority. Ordinary query sessions consume its
 * admitted dedicated-login credential and never obtain administrator access. */
export function ownServerReadOnlyRoleGuardSql(engine: 'postgresql' | 'mysql',
    options: Readonly<{ mysqlGrantee?: string; database?: string }> = {}): string {
    if (engine === 'postgresql') return postgresqlReadOnlyRoleGuardSql;
    const grantee = ownServerMysqlNativeTextLiteral(options.mysqlGrantee ?? "'happier_ro'@'127.0.0.1'");
    const database = options.database ? ownServerMysqlNativeTextLiteral(options.database) : 'DATABASE()';
    const roles = "NOT EXISTS (SELECT 1 FROM mysql.role_edges WHERE TO_USER = 'happier_ro' AND TO_HOST = '127.0.0.1')\n"
                + "  AND NOT EXISTS (SELECT 1 FROM mysql.global_grants WHERE USER = 'happier_ro' AND HOST = '127.0.0.1')\n"
                + "  AND @@mandatory_roles = ''";
    // Routine visibility includes built-in sys routines and is not an EXECUTE
    // grant. Reviewed administrator adoption checks the account's grant table.
    const routines = "NOT EXISTS (SELECT 1 FROM mysql.procs_priv WHERE User = 'happier_ro' AND Host = '127.0.0.1')";
    return `SET @happier_query_authorized = (
  ${roles} AND ${routines}
  AND NOT EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = ${grantee} AND (PRIVILEGE_TYPE <> 'USAGE' OR IS_GRANTABLE <> 'NO'))
  AND NOT EXISTS (SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${grantee}
    AND (TABLE_SCHEMA <> ${database} OR PRIVILEGE_TYPE NOT IN ('SELECT', 'SHOW VIEW') OR IS_GRANTABLE <> 'NO'))
  AND (SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.SCHEMA_PRIVILEGES
    WHERE GRANTEE = ${grantee} AND TABLE_SCHEMA = ${database} AND PRIVILEGE_TYPE IN ('SELECT', 'SHOW VIEW')) = 2
  AND NOT EXISTS (SELECT 1 FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ${grantee})
  AND NOT EXISTS (SELECT 1 FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ${grantee})
);`;
}
