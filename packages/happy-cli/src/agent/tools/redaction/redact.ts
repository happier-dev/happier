type UnknownRecord = Record<string, unknown>;

export function truncateDeep(
    value: unknown,
    opts?: { maxString?: number; maxArray?: number; maxObjectKeys?: number; maxDepth?: number },
    depth = 0,
): unknown {
    const maxString = opts?.maxString ?? 2_000;
    const maxArray = opts?.maxArray ?? 50;
    const maxObjectKeys = opts?.maxObjectKeys ?? 200;
    const maxDepth = opts?.maxDepth ?? 6;

    if (depth > maxDepth) return '[truncated depth]';

    if (typeof value === 'string') {
        if (value.length <= maxString) return value;
        return `${value.slice(0, maxString)}…(truncated ${value.length - maxString} chars)`;
    }

    if (typeof value !== 'object' || value === null) return value;

    if (Array.isArray(value)) {
        const sliced = value.slice(0, maxArray).map((v) => truncateDeep(v, opts, depth + 1));
        if (value.length <= maxArray) return sliced;
        return [...sliced, `…(truncated ${value.length - maxArray} items)`];
    }

    const entries = Object.entries(value as UnknownRecord);
    const sliced = entries.slice(0, maxObjectKeys);
    const out: UnknownRecord = {};
    for (const [k, v] of sliced) out[k] = truncateDeep(v, opts, depth + 1);
    if (entries.length > maxObjectKeys) out._truncatedKeys = entries.length - maxObjectKeys;
    return out;
}

