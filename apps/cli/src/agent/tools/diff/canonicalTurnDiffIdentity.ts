import { createHash } from 'node:crypto';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
    if (value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
    if (typeof value === 'object') {
        const out: { [key: string]: JsonValue } = {};
        for (const [key, child] of Object.entries(value)) {
            out[key] = toJsonValue(child);
        }
        return out;
    }
    return null;
}

function stableJsonStringify(value: JsonValue): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
    }
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key] ?? null)}`)
        .join(',')}}`;
}

export function resolveCanonicalTurnDiffCallId(boundedInput: unknown): string {
    const digest = createHash('sha256')
        .update(stableJsonStringify(toJsonValue(boundedInput)))
        .digest('hex')
        .slice(0, 32);
    return `turn-diff-${digest}`;
}
