import type { DatabaseStatsReadV1 } from '@happier-dev/database-protocol';
import type { DatabaseStatsSqlPlanV1 } from '../stats.js';
import { statsSqlPlan, statsText, statsCounter, statsNumber, statsBoolean, statsOptional, statsShape, statsRelation, statsSize, statsJsonObject, statsJsonArray } from '../stats.js';
export function compileMysqlStatsV1(operation: DatabaseStatsReadV1): DatabaseStatsSqlPlanV1 {
    const parameters: (string | number)[] = [];
    const bind = (value: string | number) => { parameters.push(value); return '?'; };
    const page = () => 'page' in operation.selection ? ` LIMIT ${bind(operation.selection.page.rows + 1)} OFFSET ${bind(operation.selection.page.offset ?? 0)}` : '';
    const relation = (schema: string, table: string) => {
        const selection = operation.selection;
        if ('relation' in selection && selection.relation) return `${schema} = ${bind(selection.relation.schema)} AND ${table} = ${bind(selection.relation.name)}`;
        if ('schema' in selection) return `${schema} = ${bind(selection.schema)}` + (selection.search === undefined ? '' : ` AND LOCATE(${bind(selection.search)}, ${table}) > 0`);
        return `${schema} = DATABASE()`;
    };
    if (operation.group === 'indexAdvice') return { status: 'unavailable', reason: 'unsupported_group' };
    if (operation.group === 'size') {
        const selected = operation.selection.relation;
        const predicate = selected ? `TABLE_SCHEMA = ${bind(selected.schema)} AND TABLE_NAME = ${bind(selected.name)}` : 'TABLE_SCHEMA = DATABASE()';
        return statsSqlPlan('mysql', operation, { sql: `SELECT CAST(COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0) AS CHAR) AS size_bytes,
            CAST(COALESCE(SUM(DATA_LENGTH),0) AS CHAR) AS table_bytes, CAST(COALESCE(SUM(INDEX_LENGTH),0) AS CHAR) AS index_bytes
            FROM information_schema.tables WHERE ${predicate}`, parameters }, rows => statsSize(rows[0] ?? {}, 'table_bytes_estimate'));
    }
    if (operation.group === 'statements') {
        const key = "CONCAT(s.SCHEMA_NAME, ':', s.DIGEST)";
        const predicate = operation.selection.statementKey === undefined ? '' : ` AND ${key} = ${bind(operation.selection.statementKey)}`;
        const order = { totalTime: 's.SUM_TIMER_WAIT', calls: 's.COUNT_STAR', rows: 's.SUM_ROWS_SENT' }[operation.selection.order];
        const pagination = page();
        return statsSqlPlan('mysql',operation,{sql:`WITH requested AS (SELECT ${key} AS \`key\`,s.SCHEMA_NAME AS \`database\`,
            CAST(s.COUNT_STAR AS CHAR) AS calls,CAST(s.SUM_TIMER_WAIT AS CHAR) AS total_time_ps,
            CAST(s.SUM_ROWS_SENT AS CHAR) AS \`rows\`,CAST(s.SUM_ROWS_EXAMINED AS CHAR) AS rows_examined,
            s.DIGEST_TEXT AS query
            FROM performance_schema.events_statements_summary_by_digest s WHERE s.SCHEMA_NAME=DATABASE() AND s.DIGEST IS NOT NULL${predicate}
            ORDER BY ${order} DESC,s.SCHEMA_NAME,s.DIGEST${pagination}) SELECT r.*,
            EXISTS(SELECT 1 FROM performance_schema.events_statements_summary_by_digest overflow_row WHERE overflow_row.DIGEST IS NULL AND overflow_row.COUNT_STAR > 0) AS digest_overflow,
            EXISTS(SELECT 1 FROM performance_schema.setup_consumers WHERE NAME='statements_digest' AND ENABLED='YES') AS instrumentation_enabled
            FROM (SELECT 1) metadata LEFT JOIN requested r ON TRUE`,parameters},rows=>rows.map(row=>({
            key:statsText(row,'key'),database:statsText(row,'database'),...statsShape(undefined),calls:statsCounter(row,'calls'),
            totalTimeMs: statsNumber(row,'total_time_ps')===undefined?undefined:statsNumber(row,'total_time_ps')!/1_000_000_000,rows:statsCounter(row,'rows'),nativeTimeUnit:'picoseconds',
            ...statsOptional('rowsExamined',statsCounter(row,'rows_examined')),
        })),['reset_marker_unavailable']);
    }
    if(operation.group==='tables') {
        const predicate=relation('t.TABLE_SCHEMA','t.TABLE_NAME'); const pagination=page();
        return statsSqlPlan('mysql',operation,{sql:`SELECT CONCAT(t.TABLE_SCHEMA,':',t.TABLE_NAME) AS \`key\`,
            t.TABLE_SCHEMA AS schema_name,t.TABLE_NAME AS relation_name,CAST(t.TABLE_ROWS AS CHAR) AS estimated_rows,
            CAST(t.DATA_LENGTH+t.INDEX_LENGTH AS CHAR) AS size_bytes,CAST(t.DATA_LENGTH AS CHAR) AS table_bytes,CAST(t.INDEX_LENGTH AS CHAR) AS index_bytes,
            CAST(io.COUNT_READ AS CHAR) AS rows_read,CAST(io.COUNT_INSERT AS CHAR) AS inserted,
            CAST(io.COUNT_UPDATE AS CHAR) AS updated,CAST(io.COUNT_DELETE AS CHAR) AS deleted
            FROM information_schema.tables t LEFT JOIN performance_schema.table_io_waits_summary_by_table io
            ON io.OBJECT_SCHEMA=t.TABLE_SCHEMA AND io.OBJECT_NAME=t.TABLE_NAME WHERE ${predicate}
            ORDER BY t.TABLE_SCHEMA,t.TABLE_NAME${pagination}`,parameters},rows=>rows.map(row=>({
            relation:statsRelation(row),...statsOptional('estimatedRows',statsCounter(row,'estimated_rows')),
            ...statsOptional('rowsRead',statsCounter(row,'rows_read')),...statsOptional('inserted',statsCounter(row,'inserted')),
            ...statsOptional('updated',statsCounter(row,'updated')),...statsOptional('deleted',statsCounter(row,'deleted')),
            ...(statsCounter(row,'size_bytes') === undefined ? {} : { size:statsSize(row,'table_bytes_estimate') }),
        })),['reset_marker_unavailable']);
    }
    if(operation.group==='indexes') {
        const predicate=relation('s.TABLE_SCHEMA','s.TABLE_NAME'); const pagination=page();
        return statsSqlPlan('mysql',operation,{sql:`SELECT CONCAT(s.TABLE_SCHEMA,':',s.TABLE_NAME,':',s.INDEX_NAME) AS \`key\`,
            s.TABLE_SCHEMA AS schema_name,s.TABLE_NAME AS relation_name,s.INDEX_NAME AS index_name,
            JSON_OBJECTAGG(s.SEQ_IN_INDEX,s.COLUMN_NAME) AS columns_json,MIN(s.NON_UNIQUE)=0 AS is_unique,s.INDEX_NAME='PRIMARY' AS is_primary,
            EXISTS(SELECT 1 FROM information_schema.table_constraints c WHERE c.TABLE_SCHEMA=s.TABLE_SCHEMA AND c.TABLE_NAME=s.TABLE_NAME AND c.CONSTRAINT_NAME=s.INDEX_NAME) AS is_constraint,
            CAST(MAX(io.COUNT_READ) AS CHAR) AS scans
            FROM information_schema.statistics s LEFT JOIN performance_schema.table_io_waits_summary_by_index_usage io
            ON io.OBJECT_SCHEMA=s.TABLE_SCHEMA AND io.OBJECT_NAME=s.TABLE_NAME AND io.INDEX_NAME=s.INDEX_NAME
            WHERE ${predicate} GROUP BY s.TABLE_SCHEMA,s.TABLE_NAME,s.INDEX_NAME
            ORDER BY s.TABLE_SCHEMA,s.TABLE_NAME,s.INDEX_NAME${pagination}`,parameters},rows=>rows.map(row=>({
            relation:statsRelation(row),name:statsText(row,'index_name'),columns:Object.entries(statsJsonObject(row.columns_json)).sort(([a],[b])=>Number(a)-Number(b)).map(([,column])=>column),
            unique:statsBoolean(row,'is_unique'),primary:statsBoolean(row,'is_primary'),constraint:statsBoolean(row,'is_constraint'),
            ...statsOptional('scans',statsCounter(row,'scans')),
        })),['reset_marker_unavailable']);
    }
    const predicate=operation.selection.activityKey===undefined?'':` AND t.THREAD_ID=${bind(operation.selection.activityKey)}`; const pagination=page();
    return statsSqlPlan('mysql',operation,{sql:`SELECT CAST(t.THREAD_ID AS CHAR) AS \`key\`,t.PROCESSLIST_STATE AS state,
        t.PROCESSLIST_COMMAND AS wait_class,e.EVENT_NAME AS wait_event,
        (SELECT JSON_ARRAYAGG(CAST(w.BLOCKING_THREAD_ID AS CHAR)) FROM performance_schema.data_lock_waits w
            WHERE w.REQUESTING_THREAD_ID=t.THREAD_ID) AS blocking_keys
        FROM performance_schema.threads t LEFT JOIN performance_schema.events_statements_current e ON e.THREAD_ID=t.THREAD_ID
        WHERE t.PROCESSLIST_DB=DATABASE()${predicate} ORDER BY t.THREAD_ID${pagination}`,parameters},rows=>rows.map(row=>({
        key:statsText(row,'key'),...statsOptional('state',statsText(row,'state')),...statsShape(undefined),
        ...statsOptional('waitClass',statsText(row,'wait_class')),...statsOptional('waitEvent',statsText(row,'wait_event')),
        blockingKeys:statsJsonArray(row.blocking_keys).map(String),
    })));
}
