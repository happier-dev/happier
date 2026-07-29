import { asRecord, firstNonEmptyString } from './_shared';

type SearchMatch = { filePath?: string; line?: number; excerpt?: string };

function readReleasedCodeSearchAggregateCount(record: Record<string, unknown>): number | null {
    const totalMatches = record.totalMatches;
    if (typeof totalMatches === 'number' && Number.isSafeInteger(totalMatches) && totalMatches >= 0) {
        return totalMatches;
    }
    const totalFiles = record.totalFiles;
    if (typeof totalFiles === 'number' && Number.isSafeInteger(totalFiles) && totalFiles >= 0) {
        return totalFiles;
    }
    return null;
}

function hasSearchError(record: Record<string, unknown>): boolean {
    const error = record.error;
    return record.isError === true
        || error === true
        || (typeof error === 'string' && error.trim().length > 0)
        || (error !== null && typeof error === 'object')
        || record.status === 'error'
        || record.status === 'failed';
}

// cli-v0.2.1 (b1d15a8) persisted CodeSearch aggregates as an explicit empty
// matches array plus a positive aggregate count. Newer producers own the
// canonical detailsUnavailable marker, so this adapter stays exact and narrow.
function normalizeReleasedCodeSearchAggregateRecord(
    record: Record<string, unknown>,
): Record<string, unknown> | null {
    if (hasSearchError(record) || !Array.isArray(record.matches) || record.matches.length !== 0) {
        return null;
    }
    const count = readReleasedCodeSearchAggregateCount(record);
    if (count === null || count === 0 || record.detailsUnavailable === true) {
        return null;
    }
    return { ...record, detailsUnavailable: true };
}

function normalizeStringLines(value: string): string[] {
    return value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

function parseGrepLine(line: string): SearchMatch | null {
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

function normalizeMatchObject(value: unknown): SearchMatch | null {
    const record = asRecord(value);
    if (!record) return null;
    const filePath =
        typeof (record as any).filePath === 'string'
            ? (record as any).filePath
            : typeof (record as any).file_path === 'string'
                ? (record as any).file_path
                : typeof (record as any).path === 'string'
                    ? (record as any).path
                    : typeof (record as any).file === 'string'
                        ? (record as any).file
                        : undefined;
    const line =
        typeof (record as any).line === 'number'
            ? (record as any).line
            : typeof (record as any).line_number === 'number'
                ? (record as any).line_number
                : undefined;
    const excerpt =
        typeof (record as any).excerpt === 'string'
            ? (record as any).excerpt
            : typeof (record as any).text === 'string'
                ? (record as any).text
                : typeof (record as any).snippet === 'string'
                    ? (record as any).snippet
                    : undefined;

    if (!filePath && !excerpt) return null;
    return { filePath, line, excerpt };
}

export function normalizeGlobResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).matches) && (record as any).matches.every((v: any) => typeof v === 'string')) {
        return null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { matches: result };
    }

    if (typeof result === 'string') {
        const lines = normalizeStringLines(result);
        if (lines.length > 0) return { matches: lines };
    }

    if (record && Array.isArray((record as any).files) && (record as any).files.every((v: any) => typeof v === 'string')) {
        return { matches: (record as any).files };
    }

    return null;
}

export function normalizeLsResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).entries) && (record as any).entries.every((v: any) => typeof v === 'string')) {
        return null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { entries: result };
    }

    if (typeof result === 'string') {
        const lines = normalizeStringLines(result);
        if (lines.length > 0) return { entries: lines };
    }

    if (record && Array.isArray((record as any).files) && (record as any).files.every((v: any) => typeof v === 'string')) {
        return { entries: (record as any).files };
    }

    return null;
}

export function normalizeGrepResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).matches)) {
        const matches = (record as any).matches as unknown[];
        const normalized = matches
            .map((m) => {
                if (typeof m === 'string') return { excerpt: m } satisfies SearchMatch;
                return normalizeMatchObject(m);
            })
            .filter(Boolean);
        // If every entry was already a canonical-looking match object, keep the original.
        const allCanonicalObjects =
            matches.length > 0 &&
            matches.every((m) => {
                const rec = asRecord(m);
                return !!rec && (typeof (rec as any).filePath === 'string' || typeof (rec as any).excerpt === 'string');
        });
        if (allCanonicalObjects) return null;
        return normalized.length > 0 ? { ...record, matches: normalized } : null;
    }

    if (typeof result === 'string') {
        const lines = normalizeStringLines(result);
        const matches: SearchMatch[] = [];
        for (const line of lines) {
            const parsed = parseGrepLine(line);
            if (parsed) matches.push(parsed);
            else matches.push({ excerpt: line });
        }
        return matches.length > 0 ? { matches } : null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { matches: (result as string[]).map((s) => ({ excerpt: s })) };
    }

    if (record && typeof (record as any).stdout === 'string') {
        return normalizeGrepResultForRendering((record as any).stdout);
    }

    return null;
}

function parseGroupedLineSearch(text: string): { matches: SearchMatch[] } | null {
    if (!text.includes('matches')) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const matches: SearchMatch[] = [];
    let currentFile: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        if (!line.startsWith(' ') && trimmed.endsWith(':') && trimmed.includes('/')) {
            currentFile = trimmed.slice(0, -1);
            continue;
        }

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

        const grep = parseGrepLine(line);
        if (grep) matches.push(grep);
    }

    return matches.length > 0 ? { matches } : null;
}

export function normalizeCodeSearchResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).matches)) {
        const matches = (record as any).matches as unknown[];
        const normalized = matches
            .map((m) => {
                if (typeof m === 'string') return { excerpt: m } satisfies SearchMatch;
                return normalizeMatchObject(m);
            })
            .filter(Boolean);
        const allCanonicalObjects =
            matches.length > 0 &&
            matches.every((m) => {
                const rec = asRecord(m);
                return !!rec && (typeof (rec as any).filePath === 'string' || typeof (rec as any).excerpt === 'string');
        });
        if (allCanonicalObjects) return null;
        if (normalized.length > 0) return { ...record, matches: normalized };
        return normalizeReleasedCodeSearchAggregateRecord(record);
    }

    if (typeof result === 'string') {
        const parsed = parseGroupedLineSearch(result);
        if (parsed) return parsed;
        const lines = normalizeStringLines(result);
        if (lines.length > 0) return { matches: lines.map((line) => ({ excerpt: line })) };
        return null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { matches: (result as string[]).map((s) => ({ excerpt: s })) };
    }

    if (record && typeof (record as any).stdout === 'string') {
        return normalizeCodeSearchResultForRendering((record as any).stdout);
    }

    return null;
}

export function normalizeReasoningResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (!record) return null;
    if (typeof (record as any).content === 'string' && (record as any).content.trim().length > 0) return null;

    const content =
        firstNonEmptyString((record as any).text) ??
        firstNonEmptyString((record as any).reasoning) ??
        null;
    if (!content) return null;
    return { ...record, content };
}
