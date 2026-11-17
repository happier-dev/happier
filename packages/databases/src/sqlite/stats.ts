import type { DatabaseStatsReadV1 } from '@happier-dev/database-protocol';
import type { DatabaseStatsSqlPlanV1 } from '../stats.js';
import { statsSqlPlan, statsText, statsBoolean, statsOptional, statsCounter, statsSize, statsRelation, statsJsonArray } from '../stats.js';
import { quoteSqliteIdentifier } from './identifiers.js';
export type SqliteStatsCompilationV1 = Readonly<{ dbstat?: boolean }>;
export function compileSqliteStatsV1(operation: DatabaseStatsReadV1, capabilities: SqliteStatsCompilationV1 = {}): DatabaseStatsSqlPlanV1 {
    if (operation.group==='statements'||operation.group==='activity'||operation.group==='indexAdvice') return {status:'unavailable',reason:'unsupported_group'};
    const parameters:(string|number)[]=[];
    const bind=(value:string|number)=>{parameters.push(value);return `?${parameters.length}`;};
    const selection=operation.selection;
    const schema='relation' in selection&&selection.relation?selection.relation.schema:'schema' in selection?selection.schema:'main';
    const qualified=quoteSqliteIdentifier(schema);
    const page=()=> 'page' in selection?` LIMIT ${bind(selection.page.rows+1)} OFFSET ${bind(selection.page.offset??0)}`:'';
    const predicate=()=> 'relation' in selection&&selection.relation?`t.name=${bind(selection.relation.name)}`:
        'search' in selection&&selection.search!==undefined?`instr(t.name,${bind(selection.search)})>0`:'TRUE';
    if(operation.group==='size') {
        if(operation.selection.relation) {
            if(!capabilities.dbstat)return {status:'unavailable',reason:'dbstat_unavailable'};
            return statsSqlPlan('sqlite',operation,{sql:`SELECT CAST(COALESCE(SUM(pgsize),0) AS TEXT) AS size_bytes
                FROM ${qualified}.dbstat WHERE name=${bind(operation.selection.relation.name)}`,parameters},rows=>statsSize(rows[0]??{},'page_allocation'));
        }
        return statsSqlPlan('sqlite',operation,{sql:`SELECT CAST(p.page_count*s.page_size AS TEXT) AS size_bytes,
            CAST(f.freelist_count*s.page_size AS TEXT) AS free_bytes
            FROM pragma_page_count p CROSS JOIN pragma_page_size s CROSS JOIN pragma_freelist_count f`,parameters},
        rows=>statsSize(rows[0]??{},'page_allocation'));
    }
    if(operation.group==='tables') {
        const where=predicate();
        const sizes=capabilities.dbstat?`,CAST((SELECT COALESCE(SUM(pgsize),0) FROM ${qualified}.dbstat WHERE name=t.name) AS TEXT) AS size_bytes`:'';
        const pagination=page();
        return statsSqlPlan('sqlite',operation,{sql:`SELECT t.name AS key,${bind(schema)} AS schema_name,t.name AS relation_name${sizes}
            FROM ${qualified}.sqlite_schema t WHERE t.type='table' AND t.name NOT LIKE 'sqlite_%' AND ${where}
            ORDER BY t.name${pagination}`,parameters},rows=>rows.map(row=>({relation:statsRelation(row),
            ...(row.size_bytes===undefined?{}:{size:statsSize(row,'page_allocation')})})),capabilities.dbstat?[]:['dbstat_unavailable']);
    }
    const where=predicate();
    const pagination=page();
    return statsSqlPlan('sqlite',operation,{sql:`SELECT il.name AS key,${bind(schema)} AS schema_name,t.name AS relation_name,il.name AS index_name,
        il.\`unique\` AS is_unique,il.origin='pk' AS is_primary,il.origin IN ('pk','u') AS is_constraint,
        (SELECT json_group_array(name) FROM (SELECT name FROM pragma_index_xinfo(il.name,${bind(schema)}) WHERE key=1 ORDER BY seqno)) AS columns_json
        ${capabilities.dbstat?`,CAST((SELECT COALESCE(SUM(pgsize),0) FROM ${qualified}.dbstat WHERE name=il.name) AS TEXT) AS size_bytes`:''}
        FROM ${qualified}.sqlite_schema t JOIN pragma_index_list(t.name,${bind(schema)}) il
        WHERE t.type='table' AND t.name NOT LIKE 'sqlite_%' AND ${where} ORDER BY t.name,il.name${pagination}`,parameters},rows=>rows.map(row=>({
        relation:statsRelation(row),name:statsText(row,'index_name'),columns:statsJsonArray(row.columns_json),
        unique:statsBoolean(row,'is_unique'),primary:statsBoolean(row,'is_primary'),constraint:statsBoolean(row,'is_constraint'),
        ...statsOptional('bytes',statsCounter(row,'size_bytes')),
    })),capabilities.dbstat?[]:['dbstat_unavailable']);
}
