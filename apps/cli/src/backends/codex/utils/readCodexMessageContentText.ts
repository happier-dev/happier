type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function readCodexMessageContentText(content: unknown): string | null {
    const directText = readString(content);
    if (directText) return directText;
    if (!Array.isArray(content)) return null;

    const parts: string[] = [];
    for (const entry of content) {
        const record = asRecord(entry);
        if (!record) continue;
        const text = readString(record.text);
        if (text) parts.push(text);
    }

    return parts.length > 0 ? parts.join('\n') : null;
}
