import type {
    DatabaseCellReadInputV1, DatabaseCellV1, DatabaseEditV1, DatabaseFailureV1, DatabaseFilterV1, DatabaseNamedCellV1,
    DatabaseOperationInputV1, DatabaseOperationResultV1, DatabaseOrderV1, DatabaseRelationStructureV1,
    DatabaseRelationV1, DatabaseRowsReadInputV1, DatabaseSemanticTypeV1,
    DatabaseStatementResultV1, DatabaseValueV1,
} from '@happier-dev/database-protocol';
import { admitSqliteWorkbenchStatement, scanSqliteStatements } from './statement.js';
import { quoteSqliteIdentifier } from './identifiers.js';
import { databaseRowsBindingV1 } from '../rows.js';
import { compileSqliteStatsV1, type SqliteStatsCompilationV1 } from './stats.js';
import { statsNativeRowsV1, statsOperationResultV1, type DatabaseStatsExecutionContextV1, type DatabaseStatsNativeRowV1 } from '../stats.js';
export { quoteSqliteIdentifier } from './identifiers.js';

export type SqliteNativeValue = string | number | bigint | Uint8Array | null;
export interface SqliteNativeResult {
    columns: Array<{ name: string; type: string | null }>;
    rows: SqliteNativeValue[][];
    changes: bigint | null;
}
export interface SqliteCompiledStatement { text: string; values: SqliteNativeValue[] }
export type SqliteQuery = (statement: SqliteCompiledStatement) => SqliteNativeResult;
export type SqliteExecutionOptions = Readonly<{
    stats?: DatabaseStatsExecutionContextV1 & SqliteStatsCompilationV1;
}>;

export class SqliteOperationError extends Error {
    constructor(readonly failure: DatabaseFailureV1) { super(failure.code); this.name = 'SqliteOperationError'; }
}
function unavailable(reason: string): never {
    throw new SqliteOperationError({ ok: false, status: 'unavailable', code: 'database_operation_unavailable', reason });
}
function invalid(reason: string): never {
    throw new SqliteOperationError({ ok: false, status: 'failed', code: 'invalid_action_input', reason });
}
function qualified(relation: DatabaseRelationV1): string {
    return `${quoteSqliteIdentifier(relation.schema)}.${quoteSqliteIdentifier(relation.name)}`;
}
export function sqliteParameter(value: DatabaseValueV1): SqliteNativeValue {
    switch (value.type) {
        case 'null': return null;
        case 'binary': return Buffer.from(value.value, 'base64');
        case 'integer': return BigInt(value.value);
        case 'boolean': return value.value ? 1n : 0n;
        case 'float': return typeof value.value === 'number' ? value.value : Number(value.value);
        default: return value.value;
    }
}
export function sqliteSemanticType(nativeType: string | null): DatabaseSemanticTypeV1 {
    const type = nativeType?.toUpperCase() ?? '';
    if (type.includes('JSON')) return 'json';
    if (type.includes('BOOL')) return 'boolean';
    if (type.includes('INT')) return 'integer';
    if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'text';
    if (type.includes('BLOB')) return 'binary';
    if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'float';
    if (type.includes('DATE') || type.includes('TIME')) return 'temporal';
    // SQLite NUMERIC affinity can store INTEGER, REAL or TEXT, with no fixed decimal precision.
    return 'unknown';
}
export function decodeSqliteValue(value: SqliteNativeValue, nativeType: string | null): DatabaseValueV1 {
    if (value === null) return { type: 'null' };
    if (value instanceof Uint8Array) return { type: 'binary', encoding: 'base64', value: Buffer.from(value).toString('base64') };
    const semantic = sqliteSemanticType(nativeType);
    if (semantic === 'boolean' && (value === 0n || value === 1n)) return { type: 'boolean', value: value === 1n };
    if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
    if (typeof value === 'number') return { type: 'float', value: Number.isFinite(value) ? value : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : 'NaN' };
    if (semantic === 'json') return { type: 'json', value };
    if (semantic === 'temporal') return { type: 'temporal', nativeType: nativeType!, value };
    return { type: 'text', value };
}
export function decodeSqliteResult(result: SqliteNativeResult): DatabaseStatementResultV1 {
    return { columns: result.columns.map(column => ({ name: column.name, nativeType: column.type || 'unknown', semanticType: sqliteSemanticType(column.type) })),
        rows: result.rows.map(row => ({ cells: row.map((value, index) => decodeSqliteValue(value, result.columns[index]!.type)) })),
        ...(result.changes === null ? {} : { affectedRows: String(result.changes) }), completeness: { complete: true } };
}
function bind(statement: SqliteCompiledStatement, value: DatabaseValueV1): string {
    statement.values.push(sqliteParameter(value)); return `?${statement.values.length}`;
}
export function compileSqliteFilter(filter: DatabaseFilterV1, statement: SqliteCompiledStatement): string {
    switch (filter.kind) {
        case 'null': return `${quoteSqliteIdentifier(filter.column)} IS ${filter.isNull ? '' : 'NOT '}NULL`;
        case 'not': return `(NOT ${compileSqliteFilter(filter.filter, statement)})`;
        case 'and': case 'or': return filter.filters.length ? `(${filter.filters.map(child => compileSqliteFilter(child, statement)).join(filter.kind === 'and' ? ' AND ' : ' OR ')})` : filter.kind === 'and' ? '1' : '0';
        case 'comparison': {
            const column = quoteSqliteIdentifier(filter.column); const value = bind(statement, filter.value);
            if (filter.operator === 'contains') return `(instr(CAST(${column} AS TEXT),CAST(${value} AS TEXT))>0)`;
            const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
            return `${column} ${operators[filter.operator]} ${value}`;
        }
    }
}
function text(row: readonly SqliteNativeValue[], index: number): string { return String(row[index] ?? ''); }
function catalog(query: SqliteQuery, sql: string, values: SqliteNativeValue[]): SqliteNativeValue[][] { return query({ text: sql, values }).rows; }
function indexDefinition(sql: string): { expressions: string[]; predicate?: string } {
    const { tokens } = scanSqliteStatements(sql);
    const expressions: string[] = []; let depth = 0; let start: number | undefined; let ended = false;
    for (const token of tokens) {
        const raw = sql.slice(token.start, token.end);
        if (ended) {
            if (token.kind === 'word' && raw.toUpperCase() === 'WHERE') return { expressions, predicate: sql.slice(token.end).trim().replace(/;\s*$/u, '') };
            continue;
        }
        if (token.kind !== 'symbol') continue;
        if (raw === '(') { if (depth++ === 0) start = token.end; }
        else if (raw === ')') { if (--depth === 0 && start !== undefined) { expressions.push(sql.slice(start, token.start).trim()); ended = true; } }
        else if (raw === ',' && depth === 1 && start !== undefined) { expressions.push(sql.slice(start, token.start).trim()); start = token.end; }
    }
    return { expressions };
}
function structure(query: SqliteQuery, relation: DatabaseRelationV1): DatabaseRelationStructureV1 {
    const master = `${quoteSqliteIdentifier(relation.schema)}.sqlite_schema`;
    const identity = catalog(query, `SELECT type,sql FROM ${master} WHERE name=? AND type IN ('table','view')`, [relation.name])[0];
    if (!identity) unavailable('relation_missing');
    const kind = identity[0] === 'view' ? 'view' : 'table';
    const columns = catalog(query, 'SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?,?) ORDER BY cid', [relation.name, relation.schema]);
    const primaryKey = columns.filter(row => Number(row[5]) > 0).sort((a, b) => Number(a[5]) - Number(b[5])).map(row => text(row, 1));
    const indexes = catalog(query, 'SELECT name,"unique",origin,partial FROM pragma_index_list(?,?) ORDER BY seq', [relation.name, relation.schema]);
    // A single INTEGER PK without a separate PK index aliases the nonnullable
    // rowid. INTEGER PRIMARY KEY DESC is the SQLite exception and has an index.
    const rowidAlias = primaryKey.length === 1 && !indexes.some(row => row[2] === 'pk')
        && columns.find(row => text(row, 1) === primaryKey[0])?.[2]?.toString().toUpperCase() === 'INTEGER' ? primaryKey[0] : undefined;
    const foreign = catalog(query, 'SELECT id,seq,"table","from","to" FROM pragma_foreign_key_list(?,?) ORDER BY id,seq', [relation.name, relation.schema]);
    const foreignKeys: DatabaseRelationStructureV1['foreignKeys'] = [];
    for (const row of foreign) {
        const id = `${relation.name}_fk_${text(row, 0)}`;
        let key = foreignKeys.find(item => item.name === id);
        if (!key) { key = { name: id, columns: [], target: { schema: relation.schema, name: text(row, 2) }, targetColumns: [] }; foreignKeys.push(key); }
        key.columns.push(text(row, 3));
        // An omitted destination is SQLite shorthand for the referenced primary key.
        const destination = row[4] === null ? catalog(query, 'SELECT name FROM pragma_table_xinfo(?,?) WHERE pk>0 ORDER BY pk', [text(row, 2), relation.schema])[Number(row[1])]?.[0] : row[4];
        if (typeof destination !== 'string') unavailable('foreign_key_destination_unavailable');
        key.targetColumns.push(destination);
    }
    return { relation, kind, columns: columns.filter(row => Number(row[6]) !== 1).map(row => ({ name: text(row, 1), nativeType: text(row, 2) || 'unknown', semanticType: sqliteSemanticType(text(row, 2)),
        nullable: Number(row[3]) === 0 && text(row, 1) !== rowidAlias, defaultExpression: row[4] === null ? null : text(row, 4), generated: Number(row[6]) === 2 || Number(row[6]) === 3 })), primaryKey,
        indexes: indexes.map(row => {
            const definition = catalog(query, `SELECT sql FROM ${master} WHERE type='index' AND name=?`, [text(row, 0)])[0]?.[0];
            const parsed = typeof definition === 'string' ? indexDefinition(definition) : { expressions: [] };
            return { name: text(row, 0), unique: Number(row[1]) === 1, primary: row[2] === 'pk',
                columns: catalog(query, 'SELECT cid,name,desc FROM pragma_index_xinfo(?,?) WHERE key=1 ORDER BY seqno', [text(row, 0), relation.schema]).map((column, position) => ({
                    ...(Number(column[0]) === -2 ? { kind: 'expression' as const, expression: parsed.expressions[position] ?? '' } : { kind: 'column' as const, column: text(column, 1) }), direction: Number(column[2]) ? 'desc' as const : 'asc' as const })),
                ...(parsed.predicate ? { predicate: parsed.predicate } : {}) };
        }),
        foreignKeys, ...(kind === 'view' ? { viewDefinition: text(identity, 1) } : {}),
        capabilities: [{ operation: 'rows.read', available: true }, kind === 'table' ? { operation: 'edits.apply', available: true } : { operation: 'edits.apply', available: false, code: 'database_relation_read_only', reason: 'Views are read-only in the workbench' }] };
}
function keyset(order: readonly DatabaseOrderV1[], values: readonly DatabaseNamedCellV1[], statement: SqliteCompiledStatement, backward: boolean): string {
    const prior: string[] = []; const alternatives: string[] = [];
    for (const item of order) {
        const cell = values.find(value => value.column === item.column)?.value;
        if (!cell) invalid('invalid_page_continuation');
        const column = quoteSqliteIdentifier(item.column); const value = bind(statement, cell);
        const ascending = (item.direction === 'asc') !== backward;
        const nullsFirst = (item.nulls === 'first' || (!item.nulls && item.direction === 'asc')) !== backward;
        const after = cell.type === 'null' ? nullsFirst ? `${column} IS NOT NULL` : '0'
            : `(${column} ${ascending ? '>' : '<'} ${value}${nullsFirst ? '' : ` OR ${column} IS NULL`})`;
        alternatives.push(`(${[...prior, after].join(' AND ')})`); prior.push(`${column} IS ${value}`);
    }
    return `(${alternatives.join(' OR ')})`;
}
function readRows(query: SqliteQuery, input: DatabaseRowsReadInputV1): DatabaseOperationResultV1 {
    const metadata = structure(query, input.relation);
    // Ordinary SQLite composite PRIMARY KEYs permit duplicate NULLs. Catalog
    // nullability, including rowid aliases, is decided once by structure().
    const primaryKey = metadata.primaryKey.every(name => metadata.columns.find(column => column.name === name)?.nullable === false) ? metadata.primaryKey : [];
    const selected = input.columns.length ? input.columns : metadata.columns.map(column => column.name);
    const order = [...input.order];
    for (const column of primaryKey) if (!order.some(item => item.column === column)) order.push({ column, direction: 'asc' });
    const output = [...selected];
    for (const column of [...primaryKey, ...order.map(item => item.column)]) if (!output.includes(column)) output.push(column);
    if (output.some(column => !metadata.columns.some(item => item.name === column))) invalid('unknown_column');
    const statement: SqliteCompiledStatement = { text: '', values: [] };
    const where = input.filter ? [compileSqliteFilter(input.filter, statement)] : [];
    const continuation = input.page.continuation;
    if (continuation && JSON.stringify(databaseRowsBindingV1(continuation.binding)) !== JSON.stringify(databaseRowsBindingV1(input))) invalid('invalid_page_continuation');
    if (continuation?.kind === 'keyset' && !primaryKey.length) invalid('invalid_page_continuation');
    const backward = continuation?.kind === 'keyset' && continuation.direction === 'backward';
    if (continuation?.kind === 'keyset') where.push(keyset(order, continuation.values, statement, backward));
    statement.text = `SELECT ${output.map(quoteSqliteIdentifier).join(',')} FROM ${qualified(input.relation)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    if (order.length) statement.text += ` ORDER BY ${order.map(item => `${quoteSqliteIdentifier(item.column)} ${(item.direction === 'asc') !== backward ? 'ASC' : 'DESC'} NULLS ${(item.nulls === 'first' || (!item.nulls && item.direction === 'asc')) !== backward ? 'FIRST' : 'LAST'}`).join(',')}`;
    statement.values.push(input.page.rows + 1); statement.text += ` LIMIT ?${statement.values.length}`;
    if (continuation?.kind === 'offset') { statement.values.push(continuation.offset); statement.text += ` OFFSET ?${statement.values.length}`; }
    const decoded = decodeSqliteResult(query(statement)); const more = decoded.rows.length > input.page.rows;
    const retained = decoded.rows.slice(0, input.page.rows); const last = retained.at(-1);
    const named = (row: typeof retained[number], names: readonly string[]): DatabaseNamedCellV1[] => names.map(column => {
        const value = row.cells[output.indexOf(column)]!; if (value.type === 'partial') throw new Error('Unexpected partial native cell'); return { column, value };
    });
    const next = primaryKey.length && last ? { kind: 'keyset' as const, binding: databaseRowsBindingV1(input), values: named(last, order.map(item => item.column)), direction: backward ? 'backward' as const : 'forward' as const }
        : { kind: 'offset' as const, binding: databaseRowsBindingV1(input), offset: (continuation?.kind === 'offset' ? continuation.offset : 0) + retained.length };
    return { ok: true, operation: input.operation, result: { columns: selected.map(column => metadata.columns.find(item => item.name === column)!),
        rows: (backward ? retained.reverse() : retained).map(row => ({ cells: selected.map(column => row.cells[output.indexOf(column)]!), ...(primaryKey.length ? { identity: { key: named(row, primaryKey), original: named(row, output) } } : {}) })),
        completeness: more ? { complete: false, reason: 'page', continuation: next } : { complete: true } } };
}
function compileEdit(relation: DatabaseRelationV1, change: DatabaseEditV1, metadata: DatabaseRelationStructureV1): SqliteCompiledStatement {
    const statement: SqliteCompiledStatement = { text: '', values: [] };
    if (change.kind !== 'insert') {
        if (!metadata.primaryKey.length) unavailable('primary_key_required');
        if (change.key.length !== metadata.primaryKey.length || metadata.primaryKey.some(column => !change.key.some(item => item.column === column))) invalid('invalid_row_identity');
    }
    const expression = (column: string, value: Extract<DatabaseEditV1, { kind: 'insert' }>['values'][number]['value']) => {
        const definition = metadata.columns.find(item => item.name === column);
        if (!definition || definition.generated) invalid('column_not_writable');
        return value.kind === 'default' ? definition.defaultExpression ?? 'NULL' : bind(statement, value.cell);
    };
    if (change.kind === 'insert') {
        // SQLite supports DEFAULT VALUES but not DEFAULT as an individual VALUES expression.
        for (const item of change.values) expression(item.column, { kind: 'default' });
        const values = change.values.filter(item => item.value.kind !== 'default');
        statement.text = values.length ? `INSERT INTO ${qualified(relation)} (${values.map(item => quoteSqliteIdentifier(item.column)).join(',')}) VALUES (${values.map(item => expression(item.column, item.value)).join(',')})` : `INSERT INTO ${qualified(relation)} DEFAULT VALUES`;
    } else {
        const predicates = change.key.map(item => `${quoteSqliteIdentifier(item.column)} IS ${bind(statement, item.value)}`);
        if (change.kind === 'update') {
            for (const item of change.values) {
                const original = change.original.find(value => value.column === item.column);
                if (!original) invalid('missing_original_value');
                const column = quoteSqliteIdentifier(item.column); const value = bind(statement, original.value);
                predicates.push(original.value.type === 'text' || original.value.type === 'json' || original.value.type === 'temporal'
                    ? `CAST(${column} AS BLOB) IS CAST(${value} AS BLOB)` : `${column} IS ${value}`);
            }
            statement.text = `UPDATE ${qualified(relation)} SET ${change.values.map(item => `${quoteSqliteIdentifier(item.column)}=${expression(item.column, item.value)}`).join(',')} WHERE ${predicates.join(' AND ')}`;
        } else statement.text = `DELETE FROM ${qualified(relation)} WHERE ${predicates.join(' AND ')}`;
    }
    return statement;
}
function readCell(query: SqliteQuery, input: DatabaseCellReadInputV1): DatabaseOperationResultV1 {
    const metadata = structure(query, input.relation);
    if (!metadata.primaryKey.length || input.key.length !== metadata.primaryKey.length || metadata.primaryKey.some(column => !input.key.some(item => item.column === column))) invalid('primary_key_required');
    const definition = metadata.columns.find(column => column.name === input.column); if (!definition) invalid('unknown_column');
    const statement: SqliteCompiledStatement = { text: '', values: [] };
    const key = input.key.map(item => `${quoteSqliteIdentifier(item.column)} IS ${bind(statement, item.value)}`);
    const bytes = `CAST(${quoteSqliteIdentifier(input.column)} AS BLOB)`;
    statement.values.push(input.range.offset + 1, input.range.length);
    statement.text = `SELECT substr(${bytes},?${statement.values.length - 1},?${statement.values.length}),length(${bytes}),typeof(${quoteSqliteIdentifier(input.column)}) FROM ${qualified(input.relation)} WHERE ${key.join(' AND ')}`;
    const row = query(statement).rows[0]; if (!row) unavailable('row_missing');
    if (row[0] === null) return { ok: true, operation: input.operation, value: { type: 'null' }, completeness: { complete: true } };
    // SQLite's actual storage class can differ from the declared affinity.
    const binary = row[2] === 'blob';
    if (input.range.unit !== (binary ? 'bytes' : 'utf8_bytes')) invalid('invalid_cell_range_unit');
    if (!(row[0] instanceof Uint8Array)) throw new Error('SQLite returned invalid binary data');
    let retained = Buffer.from(row[0]); let value = '';
    if (!binary) {
        for (;;) {
            try { value = new TextDecoder('utf-8', { fatal: true }).decode(retained); break; }
            catch { if (!retained.length || (retained[0]! & 0xc0) === 0x80) invalid('invalid_cell_range_boundary'); retained = retained.subarray(0, retained.length - 1); }
        }
        if (!retained.length && Number(row[1]) > input.range.offset && input.range.length) invalid('cell_range_too_short_for_character');
    }
    const total = Number(row[1]);
    if (input.range.offset === 0 && retained.length === total) return { ok: true, operation: input.operation,
        value: binary ? { type: 'binary', encoding: 'base64', value: retained.toString('base64') } : definition.semanticType === 'json' ? { type: 'json', value } : { type: 'text', value }, completeness: { complete: true } };
    const nextOffset = input.range.offset + retained.length;
    const range = { offset: input.range.offset, length: retained.length, total };
    const partial: DatabaseCellV1 = binary
        ? { type: 'partial', valueType: 'binary', encoding: 'base64', value: retained.toString('base64'), range: { ...range, unit: 'bytes' } }
        : { type: 'partial', valueType: definition.semanticType === 'json' ? 'json' : 'text', encoding: 'utf8', value, range: { ...range, unit: 'utf8_bytes' } };
    return { ok: true, operation: input.operation, value: partial,
        completeness: { complete: false, reason: 'page', ...(nextOffset < total ? { continuation: { kind: 'cell', input: { target: input.target, relation: input.relation, key: input.key, column: input.column, ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}) },
            range: { offset: nextOffset, length: input.range.length, unit: input.range.unit, total } } } : {}) } };
}

/** Pure dialect semantics; the transport owns the containing atomic transaction. */
export function executeSqliteOperation(input: DatabaseOperationInputV1, query: SqliteQuery, options: SqliteExecutionOptions = {}): DatabaseOperationResultV1 {
    switch (input.operation) {
        case 'describe': return unavailable('Target descriptions belong to the selected-target resolver');
        case 'schemas.list': {
            const names = catalog(query, 'SELECT name FROM pragma_database_list WHERE (? IS NULL OR instr(name,?)>0) AND (? IS NULL OR name>?) ORDER BY name LIMIT ?', [input.search ?? null, input.search ?? null, input.page.after ?? null, input.page.after ?? null, input.page.rows + 1]);
            const rows = names.slice(0, input.page.rows);
            return { ok: true, operation: input.operation, schemas: rows.map(row => ({ name: text(row, 0) })), completeness: names.length > rows.length ? { complete: false, reason: 'page', continuation: { kind: 'catalog', operation: input.operation, target: input.target, ...(input.search ? { search: input.search } : {}), after: text(rows.at(-1)!, 0) } } : { complete: true } };
        }
        case 'relations.list': {
            const native = catalog(query, `SELECT name,type FROM ${quoteSqliteIdentifier(input.schema)}.sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' AND (? IS NULL OR instr(name,?)>0) AND (? IS NULL OR name>?) ORDER BY name LIMIT ?`, [input.search ?? null, input.search ?? null, input.page.after ?? null, input.page.after ?? null, input.page.rows + 1]);
            const rows = native.slice(0, input.page.rows);
            return { ok: true, operation: input.operation, relations: rows.map(row => ({ relation: { schema: input.schema, name: text(row, 0) }, kind: row[1] === 'view' ? 'view' : 'table' })), completeness: native.length > rows.length ? { complete: false, reason: 'page', continuation: { kind: 'catalog', operation: input.operation, target: input.target, schema: input.schema, ...(input.search ? { search: input.search } : {}), after: text(rows.at(-1)!, 0) } } : { complete: true } };
        }
        case 'relation.structure': return { ok: true, operation: input.operation, structure: structure(query, input.relation) };
        case 'rows.read': return readRows(query, input);
        case 'cell.read': return readCell(query, input);
        case 'statement.run': {
            const statements = input.mode === 'read' ? [input.statement] : input.statements;
            const results: DatabaseStatementResultV1[] = [];
            for (const [statementIndex, statement] of statements.entries()) {
                try { results.push(decodeSqliteResult(query({ text: admitSqliteWorkbenchStatement(statement.sql), values: statement.parameters.map(sqliteParameter) }))); }
                catch (error) { if (error instanceof Error) Object.assign(error, { statementIndex }); throw error; }
            }
            return { ok: true, operation: input.operation, results };
        }
        case 'statement.explain': {
            if (input.mode === 'analyze') unavailable('SQLite does not support EXPLAIN ANALYZE');
            const result = query({ text: `EXPLAIN QUERY PLAN ${admitSqliteWorkbenchStatement(input.statement.sql)}`, values: input.statement.parameters.map(sqliteParameter) });
            return { ok: true, operation: input.operation, format: 'text', plan: result.rows.map(row => text(row, 3)).join('\n'), completeness: { complete: true } };
        }
        case 'edits.apply': {
            let metadata: DatabaseRelationStructureV1;
            try { metadata = structure(query, input.relation); }
            catch (error) { if (error instanceof SqliteOperationError && error.failure.status === 'unavailable' && error.failure.reason === 'relation_missing') throw new SqliteOperationError({ ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: 0, reason: 'relation_changed' }); throw error; }
            if (metadata.kind !== 'table') unavailable('relation_read_only');
            let inserted = 0n; let updated = 0n; let deleted = 0n;
            for (const [changeIndex, change] of input.changes.entries()) {
                const result = query(compileEdit(input.relation, change, metadata));
                if (result.changes !== 1n) throw new SqliteOperationError(result.changes === 0n
                    ? { ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex, reason: change.kind === 'delete' ? 'row_missing' : 'row_changed' }
                    : { ok: false, status: 'failed', code: 'database_edit_row_count', reason: 'The edit did not affect exactly one row' });
                if (change.kind === 'insert') inserted++; else if (change.kind === 'update') updated++; else deleted++;
            }
            return { ok: true, operation: input.operation, status: 'committed', inserted: String(inserted), updated: String(updated), deleted: String(deleted) };
        }
        case 'stats.read': {
            if (!options.stats) return unavailable('Statistics require native connection setup facts');
            const plan = compileSqliteStatsV1(input.request, options.stats);
            const resultSets: (readonly DatabaseStatsNativeRowV1[])[] = [];
            if (plan.status === 'compiled') for (const statement of plan.statements) {
                const native = query({ text: statement.sql, values: [...statement.parameters] });
                resultSets.push(statsNativeRowsV1(native.columns, native.rows));
            }
            return statsOperationResultV1('sqlite', input.request, plan, resultSets, options.stats);
        }
    }
}
