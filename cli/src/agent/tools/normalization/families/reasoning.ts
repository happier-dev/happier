type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function normalizeReasoningInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput);
    if (record) return { ...record };
    const title = firstNonEmptyString(rawInput);
    if (title) return { title };
    return { value: rawInput };
}

export function normalizeReasoningResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') return { content: rawOutput };
    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const content = firstNonEmptyString(record.content);
    const text = firstNonEmptyString(record.text);

    // Prefer a single canonical `content` field, but keep the original keys too.
    if (content) return { ...record, content };
    if (text) return { ...record, content: text };
    return { ...record };
}

