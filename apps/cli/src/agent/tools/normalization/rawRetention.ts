import { isDeepStrictEqual } from 'node:util';

import { truncateDeep } from '../redaction/redact';

type UnknownRecord = Record<string, unknown>;
const represented = Symbol('represented');

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function remainingRaw(raw: unknown, canonical: unknown): unknown | typeof represented {
    if (isDeepStrictEqual(raw, canonical)) return represented;
    const rawRecord = asRecord(raw);
    const canonicalRecord = asRecord(canonical);
    if (!rawRecord || !canonicalRecord) return raw;

    const remaining: UnknownRecord = {};
    for (const [key, value] of Object.entries(rawRecord)) {
        const residual = Object.prototype.hasOwnProperty.call(canonicalRecord, key)
            ? remainingRaw(value, canonicalRecord[key])
            : value;
        if (residual !== represented) remaining[key] = residual;
    }
    return Object.keys(remaining).length > 0 ? remaining : represented;
}

/** Keep only raw facts absent from the canonical shape, under the existing raw bounds. */
export function withUnrepresentedRaw(canonical: UnknownRecord, raw: unknown): UnknownRecord {
    const boundedRaw = truncateDeep(raw);
    const boundedCanonical = asRecord(truncateDeep(canonical)) ?? {};
    // Primitive results have no field identity. Only these canonical output slots
    // represent their value; equal values in unrelated metadata do not.
    const file = asRecord(boundedCanonical.file);
    const primitiveSlots = typeof boundedRaw === 'string'
        ? [boundedCanonical.value, boundedCanonical.stdout, boundedCanonical.message,
            boundedCanonical.text, boundedCanonical.content, boundedCanonical.output, file?.content]
        : [boundedCanonical.value];
    const residual = !asRecord(boundedRaw) && primitiveSlots.some((value) => isDeepStrictEqual(value, boundedRaw))
        ? represented
        : remainingRaw(boundedRaw, boundedCanonical);
    return residual === represented ? canonical : { ...canonical, _raw: residual };
}
