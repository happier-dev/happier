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

export function normalizeWriteInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const filePath =
        typeof out.file_path === 'string' && out.file_path.trim().length > 0
            ? out.file_path.trim()
            : typeof out.filePath === 'string' && out.filePath.trim().length > 0
                ? out.filePath.trim()
                : typeof (out as any).filepath === 'string' && (out as any).filepath.trim().length > 0
                    ? (out as any).filepath.trim()
                : typeof out.path === 'string' && out.path.trim().length > 0
                    ? out.path.trim()
                    : null;
    if (filePath) out.file_path = filePath;

    const content =
        typeof out.content === 'string'
            ? out.content
            : typeof (out as any).file_content === 'string'
                ? (out as any).file_content
            : typeof out.text === 'string'
                ? out.text
                : typeof out.data === 'string'
                    ? out.data
                    : typeof out.newText === 'string'
                        ? out.newText
                        : null;
    if (content != null && typeof out.content !== 'string') out.content = content;

    return out;
}

export function normalizeWriteResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const trimmed = rawOutput.trim();
        if (trimmed.length === 0) return {};
        return { message: rawOutput };
    }

    if (Array.isArray(rawOutput)) {
        // Claude-style tool_result "content" blocks, or other providers returning list payloads.
        const text = coerceTextFromContentBlocks(rawOutput);
        if (text) return { message: text };
        return { value: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    const out: UnknownRecord = { ...record };
    const text = coerceTextFromContentBlocks((record as any).content);
    if (text && typeof out.text !== 'string') out.text = text;

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
