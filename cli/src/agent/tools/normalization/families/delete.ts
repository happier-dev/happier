type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function coerceStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    return out.length > 0 ? out : null;
}

function coerceSinglePath(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeDeleteInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const explicitList =
        coerceStringArray((record as any).file_paths) ??
        coerceStringArray((record as any).paths) ??
        null;

    const single =
        coerceSinglePath((record as any).file_path) ??
        coerceSinglePath((record as any).filePath) ??
        coerceSinglePath((record as any).path) ??
        null;

    const fromLocations = (() => {
        const locations = Array.isArray((record as any).locations) ? ((record as any).locations as unknown[]) : null;
        if (!locations || locations.length === 0) return null;
        const paths: string[] = [];
        for (const loc of locations) {
            const rec = asRecord(loc);
            const p = coerceSinglePath(rec?.path);
            if (p) paths.push(p);
        }
        return paths.length > 0 ? paths : null;
    })();

    const filePaths = explicitList ?? (single ? [single] : null) ?? fromLocations;
    if (filePaths) out.file_paths = filePaths;
    if (!out.file_path && filePaths && filePaths.length === 1) out.file_path = filePaths[0];

    return out;
}

export function normalizeDeleteResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) return {};
        return { message: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const out: UnknownRecord = { ...record };

    if (typeof (record as any).errorMessage === 'string' && typeof (record as any).error !== 'string') {
        out.error = (record as any).errorMessage;
    }

    const deleted =
        typeof (record as any).deleted === 'boolean'
            ? Boolean((record as any).deleted)
            : typeof (record as any).success === 'boolean'
                ? Boolean((record as any).success)
                : typeof (record as any).ok === 'boolean'
                    ? Boolean((record as any).ok)
                    : undefined;
    if (typeof deleted === 'boolean') out.deleted = deleted;

    if (typeof out.deleted !== 'boolean') {
        const hasError = typeof (record as any).error === 'string' && (record as any).error.trim().length > 0;
        if (hasError) out.deleted = false;
    }

    return out;
}

