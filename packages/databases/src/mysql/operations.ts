import type {
    DatabaseCellReadInputV1, DatabaseEditV1, DatabaseFailureCauseV1, DatabaseFailureV1, DatabaseFilterV1, DatabaseNamedCellV1,
    DatabaseOperationInputV1, DatabaseOperationResultV1, DatabaseOrderV1, DatabaseRelationStructureV1,
    DatabaseRelationV1, DatabaseRowsReadInputV1, DatabaseRowsResultV1,
    DatabaseSemanticTypeV1, DatabaseStatementResultV1, DatabaseValueV1,
} from '@happier-dev/database-protocol';
import { admitMysqlWorkbenchStatement } from './statement.js';
import { databaseRowsBindingV1 } from '../rows.js';
import { compileMysqlStatsV1 } from './stats.js';
import { statsNativeRowsV1, statsOperationResultV1, statsSize, type DatabaseStatsExecutionContextV1, type DatabaseStatsNativeRowV1 } from '../stats.js';

export interface MysqlNativeField { name: string; columnType: number; characterSet: number }
export type MysqlNativeValue = string | number | Buffer | null;
export interface MysqlNativeResult {
    fields: ReadonlyArray<MysqlNativeField>;
    rows: ReadonlyArray<ReadonlyArray<MysqlNativeValue>>;
    affectedRows?: number | string;
    command?: string;
}
export interface MysqlCompiledStatement { text: string; values: Array<string | number | boolean | Buffer | null> }
export type MysqlQuery = (statement: MysqlCompiledStatement) => Promise<MysqlNativeResult>;
export interface MysqlExecutionOptions { noBackslashEscapes?: boolean; ansiQuotes?: boolean; stats?: DatabaseStatsExecutionContextV1 }

// Stable MySQL wire protocol column types. BOOL is a TINYINT on this boundary, not a distinct boolean type.
const wireTypes: Readonly<Record<number, string>> = {
    0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL',
    7: 'TIMESTAMP', 8: 'BIGINT', 9: 'MEDIUMINT', 10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR',
    14: 'DATE', 16: 'BIT', 17: 'TIMESTAMP', 18: 'DATETIME', 19: 'TIME', 245: 'JSON',
    246: 'DECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINYBLOB', 250: 'MEDIUMBLOB', 251: 'LONGBLOB',
    252: 'BLOB', 253: 'VARCHAR', 254: 'CHAR', 255: 'GEOMETRY',
};
const semanticTypes: Readonly<Record<string, DatabaseSemanticTypeV1>> = {
    TINYINT: 'integer', SMALLINT: 'integer', MEDIUMINT: 'integer', INT: 'integer', INTEGER: 'integer', BIGINT: 'integer', YEAR: 'integer',
    DECIMAL: 'decimal', NUMERIC: 'decimal', FLOAT: 'float', DOUBLE: 'float', REAL: 'float', JSON: 'json',
    TIMESTAMP: 'temporal', DATETIME: 'temporal', DATE: 'temporal', TIME: 'temporal',
    BIT: 'binary', BINARY: 'binary', VARBINARY: 'binary', GEOMETRY: 'binary',
    CHAR: 'text', VARCHAR: 'text', ENUM: 'text', SET: 'text', TEXT: 'text', TINYTEXT: 'text', MEDIUMTEXT: 'text', LONGTEXT: 'text',
    BLOB: 'binary', TINYBLOB: 'binary', MEDIUMBLOB: 'binary', LONGBLOB: 'binary',
};
export function mysqlSemanticType(nativeType: string): DatabaseSemanticTypeV1 { return semanticTypes[nativeType.toUpperCase()] ?? 'unknown'; }
function fieldType(field: MysqlNativeField): DatabaseSemanticTypeV1 {
    // TEXT and BLOB share a protocol type; the binary character set distinguishes their bytes.
    if ([249, 250, 251, 252, 253, 254].includes(field.columnType)) return field.characterSet === 63 ? 'binary' : 'text';
    return mysqlSemanticType(wireTypes[field.columnType] ?? '');
}
export function quoteMysqlIdentifier(value: string): string { return `\`${value.replaceAll('`', '``')}\``; }
function qualified(relation: DatabaseRelationV1): string { return `${quoteMysqlIdentifier(relation.schema)}.${quoteMysqlIdentifier(relation.name)}`; }
export function mysqlParameter(value: DatabaseValueV1): string | number | boolean | Buffer | null {
    switch (value.type) {
        case 'null': return null;
        case 'binary': return Buffer.from(value.value, 'base64');
        default: return value.value;
    }
}
export function decodeMysqlValue(value: MysqlNativeValue, field: MysqlNativeField): DatabaseValueV1 {
    if (value === null) return { type: 'null' };
    const semantic = fieldType(field);
    if (semantic === 'binary') {
        if (!Buffer.isBuffer(value)) throw new Error('MySQL returned a nonbinary value for binary metadata');
        return { type: 'binary', encoding: 'base64', value: value.toString('base64') };
    }
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    switch (semantic) {
        case 'integer':
            if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('MySQL returned an inexact integer');
            return { type: 'integer', value: text };
        case 'decimal': return { type: 'decimal', value: text };
        case 'float': return { type: 'float', value: text === 'NaN' || text === 'Infinity' || text === '-Infinity' ? text : Number(value) };
        case 'json': return { type: 'json', value: text };
        case 'temporal': return { type: 'temporal', nativeType: wireTypes[field.columnType]!, value: text };
        default: return { type: 'text', value: text };
    }
}
export function decodeMysqlResult(native: MysqlNativeResult): DatabaseStatementResultV1 {
    return { columns: native.fields.map(field => ({ name: field.name, nativeType: wireTypes[field.columnType] ?? `mysql:${field.columnType}`, semanticType: fieldType(field) })),
        rows: native.rows.map(row => ({ cells: row.map((value, index) => decodeMysqlValue(value, native.fields[index]!)) })),
        ...(native.command ? { command: native.command } : {}), ...(native.affectedRows === undefined ? {} : { affectedRows: String(native.affectedRows) }), completeness: { complete: true } };
}
export class MysqlOperationError extends Error {
    constructor(readonly failure: DatabaseFailureV1) { super('reason' in failure ? failure.reason : failure.code); this.name = 'MysqlOperationError'; }
}
export function mysqlFailureCause(error: unknown): DatabaseFailureCauseV1 {
    const object = typeof error === 'object' && error !== null ? error : undefined;
    const code = object && 'code' in object && typeof object.code === 'string' ? object.code : 'action_failed';
    const native = object && 'sqlState' in object && typeof object.sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(object.sqlState);
    return { source: native || code.startsWith('ER_') ? 'engine' : 'transport', code,
        message: error instanceof Error ? error.message : 'The database operation failed' };
}
function unavailable(reason: string): never { throw new MysqlOperationError({ ok: false, status: 'unavailable', code: 'database_operation_unavailable', reason }); }
function invalid(reason: string): never { throw new MysqlOperationError({ ok: false, status: 'failed', code: 'invalid_action_input', reason }); }
function scalar(row: ReadonlyArray<MysqlNativeValue>, index: number): string {
    const value = row[index];
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('MySQL returned invalid catalog metadata');
    return String(value);
}
function bind(statement: MysqlCompiledStatement, value: DatabaseValueV1): string {
    statement.values.push(mysqlParameter(value));
    return value.type === 'json' ? 'CAST(? AS JSON)' : '?';
}
export function compileMysqlFilter(filter: DatabaseFilterV1, statement: MysqlCompiledStatement): string {
    switch (filter.kind) {
        case 'null': return `${quoteMysqlIdentifier(filter.column)} IS ${filter.isNull ? '' : 'NOT '}NULL`;
        case 'not': return `(NOT ${compileMysqlFilter(filter.filter, statement)})`;
        case 'and': case 'or': return filter.filters.length ? `(${filter.filters.map(child => compileMysqlFilter(child, statement)).join(filter.kind === 'and' ? ' AND ' : ' OR ')})` : filter.kind === 'and' ? 'TRUE' : 'FALSE';
        case 'comparison': {
            const column = quoteMysqlIdentifier(filter.column); const value = bind(statement, filter.value);
            if (filter.operator === 'contains') return `(LOCATE(${value}, CAST(${column} AS CHAR)) > 0)`;
            const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
            return `${column} ${operators[filter.operator]} ${value}`;
        }
    }
}

async function structure(query: MysqlQuery, relation: DatabaseRelationV1): Promise<DatabaseRelationStructureV1> {
    const values = [relation.schema, relation.name];
    const identity = await query({ text: 'SELECT t.TABLE_TYPE,t.ENGINE,e.TRANSACTIONS FROM information_schema.TABLES t LEFT JOIN information_schema.ENGINES e ON e.ENGINE=t.ENGINE WHERE t.TABLE_SCHEMA=? AND t.TABLE_NAME=?', values });
    if (!identity.rows[0]) unavailable('relation_missing');
    const kind = scalar(identity.rows[0], 0) === 'VIEW' ? 'view' : 'table';
    const transactional = identity.rows[0][2] === 'YES';
    const columns = await query({ text: 'SELECT COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', values });
    const indexes = await query({ text: 'SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,COLLATION,EXPRESSION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', values });
    const foreign = await query({ text: 'SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION', values });
    const result: DatabaseRelationStructureV1 = { relation, kind,
        columns: columns.rows.map(row => ({ name: scalar(row, 0), nativeType: scalar(row, 2), semanticType: mysqlSemanticType(scalar(row, 1)), nullable: row[3] === 'YES',
            defaultExpression: row[4] === null ? null : scalar(row, 4), generated: /(?:VIRTUAL|STORED) GENERATED/iu.test(scalar(row, 5)) })),
        primaryKey: [], indexes: [], foreignKeys: [], capabilities: [{ operation: 'rows.read', available: true },
            kind !== 'table' ? { operation: 'edits.apply', available: false, code: 'database_relation_read_only', reason: 'relation_read_only' }
                : transactional ? { operation: 'edits.apply', available: true }
                    : { operation: 'edits.apply', available: false, code: 'database_operation_unavailable', reason: 'nontransactional_storage_engine' }],
    };
    for (const row of indexes.rows) {
        const name = scalar(row, 0);
        let index = result.indexes.find(item => item.name === name);
        if (!index) { index = { name, unique: scalar(row, 1) === '0', primary: name === 'PRIMARY', columns: [] }; result.indexes.push(index); }
        const direction = row[3] === 'D' ? 'desc' : 'asc';
        index.columns.push(row[2] === null ? { kind: 'expression', expression: scalar(row, 4), direction } : { kind: 'column', column: scalar(row, 2), direction });
        if (index.primary && row[2] !== null) result.primaryKey.push(scalar(row, 2));
    }
    for (const row of foreign.rows) {
        const name = scalar(row, 0);
        let key = result.foreignKeys.find(item => item.name === name);
        if (!key) { key = { name, columns: [], target: { schema: scalar(row, 2), name: scalar(row, 3) }, targetColumns: [] }; result.foreignKeys.push(key); }
        key.columns.push(scalar(row, 1)); key.targetColumns.push(scalar(row, 4));
    }
    if (kind === 'view') {
        const view = await query({ text: 'SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', values });
        if (view.rows[0]?.[0] !== null && view.rows[0]?.[0] !== undefined) result.viewDefinition = scalar(view.rows[0], 0);
    }
    return result;
}
function nullsFirst(order: DatabaseOrderV1): boolean { return order.nulls ? order.nulls === 'first' : order.direction === 'asc'; }
function keysetPredicate(order: readonly DatabaseOrderV1[], cells: readonly DatabaseNamedCellV1[], statement: MysqlCompiledStatement, backward: boolean): string {
    return `(${order.map((item, index) => {
        const prior = order.slice(0, index).map(previous => {
            const cell = cells.find(value => value.column === previous.column)?.value;
            if (!cell) invalid('invalid_page_continuation');
            return `${quoteMysqlIdentifier(previous.column)} <=> ${bind(statement, cell)}`;
        });
        const cell = cells.find(value => value.column === item.column)?.value;
        if (!cell) invalid('invalid_page_continuation');
        const column = quoteMysqlIdentifier(item.column); const first = nullsFirst(item) !== backward;
        const after = cell.type === 'null' ? first ? `${column} IS NOT NULL` : 'FALSE'
            : `(${column} ${(item.direction === 'asc') !== backward ? '>' : '<'} ${bind(statement, cell)}${first ? '' : ` OR ${column} IS NULL`})`;
        return `(${[...prior, after].join(' AND ')})`;
    }).join(' OR ')})`;
}
export interface MysqlRowsReadPlan { statement: MysqlCompiledStatement; selected: string[]; output: string[]; order: DatabaseOrderV1[]; backward: boolean }
export function compileMysqlRowsRead(input: DatabaseRowsReadInputV1, metadata: DatabaseRelationStructureV1): MysqlRowsReadPlan {
    const selected = input.columns.length ? input.columns : metadata.columns.map(column => column.name);
    const order = [...input.order];
    for (const column of metadata.primaryKey) if (!order.some(item => item.column === column)) order.push({ column, direction: 'asc' });
    const output = [...selected];
    for (const column of [...metadata.primaryKey, ...order.map(item => item.column)]) if (!output.includes(column)) output.push(column);
    if (output.some(column => !metadata.columns.some(item => item.name === column))) invalid('unknown_column');
    const statement: MysqlCompiledStatement = { text: '', values: [] };
    const where = input.filter ? [compileMysqlFilter(input.filter, statement)] : [];
    const continuation = input.page.continuation;
    if (continuation && JSON.stringify(databaseRowsBindingV1(continuation.binding)) !== JSON.stringify(databaseRowsBindingV1(input))) invalid('invalid_page_continuation');
    if (continuation?.kind === 'keyset' && !metadata.primaryKey.length) invalid('invalid_page_continuation');
    const backward = continuation?.kind === 'keyset' && continuation.direction === 'backward';
    if (continuation?.kind === 'keyset') where.push(keysetPredicate(order, continuation.values, statement, backward));
    statement.text = `SELECT ${output.map(quoteMysqlIdentifier).join(',')} FROM ${qualified(input.relation)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    if (order.length) statement.text += ` ORDER BY ${order.map(item => `(${quoteMysqlIdentifier(item.column)} IS NULL) ${nullsFirst(item) !== backward ? 'DESC' : 'ASC'},${quoteMysqlIdentifier(item.column)} ${(item.direction === 'asc') !== backward ? 'ASC' : 'DESC'}`).join(',')}`;
    statement.text += ' LIMIT ?'; statement.values.push(input.page.rows + 1);
    if (continuation?.kind === 'offset') { statement.text += ' OFFSET ?'; statement.values.push(continuation.offset); }
    return { statement, selected, output, order, backward };
}
export function decodeMysqlRowsRead(input: DatabaseRowsReadInputV1, metadata: DatabaseRelationStructureV1, plan: MysqlRowsReadPlan, native: MysqlNativeResult): DatabaseRowsResultV1 {
    const decoded = decodeMysqlResult(native);
    const retained = decoded.rows.slice(0, input.page.rows);
    const named = (row: typeof retained[number], names: readonly string[]): DatabaseNamedCellV1[] => names.map(column => {
        const value = row.cells[plan.output.indexOf(column)]!;
        if (value.type === 'partial') throw new Error('Unexpected partial native MySQL cell');
        return { column, value };
    });
    const last = retained.at(-1); const binding = databaseRowsBindingV1(input);
    const continuation = metadata.primaryKey.length && last ? { kind: 'keyset' as const, binding, values: named(last, plan.order.map(item => item.column)), direction: plan.backward ? 'backward' as const : 'forward' as const }
        : { kind: 'offset' as const, binding, offset: (input.page.continuation?.kind === 'offset' ? input.page.continuation.offset : 0) + retained.length };
    return { columns: plan.selected.map(column => metadata.columns.find(item => item.name === column)!),
        rows: (plan.backward ? retained.reverse() : retained).map(row => ({ cells: plan.selected.map(column => row.cells[plan.output.indexOf(column)]!),
            ...(metadata.primaryKey.length ? { identity: { key: named(row, metadata.primaryKey), original: named(row, plan.output) } } : {}) })),
        completeness: decoded.rows.length > retained.length ? { complete: false, reason: 'page', continuation } : { complete: true } };
}
export function compileMysqlEdit(relation: DatabaseRelationV1, change: DatabaseEditV1, metadata: DatabaseRelationStructureV1): MysqlCompiledStatement {
    if (metadata.kind !== 'table') unavailable('relation_read_only');
    const capability = metadata.capabilities.find(item => item.operation === 'edits.apply');
    if (!capability?.available) unavailable(capability && !capability.available ? capability.reason : 'transactional_edit_unavailable');
    if (change.kind !== 'insert') {
        if (!metadata.primaryKey.length) unavailable('primary_key_required');
        if (change.key.length !== metadata.primaryKey.length || metadata.primaryKey.some(column => !change.key.some(item => item.column === column))) invalid('invalid_row_identity');
    }
    const statement: MysqlCompiledStatement = { text: '', values: [] };
    const write = (column: string, value: Extract<DatabaseEditV1, { kind: 'insert' }>['values'][number]['value']) => {
        const definition = metadata.columns.find(item => item.name === column);
        if (!definition || definition.generated) invalid('column_not_writable');
        return value.kind === 'default' ? 'DEFAULT' : bind(statement, value.cell);
    };
    if (change.kind === 'insert') {
        statement.text = change.values.length ? `INSERT INTO ${qualified(relation)} (${change.values.map(item => quoteMysqlIdentifier(item.column)).join(',')}) VALUES (${change.values.map(item => write(item.column, item.value)).join(',')})` : `INSERT INTO ${qualified(relation)} () VALUES ()`;
    } else {
        // Positional placeholders must be bound in text order: SET occurs before WHERE.
        const assignments = change.kind === 'update' ? change.values.map(item => `${quoteMysqlIdentifier(item.column)}=${write(item.column, item.value)}`) : [];
        const predicates = change.key.map(item => `${quoteMysqlIdentifier(item.column)} <=> ${bind(statement, item.value)}`);
        if (change.kind === 'update') for (const item of change.values) {
            const original = change.original.find(value => value.column === item.column);
            if (!original) invalid('missing_original_value');
            predicates.push(`${quoteMysqlIdentifier(item.column)} <=> ${bind(statement, original.value)}`);
        }
        statement.text = change.kind === 'update' ? `UPDATE ${qualified(relation)} SET ${assignments.join(',')} WHERE ${predicates.join(' AND ')}` : `DELETE FROM ${qualified(relation)} WHERE ${predicates.join(' AND ')}`;
    }
    return statement;
}
async function readCell(query: MysqlQuery, input: DatabaseCellReadInputV1): Promise<DatabaseOperationResultV1> {
    const metadata = await structure(query, input.relation);
    if (!metadata.primaryKey.length || input.key.length !== metadata.primaryKey.length || metadata.primaryKey.some(column => !input.key.some(item => item.column === column))) invalid('primary_key_required');
    const definition = metadata.columns.find(column => column.name === input.column);
    if (!definition) invalid('unknown_column');
    const binary = definition.semanticType === 'binary';
    if (input.range.unit !== (binary ? 'bytes' : 'utf8_bytes')) invalid('invalid_cell_range_unit');
    const column = quoteMysqlIdentifier(input.column);
    const bytes = binary ? `CAST(${column} AS BINARY)` : `CAST(CONVERT(${column} USING utf8mb4) AS BINARY)`;
    const statement: MysqlCompiledStatement = { text: '', values: [input.range.offset + 1, input.range.length] };
    const predicates = input.key.map(item => `${quoteMysqlIdentifier(item.column)} <=> ${bind(statement, item.value)}`);
    statement.text = `SELECT SUBSTRING(${bytes},?,?),OCTET_LENGTH(${bytes}) FROM ${qualified(input.relation)} WHERE ${predicates.join(' AND ')}`;
    const native = await query(statement); const row = native.rows[0];
    if (!row) unavailable('row_missing');
    if (row[0] === null) return { ok: true, operation: 'cell.read', value: { type: 'null' }, completeness: { complete: true } };
    if (!Buffer.isBuffer(row[0])) throw new Error('MySQL returned invalid byte-range data');
    let retained = row[0]; let value = ''; const total = Number(scalar(row, 1));
    if (!binary) {
        for (;;) {
            try { value = new TextDecoder('utf-8', { fatal: true }).decode(retained); break; }
            catch {
                if (!retained.length || (retained[0]! & 0xc0) === 0x80) invalid('invalid_cell_range_boundary');
                retained = retained.subarray(0, retained.length - 1);
            }
        }
        if (!retained.length && total > input.range.offset && input.range.length) invalid('cell_range_too_short_for_character');
    }
    if (input.range.offset === 0 && retained.length === total) return { ok: true, operation: 'cell.read',
        value: binary ? { type: 'binary', encoding: 'base64', value: retained.toString('base64') } : definition.semanticType === 'json' ? { type: 'json', value } : { type: 'text', value }, completeness: { complete: true } };
    const next = input.range.offset + retained.length;
    const range = { offset: input.range.offset, length: retained.length, total };
    const partial = binary
        ? { type: 'partial', valueType: 'binary', value: retained.toString('base64'), encoding: 'base64', range: { ...range, unit: 'bytes' } } as const
        : definition.semanticType === 'json'
            ? { type: 'partial', valueType: 'json', value, encoding: 'utf8', range: { ...range, unit: 'utf8_bytes' } } as const
            : { type: 'partial', valueType: 'text', value, encoding: 'utf8', range: { ...range, unit: 'utf8_bytes' } } as const;
    return { ok: true, operation: 'cell.read', value: partial,
        completeness: { complete: false, reason: 'page', ...(next < total ? { continuation: { kind: 'cell', input: { target: input.target, relation: input.relation, key: input.key, column: input.column, ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}) }, range: { offset: next, length: input.range.length, unit: input.range.unit, total } } } : {}) } };
}

/** Transport owns one enclosing transaction, cancellation and disposal. This owner compiles and decodes. */
export async function executeMysqlOperation(input: DatabaseOperationInputV1, query: MysqlQuery, options: MysqlExecutionOptions = {}): Promise<DatabaseOperationResultV1> {
    switch (input.operation) {
        case 'describe': return unavailable('Target descriptions belong to the selected-target resolver');
        case 'schemas.list': {
            const native = await query({ text: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') AND (? IS NULL OR LOCATE(?,SCHEMA_NAME)>0) AND (? IS NULL OR SCHEMA_NAME>?) ORDER BY SCHEMA_NAME LIMIT ?", values: [input.search ?? null, input.search ?? null, input.page.after ?? null, input.page.after ?? null, input.page.rows + 1] });
            const rows = native.rows.slice(0, input.page.rows);
            return { ok: true, operation: input.operation, schemas: rows.map(row => ({ name: scalar(row, 0) })), completeness: native.rows.length > rows.length ? { complete: false, reason: 'page', continuation: { kind: 'catalog', operation: input.operation, target: input.target, ...(input.database ? { database: input.database } : {}), ...(input.search ? { search: input.search } : {}), after: scalar(rows.at(-1)!, 0) } } : { complete: true } };
        }
        case 'relations.list': {
            const native = await query({ text: 'SELECT TABLE_NAME,TABLE_TYPE,CAST(TABLE_ROWS AS CHAR),CAST(DATA_LENGTH AS CHAR),CAST(INDEX_LENGTH AS CHAR),CAST(DATA_LENGTH+INDEX_LENGTH AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND (? IS NULL OR LOCATE(?,TABLE_NAME)>0) AND (? IS NULL OR TABLE_NAME>?) ORDER BY TABLE_NAME LIMIT ?', values: [input.schema, input.search ?? null, input.search ?? null, input.page.after ?? null, input.page.after ?? null, input.page.rows + 1] });
            const rows = native.rows.slice(0, input.page.rows);
            return { ok: true, operation: input.operation, relations: rows.map(row => ({ relation: { schema: input.schema, name: scalar(row, 0) }, kind: row[1] === 'VIEW' ? 'view' : 'table', ...(row[2] == null ? {} : { estimatedRows: scalar(row, 2) }),
                ...(row[5] == null ? {} : { size: statsSize({ table_bytes: row[3], index_bytes: row[4], size_bytes: row[5] }, 'table_bytes_estimate') }) })), completeness: native.rows.length > rows.length ? { complete: false, reason: 'page', continuation: { kind: 'catalog', operation: input.operation, target: input.target, schema: input.schema, ...(input.database ? { database: input.database } : {}), ...(input.search ? { search: input.search } : {}), after: scalar(rows.at(-1)!, 0) } } : { complete: true } };
        }
        case 'relation.structure': return { ok: true, operation: input.operation, structure: await structure(query, input.relation) };
        case 'rows.read': {
            const metadata = await structure(query, input.relation); const plan = compileMysqlRowsRead(input, metadata);
            return { ok: true, operation: input.operation, result: decodeMysqlRowsRead(input, metadata, plan, await query(plan.statement)) };
        }
        case 'statement.run': {
            const statements = (input.mode === 'read' ? [input.statement] : input.statements).map(statement => ({
                text: admitMysqlWorkbenchStatement(statement.sql, options), values: statement.parameters.map(mysqlParameter),
            }));
            const results: DatabaseStatementResultV1[] = [];
            for (const [statementIndex, statement] of statements.entries()) {
                try { results.push(decodeMysqlResult(await query(statement))); }
                catch (error) {
                    const cause = { ...mysqlFailureCause(error), statementIndex };
                    throw new MysqlOperationError({ ok: false, status: 'failed',
                        code: cause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause });
                }
            }
            return { ok: true, operation: input.operation, results };
        }
        case 'statement.explain': {
            const native = await query({ text: `EXPLAIN ${input.mode === 'analyze' ? 'ANALYZE ' : 'FORMAT=JSON '}${admitMysqlWorkbenchStatement(input.statement.sql, options)}`, values: input.statement.parameters.map(mysqlParameter) });
            return { ok: true, operation: input.operation, format: input.mode === 'analyze' ? 'text' : 'json', plan: native.rows.map(row => scalar(row, 0)).join('\n'), completeness: { complete: true } };
        }
        case 'edits.apply': {
            const metadata = await structure(query, input.relation);
            // Compile every change before the first mutation, using the one metadata result.
            const statements = input.changes.map(change => compileMysqlEdit(input.relation, change, metadata));
            let inserted = 0n; let updated = 0n; let deleted = 0n;
            for (const [index, statement] of statements.entries()) {
                const result = await query(statement); const change = input.changes[index]!;
                if (String(result.affectedRows) !== '1') {
                    if (String(result.affectedRows) === '0' && change.kind === 'update') {
                        const keyStatement: MysqlCompiledStatement = { text: '', values: [] };
                        const key = change.key.map(item => `${quoteMysqlIdentifier(item.column)} <=> ${bind(keyStatement, item.value)}`);
                        keyStatement.text = `SELECT 1 FROM ${qualified(input.relation)} WHERE ${key.join(' AND ')} LIMIT 1`;
                        const keyResult = await query(keyStatement);
                        throw new MysqlOperationError({ ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: index,
                            reason: keyResult.rows.length === 0 ? 'row_missing' : 'row_changed' });
                    }
                    throw new MysqlOperationError(String(result.affectedRows) === '0'
                        ? { ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: index, reason: change.kind === 'delete' ? 'row_missing' : 'row_changed' }
                        : { ok: false, status: 'failed', code: 'database_edit_row_count', reason: 'The edit did not affect exactly one row' });
                }
                if (change.kind === 'insert') inserted++; else if (change.kind === 'update') updated++; else deleted++;
            }
            return { ok: true, operation: input.operation, status: 'committed', inserted: String(inserted), updated: String(updated), deleted: String(deleted) };
        }
        case 'cell.read': return readCell(query, input);
        case 'stats.read': {
            if (!options.stats) return unavailable('Statistics require native connection setup facts');
            const plan = compileMysqlStatsV1(input.request);
            const resultSets: (readonly DatabaseStatsNativeRowV1[])[] = [];
            if (plan.status === 'compiled') for (const statement of plan.statements) {
                const native = await query({ text: statement.sql, values: [...statement.parameters] });
                resultSets.push(statsNativeRowsV1(native.fields, native.rows));
            }
            return statsOperationResultV1('mysql', input.request, plan, resultSets, options.stats);
        }
    }
}
