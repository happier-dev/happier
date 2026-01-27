type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function asNonEmptyRecord(value: unknown): UnknownRecord | null {
    const record = asRecord(value);
    if (!record) return null;
    return Object.keys(record).length > 0 ? record : null;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeSinglePatchChange(raw: unknown): UnknownRecord {
    const record = asRecord(raw);
    if (!record) return { value: raw };

    const type = firstNonEmptyString(record.type)?.toLowerCase() ?? null;
    const content = firstNonEmptyString(record.content);
    const oldContent =
        firstNonEmptyString(record.old_content) ??
        firstNonEmptyString(record.oldContent) ??
        null;
    const newContent =
        firstNonEmptyString(record.new_content) ??
        firstNonEmptyString(record.newContent) ??
        null;

    // Keep the original record keys for debugging; add normalized fields when possible.
    const next: UnknownRecord = { ...record };

    if (type === 'add' && content) {
        next.add = { content };
        return next;
    }

    if ((type === 'update' || type === 'modify') && oldContent && newContent) {
        next.modify = { old_content: oldContent, new_content: newContent };
        return next;
    }

    if ((type === 'delete' || type === 'remove') && (content || oldContent)) {
        next.delete = { content: content ?? oldContent ?? '' };
        return next;
    }

    // Unknown / insufficient information — return as-is.
    return next;
}

export function normalizePatchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput);
    if (!record) return { changes: {}, value: rawInput };

    const changes = asNonEmptyRecord(record.changes);
    if (!changes) return { ...record };

    const normalizedChanges: Record<string, unknown> = {};
    for (const [path, change] of Object.entries(changes)) {
        normalizedChanges[path] = normalizeSinglePatchChange(change);
    }

    return { ...record, changes: normalizedChanges };
}

