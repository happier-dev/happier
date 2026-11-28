import type { DatabaseOperationResultV1, DatabaseStatsReadV1, DatabaseStatsReasonV1 } from '@happier-dev/plugin-sdk/database';
import { statsJsonArray, statsJsonObject, statsNumber, statsOperationResultV1, statsScope } from '../stats.js';
import { quotePostgresqlIdentifier as quote } from './identifiers.js';
import { PostgresqlInputError, psqlInputScanner, type PostgresqlLexicalToken } from './input.js';
import type { PostgresqlExecutionOptions, PostgresqlQuery } from './operations.js';
import { compilePostgresqlStatsV1 } from './stats.js';
import { postgresqlWorkbenchReadSql } from './workbenchIdentity.js';

/** Stats text is only a source of identifiers for this intentionally small grammar. */
function readStatementShape(sql: string) {
    const tokens: PostgresqlLexicalToken[] = [];
    const scanner = psqlInputScanner('query', { token: token => tokens.push(token) });
    try { scanner.write(sql, true); }
    catch (error) {
        if (error instanceof PostgresqlInputError) return;
        throw error;
    }
    let position = 0;
    const at = () => tokens[position];
    const raw = (token: PostgresqlLexicalToken) => sql.slice(token.start, token.end);
    const take = (kind: PostgresqlLexicalToken['kind'], text: string) => {
        const token = at();
        if (token?.kind !== kind || raw(token).toLowerCase() !== text) return false;
        position++;
        return true;
    };
    const identifier = () => {
        const token = at();
        if (token?.kind === 'identifier') {
            position++;
            return raw(token).slice(1, -1).replaceAll('""', '"');
        }
        if (token?.kind === 'word' && /^[a-z_][a-z0-9_$]*$/iu.test(raw(token))) {
            position++;
            return raw(token).toLowerCase();
        }
    };

    if (!take('word', 'select') || !take('symbol', '*') || !take('word', 'from')) return;
    const schema = identifier();
    if (!schema || !take('symbol', '.')) return;
    const name = identifier();
    if (!name) return;
    let filter: string | undefined;
    let order: string | undefined;
    if (take('word', 'where')) {
        filter = identifier();
        if (!filter || !take('symbol', '=') || !take('parameter', '$1')) return;
    }
    if (take('word', 'order')) {
        if (!take('word', 'by')) return;
        order = identifier();
        if (!order) return;
    }
    if (at() || (!filter && !order)) return;
    return { schema, name, filter, order };
}

function usesIndex(plan: Readonly<Record<string, unknown>>, index: string): boolean {
    return plan['Index Name'] === index || statsJsonArray(plan.Plans).some(child => usesIndex(statsJsonObject(child), index));
}

export async function readPostgresqlIndexAdvice(
    request: Extract<DatabaseStatsReadV1, { group: 'indexAdvice' }>, query: PostgresqlQuery,
    stats: NonNullable<PostgresqlExecutionOptions['stats']>,
): Promise<DatabaseOperationResultV1> {
    const unavailable = (reason: DatabaseStatsReasonV1) =>
        statsOperationResultV1('postgresql', request, { status: 'unavailable', reason }, [], stats);

    if (stats.nativeBackendPid === undefined) return unavailable('unsupported_transport');
    const run = (text: string, values: string[] = []) => query({ text: postgresqlWorkbenchReadSql(text), values });
    await query({ text: 'SET LOCAL search_path TO pg_catalog, pg_temp', values: [] });
    const [[version, backendPid, extensionSchema] = []] = (await run(`SELECT current_setting('server_version_num'),
        pg_catalog.pg_backend_pid()::text,
        (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='hypopg')`)).rows;
    // Compare BackendKeyData with the server executing this transaction. A pooler
    // that substitutes its own cancellation key does not give us a disposable backend.
    if (backendPid !== String(stats.nativeBackendPid)) return unavailable('unsupported_transport');
    if (Number(version) < 160000) return unavailable('unsupported_engine');
    if (!extensionSchema) {
        const result = unavailable('hypopg_missing');
        if (result.ok && result.operation === 'stats.read' && result.observation.status === 'unavailable') {
            result.observation.remediation = 'Ask your database administrator to enable HypoPG in this database, then retry.';
        }
        return result;
    }
    const statements = compilePostgresqlStatsV1({ kind: 'stats.read', group: 'statements',
        selection: { statementKey: request.selection.statementKey, page: { rows: 1 }, order: 'totalTime' } }, stats, { diagnoseHiddenSelection: true });
    if (statements.status !== 'compiled') return unavailable(statements.reason);
    const selected = statements.statements[0]!;
    const result = await query({ text: selected.sql, values: selected.parameters.map(String) });
    const row = result.rows[0];
    if (row?.[result.fields.findIndex(field => field.name === 'visibility_restricted')] === 't') {
        return unavailable('visibility_restricted');
    }
    const sql = row?.[result.fields.findIndex(field => field.name === 'query')];
    if (!sql) return unavailable('row_evicted');
    const shape = readStatementShape(sql);
    if (!shape) return unavailable('index_advice_statement_unsupported');

    const columns = [...new Set([shape.filter, shape.order].filter(column => column !== undefined))];
    const catalog = await run(`SELECT n.nspname, c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname=$1::text AND c.relname=$2::text AND a.attname::text IN
            (SELECT jsonb_array_elements_text($3::jsonb))
        AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relhasrules
        AND NOT EXISTS (SELECT FROM pg_inherits WHERE inhparent=c.oid)
        AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap')
        AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT')
        AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid IN ('int2'::regtype,'int4'::regtype,'int8'::regtype)`,
    [shape.schema, shape.name, JSON.stringify(columns)]);
    const [schema, name] = catalog.rows[0] ?? [];
    const catalogColumns = new Map(catalog.rows.flatMap(([, , column]) => column ? [[column, column] as const] : []));
    const filterColumn = shape.filter === undefined ? undefined : catalogColumns.get(shape.filter);
    const sortColumn = shape.order === undefined ? undefined : catalogColumns.get(shape.order);
    if (!schema || !name || catalogColumns.size !== columns.length
        || (shape.filter && !filterColumn) || (shape.order && !sortColumn)) {
        return unavailable('index_advice_statement_unsupported');
    }

    const relation = `${quote(schema)}.${quote(name)}`;
    const filter = filterColumn ? ` WHERE ${quote(filterColumn)} OPERATOR(pg_catalog.=) $1` : '';
    const sort = sortColumn ? ` ORDER BY ${quote(sortColumn)}` : '';
    const explain = async () => {
        const result = await query({
            text: `EXPLAIN (GENERIC_PLAN, FORMAT JSON) SELECT * FROM ONLY ${relation}${filter}${sort}`,
            values: [], simpleProtocol: true,
        });
        return statsJsonObject(statsJsonObject(statsJsonArray(result.rows[0]?.[0])[0]).Plan);
    };
    const baseline = await explain();
    const baselineCost = statsNumber(baseline, 'Total Cost');
    if (baselineCost === undefined) throw new Error('Missing baseline planner cost');

    const data = [];
    const hypopg = quote(extensionSchema);
    for (const column of catalogColumns.values()) {
        const create = await run(`SELECT indexname FROM ${hypopg}.hypopg_create_index(
            pg_catalog.format('CREATE INDEX ON %I.%I (%I)', $1::text, $2::text, $3::text))`,
        [schema, name, column]);
        const index = create.rows[0]?.[0];
        if (!index) throw new Error('Missing hypothetical index name');
        const candidate = await explain();
        await run(`SELECT ${hypopg}.hypopg_reset()`);
        const candidateCost = statsNumber(candidate, 'Total Cost');
        if (candidateCost === undefined) throw new Error('Missing hypothetical planner cost');
        if (candidateCost < baselineCost && candidateCost * 2 <= baselineCost && usesIndex(candidate, index)) {
            data.push({ relation: { schema, name }, column, baselineCost, candidateCost });
        }
    }
    return { ok: true, operation: 'stats.read', observation: {
        v: 1, status: 'available', group: 'indexAdvice', engineId: 'postgresql', observedAtMs: Date.now(),
        scope: statsScope(request, stats.database), intervalBasis: stats.intervalBasis,
        coverage: { status: 'complete' }, completeness: { complete: true }, data,
    } };
}
