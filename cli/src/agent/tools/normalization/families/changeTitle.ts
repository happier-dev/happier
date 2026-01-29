type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function coerceTextFromContentBlocks(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as UnknownRecord;
        if (typeof rec.text === 'string') parts.push(rec.text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

function extractQuotedTitle(text: string): string | null {
    const match = text.match(/title\s+to:\s*\"([^\"]+)\"/i);
    if (match && match[1]?.trim()) return match[1].trim();
    const anyQuotes = text.match(/\"([^\"]+)\"/);
    if (anyQuotes && anyQuotes[1]?.trim()) return anyQuotes[1].trim();
    return null;
}

export function normalizeChangeTitleResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const title = extractQuotedTitle(rawOutput);
        return title ? { title } : { message: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const contentText =
        coerceTextFromContentBlocks((record as any).content) ??
        (Array.isArray((record as any).content) ? coerceTextFromContentBlocks((record as any).content) : null);
    const message = typeof contentText === 'string' ? contentText : typeof (record as any).message === 'string' ? (record as any).message : null;

    const title = message ? extractQuotedTitle(message) : null;
    if (title) return { ...record, title };
    if (message) return { ...record, message };
    return { ...record };
}

