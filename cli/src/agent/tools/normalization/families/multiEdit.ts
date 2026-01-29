type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeEditEntry(raw: unknown): UnknownRecord | null {
    const record = asRecord(raw);
    if (!record) return null;

    const filePath =
        firstNonEmptyString(record.file_path) ??
        firstNonEmptyString(record.filePath) ??
        firstNonEmptyString(record.path) ??
        null;
    const oldString =
        firstNonEmptyString(record.old_string) ??
        firstNonEmptyString(record.oldText) ??
        firstNonEmptyString(record.oldString) ??
        null;
    const newString =
        firstNonEmptyString(record.new_string) ??
        firstNonEmptyString(record.newText) ??
        firstNonEmptyString(record.newString) ??
        null;
    const replaceAll = record.replace_all ?? record.replaceAll;

    if (!filePath) return null;
    if (!oldString && !newString) return null;

    const out: UnknownRecord = {
        file_path: filePath,
    };
    if (oldString) out.old_string = oldString;
    if (newString) out.new_string = newString;
    if (typeof replaceAll === 'boolean') out.replace_all = replaceAll;
    return out;
}

export function normalizeMultiEditInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const rawEdits = Array.isArray((record as any).edits) ? ((record as any).edits as unknown[]) : [];
    const edits = rawEdits.map(normalizeEditEntry).filter((e): e is UnknownRecord => !!e);
    return { ...record, edits };
}

