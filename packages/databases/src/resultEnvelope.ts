import type {
    DatabaseCellV1, DatabaseCompletenessV1, DatabaseContinuationV1, DatabaseOperationInputV1,
    DatabaseOperationResultV1, DatabasePartialCellV1, DatabaseRowV1, DatabaseRowsReadInputV1,
    DatabaseRowsResultV1, DatabaseReadStatementInputV1, DatabaseValueRangeV1,
} from '@happier-dev/database-protocol';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import { databaseRowsBindingV1 } from './rows.js';

// Entries are typed JSON; measure their spelling without rebuilding the whole
// Action framing for each item. The canonical owner still measures acceptance.
const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const unavailable: DatabaseOperationResultV1 = {
    ok: false, status: 'failed', code: 'database_response_envelope',
    reason: 'The result metadata exceeds the Action response envelope. Request fewer columns or a smaller value range.',
};

function incomplete(continuation?: DatabaseContinuationV1): DatabaseCompletenessV1 {
    return continuation ? { complete: false, reason: 'response_envelope', continuation }
        : { complete: false, reason: 'response_envelope' };
}

type ReadWindow = NonNullable<NonNullable<DatabaseReadStatementInputV1['demand']>['window']>;

function rerun(input: DatabaseReadStatementInputV1, window: ReadWindow, rows = 0): Extract<DatabaseContinuationV1, { kind: 'rerun' }> {
    return { kind: 'rerun', snapshot: false, input: 'original', demand: { rows: Math.max(input.demand?.rows ?? 0, rows) + 1, window } };
}

function readRowOffset(input: DatabaseReadStatementInputV1): number {
    const window = input.demand?.window;
    return window?.kind === 'rows' ? window.offset : window?.kind === 'cell' ? window.row : 0;
}

function readCellContinuation(input: DatabaseReadStatementInputV1, cell: DatabasePartialCellV1, column: number): DatabaseContinuationV1 | undefined {
    const offset = cell.range.offset + cell.range.length;
    if (cell.range.total === undefined || offset >= cell.range.total) return undefined;
    const window = input.demand?.window;
    return rerun(input, { kind: 'cell', row: readRowOffset(input), column: window?.kind === 'cell' ? window.column : column,
        range: { offset, length: cell.range.total - offset, unit: cell.range.unit } });
}

function sliceReadCell(cell: DatabaseCellV1, range: DatabaseValueRangeV1): DatabaseCellV1 | string {
    const kind = cell.type === 'partial' ? cell.valueType : cell.type;
    if (kind !== 'text' && kind !== 'json' && kind !== 'binary') return cell;
    if (!('value' in cell) || typeof cell.value !== 'string') return cell;
    const binary = kind === 'binary';
    if (range.unit !== (binary ? 'bytes' : 'utf8_bytes')) return 'invalid_cell_range_unit';
    const bytes = Buffer.from(cell.value, binary ? 'base64' : 'utf8');
    const offset = Math.min(range.offset, bytes.length);
    let end = Math.min(offset + range.length, bytes.length);
    if (!binary) {
        if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) return 'invalid_cell_range_boundary';
        while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    const retained = bytes.subarray(offset, end);
    const span = { offset, length: retained.length, total: bytes.length };
    return binary
        ? { type: 'partial', valueType: 'binary', encoding: 'base64', value: retained.toString('base64'), range: { ...span, unit: 'bytes' } }
        : kind === 'json'
            ? { type: 'partial', valueType: 'json', encoding: 'utf8', value: retained.toString('utf8'), range: { ...span, unit: 'utf8_bytes' } }
            : { type: 'partial', valueType: 'text', encoding: 'utf8', value: retained.toString('utf8'), range: { ...span, unit: 'utf8_bytes' } };
}

/** Window projection precedes the transport check, including for small replies. */
function projectRead(input: DatabaseReadStatementInputV1,
    result: Extract<DatabaseOperationResultV1, { ok: true; operation: 'statement.run' }>): DatabaseOperationResultV1 {
    if (!input.demand) return result;
    const projected: Array<(typeof result.results)[number]> = [];
    for (const native of result.results) {
        const window = input.demand.window;
        if (window?.kind === 'cell') {
            const column = native.columns[window.column];
            const original = native.rows[window.row]?.cells[window.column];
            if (!column || !original) return { ok: false, status: 'failed', code: 'invalid_action_input', reason: column ? 'row_missing' : 'unknown_column' };
            const cell = sliceReadCell(original, window.range);
            if (typeof cell === 'string') return { ok: false, status: 'failed', code: 'invalid_action_input', reason: cell };
            const next = cell.type === 'partial' ? readCellContinuation(input, cell, window.column) : undefined;
            projected.push({ ...native, columns: [column], rows: [{ cells: [cell] }],
                completeness: { complete: false, reason: 'page', ...(next ? { continuation: next } : {}) } });
        } else {
            const offset = window?.offset ?? 0;
            const rows = native.rows.slice(offset, offset + input.demand.rows);
            projected.push({ ...native, rows, completeness: offset + rows.length < native.rows.length
                ? { complete: false, reason: 'page', continuation: rerun(input, { kind: 'rows', offset: offset + rows.length }) }
                : native.completeness });
        }
    }
    return { ...result, results: projected };
}

function rowsContinuation(input: DatabaseRowsReadInputV1, result: DatabaseRowsResultV1, count: number): DatabaseContinuationV1 | undefined {
    const binding = databaseRowsBindingV1(input);
    const last = result.rows[count - 1];
    if (last?.identity) {
        const values = [...last.identity.key];
        for (const order of input.order) {
            if (values.some(value => value.column === order.column)) continue;
            const cell = last.cells[result.columns.findIndex(column => column.name === order.column)];
            const value = cell && cell.type !== 'partial' ? { column: order.column, value: cell }
                : last.identity.original.find(value => value.column === order.column);
            if (!value) return undefined;
            values.push(value);
        }
        return { kind: 'keyset', binding, values, direction: input.page.continuation?.kind === 'keyset' ? input.page.continuation.direction : 'forward' };
    }
    const previous = input.page.continuation;
    if (previous?.kind === 'keyset') return count === 0 ? previous : undefined;
    return { kind: 'offset', binding, offset: (previous?.offset ?? 0) + count };
}

function continuation(input: DatabaseOperationInputV1, result: DatabaseRowsResultV1, count: number): DatabaseContinuationV1 | undefined {
    if (input.operation === 'rows.read') return rowsContinuation(input, result, count);
    if (input.operation === 'statement.run' && input.mode === 'read') {
        return rerun(input, { kind: 'rows', offset: readRowOffset(input) + count }, Math.max(result.rows.length, count));
    }
    return undefined;
}

/** Ranges use native bytes; JSON escaping is measured separately by the envelope owner. */
function cellSlicer(cell: DatabaseCellV1): { length: number; bytes: number; slice: (length: number) => DatabasePartialCellV1 } | undefined {
    const kind = cell.type === 'partial' ? cell.valueType : cell.type;
    if (kind !== 'text' && kind !== 'json' && kind !== 'binary') return undefined;
    if (!('value' in cell) || typeof cell.value !== 'string') return undefined;
    const originalRange = cell.type === 'partial' ? cell.range : undefined;
    const offset = originalRange?.offset ?? 0;
    if (kind === 'binary') {
        const bytes = Buffer.from(cell.value, 'base64');
        const total = originalRange ? originalRange.total : offset + bytes.byteLength;
        return { length: bytes.byteLength, bytes: serializedBytes(cell.value) - 2, slice: length => {
            const retained = bytes.subarray(0, length);
            return { type: 'partial', valueType: 'binary', encoding: 'base64', value: retained.toString('base64'),
                range: { offset, length: retained.byteLength, unit: 'bytes', ...(total !== undefined ? { total } : {}) } };
        } };
    }
    // Search is in UTF-16 units but never split a surrogate pair.
    const source = cell.value;
    const total = originalRange ? originalRange.total : offset + Buffer.byteLength(source);
    return { length: source.length, bytes: serializedBytes(source) - 2, slice: length => {
        let end = Math.min(length, source.length);
        if (end > 0 && end < source.length && source.charCodeAt(end - 1) >= 0xD800 && source.charCodeAt(end - 1) <= 0xDBFF) end -= 1;
        const value = source.slice(0, end);
        return { type: 'partial', valueType: kind, encoding: 'utf8', value,
            range: { offset, length: Buffer.byteLength(value), unit: 'utf8_bytes', ...(total !== undefined ? { total } : {}) } };
    } };
}

function remainingCell(input: DatabaseOperationInputV1, cell: DatabasePartialCellV1, row?: DatabaseRowV1, column?: string,
    source?: DatabaseCellV1, columnIndex?: number): DatabaseContinuationV1 | undefined {
    const end = cell.range.total ?? (source?.type === 'partial' ? source.range.offset + source.range.length : cell.range.offset + cell.range.length);
    const range = { ...cell.range, offset: cell.range.offset + cell.range.length,
        length: end - cell.range.offset - cell.range.length };
    if (input.operation === 'cell.read') {
        const { operation: _operation, range: _range, ...operand } = input;
        return { kind: 'cell', input: operand, range };
    }
    if (input.operation === 'rows.read' && row?.identity && column) {
        return { kind: 'cell', input: { target: input.target, relation: input.relation, key: row.identity.key, column,
            ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}) }, range };
    }
    if (input.operation === 'statement.run' && input.mode === 'read' && columnIndex !== undefined) return readCellContinuation(input, cell, columnIndex);
    return undefined;
}

function fitCell(cell: DatabaseCellV1, build: (cell: DatabasePartialCellV1) => DatabaseOperationResultV1): DatabaseOperationResultV1 | undefined {
    const slicer = cellSlicer(cell);
    if (!slicer) return undefined;
    const empty = build(slicer.slice(0));
    const available = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - measureExternalActionResultResponseEnvelopeUtf8BytesV1(empty);
    if (available < 0) return undefined;
    // Estimate from the actual escaped value. A strongly escaped prefix halves
    // before the measured overage could discard the whole slice. The canonical
    // envelope measurement decides acceptance.
    let length = Math.min(slicer.length, Math.floor(slicer.length * available / Math.max(1, slicer.bytes)));
    for (;;) {
        const candidate = build(slicer.slice(length));
        const overage = measureExternalActionResultResponseEnvelopeUtf8BytesV1(candidate) - EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES;
        if (overage <= 0) return candidate;
        if (length === 0) return undefined;
        length -= Math.min(overage, Math.ceil(length / 2));
    }
}

function fitList<T>(items: T[], build: (items: T[], last: T | undefined) => DatabaseOperationResultV1,
    fixedFramingBytes?: number): DatabaseOperationResultV1 {
    let bytes = 0;
    let retained = 0;
    for (const item of items) {
        const nextBytes = bytes + serializedBytes(item) + (retained > 0 ? 1 : 0);
        const framingBytes = fixedFramingBytes ?? measureExternalActionResultResponseEnvelopeUtf8BytesV1(build([], item));
        if (framingBytes + nextBytes > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) break;
        bytes = nextBytes;
        retained += 1;
    }
    if (retained === 0 && items.length > 0) return unavailable;
    const result = build(items.slice(0, retained), items[retained - 1]);
    return isExternalActionResultWithinResponseEnvelopeLimitV1(result) ? result : unavailable;
}

function fitPartialRow(input: DatabaseOperationInputV1, result: DatabaseRowsResultV1, row: DatabaseRowV1,
    build: (result: DatabaseRowsResultV1) => DatabaseOperationResultV1): DatabaseOperationResultV1 | undefined {
    const candidates = row.cells.flatMap((cell, index) => {
        const slicer = cellSlicer(cell);
        return slicer ? [{ index, slicer }] : [];
    }).sort((left, right) => right.slicer.bytes - left.slicer.bytes);
    const selected: typeof candidates = [];
    const lengths = new Map<number, number>();
    const render = () => {
        const cells = [...row.cells];
        for (const { index, slicer } of selected) cells[index] = slicer.slice(lengths.get(index) ?? 0);
        const partialColumns = new Set(selected.map(({ index }) => result.columns[index]!.name));
        const identity = row.identity ? { ...row.identity, original: row.identity.original.filter(value => !partialColumns.has(value.column)) } : undefined;
        const first = selected[0];
        const cell = first ? cells[first.index] : undefined;
        const next = cell?.type === 'partial' ? remainingCell(input, cell, row, result.columns[first!.index]!.name, row.cells[first!.index], first!.index) : undefined;
        return build({ ...result, rows: [{ cells, ...(identity ? { identity } : {}) }],
            completeness: incomplete(next ?? continuation(input, result, 0)) });
    };
    for (const candidate of candidates) {
        selected.push(candidate);
        const framingBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(render());
        if (framingBytes > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) continue;
        const available = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - framingBytes;
        const totalBytes = selected.reduce((sum, value) => sum + value.slicer.bytes, 0);
        for (const { index, slicer } of selected) lengths.set(index, Math.min(slicer.length, Math.floor(slicer.length * available / Math.max(1, totalBytes))));
        for (;;) {
            const value = render();
            const overage = measureExternalActionResultResponseEnvelopeUtf8BytesV1(value) - EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES;
            if (overage <= 0) return value;
            const largest = selected.reduce((left, right) => (lengths.get(left.index) ?? 0) >= (lengths.get(right.index) ?? 0) ? left : right);
            const length = lengths.get(largest.index) ?? 0;
            if (length === 0) return undefined;
            lengths.set(largest.index, length - Math.min(overage, Math.ceil(length / 2)));
        }
    }
    return undefined;
}

function fitRows(input: DatabaseOperationInputV1, result: DatabaseRowsResultV1,
    build: (result: DatabaseRowsResultV1) => DatabaseOperationResultV1): DatabaseOperationResultV1 {
    const backward = input.operation === 'rows.read' && input.page.continuation?.kind === 'keyset' && input.page.continuation.direction === 'backward';
    const ordered = backward ? { ...result, rows: [...result.rows].reverse() } : result;
    let bytes = 0;
    let retained = 0;
    for (const row of ordered.rows) {
        const nextBytes = bytes + serializedBytes(row) + (retained > 0 ? 1 : 0);
        const framing = build({ ...result, rows: [], completeness: incomplete(continuation(input, ordered, retained + 1)) });
        if (measureExternalActionResultResponseEnvelopeUtf8BytesV1(framing) + nextBytes > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES) break;
        bytes = nextBytes;
        retained += 1;
    }
    // Preserve the complete prefix. A separate cell request retains an oversized
    // first row without reclassifying its partial value as a complete SQL cell.
    if (retained === 0 && ordered.rows[0]) {
        const fitted = fitPartialRow(input, result, ordered.rows[0], build);
        if (fitted) return fitted;
    }
    const rows = ordered.rows.slice(0, retained);
    if (backward) rows.reverse();
    const fitted = build({ ...result, rows, completeness: incomplete(continuation(input, ordered, retained)) });
    return isExternalActionResultWithinResponseEnvelopeLimitV1(fitted) ? fitted : unavailable;
}

/** Fit typed database data to the canonical Action transport response envelope. */
export function fitDatabaseOperationResult(input: DatabaseOperationInputV1, result: DatabaseOperationResultV1): DatabaseOperationResultV1 {
    if (input.operation === 'statement.run' && input.mode === 'read' && result.ok && result.operation === 'statement.run') result = projectRead(input, result);
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(result)) return result;
    if (!result.ok) return unavailable;
    if (result.operation === 'schemas.list' && input.operation === 'schemas.list') {
        return fitList(result.schemas, (schemas, last) => ({ ...result, schemas, completeness: incomplete(last ? {
            kind: 'catalog', operation: input.operation, target: input.target, after: last.name,
            ...(input.database ? { database: input.database } : {}), ...(input.search !== undefined ? { search: input.search } : {}),
        } : undefined) }));
    }
    if (result.operation === 'relations.list' && input.operation === 'relations.list') {
        return fitList(result.relations, (relations, last) => ({ ...result, relations, completeness: incomplete(last ? {
            kind: 'catalog', operation: input.operation, target: input.target, after: last.relation.name, schema: input.schema,
            ...(input.database ? { database: input.database } : {}), ...(input.search !== undefined ? { search: input.search } : {}),
        } : undefined) }));
    }
    if (result.operation === 'rows.read') return fitRows(input, result.result, next => ({ ...result, result: next }));
    if (result.operation === 'cell.read') {
        return fitCell(result.value, cell => ({ ...result, value: cell, completeness: incomplete(remainingCell(input, cell, undefined, undefined, result.value)) })) ?? unavailable;
    }
    if (result.operation === 'statement.run') {
        const summaries = result.results.map(value => ({ columns: [], rows: [], completeness: incomplete(),
            ...(value.command !== undefined ? { command: value.command } : {}),
            ...(value.affectedRows !== undefined ? { affectedRows: value.affectedRows } : {}) }));
        const buildSummaries = (entries: typeof summaries): DatabaseOperationResultV1 => ({ ...result, results: entries, completeness: incomplete() });
        // Admit acknowledgements first. If even their ordered list must be
        // shortened, do not traverse all original row/column metadata again.
        const summaryPrefix = fitList(summaries, buildSummaries, measureExternalActionResultResponseEnvelopeUtf8BytesV1(buildSummaries([])));
        if (!summaryPrefix.ok || summaryPrefix.operation !== 'statement.run' || summaryPrefix.results.length < summaries.length) return summaryPrefix;
        // Reserve each later statement's metadata and incompleteness before rows.
        const results = result.results.map(value => ({ ...value, rows: [], completeness: incomplete() }));
        let fitted = result;
        fitted = { ...result, results };
        if (!isExternalActionResultWithinResponseEnvelopeLimitV1(fitted)) {
            fitted = { ...result, results: summaries };
        }
        for (let index = 0; index < result.results.length; index += 1) {
            const original = result.results[index]!;
            const complete = { ...fitted, results: fitted.results.map((value, position) => position === index ? original : value) };
            if (isExternalActionResultWithinResponseEnvelopeLimitV1(complete)) { fitted = complete; continue; }
            const next = fitRows(input, original, value => ({ ...fitted, results: fitted.results.map((old, position) => position === index ? { ...original, ...value } : old) }));
            if (!next.ok || next.operation !== 'statement.run') {
                // Delivery must not relabel a successful native mutation as a
                // failed operation merely because RETURNING metadata is large.
                fitted = { ...fitted, results: fitted.results.map((value, position) => position === index ? summaries[index]! : value) };
                continue;
            }
            fitted = next;
        }
        return isExternalActionResultWithinResponseEnvelopeLimitV1(fitted) ? fitted : unavailable;
    }
    return unavailable;
}
