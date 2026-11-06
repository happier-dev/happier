import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ResourceContent } from '@happier-dev/plugin-sdk/ui';

// Projection admission retains immutable JSON members by reference. Keep their
// native UTF-8 at the same lifetime, including Work/private facts and cost totals,
// so independent source progress serializes only replaced members.
const memberBytes = new WeakMap<object, Uint8Array>();
// Keep the immutable encoded fragments with their admitted data identity. The
// complete, independently mutable transport buffer is still released by its
// Resource owner; retaining a batch does not retain that duplicate buffer.
const batchChunks = new WeakMap<UsageQueryBatchResult, readonly Uint8Array[]>();
type JsonParts = Array<string | Uint8Array>;

function encodeMember(value: unknown, encoder: TextEncoder): string | Uint8Array | undefined {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const retained = memberBytes.get(value);
    if (retained !== undefined) return retained;
    const encoded = encoder.encode(JSON.stringify(value));
    memberBytes.set(value, encoded);
    return encoded;
}

function stringifyFields(value: object, encode: (value: unknown, key: string) => string | Uint8Array | JsonParts | undefined = entry => JSON.stringify(entry)): JsonParts {
    const parts: JsonParts = ['{'];
    let separator = '';
    for (const [key, entry] of Object.entries(value)) {
        const encoded = encode(entry, key);
        if (encoded === undefined) continue;
        parts.push(`${separator}${JSON.stringify(key)}:`);
        if (Array.isArray(encoded)) parts.push(...encoded);
        else parts.push(encoded);
        separator = ',';
    }
    parts.push('}');
    return parts;
}

/** Native JSON per changed section, assembled into the complete Resource bytes. */
export function encodeUsageQueryResource(value: UsageQueryBatchResult) {
    const retained = batchChunks.get(value);
    if (retained) return { bytes: assembleChunks(retained) };
    const encoder = new TextEncoder();
    const results: JsonParts = ['['];
    for (const [index, slice] of value.results.entries()) {
        if (index > 0) results.push(',');
        results.push(...stringifyFields(slice, (entry, key) => {
            if (key === 'comparison' && slice.comparison) {
                const comparison = slice.comparison;
                // Read the comparison envelope for each revision; its admitted
                // facts and query have independent immutable identities.
                return stringifyFields(comparison, (field, name) => name === 'source'
                    ? JSON.stringify(field) : encodeMember(field, encoder));
            }
            return encodeMember(entry, encoder);
        }));
    }
    results.push(']');
    const parts = stringifyFields(value, (entry, key) => key === 'results' ? results : JSON.stringify(entry));
    const chunks: Uint8Array[] = [];
    const text: string[] = [];
    const flushText = () => {
        if (text.length === 0) return;
        const chunk = encoder.encode(text.join(''));
        chunks.push(chunk);
        text.length = 0;
    };
    for (const part of parts) {
        if (typeof part === 'string') text.push(part);
        else {
            flushText();
            chunks.push(part);
        }
    }
    flushText();
    batchChunks.set(value, chunks);
    return { bytes: assembleChunks(chunks) };
}

function assembleChunks(chunks: readonly Uint8Array[]): Uint8Array {
    const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/** Retain admitted facts, letting an unconsumed complete transport buffer go. */
export function createUsageQueryResourceContent(value: UsageQueryBatchResult, bytes: Uint8Array, digest: string): ResourceContent {
    // Keep the original strong byte parameter outside the getter's closure.
    return contentWithWeakBytes(value, new WeakRef(bytes), digest);
}

function contentWithWeakBytes(value: UsageQueryBatchResult, retained: WeakRef<Uint8Array>, digest: string): ResourceContent {
    return {
        contentType: 'application/json',
        digest,
        get bytes() {
            const existing = retained.deref();
            if (existing) return existing;
            const bytes = encodeUsageQueryResource(value).bytes;
            retained = new WeakRef(bytes);
            return bytes;
        },
    };
}
