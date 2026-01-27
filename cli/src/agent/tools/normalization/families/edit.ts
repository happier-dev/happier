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

    const filePath =
        (typeof record.file_path === 'string' && record.file_path.trim().length > 0)
            ? record.file_path.trim()
            : (typeof record.path === 'string' && record.path.trim().length > 0)
                ? record.path.trim()
                : (typeof record.filePath === 'string' && record.filePath.trim().length > 0)
                    ? record.filePath.trim()
                    : null;
    if (filePath) out.file_path = filePath;

    const firstItem = coerceFirstItemDiff(record.items);
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

