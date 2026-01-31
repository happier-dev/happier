type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function coerceFirstItemDiff(items: unknown): UnknownRecord | null {
    if (!Array.isArray(items) || items.length === 0) return null;
    const first = items[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
    return first as UnknownRecord;
}

function coerceItemPath(item: UnknownRecord | null): string | null {
    if (!item) return null;
    const path =
        (typeof item.path === 'string' && item.path.trim().length > 0)
            ? item.path.trim()
            : (typeof item.filePath === 'string' && item.filePath.trim().length > 0)
                ? item.filePath.trim()
                : null;
    return path;
}

function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = locations[0];
    if (!first || typeof first !== 'object') return null;
    const obj = first as UnknownRecord;
    const path =
        (typeof obj.path === 'string' && obj.path.trim().length > 0)
            ? obj.path.trim()
            : (typeof obj.filePath === 'string' && obj.filePath.trim().length > 0)
                ? obj.filePath.trim()
                : null;
    return path;
}

function coerceItemText(item: UnknownRecord | null, key: 'old' | 'new'): string | null {
    if (!item) return null;
    const candidates =
        key === 'old'
            ? [item.oldText, item.old_string, item.oldString]
            : [item.newText, item.new_string, item.newString];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) return c;
    }
    return null;
}

export function normalizeEditInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const firstItem = coerceFirstItemDiff(record.items);

    const filePath =
        (typeof record.file_path === 'string' && record.file_path.trim().length > 0)
            ? record.file_path.trim()
            : (typeof record.path === 'string' && record.path.trim().length > 0)
                ? record.path.trim()
                : (typeof record.filePath === 'string' && record.filePath.trim().length > 0)
                    ? record.filePath.trim()
                    : null;
    const fromItem = filePath ? null : coerceItemPath(firstItem);
    const fromLocations = filePath || fromItem ? null : coerceSingleLocationPath(record.locations);
    const normalizedPath = filePath ?? fromItem ?? fromLocations;
    if (normalizedPath) out.file_path = normalizedPath;

    const oldText =
        (typeof record.old_string === 'string' && record.old_string.trim().length > 0)
            ? record.old_string.trim()
            : (typeof record.oldText === 'string' && record.oldText.trim().length > 0)
                ? record.oldText.trim()
                : (typeof record.oldString === 'string' && record.oldString.trim().length > 0)
                    ? record.oldString.trim()
                    : coerceItemText(firstItem, 'old');
    const newText =
        (typeof record.new_string === 'string' && record.new_string.trim().length > 0)
            ? record.new_string.trim()
            : (typeof record.newText === 'string' && record.newText.trim().length > 0)
                ? record.newText.trim()
                : (typeof record.newString === 'string' && record.newString.trim().length > 0)
                    ? record.newString.trim()
                    : coerceItemText(firstItem, 'new');

    if (oldText) out.old_string = oldText;
    if (newText) out.new_string = newText;

    // Keep Gemini/Codex compatibility fields when present.
    if (typeof record.oldText === 'string' && record.oldText.trim().length > 0) out.oldText = record.oldText;
    if (typeof record.newText === 'string' && record.newText.trim().length > 0) out.newText = record.newText;

    const replaceAll = record.replace_all ?? record.replaceAll;
    if (typeof replaceAll === 'boolean') out.replace_all = replaceAll;

    return out;
}

export function normalizeEditResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) return {};
        return { message: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const out: UnknownRecord = { ...record };
    const applied =
        typeof (record as any).applied === 'boolean'
            ? Boolean((record as any).applied)
            : typeof (record as any).success === 'boolean'
                ? Boolean((record as any).success)
                : typeof (record as any).ok === 'boolean'
                    ? Boolean((record as any).ok)
                    : undefined;
    if (typeof applied === 'boolean') out.applied = applied;

    if (typeof out.applied !== 'boolean') {
        const hasError = typeof (record as any).error === 'string' && (record as any).error.trim().length > 0;
        if (hasError) out.applied = false;
    }

    return out;
}
