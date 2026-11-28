export const POSTGRESQL_WORKBENCH_APPLICATION_NAME = 'happier-database-workbench';

export const POSTGRESQL_WORKBENCH_READ_PREFIX = 'WITH happier_database_workbench_internal AS (SELECT)\n';

/** pg_stat_statements groups by parsed query identity and ignores comments. An unused
 * CTE gives Workbench-owned SELECTs a distinct identity without changing their results. */
export function postgresqlWorkbenchReadSql(sql: string): string {
    return POSTGRESQL_WORKBENCH_READ_PREFIX + sql;
}
