import type { DatabaseStatsReadV1 } from '@happier-dev/plugin-sdk/database';
import type { DatabaseStatsSqlPlanV1 } from '../stats.js';
import { statsSqlPlan, statsText, statsCounter, statsNumber, statsBoolean, statsOptional, statsShape, statsRelation, statsSize, statsJsonArray, statsJsonObject } from '../stats.js';
import { normalizePostgresqlStatement } from './statement.js';
import { quotePostgresqlIdentifier } from './identifiers.js';
import { POSTGRESQL_WORKBENCH_APPLICATION_NAME, POSTGRESQL_WORKBENCH_READ_PREFIX, postgresqlWorkbenchReadSql } from './workbenchIdentity.js';

function diagnosticShape(sql: string | undefined): string | undefined {
    const safe = statsShape(sql, normalizePostgresqlStatement);
    return 'shape' in safe ? safe.shape : undefined;
}

export type PostgresqlStatsCompilationV1 = Readonly<{
    /** Catalog facts already held by the dialect connection owner; null means absent. */
    pgStatStatements?: Readonly<{ schema: string; version: string }> | null;
}>;
export function compilePostgresqlStatsV1(
    operation: DatabaseStatsReadV1, capabilities: PostgresqlStatsCompilationV1 = {},
    options: Readonly<{ diagnoseHiddenSelection?: true }> = {},
): DatabaseStatsSqlPlanV1 {
    const parameters: (string | number)[] = [];
    const bind = (value: string | number) => { parameters.push(value); return `$${parameters.length}`; };
    const page = () => 'page' in operation.selection ? ` LIMIT ${bind(operation.selection.page.rows + 1)} OFFSET ${bind(operation.selection.page.offset ?? 0)}` : '';
    const selectedRelation = (namespace: string, relation: string) => {
        const selection = operation.selection;
        if ('relation' in selection && selection.relation) return `${namespace} = ${bind(selection.relation.schema)} AND ${relation} = ${bind(selection.relation.name)}`;
        if ('schema' in selection) return `${namespace} = ${bind(selection.schema)}` + (selection.search === undefined ? '' : ` AND strpos(${relation}, ${bind(selection.search)}) > 0`);
        return 'TRUE';
    };
    const metadata = `pg_catalog.pg_postmaster_start_time()::text AS engine_started_at,
        (SELECT stats_reset::text FROM pg_catalog.pg_stat_database WHERE datname = current_database()) AS stats_reset`;
    if (operation.group === 'indexAdvice') return { status: 'unavailable', reason: 'unsupported_transport' };
    if (operation.group === 'size') {
        const relation = operation.selection.relation;
        if (!relation) return statsSqlPlan('postgresql', operation, {
            sql: postgresqlWorkbenchReadSql('SELECT pg_catalog.pg_database_size(current_database())::text AS size_bytes'), parameters }, rows => statsSize(rows[0] ?? {}, 'database_bytes'));
        const schema = bind(relation.schema); const name = bind(relation.name);
        return statsSqlPlan('postgresql', operation, { sql: postgresqlWorkbenchReadSql(`SELECT pg_catalog.pg_total_relation_size(c.oid)::text AS size_bytes,
            pg_catalog.pg_relation_size(c.oid)::text AS relation_bytes, pg_catalog.pg_table_size(c.oid)::text AS table_bytes,
            pg_catalog.pg_indexes_size(c.oid)::text AS index_bytes FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = ${name}`), parameters },
        rows => statsSize(rows[0] ?? {}, 'database_bytes'));
    }
    if (operation.group === 'statements') {
        const extension = capabilities.pgStatStatements;
        if (extension === null) return { status: 'unavailable', reason: 'extension_missing' };
        if (!extension) return { status: 'unavailable', reason: 'extension_metadata_required' };
        const version = /^1\.(\d+)$/u.exec(extension.version);
        if (!version) return { status: 'unavailable', reason: 'unsupported_extension_version' };
        const minor = Number(version[1]);
        const namespace = quotePostgresqlIdentifier(extension.schema);
        const topLevel = minor >= 9 ? 's.toplevel' : 'TRUE';
        const time = minor >= 8 ? 's.total_exec_time' : 's.total_time';
        const key = `s.dbid::text || ':' || s.userid::text || ':' || s.queryid::text || ':' || ${topLevel}::text`;
        const selected = operation.selection.statementKey;
        // pg_stat_statements removes the query ID together with its text. If the
        // owner has hidden rows in this DB, the exact key cannot settle eviction.
        const hiddenIdentity = options.diagnoseHiddenSelection ? selected?.match(/^(\d+):(\d+):-?\d+:(true|false)$/u) : undefined;
        const exact = selected === undefined ? '' : `(${key}) = ${bind(selected)}`;
        const hidden = hiddenIdentity
            ? ` OR (s.queryid IS NULL AND s.dbid::text = ${bind(hiddenIdentity[1]!)}
                AND s.userid::text = ${bind(hiddenIdentity[2]!)} AND ${topLevel}::text = ${bind(hiddenIdentity[3]!)})`
            : '';
        const predicate = exact ? ` AND ${hidden ? `(${exact}${hidden})` : exact}` : '';
        const preferExact = hiddenIdentity ? 's.queryid IS NULL, ' : '';
        const order = { totalTime: time, calls: 's.calls', rows: 's.rows' }[operation.selection.order];
        const pagination = page();
        const info = minor >= 9 ? `LEFT JOIN ${namespace}."pg_stat_statements_info" info ON TRUE` : '';
        const extensionMetadata = `${bind(extension.version)}::text AS extension_version, ${metadata},
            ${minor >= 9 ? 'info.stats_reset::text AS extension_stats_reset, info.dealloc::text AS deallocated' : 'NULL::text AS extension_stats_reset, NULL::text AS deallocated'}`;
        const workbenchPrefix = bind(POSTGRESQL_WORKBENCH_READ_PREFIX);
        return statsSqlPlan('postgresql', operation, { sql: postgresqlWorkbenchReadSql(`SELECT r.*, ${extensionMetadata}
            FROM (SELECT 1) available ${info}
            LEFT JOIN LATERAL (SELECT ${key} AS key, current_database() AS database, s.userid::text AS user_id,
                ${topLevel} AS top_level, s.query, s.queryid IS NULL AS visibility_restricted, s.calls::text AS calls,
                ${time} AS total_time_ms, s.rows::text AS rows, s.shared_blks_read::text AS blocks_read,
                s.shared_blks_hit::text AS blocks_hit, s.temp_blks_written::text AS temp_blocks_written
                ${minor >= 8 ? ', s.total_plan_time AS planning_time_ms' : ''}
                ${minor >= 11 ? ', s.stats_since::text AS stats_started_at' : ''}
                FROM ${namespace}."pg_stat_statements" s WHERE s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
                AND pg_catalog.left(s.query, ${POSTGRESQL_WORKBENCH_READ_PREFIX.length}) IS DISTINCT FROM ${workbenchPrefix}
                ${predicate} ORDER BY ${preferExact}${order} DESC, s.dbid, s.userid, s.queryid${minor >= 9 ? ', s.toplevel' : ''}${pagination}) r ON TRUE
            `), parameters }, rows => rows.filter(row => row.key !== undefined).map(row => ({
            key: statsText(row, 'key'), database: statsText(row, 'database'), ...statsOptional('user', statsText(row, 'user_id')),
            topLevel: statsBoolean(row, 'top_level'), ...statsShape(statsText(row, 'query'), normalizePostgresqlStatement),
            calls: statsCounter(row, 'calls'), totalTimeMs: statsNumber(row, 'total_time_ms'), rows: statsCounter(row, 'rows'), nativeTimeUnit: 'milliseconds',
            ...statsOptional('blocksRead', statsCounter(row, 'blocks_read')), ...statsOptional('blocksHit', statsCounter(row, 'blocks_hit')),
            ...statsOptional('tempBlocksWritten', statsCounter(row, 'temp_blocks_written')), ...statsOptional('planningTimeMs', statsNumber(row, 'planning_time_ms')),
        })), minor < 9 ? ['reset_marker_unavailable', 'eviction_possible'] : minor < 11 ? ['reset_marker_unavailable'] : []);
    }
    if (operation.group === 'tables') {
        const predicate = selectedRelation('n.nspname', 'c.relname');
        const pagination = page();
        return statsSqlPlan('postgresql', operation, { sql: postgresqlWorkbenchReadSql(`SELECT c.oid::text AS key, n.nspname AS schema_name, c.relname AS relation_name,
            CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text END AS estimated_rows, s.n_live_tup::text AS live_rows, s.n_dead_tup::text AS dead_rows,
            s.seq_scan::text AS sequential_scans, s.idx_scan::text AS index_scans,
            (s.seq_tup_read + s.idx_tup_fetch)::text AS rows_read,
            s.n_tup_ins::text AS inserted, s.n_tup_upd::text AS updated, s.n_tup_del::text AS deleted,
            s.last_vacuum::text AS last_vacuum, s.last_analyze::text AS last_analyze,
            s.last_autovacuum::text AS last_autovacuum, s.last_autoanalyze::text AS last_autoanalyze,
            pg_catalog.pg_relation_size(c.oid)::text AS relation_bytes, pg_catalog.pg_table_size(c.oid)::text AS table_bytes,
            pg_catalog.pg_indexes_size(c.oid)::text AS index_bytes, pg_catalog.pg_total_relation_size(c.oid)::text AS size_bytes,
            ${metadata} FROM pg_catalog.pg_stat_user_tables s JOIN pg_catalog.pg_class c ON c.oid = s.relid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${predicate} ORDER BY n.nspname,c.relname${pagination}`), parameters }, rows => rows.map(row => ({
            relation: statsRelation(row), ...statsOptional('estimatedRows', statsCounter(row, 'estimated_rows')),
            ...statsOptional('liveRows', statsCounter(row, 'live_rows')), ...statsOptional('deadRows', statsCounter(row, 'dead_rows')),
            ...statsOptional('sequentialScans', statsCounter(row, 'sequential_scans')), ...statsOptional('indexScans', statsCounter(row, 'index_scans')),
            ...statsOptional('rowsRead', statsCounter(row, 'rows_read')), ...statsOptional('inserted', statsCounter(row, 'inserted')),
            ...statsOptional('updated', statsCounter(row, 'updated')), ...statsOptional('deleted', statsCounter(row, 'deleted')),
            ...statsOptional('lastVacuum', statsText(row, 'last_vacuum')), ...statsOptional('lastAnalyze', statsText(row, 'last_analyze')),
            ...statsOptional('lastAutovacuum', statsText(row, 'last_autovacuum')), ...statsOptional('lastAutoanalyze', statsText(row, 'last_autoanalyze')),
            size: statsSize(row, 'database_bytes'),
        })));
    }
    if (operation.group === 'indexes') {
        const predicate = selectedRelation('n.nspname', 't.relname');
        const pagination = page();
        return statsSqlPlan('postgresql', operation, { sql: postgresqlWorkbenchReadSql(`SELECT i.oid::text AS key,n.nspname AS schema_name,t.relname AS relation_name,i.relname AS index_name,
            to_json(ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY k(attnum,position)
                LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum ORDER BY k.position)) AS columns,
            pg_catalog.pg_get_indexdef(i.oid) AS definition,pg_catalog.pg_get_expr(ix.indpred,ix.indrelid) AS predicate,
            ix.indisunique AS is_unique,ix.indisprimary AS is_primary,
            EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co WHERE co.conindid=i.oid) AS is_constraint,
            s.idx_scan::text AS scans,s.idx_tup_read::text AS tuples_read,s.idx_tup_fetch::text AS tuples_fetched,
            pg_catalog.pg_relation_size(i.oid)::text AS size_bytes,${metadata}
            FROM pg_catalog.pg_stat_user_indexes s JOIN pg_catalog.pg_class i ON i.oid=s.indexrelid
            JOIN pg_catalog.pg_index ix ON ix.indexrelid=i.oid JOIN pg_catalog.pg_class t ON t.oid=ix.indrelid
            JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE ${predicate} ORDER BY n.nspname,t.relname,i.relname${pagination}`), parameters }, rows => rows.map(row => ({
            relation: statsRelation(row), name: statsText(row,'index_name'), columns: statsJsonArray(row.columns),
            ...statsOptional('definition', diagnosticShape(statsText(row, 'definition'))),
            ...statsOptional('predicate', diagnosticShape(statsText(row, 'predicate') ? `SELECT ${statsText(row, 'predicate')}` : undefined)),
            unique:statsBoolean(row,'is_unique'),primary:statsBoolean(row,'is_primary'),constraint:statsBoolean(row,'is_constraint'),
            ...statsOptional('scans',statsCounter(row,'scans')),...statsOptional('tuplesRead',statsCounter(row,'tuples_read')),
            ...statsOptional('tuplesFetched',statsCounter(row,'tuples_fetched')),...statsOptional('bytes',statsCounter(row,'size_bytes')),
        })));
    }
    const activityKey = operation.selection.activityKey;
    const predicate = activityKey === undefined ? '' : ` AND a.pid = ${bind(activityKey)}::integer`;
    const pagination = page();
    const workbenchApplication = bind(POSTGRESQL_WORKBENCH_APPLICATION_NAME);
    return statsSqlPlan('postgresql', operation, {sql:postgresqlWorkbenchReadSql(`SELECT a.pid::text AS key,a.state,a.query,a.wait_event_type AS wait_class,a.wait_event,
        a.xact_start::text AS transaction_started_at,a.query_start::text AS query_started_at,
        a.state IS NULL AS visibility_restricted,to_json(pg_catalog.pg_blocking_pids(a.pid)) AS blocking_keys,
        (SELECT json_agg(json_build_object('relation',c.relname,'mode',l.mode,'granted',l.granted))
            FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_class c ON c.oid=l.relation WHERE l.pid=a.pid) AS locks,
        ${metadata} FROM pg_catalog.pg_stat_activity a WHERE a.datname=current_database()
        AND a.pid <> pg_catalog.pg_backend_pid() AND a.application_name IS DISTINCT FROM ${workbenchApplication}${predicate}
        ORDER BY a.pid${pagination}`),parameters}, rows=>rows.map(row=>({key:statsText(row,'key'),
        ...statsOptional('state',statsText(row,'state')),...statsShape(statsText(row,'query'),normalizePostgresqlStatement),
        ...statsOptional('waitClass',statsText(row,'wait_class')),...statsOptional('waitEvent',statsText(row,'wait_event')),
        ...statsOptional('transactionStartedAt',statsText(row,'transaction_started_at')),...statsOptional('queryStartedAt',statsText(row,'query_started_at')),
        blockingKeys:statsJsonArray(row.blocking_keys).map(String),
        ...(row.locks?{locks:statsJsonArray(row.locks).map(value=>{ const lock=statsJsonObject(value); return {
            ...statsOptional('relation',lock.relation ?? undefined),mode:lock.mode,granted:lock.granted}; })}:{}),
    })));
}
