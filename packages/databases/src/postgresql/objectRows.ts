import type { DatabaseStatementResultV1, DatabaseValueV1 } from '@happier-dev/database-protocol';
import { isStrictPluginJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { PostgresqlOperationError } from './operations.js';

function invalid(): never {
    throw new PostgresqlOperationError({ ok: false, status: 'failed', code: 'provider_response_invalid' });
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cell(value: unknown): DatabaseValueV1 {
    if (value === null) return { type: 'null' };
    switch (typeof value) {
        case 'string': return { type: 'text', value };
        case 'boolean': return { type: 'boolean', value };
        // The provider has already decoded JSON numbers, not lossless SQL numerics.
        case 'number': return { type: 'float', value };
        case 'object': {
            try { return { type: 'json', value: JSON.stringify(value) }; }
            catch { return invalid(); }
        }
        default: return invalid();
    }
}

/** Restricted provider object frames do not prove PostgreSQL field types or completeness. */
export function decodePostgresqlObjectRowsV1(response: unknown): DatabaseStatementResultV1 {
    if (!Array.isArray(response) || !isStrictPluginJsonValue(response)) return invalid();
    const frame: readonly unknown[] = response;
    const first = frame[0];
    if (frame.length && !record(first)) return invalid();
    const names = Object.keys(first ?? {});
    const rows = frame.map(row => {
        if (!record(row) || Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) return invalid();
        return { cells: names.map(name => cell(row[name])) };
    });
    return { columns: names.map(name => ({ name, nativeType: 'unknown', semanticType: 'unknown' })), rows,
        completeness: { complete: false, reason: 'transport_unproven' } };
}
