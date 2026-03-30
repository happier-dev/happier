export function stableJsonStringify(value: unknown): string {
    const seen = new WeakSet<object>();

    const format = (input: unknown): string => {
        if (input === null || input === undefined) return 'null';
        if (typeof input === 'string') return JSON.stringify(input);
        if (typeof input === 'number') return Number.isFinite(input) ? String(input) : 'null';
        if (typeof input === 'boolean') return input ? 'true' : 'false';
        if (Array.isArray(input)) return `[${input.map((v) => format(v)).join(',')}]`;
        if (typeof input === 'object') {
            const obj = input as Record<string, unknown>;
            if (seen.has(obj)) return JSON.stringify('[Circular]');
            seen.add(obj);
            const keys = Object.keys(obj).sort();
            const out = `{${keys.map((k) => `${JSON.stringify(k)}:${format(obj[k])}`).join(',')}}`;
            seen.delete(obj);
            return out;
        }

        // functions/symbols/etc: treat as null for key stability
        return 'null';
    };

    return format(value);
}

