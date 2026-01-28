type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export function normalizeGlobInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.pattern !== 'string' && typeof out.glob === 'string' && out.glob.trim().length > 0) {
        out.pattern = out.glob.trim();
    }
    if (typeof out.path !== 'string' && typeof out.cwd === 'string' && out.cwd.trim().length > 0) {
        out.path = out.cwd.trim();
    }

    return out;
}

export function normalizeCodeSearchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const query =
        typeof out.query === 'string' && out.query.trim().length > 0
            ? out.query.trim()
            : typeof out.q === 'string' && out.q.trim().length > 0
                ? out.q.trim()
                : typeof out.pattern === 'string' && out.pattern.trim().length > 0
                    ? out.pattern.trim()
                    : typeof (out as any).information_request === 'string' && (out as any).information_request.trim().length > 0
                        ? (out as any).information_request.trim()
                        : typeof (out as any).informationRequest === 'string' && (out as any).informationRequest.trim().length > 0
                            ? (out as any).informationRequest.trim()
                    : null;

    if (query && typeof out.query !== 'string') out.query = query;

    return out;
}

export function normalizeGrepInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.pattern !== 'string' && typeof out.query === 'string' && out.query.trim().length > 0) {
        out.pattern = out.query.trim();
    }

    return out;
}

export function normalizeLsInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.path !== 'string' && typeof out.dir === 'string' && out.dir.trim().length > 0) {
        out.path = out.dir.trim();
    }

    return out;
}
