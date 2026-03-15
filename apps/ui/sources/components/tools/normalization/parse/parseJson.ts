export function maybeParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const first = trimmed[0];
    if (first !== '{' && first !== '[' && first !== '"') return value;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === 'string') {
            const nested = parsed.trim();
            if (!nested) return value;
            const nestedFirst = nested[0];
            if (nestedFirst !== '{' && nestedFirst !== '[') return value;
            try {
                return JSON.parse(nested) as unknown;
            } catch {
                return value;
            }
        }
        return parsed;
    } catch {
        return value;
    }
}
