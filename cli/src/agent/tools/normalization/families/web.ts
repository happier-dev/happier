type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export function normalizeWebFetchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const url =
        typeof out.url === 'string' && out.url.trim().length > 0
            ? out.url.trim()
            : typeof out.uri === 'string' && out.uri.trim().length > 0
                ? out.uri.trim()
                : typeof out.href === 'string' && out.href.trim().length > 0
                    ? out.href.trim()
                    : typeof out.link === 'string' && out.link.trim().length > 0
                        ? out.link.trim()
                        : null;
    if (url && typeof out.url !== 'string') out.url = url;

    return out;
}

export function normalizeWebSearchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const query =
        typeof out.query === 'string' && out.query.trim().length > 0
            ? out.query.trim()
            : typeof out.q === 'string' && out.q.trim().length > 0
                ? out.q.trim()
                : typeof out.text === 'string' && out.text.trim().length > 0
                    ? out.text.trim()
                    : typeof out.pattern === 'string' && out.pattern.trim().length > 0
                        ? out.pattern.trim()
                        : null;
    if (query && typeof out.query !== 'string') out.query = query;

    return out;
}

