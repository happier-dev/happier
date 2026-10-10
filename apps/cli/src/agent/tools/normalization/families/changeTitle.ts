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

function parseJsonResult(text: string): UnknownRecord | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }

    const rec = asRecord(parsed);
    if (!rec) return null;
    const candidates = [rec, asRecord(rec.output), asRecord(asRecord(rec.data)?.output),
        asRecord(asRecord(rec.data)?.result), asRecord(asRecord(rec.result)?.output)];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (typeof candidate.error === 'string' && candidate.error.trim()) {
            return {
                success: false,
                error: candidate.error,
                errorMessage: candidate.error,
                ...(typeof candidate.errorCode === 'string' ? { errorCode: candidate.errorCode } : {}),
            };
        }
        if (typeof candidate.title === 'string' && candidate.title.trim()) {
            return { title: candidate.title.trim() };
        }
    }
    // A JSON property name is not a quoted success title.
    return { message: text };
}

export function normalizeChangeTitleResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const parsed = parseJsonResult(rawOutput);
        if (parsed) return parsed;
        const title = extractQuotedTitle(rawOutput);
        return title ? { title } : { message: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const contentText = coerceTextFromContentBlocks(record.content);
    const message =
        typeof contentText === 'string'
            ? contentText
            : typeof record.message === 'string'
                ? record.message
                : typeof record.stdout === 'string'
                    ? record.stdout
                    : null;

    const parsed = message ? parseJsonResult(message) : null;
    if (parsed?.success === false) return parsed;
    const title = typeof parsed?.title === 'string' ? parsed.title : message && !parsed ? extractQuotedTitle(message) : null;
    if (title) return { ...record, title };
    if (message) return { ...record, message };
    return { ...record };
}
