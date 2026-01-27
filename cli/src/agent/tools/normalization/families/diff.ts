type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function normalizeDiffInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput);
    if (!record) {
        const diff = firstNonEmptyString(rawInput);
        return diff ? { unified_diff: diff } : { value: rawInput };
    }

    const unified = firstNonEmptyString(record.unified_diff) ?? firstNonEmptyString(record.unifiedDiff) ?? null;
    if (unified) return { ...record, unified_diff: unified };

    const diff = firstNonEmptyString(record.diff) ?? firstNonEmptyString(record.patch) ?? null;
    if (diff) return { ...record, unified_diff: diff };

    return { ...record };
}

