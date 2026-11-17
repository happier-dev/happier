import type { DatabaseCellResultV1, DatabaseCellV1, DatabaseValueRangeV1 } from '@happier-dev/database-protocol';

export type JsonCellInspection =
    | Readonly<{ status: 'complete'; value: string; formatted: string }>
    | Readonly<{ status: 'incomplete'; result: DatabaseCellResultV1 }>
    | Readonly<{ status: 'unavailable'; reason: 'not_json' | 'invalid_json' }>;

/** Format tokens, rather than round-tripping JS numbers, to preserve database JSON precision. */
function formatJson(value: string): string | undefined {
    try { JSON.parse(value); } catch { return undefined; }
    const tokens = value.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/gu) ?? [];
    let depth = 0;
    let formatted = '';
    const newline = () => { formatted += `\n${'  '.repeat(depth)}`; };
    for (const [index, token] of tokens.entries()) {
        if (token === '{' || token === '[') {
            formatted += token;
            depth++;
            if (tokens[index + 1] !== '}' && tokens[index + 1] !== ']') newline();
        } else if (token === '}' || token === ']') {
            depth--;
            if (tokens[index - 1] !== '{' && tokens[index - 1] !== '[') newline();
            formatted += token;
        } else if (token === ',') { formatted += token; newline(); }
        else formatted += token === ':' ? ': ' : token;
    }
    return formatted;
}

/** Detail-only demand follows the existing cell range/continuation owner; no independent cap. */
export async function inspectJsonCell(cell: DatabaseCellV1, read: (range: DatabaseValueRangeV1) => Promise<DatabaseCellResultV1>): Promise<JsonCellInspection> {
    let value: string | undefined;
    if (cell.type === 'json') value = cell.value;
    else if (cell.type !== 'partial' || cell.valueType !== 'json') return { status: 'unavailable', reason: 'not_json' };
    else {
        let result = await read({ offset: 0, length: cell.range.total ?? cell.range.length, unit: 'utf8_bytes', ...(cell.range.total === undefined ? {} : { total: cell.range.total }) });
        let text = '';
        let offset = 0;
        while (result.value.type === 'partial' && result.value.valueType === 'json') {
            const part = result.value;
            if (part.range.offset !== offset || part.range.length === 0) return { status: 'incomplete', result };
            text += part.value;
            offset += part.range.length;
            if (part.range.total !== undefined && offset === part.range.total) { value = text; break; }
            const continuation = !result.completeness.complete ? result.completeness.continuation : undefined;
            if (continuation?.kind !== 'cell') return { status: 'incomplete', result };
            result = await read(continuation.range);
        }
        if (result.value.type === 'json' && result.completeness.complete) value = result.value.value;
        else if (value === undefined) return { status: 'incomplete', result };
    }
    if (value === undefined) return { status: 'unavailable', reason: 'not_json' };
    const formatted = formatJson(value);
    return formatted === undefined ? { status: 'unavailable', reason: 'invalid_json' } : { status: 'complete', value, formatted };
}
