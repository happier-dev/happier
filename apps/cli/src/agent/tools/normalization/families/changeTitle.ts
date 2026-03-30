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

function parseJsonTitle(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }

    const asRecord = (value: unknown): UnknownRecord | null => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return value as UnknownRecord;
    };

    const readTitle = (value: unknown): string | null => {
        const rec = asRecord(value);
        if (rec && typeof rec.title === 'string' && rec.title.trim()) return rec.title.trim();
        return null;
    };

    const rec = asRecord(parsed);
    if (rec) {
        return (
            readTitle(rec) ??
            readTitle(rec.output) ??
            readTitle((asRecord(rec.data) ?? null)?.output) ??
            readTitle((asRecord(rec.data) ?? null)?.result) ??
            readTitle((asRecord(rec.result) ?? null)?.output)
        );
    }

    return null;
}

export function normalizeChangeTitleResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const title = parseJsonTitle(rawOutput) ?? extractQuotedTitle(rawOutput);
        return title ? { title } : { message: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const contentText =
        coerceTextFromContentBlocks((record as any).content) ??
        (Array.isArray((record as any).content) ? coerceTextFromContentBlocks((record as any).content) : null);
    const message =
        typeof contentText === 'string'
            ? contentText
            : typeof (record as any).message === 'string'
                ? (record as any).message
                : typeof (record as any).stdout === 'string'
                    ? (record as any).stdout
                    : null;

    const title = message ? (parseJsonTitle(message) ?? extractQuotedTitle(message)) : null;
    if (title) return { ...record, title };
    if (message) return { ...record, message };
    return { ...record };
}
