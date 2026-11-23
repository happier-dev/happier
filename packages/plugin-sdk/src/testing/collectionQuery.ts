import {
    PluginCollectionQueryRequestV1Schema,
    type PluginCollectionIndexScalarValueV1,
    comparePluginCollectionIndexSortKeysV1,
    encodePluginCollectionIndexTuplePrefixV1,
} from '@happier-dev/protocol';
import type { PluginCollectionQuery } from '../collections.js';

/** Use the host's query page default in an in-memory Collection fixture. */
export function parseTestCollectionQueryLimit(limit: PluginCollectionQuery['limit']): number {
    return PluginCollectionQueryRequestV1Schema.shape.limit.parse(limit);
}

/** Match a finite-number index range using the host's ordering, including null bounds. */
export function matchesTestCollectionNumericRange(value: unknown, range: PluginCollectionQuery['range']): boolean {
    if (range === undefined) return true;
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const encode = (operand: PluginCollectionIndexScalarValueV1) =>
        encodePluginCollectionIndexTuplePrefixV1({ fields: [{ kind: 'finiteNumber', value: operand }] });
    const key = encode(value);
    return (range.lower === undefined || comparePluginCollectionIndexSortKeysV1(key, encode(range.lower)) >= 0)
        && (range.upper === undefined || comparePluginCollectionIndexSortKeysV1(key, encode(range.upper)) <= 0);
}
