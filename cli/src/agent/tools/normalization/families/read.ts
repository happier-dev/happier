type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function parseOpencodeFileWrapper(text: string): { content: string; startLine?: number; numLines?: number; totalLines?: number } | null {
    if (!text.includes('<file>')) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const startIndex = lines.findIndex((l) => l.trim() === '<file>');
    if (startIndex < 0) return null;
    const endIndex = lines.findIndex((l, idx) => idx > startIndex && l.trim() === '</file>');
    if (endIndex < 0) return null;

    const contentLines: string[] = [];
    let startLine: number | undefined;
    let totalLines: number | undefined;

    for (let i = startIndex + 1; i < endIndex; i++) {
        const line = lines[i];
        if (line.startsWith('(End of file')) {
            const match = line.match(/total\s+(\d+)\s+lines/i);
            if (match) {
                const n = Number(match[1]);
                if (Number.isFinite(n) && n > 0) totalLines = n;
            }
            continue;
        }

        const match = line.match(/^(\d+)\|\s?(.*)$/);
        if (match) {
            const n = Number(match[1]);
            if (Number.isFinite(n) && startLine == null) startLine = n;
            contentLines.push(match[2]);
            continue;
        }

        if (line.trim().length === 0) {
            contentLines.push('');
        }
    }

    const content = contentLines.join('\n').trimEnd();
    if (content.length === 0) return null;

    return {
        content,
        startLine,
        numLines: contentLines.length > 0 ? contentLines.length : undefined,
        totalLines,
    };
}

function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = locations[0];
    if (!first || typeof first !== 'object') return null;
    const obj = first as UnknownRecord;
    const path =
        (typeof obj.path === 'string' && obj.path.trim().length > 0)
            ? obj.path.trim()
            : (typeof obj.filePath === 'string' && obj.filePath.trim().length > 0)
                ? obj.filePath.trim()
                : null;
    return path;
}

export function normalizeReadInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const filePath =
        (typeof record.file_path === 'string' && record.file_path.trim().length > 0)
            ? record.file_path.trim()
            : (typeof record.path === 'string' && record.path.trim().length > 0)
                ? record.path.trim()
                : (typeof (record as any).filepath === 'string' && (record as any).filepath.trim().length > 0)
                    ? (record as any).filepath.trim()
                : (typeof record.filePath === 'string' && record.filePath.trim().length > 0)
                    ? record.filePath.trim()
                    : null;

    const fromLocations = filePath ? null : coerceSingleLocationPath(record.locations);
    const normalizedPath = filePath ?? fromLocations;
    if (normalizedPath) out.file_path = normalizedPath;

    const limit = record.limit;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) out.limit = limit;
    const offset = record.offset;
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) out.offset = offset;

    return out;
}

export function normalizeReadResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const parsed = parseOpencodeFileWrapper(rawOutput);
        if (parsed) {
            const file: UnknownRecord = { content: parsed.content };
            if (typeof parsed.startLine === 'number') file.startLine = parsed.startLine;
            if (typeof parsed.numLines === 'number') file.numLines = parsed.numLines;
            if (typeof parsed.totalLines === 'number') file.totalLines = parsed.totalLines;
            return { file };
        }

        const text = rawOutput.trimEnd();
        if (text.length > 0) {
            return { file: { content: text } };
        }
        return {};
    }

    const record = asRecord(rawOutput);
    if (!record) {
        // Preserve primitive/array outputs for debug; UI renderers will fall back to _raw.
        return { value: rawOutput };
    }

    const out: UnknownRecord = { ...record };

    const fileRecord = asRecord(out.file);
    if (fileRecord) {
        out.file = { ...fileRecord };
        return out;
    }

    const content =
        typeof out.content === 'string'
            ? out.content
            : typeof out.text === 'string'
                ? out.text
                : null;

    const filePath =
        typeof out.filePath === 'string'
            ? out.filePath
            : typeof out.path === 'string'
                ? out.path
                : typeof out.file_path === 'string'
                    ? out.file_path
                    : null;

    if (content != null && filePath != null && filePath.trim().length > 0) {
        out.file = {
            filePath,
            content,
        };
    }

    return out;
}
