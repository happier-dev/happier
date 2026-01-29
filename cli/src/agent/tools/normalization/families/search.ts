type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function parseGrepLine(line: string): { filePath: string; line?: number; excerpt?: string } | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    const match = trimmed.match(/^(.+?):(\d+):\s?(.*)$/);
    if (!match) return null;
    const n = Number(match[2]);
    return {
        filePath: match[1],
        line: Number.isFinite(n) ? n : undefined,
        excerpt: match[3],
    };
}

function parseOpenCodeSearch(text: string): { matches: Array<{ filePath: string; line?: number; excerpt?: string }> } | null {
    if (!text.includes('matches')) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const matches: Array<{ filePath: string; line?: number; excerpt?: string }> = [];
    let currentFile: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        // "/path/file:" header
        if (!line.startsWith(' ') && trimmed.endsWith(':') && trimmed.includes('/')) {
            currentFile = trimmed.slice(0, -1);
            continue;
        }

        // "Line 2: beta"
        const m = trimmed.match(/^Line\s+(\d+):\s?(.*)$/i);
        if (m && currentFile) {
            const n = Number(m[1]);
            matches.push({
                filePath: currentFile,
                line: Number.isFinite(n) ? n : undefined,
                excerpt: m[2],
            });
            continue;
        }

        // Fallback: grep-ish "path:line: text"
        const grep = parseGrepLine(line);
        if (grep) matches.push(grep);
    }

    if (matches.length === 0) return null;
    return { matches };
}

function coerceTextFromContentBlocks(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as UnknownRecord;
        if (typeof rec.text === 'string') {
            parts.push(rec.text);
            continue;
        }
        const nested = rec.content;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const nestedRec = nested as UnknownRecord;
            if (typeof nestedRec.text === 'string') parts.push(nestedRec.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

export function normalizeGlobInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.pattern !== 'string' && typeof out.glob === 'string' && out.glob.trim().length > 0) {
        out.pattern = out.glob.trim();
    }
    if (typeof out.path !== 'string' && typeof out.cwd === 'string' && out.cwd.trim().length > 0) {
        out.path = out.cwd.trim();
    }

    return out;
}

export function normalizeGlobResult(rawOutput: unknown): UnknownRecord {
    if (Array.isArray(rawOutput) && rawOutput.every((v) => typeof v === 'string')) {
        return { matches: rawOutput };
    }

    if (Array.isArray(rawOutput)) {
        const text = coerceTextFromContentBlocks(rawOutput);
        if (text) {
            const lines = text
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            return { matches: lines.length > 0 ? lines : [text] };
        }
    }

    if (typeof rawOutput === 'string') {
        const lines = rawOutput
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length > 0) return { matches: lines };
        return {};
    }

    const record = asRecord(rawOutput);
    if (record && Array.isArray((record as any).matches)) {
        return { matches: (record as any).matches };
    }

    return { value: rawOutput };
}

export function normalizeCodeSearchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const query =
        typeof out.query === 'string' && out.query.trim().length > 0
            ? out.query.trim()
            : typeof out.q === 'string' && out.q.trim().length > 0
                ? out.q.trim()
                : typeof out.pattern === 'string' && out.pattern.trim().length > 0
                    ? out.pattern.trim()
                    : typeof (out as any).information_request === 'string' && (out as any).information_request.trim().length > 0
                        ? (out as any).information_request.trim()
                        : typeof (out as any).informationRequest === 'string' && (out as any).informationRequest.trim().length > 0
                            ? (out as any).informationRequest.trim()
                    : null;

    if (query && typeof out.query !== 'string') out.query = query;

    return out;
}

export function normalizeCodeSearchResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const parsed = parseOpenCodeSearch(rawOutput);
        if (parsed) return parsed;

        const lines = rawOutput
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length > 0) return { matches: lines.map((l) => ({ excerpt: l })) };
        return {};
    }

    if (Array.isArray(rawOutput)) {
        const text = coerceTextFromContentBlocks(rawOutput);
        if (text) return { matches: [{ excerpt: text }] };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    if (Array.isArray((record as any).matches)) {
        return { matches: (record as any).matches };
    }

    return { ...record };
}

export function normalizeGrepInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.pattern !== 'string' && typeof out.query === 'string' && out.query.trim().length > 0) {
        out.pattern = out.query.trim();
    }

    return out;
}

export function normalizeGrepResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const lines = rawOutput.replace(/\r\n/g, '\n').split('\n');
        const matches: Array<{ filePath: string; line?: number; excerpt?: string }> = [];
        for (const line of lines) {
            const parsed = parseGrepLine(line);
            if (parsed) matches.push(parsed);
        }
        if (matches.length > 0) return { matches };
        const trimmed = rawOutput.trim();
        if (trimmed.length > 0) return { matches: [{ excerpt: trimmed }] };
        return {};
    }

    const record = asRecord(rawOutput);
    if (record && Array.isArray((record as any).matches)) return { matches: (record as any).matches };
    if (record) return { ...record };
    return { value: rawOutput };
}

export function normalizeLsInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.path !== 'string' && typeof out.dir === 'string' && out.dir.trim().length > 0) {
        out.path = out.dir.trim();
    }

    return out;
}

export function normalizeLsResult(rawOutput: unknown): UnknownRecord {
    if (Array.isArray(rawOutput)) {
        return { entries: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (record && Array.isArray((record as any).entries)) return { entries: (record as any).entries };
    if (record && Array.isArray((record as any).files)) return { entries: (record as any).files };
    if (record) return { ...record };
    return { value: rawOutput };
}
