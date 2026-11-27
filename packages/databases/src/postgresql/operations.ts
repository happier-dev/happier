import type {
    DatabaseCellReadInputV1,
    DatabaseEditV1,
    DatabaseFailureCauseV1,
    DatabaseFailureV1,
    DatabaseFilterV1,
    DatabaseNamedCellV1,
    DatabaseIncomingForeignKeyV1,
    DatabaseOperationInputV1,
    DatabaseOperationResultV1,
    DatabaseOrderV1,
    DatabasePartialCellV1,
    DatabaseRelationStructureV1,
    DatabaseRelationV1,
    DatabaseRowsReadInputV1,
    DatabaseSemanticTypeV1,
    DatabaseStatementResultV1,
    DatabaseValueV1,
} from '@happier-dev/plugin-sdk/database';
import { admitPostgresqlWorkbenchStatement } from './statement.js';
import { fitDatabaseOperationResult } from '../resultEnvelope.js';
import { databaseRowsBindingV1 } from '../rows.js';
import { quotePostgresqlIdentifier } from './identifiers.js';
import { POSTGRESQL_STATISTICS_ENABLE_SQL_V1 } from './setup.js';
import { readPostgresqlIndexAdvice } from './indexAdvice.js';
import { compilePostgresqlStatsV1, type PostgresqlStatsCompilationV1 } from './stats.js';
import { statsNativeRowsV1, statsOperationResultV1, statsSize, type DatabaseStatsExecutionContextV1, type DatabaseStatsNativeRowV1 } from '../stats.js';
export { quotePostgresqlIdentifier } from './identifiers.js';

export interface PostgresqlNativeResult {
    fields: ReadonlyArray<{ name: string; dataTypeID: number }>;
    rows: ReadonlyArray<ReadonlyArray<string | null>>;
    command: string;
    rowCount: number | null;
}
export interface PostgresqlCompiledStatement {
    text: string;
    values: Array<string | boolean | Buffer | null>;
    /** PostgreSQL 16 handles unbound EXPLAIN GENERIC_PLAN placeholders in the simple protocol. */
    simpleProtocol?: true;
    /** Ordered projection for catalog transports that return records instead of positional rows. */
    resultFields?: PostgresqlNativeResult['fields'];
}
export type PostgresqlQuery = (statement: PostgresqlCompiledStatement) => Promise<PostgresqlNativeResult>;
export type PostgresqlExecutionOptions = Readonly<{
    stats?: DatabaseStatsExecutionContextV1 & PostgresqlStatsCompilationV1 & Readonly<{
        nativeBackendPid?: number;
    }>;
}>;

const schemaCatalogFields = [{ name: 'nspname', dataTypeID: 19 }] as const;
const relationCatalogFields = [
    { name: 'relname', dataTypeID: 19 },
    { name: 'relkind', dataTypeID: 18 },
    ...['estimated_rows', 'relation_bytes', 'table_bytes', 'index_bytes', 'size_bytes'].map(name => ({ name, dataTypeID: 25 })),
] as const;

export function postgresqlFailureCause(error: unknown): DatabaseFailureCauseV1 {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed';
    const position = error instanceof Error && 'position' in error && typeof error.position === 'string' ? Number(error.position) : undefined;
    return { source: /^[0-9A-Z]{5}$/.test(code) ? 'engine' : 'transport', code,
        message: error instanceof Error ? error.message : 'The database operation failed',
        ...(position !== undefined && Number.isSafeInteger(position) && position > 0 ? { position } : {}) };
}

/** PostgreSQL's stable built-in pg_type OIDs; extension/domain OIDs keep their native text. */
const builtinTypes: Readonly<Record<number, readonly [string, DatabaseSemanticTypeV1]>> = {
    16: ['bool', 'boolean'], 17: ['bytea', 'binary'], 18: ['char', 'text'], 19: ['name', 'text'],
    20: ['int8', 'integer'], 21: ['int2', 'integer'], 23: ['int4', 'integer'], 25: ['text', 'text'],
    26: ['oid', 'integer'], 114: ['json', 'json'], 700: ['float4', 'float'], 701: ['float8', 'float'],
    1042: ['bpchar', 'text'], 1043: ['varchar', 'text'], 1082: ['date', 'temporal'],
    1083: ['time', 'temporal'], 1114: ['timestamp', 'temporal'], 1184: ['timestamptz', 'temporal'],
    1186: ['interval', 'temporal'], 1266: ['timetz', 'temporal'], 1700: ['numeric', 'decimal'],
    2950: ['uuid', 'text'], 3802: ['jsonb', 'json'],
};

function qualified(relation: DatabaseRelationV1): string {
    return `${quotePostgresqlIdentifier(relation.schema)}.${quotePostgresqlIdentifier(relation.name)}`;
}
export function postgresqlParameter(value: DatabaseValueV1): string | boolean | Buffer | null {
    switch (value.type) {
        case 'null': return null;
        case 'binary': return Buffer.from(value.value, 'base64');
        case 'float': return String(value.value);
        default: return value.value;
    }
}
export function postgresqlSemanticType(oid: number): DatabaseSemanticTypeV1 {
    return builtinTypes[oid]?.[1] ?? 'unknown';
}
export function decodePostgresqlValue(value: string | null, oid: number, nativeType?: string): DatabaseValueV1 {
    if (value === null) return { type: 'null' };
    const [native, semantic] = builtinTypes[oid] ?? [nativeType ?? `oid:${oid}`, 'unknown'];
    switch (semantic) {
        case 'integer': return { type: 'integer', value };
        case 'decimal': return value === 'NaN' || value === 'Infinity' || value === '-Infinity'
            ? { type: 'float', value } : { type: 'decimal', value };
        case 'float': return { type: 'float', value: value === 'NaN' || value === 'Infinity' || value === '-Infinity' ? value : Number(value) };
        case 'boolean': return { type: 'boolean', value: value === 't' };
        case 'json': return { type: 'json', value };
        case 'binary': {
            let bytes: Buffer;
            if (value.startsWith('\\x')) bytes = Buffer.from(value.slice(2), 'hex');
            else {
                const decoded: number[] = [];
                for (let index = 0; index < value.length; index++) {
                    if (value[index] !== '\\') decoded.push(value.charCodeAt(index));
                    else if (value[index + 1] === '\\') { decoded.push(92); index++; }
                    else { decoded.push(Number.parseInt(value.slice(index + 1, index + 4), 8)); index += 3; }
                }
                bytes = Buffer.from(decoded);
            }
            return { type: 'binary', encoding: 'base64', value: bytes.toString('base64') };
        }
        case 'temporal': return { type: 'temporal', nativeType: nativeType ?? native, value };
        default: return { type: 'text', value };
    }
}
export function decodePostgresqlResult(result: PostgresqlNativeResult): DatabaseStatementResultV1 {
    return {
        columns: result.fields.map(field => ({ name: field.name,
            nativeType: builtinTypes[field.dataTypeID]?.[0] ?? `oid:${field.dataTypeID}`,
            semanticType: postgresqlSemanticType(field.dataTypeID) })),
        rows: result.rows.map(row => ({ cells: row.map((value, index) => decodePostgresqlValue(value, result.fields[index]!.dataTypeID)) })),
        command: result.command,
        ...(result.rowCount === null ? {} : { affectedRows: String(result.rowCount) }),
        completeness: { complete: true },
    };
}

export class PostgresqlOperationError extends Error {
    constructor(readonly failure: DatabaseFailureV1) { super(failure.code); this.name = 'PostgresqlOperationError'; }
}
function unavailable(reason: string): never {
    throw new PostgresqlOperationError({ ok: false, status: 'unavailable', code: 'database_operation_unavailable', reason });
}
function invalid(reason: string): never {
    throw new PostgresqlOperationError({ ok: false, status: 'failed', code: 'invalid_action_input', reason });
}
function scalar(row: ReadonlyArray<string | null>, index: number): string {
    const value = row[index];
    if (typeof value !== 'string') throw new Error('PostgreSQL returned invalid catalog metadata');
    return value;
}
function stringArray(value: string): string[] {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('PostgreSQL returned invalid catalog columns');
    return parsed;
}
function bind(statement: PostgresqlCompiledStatement, value: DatabaseValueV1): string {
    statement.values.push(postgresqlParameter(value));
    return `$${statement.values.length}`;
}
export function compilePostgresqlFilter(filter: DatabaseFilterV1, statement: PostgresqlCompiledStatement): string {
    switch (filter.kind) {
        case 'null': return `${quotePostgresqlIdentifier(filter.column)} IS ${filter.isNull ? '' : 'NOT '}NULL`;
        case 'not': return `(NOT ${compilePostgresqlFilter(filter.filter, statement)})`;
        case 'and': case 'or': return filter.filters.length
            ? `(${filter.filters.map(child => compilePostgresqlFilter(child, statement)).join(filter.kind === 'and' ? ' AND ' : ' OR ')})`
            : filter.kind === 'and' ? 'TRUE' : 'FALSE';
        case 'comparison': {
            const column = quotePostgresqlIdentifier(filter.column);
            const value = bind(statement, filter.value);
            if (filter.operator === 'contains') return `(strpos(${column}::text, ${value}::text) > 0)`;
            const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
            return `${column} ${operators[filter.operator]} ${value}`;
        }
    }
}

async function readRelationMetadata(query: PostgresqlQuery, relation: DatabaseRelationV1, options: {
    primaryOnly?: boolean; missing?: DatabaseFailureV1;
} = {}) {
    const identity = await query({ text: 'SELECT c.relkind,c.oid::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN (\'r\',\'p\',\'v\',\'m\')', values: [relation.schema, relation.name] });
    if (!identity.rows[0]) {
        if (options.missing) throw new PostgresqlOperationError(options.missing);
        unavailable('relation_missing');
    }
    const nativeKind = scalar(identity.rows[0], 0);
    const kind: DatabaseRelationStructureV1['kind'] = nativeKind === 'v' ? 'view' : nativeKind === 'm' ? 'materialized_view' : 'table';
    const columns = await query({ text: `SELECT a.attname, a.atttypid::text, pg_catalog.format_type(a.atttypid,a.atttypmod), a.attnotnull::text,
        pg_catalog.pg_get_expr(d.adbin,d.adrelid), (a.attgenerated<>'' OR a.attidentity='a')::text
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, values: [relation.schema, relation.name] });
    const indexes = await query({ text: `SELECT ci.relname,i.indisunique::text,i.indisprimary::text,
        (SELECT json_agg(pg_catalog.pg_get_indexdef(i.indexrelid,k,true) ORDER BY k)::text FROM generate_series(1,i.indnkeyatts) k),
        pg_catalog.pg_get_expr(i.indpred,i.indrelid),
        (SELECT json_agg(COALESCE(a.attname,'') ORDER BY ord)::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY u(num,ord) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.num WHERE ord<=i.indnkeyatts),
        (SELECT json_agg(CASE WHEN (i.indoption[k-1] & 1)=1 THEN 'desc' ELSE 'asc' END ORDER BY k)::text FROM generate_series(1,i.indnkeyatts) k)
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid WHERE n.nspname=$1 AND c.relname=$2${options.primaryOnly ? ' AND i.indisprimary' : ''} ORDER BY ci.relname`, values: [relation.schema, relation.name] });
    const primary = indexes.rows.find(row => scalar(row, 2) === 'true');
    return {
        oid: scalar(identity.rows[0], 1), kind,
        columns: columns.rows.map(row => ({ name: scalar(row, 0), nativeType: scalar(row, 2),
            semanticType: postgresqlSemanticType(Number(scalar(row, 1))), nullable: scalar(row, 3) !== 'true',
            defaultExpression: row[4] ?? null, generated: scalar(row, 5) === 'true' })),
        primaryKey: primary ? stringArray(scalar(primary, 5)) : [],
        indexes: indexes.rows,
    };
}

async function structure(query: PostgresqlQuery, relation: DatabaseRelationV1, options: {
    includeIncoming?: boolean; missing?: DatabaseFailureV1;
} = {}): Promise<DatabaseRelationStructureV1> {
    const { oid, kind, columns, primaryKey, indexes } = await readRelationMetadata(query, relation, options);
    // A source partition's copy of its parent's key describes the same rows as the parent's key.
    const incoming = options.includeIncoming && kind === 'table' ? `
        UNION ALL
        SELECT f.*,false FROM pg_catalog.pg_constraint f
        LEFT JOIN pg_catalog.pg_constraint parent ON parent.oid=f.conparentid
        WHERE f.contype='f' AND f.confrelid=$1::oid AND parent.confrelid IS DISTINCT FROM f.confrelid` : '';
    const foreign = await query({ text: `SELECT f.conname,n.nspname,c.relname,
        (SELECT json_agg(a.attname ORDER BY u.ord)::text FROM unnest(f.conkey) WITH ORDINALITY u(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=u.num),
        (SELECT json_agg(a.attname ORDER BY u.ord)::text FROM unnest(f.confkey) WITH ORDINALITY u(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=u.num),
        f.outgoing
        FROM (
            SELECT f.*,true AS outgoing FROM pg_catalog.pg_constraint f WHERE f.contype='f' AND f.conrelid=$1::oid
            ${incoming}
        ) f
        JOIN pg_catalog.pg_class c ON c.oid=CASE WHEN f.outgoing THEN f.confrelid ELSE f.conrelid END
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        ORDER BY f.conname,n.nspname,c.relname`, values: [oid] });
    const foreignKeys: Array<DatabaseRelationStructureV1['foreignKeys'][number]> = [];
    const incomingForeignKeys: DatabaseIncomingForeignKeyV1[] = [];
    for (const row of foreign.rows) {
        const name = scalar(row, 0);
        const peer = { schema: scalar(row, 1), name: scalar(row, 2) };
        const sourceColumns = stringArray(scalar(row, 3));
        const targetColumns = stringArray(scalar(row, 4));
        if (row[5] === 't') foreignKeys.push({ name, target: peer, columns: sourceColumns, targetColumns });
        else incomingForeignKeys.push({ name, source: peer, sourceColumns, targetColumns });
    }
    const result: DatabaseRelationStructureV1 = {
        relation, kind, columns, primaryKey,
        indexes: indexes.map(row => {
            const expressions = stringArray(scalar(row, 3)); const names = stringArray(scalar(row, 5)); const directions = stringArray(scalar(row, 6));
            return { name: scalar(row, 0), unique: scalar(row, 1) === 'true', primary: scalar(row, 2) === 'true',
                columns: expressions.map((expression, index) => ({ ...(names[index] ? { kind: 'column' as const, column: names[index]! } : { kind: 'expression' as const, expression }), direction: directions[index] === 'desc' ? 'desc' as const : 'asc' as const })),
                ...(row[4] === null ? {} : { predicate: scalar(row, 4) }) };
        }),
        foreignKeys, ...(options.includeIncoming ? { incomingForeignKeys } : {}),
        capabilities: [{ operation: 'rows.read', available: true },
            kind === 'table' ? { operation: 'edits.apply', available: true } : { operation: 'edits.apply', available: false, code: 'database_relation_read_only', reason: 'Views are read-only in the workbench' }],
    };
    if (kind !== 'table') {
        const definition = await query({ text: 'SELECT pg_catalog.pg_get_viewdef($1::regclass,true)', values: [qualified(relation)] });
        return { ...result, viewDefinition: scalar(definition.rows[0]!, 0) };
    }
    return result;
}

function keysetPredicate(order: readonly DatabaseOrderV1[], values: readonly DatabaseNamedCellV1[], statement: PostgresqlCompiledStatement, backward: boolean): string {
    const prior: string[] = [];
    const alternatives: string[] = [];
    for (const item of order) {
        const cell = values.find(value => value.column === item.column)?.value;
        if (!cell) invalid('invalid_page_continuation');
        const column = quotePostgresqlIdentifier(item.column);
        const value = bind(statement, cell);
        const ascending = (item.direction === 'asc') !== backward;
        const nullsFirst = (item.nulls === 'first' || (!item.nulls && item.direction === 'desc')) !== backward;
        const after = cell.type === 'null' ? (nullsFirst ? `${column} IS NOT NULL` : 'FALSE')
            : `(${column} ${ascending ? '>' : '<'} ${value}${nullsFirst ? '' : ` OR ${column} IS NULL`})`;
        alternatives.push(`(${[...prior, after].join(' AND ')})`);
        prior.push(`${column} IS NOT DISTINCT FROM ${value}`);
    }
    return `(${alternatives.join(' OR ')})`;
}
async function readRows(query: PostgresqlQuery, input: DatabaseRowsReadInputV1): Promise<DatabaseOperationResultV1> {
    const metadata = await readRelationMetadata(query, input.relation, { primaryOnly: true });
    const selected = input.columns.length ? input.columns : metadata.columns.map(column => column.name);
    const order = [...input.order];
    for (const column of metadata.primaryKey) if (!order.some(item => item.column === column)) order.push({ column, direction: 'asc' });
    const output = [...selected];
    for (const column of [...metadata.primaryKey, ...order.map(item => item.column)]) if (!output.includes(column)) output.push(column);
    const known = new Set(metadata.columns.map(column => column.name));
    if (output.some(column => !known.has(column))) invalid('unknown_column');
    const statement: PostgresqlCompiledStatement = { text: '', values: [] };
    const where: string[] = input.filter ? [compilePostgresqlFilter(input.filter, statement)] : [];
    const continuation = input.page.continuation;
    if (continuation && JSON.stringify(databaseRowsBindingV1(continuation.binding)) !== JSON.stringify(databaseRowsBindingV1(input))) invalid('invalid_page_continuation');
    const backward = continuation?.kind === 'keyset' && continuation.direction === 'backward';
    if (continuation?.kind === 'keyset') where.push(keysetPredicate(order, continuation.values, statement, backward));
    statement.text = `SELECT ${output.map(quotePostgresqlIdentifier).join(',')} FROM ${qualified(input.relation)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    if (order.length) statement.text += ` ORDER BY ${order.map(item => `${quotePostgresqlIdentifier(item.column)} ${(item.direction === 'asc') !== backward ? 'ASC' : 'DESC'} NULLS ${(item.nulls === 'first' || (!item.nulls && item.direction === 'desc')) !== backward ? 'FIRST' : 'LAST'}`).join(',')}`;
    statement.values.push(String(input.page.rows + 1)); statement.text += ` LIMIT $${statement.values.length}`;
    if (continuation?.kind === 'offset') { statement.values.push(String(continuation.offset)); statement.text += ` OFFSET $${statement.values.length}`; }
    const native = await query(statement);
    const decoded = decodePostgresqlResult(native);
    const more = decoded.rows.length > input.page.rows;
    const retained = decoded.rows.slice(0, input.page.rows);
    const last = retained.at(-1);
    const named = (row: typeof retained[number], names: readonly string[]): DatabaseNamedCellV1[] => names.map(column => {
        const value = row.cells[output.indexOf(column)]!;
        if (value.type === 'partial') throw new Error('Unexpected partial native cell');
        return { column, value };
    });
    const binding = databaseRowsBindingV1(input);
    const next = metadata.primaryKey.length && last ? { kind: 'keyset' as const, binding, values: named(last, order.map(item => item.column)), direction: backward ? 'backward' as const : 'forward' as const }
        : { kind: 'offset' as const, binding, offset: (continuation?.kind === 'offset' ? continuation.offset : 0) + retained.length };
    return { ok: true, operation: 'rows.read', result: {
        columns: selected.map(column => metadata.columns.find(item => item.name === column)!),
        rows: (backward ? retained.reverse() : retained).map(row => ({ cells: selected.map(column => row.cells[output.indexOf(column)]!),
            ...(metadata.primaryKey.length ? { identity: { key: named(row, metadata.primaryKey), original: named(row, output) } } : {}) })),
        completeness: more ? { complete: false, reason: 'page', continuation: next } : { complete: true },
    } };
}

async function readCell(query: PostgresqlQuery, input: DatabaseCellReadInputV1): Promise<DatabaseOperationResultV1> {
    const metadata = await readRelationMetadata(query, input.relation, { primaryOnly: true });
    if (!metadata.primaryKey.length || input.key.length !== metadata.primaryKey.length
        || metadata.primaryKey.some(column => !input.key.some(item => item.column === column))) invalid('primary_key_required');
    const definition = metadata.columns.find(column => column.name === input.column);
    if (!definition) invalid('unknown_column');
    const binary = definition.semanticType === 'binary';
    if (input.range.unit !== (binary ? 'bytes' : 'utf8_bytes')) invalid('invalid_cell_range_unit');
    const statement: PostgresqlCompiledStatement = { text: '', values: [] };
    const key = input.key.map(item => `${quotePostgresqlIdentifier(item.column)} IS NOT DISTINCT FROM ${bind(statement, item.value)}`);
    const column = quotePostgresqlIdentifier(input.column);
    const bytes = binary ? column : `convert_to(${column}::text,'UTF8')`;
    statement.values.push(String(BigInt(input.range.offset) + 1n)); const offset = `$${statement.values.length}`;
    statement.values.push(String(input.range.length)); const length = `$${statement.values.length}`;
    // PostgreSQL substring accepts int32 operands; a caller's larger demand still covers the actual value.
    statement.text = `SELECT substring(${bytes} FROM LEAST(${offset}::numeric,octet_length(${bytes})::numeric+1)::integer FOR LEAST(${length}::numeric,octet_length(${bytes}))::integer),octet_length(${bytes})::text FROM ${qualified(input.relation)} WHERE ${key.join(' AND ')}`;
    const result = await query(statement);
    if (!result.rows[0]) unavailable('row_missing');
    const raw = result.rows[0][0];
    if (raw === null) return { ok: true, operation: 'cell.read', value: { type: 'null' }, completeness: { complete: true } };
    const decoded = decodePostgresqlValue(scalar(result.rows[0], 0), 17);
    if (decoded.type !== 'binary') throw new Error('PostgreSQL returned invalid binary metadata');
    let retained = Buffer.from(decoded.value, 'base64');
    let value = '';
    if (!binary) {
        // A byte demand can end inside a UTF-8 scalar. Return the complete prefix and continue at its byte boundary.
        for (;;) {
            try { value = new TextDecoder('utf-8', { fatal: true }).decode(retained); break; }
            catch {
                if (!retained.length || (retained[0]! & 0xc0) === 0x80) invalid('invalid_cell_range_boundary');
                retained = retained.subarray(0, retained.length - 1);
            }
        }
        if (!retained.length && Number(scalar(result.rows[0], 1)) > input.range.offset && input.range.length) invalid('cell_range_too_short_for_character');
    }
    const total = Number(scalar(result.rows[0], 1));
    const complete = input.range.offset === 0 && retained.length === total;
    if (complete) {
        const native = binary ? { type: 'binary' as const, encoding: 'base64' as const, value: retained.toString('base64') }
            : definition.semanticType === 'json' ? { type: 'json' as const, value } : { type: 'text' as const, value };
        return { ok: true, operation: 'cell.read', value: native, completeness: { complete: true } };
    }
    const range = { offset: input.range.offset, length: retained.length, unit: input.range.unit, total };
    const nextOffset = input.range.offset + retained.length;
    const partial: DatabasePartialCellV1 = binary
        ? { type: 'partial', valueType: 'binary', value: retained.toString('base64'), encoding: 'base64', range: { ...range, unit: 'bytes' } }
        : definition.semanticType === 'json'
            ? { type: 'partial', valueType: 'json', value, encoding: 'utf8', range: { ...range, unit: 'utf8_bytes' } }
            : { type: 'partial', valueType: 'text', value, encoding: 'utf8', range: { ...range, unit: 'utf8_bytes' } };
    return { ok: true, operation: 'cell.read',
        value: partial,
        completeness: { complete: false, reason: 'page', ...(nextOffset < total ? { continuation: { kind: 'cell',
            input: { target: input.target, relation: input.relation, key: input.key, column: input.column,
                ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}) },
            range: { offset: nextOffset, length: input.range.length, unit: input.range.unit, total } } } : {}) },
    };
}

function compileEdit(relation: DatabaseRelationV1, change: DatabaseEditV1, metadata: DatabaseRelationStructureV1): PostgresqlCompiledStatement {
    const statement: PostgresqlCompiledStatement = { text: '', values: [] };
    if (change.kind !== 'insert') {
        if (!metadata.primaryKey.length) unavailable('primary_key_required');
        if (change.key.length !== metadata.primaryKey.length || metadata.primaryKey.some(column => !change.key.some(item => item.column === column))) invalid('invalid_row_identity');
    }
    const write = (column: string, value: Extract<DatabaseEditV1, { kind: 'insert' }>['values'][number]['value']) => {
        const definition = metadata.columns.find(item => item.name === column);
        if (!definition || definition.generated) invalid('column_not_writable');
        return value.kind === 'default' ? 'DEFAULT' : bind(statement, value.cell);
    };
    if (change.kind === 'insert') {
        statement.text = change.values.length ? `INSERT INTO ${qualified(relation)} (${change.values.map(item => quotePostgresqlIdentifier(item.column)).join(',')}) VALUES (${change.values.map(item => write(item.column, item.value)).join(',')})` : `INSERT INTO ${qualified(relation)} DEFAULT VALUES`;
    } else {
        const predicates = change.key.map(item => `${quotePostgresqlIdentifier(item.column)} IS NOT DISTINCT FROM ${bind(statement, item.value)}`);
        if (change.kind === 'update') {
            for (const item of change.values) {
                const original = change.original.find(value => value.column === item.column);
                if (!original) invalid('missing_original_value');
                const definition = metadata.columns.find(value => value.name === item.column);
                const column = quotePostgresqlIdentifier(item.column);
                // JSON and unsupported native types (for example XML) may lack equality; compare their original native text.
                predicates.push(definition?.nativeType === 'json' || definition?.semanticType === 'unknown'
                    ? `${column}::text IS NOT DISTINCT FROM ${bind(statement, original.value)}::text`
                    : `${column} IS NOT DISTINCT FROM ${bind(statement, original.value)}`);
            }
            statement.text = `UPDATE ${qualified(relation)} SET ${change.values.map(item => `${quotePostgresqlIdentifier(item.column)}=${write(item.column, item.value)}`).join(',')} WHERE ${predicates.join(' AND ')}`;
        } else statement.text = `DELETE FROM ${qualified(relation)} WHERE ${predicates.join(' AND ')}`;
    }
    return statement;
}

/** Dialect semantics operate on native frames, independent of network/container transport. */
async function executeDialectOperation(input: DatabaseOperationInputV1, query: PostgresqlQuery, options: PostgresqlExecutionOptions): Promise<DatabaseOperationResultV1> {
    switch (input.operation) {
        case 'describe': return unavailable('Target descriptions belong to the selected-target resolver');
        case 'activity.cancel': {
            // Select the same query on the same database before sending the signal. A PID alone can be reused.
            const result = await query({ text: `SELECT pg_catalog.pg_cancel_backend(a.pid) AS signalled
                FROM pg_catalog.pg_stat_activity a
                WHERE a.datname = current_database() AND a.pid = $1::integer
                    AND a.query_start = $2::timestamptz AND a.state = 'active' AND a.pid <> pg_catalog.pg_backend_pid()`,
                values: [input.activityKey, input.queryStartedAt] });
            const row = result.rows[0];
            return { ok: true, operation: input.operation, status: !row ? 'activity_ended' : row[0] === 't' ? 'signal_sent' : 'signal_failed' };
        }
        case 'stats.enable': {
            if (input.target.kind !== 'managed_deployment' && input.target.kind !== 'manual') {
                return unavailable('statistics_setup_requires_target_support');
            }
            const setup = (await query({ text: POSTGRESQL_STATISTICS_ENABLE_SQL_V1.probe, values: [] })).rows[0];
            if (setup?.[0] !== 't') return { ok: true, operation: input.operation, status: 'restart_required' };
            if (setup[1] !== 't') await query({ text: POSTGRESQL_STATISTICS_ENABLE_SQL_V1.install, values: [] });
            return { ok: true, operation: input.operation, status: 'enabled' };
        }
        case 'stats.read': {
            if (!options.stats) return unavailable('Statistics require native connection setup facts');
            if (input.request.group === 'indexAdvice') return readPostgresqlIndexAdvice(input.request, query, options.stats);
            const plan = compilePostgresqlStatsV1(input.request, options.stats);
            const resultSets: (readonly DatabaseStatsNativeRowV1[])[] = [];
            if (plan.status === 'compiled') for (const statement of plan.statements) {
                const native = await query({ text: statement.sql, values: statement.parameters.map(String) });
                resultSets.push(statsNativeRowsV1(native.fields, native.rows));
            }
            return statsOperationResultV1('postgresql', input.request, plan, resultSets, options.stats);
        }
        case 'schemas.list': {
            const native = await query({ text: "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND ($1::text IS NULL OR strpos(nspname,$1)>0) AND ($2::text IS NULL OR nspname>$2) ORDER BY nspname LIMIT $3",
                values: [input.search ?? null, input.page.after ?? null, String(input.page.rows + 1)],
                resultFields: schemaCatalogFields });
            const rows = native.rows.slice(0, input.page.rows);
            return { ok: true, operation: input.operation, schemas: rows.map(row => ({ name: scalar(row, 0) })), completeness: native.rows.length > rows.length
                ? { complete: false, reason: 'page', continuation: { kind: 'catalog', operation: input.operation, target: input.target, ...(input.database ? { database: input.database } : {}), ...(input.search ? { search: input.search } : {}), after: scalar(rows.at(-1)!, 0) } } : { complete: true } };
        }
        case 'relations.list': {
            const native = await query({ text: `SELECT c.relname,c.relkind,CASE WHEN c.reltuples>=0 THEN c.reltuples::bigint::text END AS estimated_rows,
                CASE WHEN c.relkind<>'v' THEN pg_catalog.pg_relation_size(c.oid)::text END AS relation_bytes,
                CASE WHEN c.relkind<>'v' THEN pg_catalog.pg_table_size(c.oid)::text END AS table_bytes,
                CASE WHEN c.relkind<>'v' THEN pg_catalog.pg_indexes_size(c.oid)::text END AS index_bytes,
                CASE WHEN c.relkind<>'v' THEN pg_catalog.pg_total_relation_size(c.oid)::text END AS size_bytes
                FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m') AND ($2::text IS NULL OR strpos(c.relname,$2)>0) AND ($3::text IS NULL OR c.relname>$3) ORDER BY c.relname LIMIT $4`,
                values: [input.schema, input.search ?? null, input.page.after ?? null, String(input.page.rows + 1)],
                resultFields: relationCatalogFields });
            const rows = native.rows.slice(0, input.page.rows);
            return { ok: true, operation: input.operation, relations: rows.map(row => ({ relation: { schema: input.schema, name: scalar(row, 0) }, kind: row[1] === 'v' ? 'view' : row[1] === 'm' ? 'materialized_view' : 'table',
                ...(row[2] == null ? {} : { estimatedRows: scalar(row, 2) }),
                ...(row[6] == null ? {} : { size: statsSize({ relation_bytes: row[3], table_bytes: row[4], index_bytes: row[5], size_bytes: row[6] }, 'database_bytes') }) })), completeness: native.rows.length > rows.length
                ? { complete: false, reason: 'page', continuation: { kind: 'catalog', operation: input.operation, target: input.target, schema: input.schema, ...(input.database ? { database: input.database } : {}), ...(input.search ? { search: input.search } : {}), after: scalar(rows.at(-1)!, 0) } } : { complete: true } };
        }
        case 'relation.structure': return { ok: true, operation: input.operation, structure: await structure(query, input.relation, { includeIncoming: true }) };
        case 'rows.read': return readRows(query, input);
        case 'statement.run': {
            const statements = input.mode === 'read' ? [input.statement] : input.statements;
            const results: DatabaseStatementResultV1[] = [];
            for (const [statementIndex, statement] of statements.entries()) {
                const text = admitPostgresqlWorkbenchStatement(statement.sql);
                try {
                    results.push(decodePostgresqlResult(await query({ text, values: statement.parameters.map(postgresqlParameter) })));
                } catch (error) {
                    if (error instanceof PostgresqlOperationError) throw error;
                    const cause = { ...postgresqlFailureCause(error), statementIndex };
                    throw new PostgresqlOperationError({ ok: false, status: 'failed',
                        code: cause.source === 'engine' ? 'database_engine_error' : 'database_transport_error', cause });
                }
            }
            return { ok: true, operation: input.operation, results };
        }
        case 'statement.explain': {
            const text = `EXPLAIN (${input.mode === 'analyze' ? 'ANALYZE, ' : ''}FORMAT TEXT) ${admitPostgresqlWorkbenchStatement(input.statement.sql)}`;
            const plan = await query({ text, values: input.statement.parameters.map(postgresqlParameter) });
            return { ok: true, operation: input.operation, format: 'text', plan: plan.rows.map(row => scalar(row, 0)).join('\n'), completeness: { complete: true } };
        }
        case 'edits.apply': {
            const metadata = await structure(query, input.relation, { missing: { ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: 0, reason: 'relation_changed' } });
            if (metadata.kind !== 'table') unavailable('relation_read_only');
            let inserted = 0n; let updated = 0n; let deleted = 0n;
            for (const [changeIndex, change] of input.changes.entries()) {
                const result = await query(compileEdit(input.relation, change, metadata));
                if (result.rowCount !== 1) {
                    if (result.rowCount === 0 && change.kind === 'update') {
                        const keyStatement: PostgresqlCompiledStatement = { text: '', values: [] };
                        const key = change.key.map(item => `${quotePostgresqlIdentifier(item.column)} IS NOT DISTINCT FROM ${bind(keyStatement, item.value)}`);
                        keyStatement.text = `SELECT 1 FROM ${qualified(input.relation)} WHERE ${key.join(' AND ')} LIMIT 1`;
                        const keyResult = await query(keyStatement);
                        throw new PostgresqlOperationError({ ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex,
                            reason: keyResult.rows.length === 0 ? 'row_missing' : 'row_changed' });
                    }
                    throw new PostgresqlOperationError(result.rowCount === 0
                        ? { ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex, reason: change.kind === 'delete' ? 'row_missing' : 'row_changed' }
                        : { ok: false, status: 'failed', code: 'database_edit_row_count', reason: 'The edit did not affect exactly one row' });
                }
                if (change.kind === 'insert') inserted++; else if (change.kind === 'update') updated++; else deleted++;
            }
            return { ok: true, operation: input.operation, status: 'committed', inserted: String(inserted), updated: String(updated), deleted: String(deleted) };
        }
        case 'cell.read': return readCell(query, input);
    }
}

export async function executePostgresqlOperation(input: DatabaseOperationInputV1, query: PostgresqlQuery, options: PostgresqlExecutionOptions = {}): Promise<DatabaseOperationResultV1> {
    return fitDatabaseOperationResult(input, await executeDialectOperation(input, query, options));
}
