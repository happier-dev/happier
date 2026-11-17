import type { DatabaseStatsReadV1 } from '@happier-dev/database-protocol';
import { statsSize, statsSqlPlan, type DatabaseStatsSqlPlanV1 } from './stats.js';

export { statsNativeRowsV1, type DatabaseStatsNativeRowV1 } from './stats.js';

/** Size compilation is portable: native stats and page projections share these SQL and decode owners. */
export function compileDatabaseSizeV1(engine: 'postgresql' | 'mysql',
    operation: Extract<DatabaseStatsReadV1, { group: 'size' }>): DatabaseStatsSqlPlanV1 {
    const parameters: (string | number)[] = [];
    const bind = (value: string) => { parameters.push(value); return engine === 'postgresql' ? `$${parameters.length}` : '?'; };
    const relation = operation.selection.relation;
    if (engine === 'postgresql') {
        if (!relation) return statsSqlPlan('postgresql', operation, {
            sql: 'SELECT pg_catalog.pg_database_size(current_database())::text AS size_bytes', parameters }, rows => statsSize(rows[0] ?? {}, 'database_bytes'));
        const schema = bind(relation.schema); const name = bind(relation.name);
        return statsSqlPlan('postgresql', operation, { sql: `SELECT pg_catalog.pg_total_relation_size(c.oid)::text AS size_bytes,
            pg_catalog.pg_relation_size(c.oid)::text AS relation_bytes, pg_catalog.pg_table_size(c.oid)::text AS table_bytes,
            pg_catalog.pg_indexes_size(c.oid)::text AS index_bytes FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = ${name}`, parameters },
        rows => statsSize(rows[0] ?? {}, 'database_bytes'));
    }
    const predicate = relation ? `TABLE_SCHEMA = ${bind(relation.schema)} AND TABLE_NAME = ${bind(relation.name)}` : 'TABLE_SCHEMA = DATABASE()';
    return statsSqlPlan('mysql', operation, { sql: `SELECT CAST(COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0) AS CHAR) AS size_bytes,
            CAST(COALESCE(SUM(DATA_LENGTH),0) AS CHAR) AS table_bytes, CAST(COALESCE(SUM(INDEX_LENGTH),0) AS CHAR) AS index_bytes
            FROM information_schema.tables WHERE ${predicate}`, parameters }, rows => statsSize(rows[0] ?? {}, 'table_bytes_estimate'));
}
