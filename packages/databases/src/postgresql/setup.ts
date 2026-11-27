import type { PostgresqlCompiledStatement, PostgresqlExecutionOptions, PostgresqlNativeResult } from './operations.js';
import type { DatabaseStatsOperationInputV1 } from '@happier-dev/plugin-sdk/database';
import type { PostgresqlStatsCompilationV1 } from './stats.js';
import { statsNativeRowsV1, statsText } from '../stats.js';

/** Fixed statements shared by the admitted deployment admin and credential-backed connections. */
export const POSTGRESQL_STATISTICS_ENABLE_SQL_V1 = {
    probe: `SELECT EXISTS (
        SELECT FROM pg_catalog.regexp_split_to_table(pg_catalog.current_setting('shared_preload_libraries'), ',') AS library(name)
        WHERE pg_catalog.btrim(library.name, ' "') IN ('pg_stat_statements', '$libdir/pg_stat_statements')
    ) AS preloaded, EXISTS (SELECT FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements') AS installed`,
    install: 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements',
} as const;

/** Native facts held for one demand; the connection owner constructs its binding basis. */
export type PostgresqlSetupFactsV1 = Readonly<{
    database: string; databaseOid: string; currentUser: string;
    serverAddress: string | null; serverPort: string | null;
    serverVersion: string; engineStartedAt: string;
    pgStatStatements: NonNullable<PostgresqlStatsCompilationV1['pgStatStatements']> | null;
}>;

/** Establish the lexer's string grammar and discover installed facts in one startup call. */
export function compilePostgresqlSetupV1(): PostgresqlCompiledStatement {
    return { text: `SELECT pg_catalog.set_config('standard_conforming_strings','on',false),
        current_database() AS database, d.oid::text AS database_oid, current_user AS current_user,
        pg_catalog.inet_server_addr()::text AS server_address, pg_catalog.inet_server_port()::text AS server_port,
        current_setting('server_version_num') AS server_version, pg_catalog.pg_postmaster_start_time()::text AS engine_started_at,
        n.nspname AS extension_schema, e.extversion AS extension_version
        FROM pg_catalog.pg_database d
        LEFT JOIN pg_catalog.pg_extension e ON e.extname='pg_stat_statements'
        LEFT JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
        WHERE d.datname=current_database()`, values: [] };
}

export function decodePostgresqlSetupV1(native: PostgresqlNativeResult): PostgresqlSetupFactsV1 {
    const row = statsNativeRowsV1(native.fields, native.rows)[0] ?? {};
    const required = (key: string): string => {
        const value = statsText(row, key);
        if (value === undefined) throw new Error(`invalid_postgresql_setup_${key}`);
        return value;
    };
    const schema = statsText(row, 'extension_schema');
    return { database: required('database'), databaseOid: required('database_oid'), currentUser: required('current_user'),
        serverAddress: statsText(row, 'server_address') ?? null, serverPort: statsText(row, 'server_port') ?? null,
        serverVersion: required('server_version'), engineStartedAt: required('engine_started_at'),
        pgStatStatements: schema === undefined ? null : { schema, version: required('extension_version') } };
}

/** The same native facts bind a statistics interval on direct and provider transports. */
export function postgresqlStatsExecutionOptions(setup: PostgresqlSetupFactsV1, input: DatabaseStatsOperationInputV1,
    nativeBackendPid?: number): PostgresqlExecutionOptions {
    const databaseIdentity = JSON.stringify({ database: setup.database, databaseOid: setup.databaseOid,
        serverAddress: setup.serverAddress, serverPort: setup.serverPort, engineStartedAt: setup.engineStartedAt });
    return { stats: {
        database: setup.database, pgStatStatements: setup.pgStatStatements,
        ...(nativeBackendPid == null ? {} : { nativeBackendPid }),
        intervalBasis: { databaseIdentity, engineStartedAt: setup.engineStartedAt,
            bindingKey: JSON.stringify({ target: input.target, databaseIdentity, currentUser: setup.currentUser }),
            selectionKey: JSON.stringify(input.request) },
    } };
}
