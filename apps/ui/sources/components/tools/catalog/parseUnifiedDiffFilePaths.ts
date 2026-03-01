export function parseUnifiedDiffFilePaths(unifiedDiff: string): string[] {
    const lines = unifiedDiff.split('\n');

    const normalizeDiffPath = (raw: string): string => {
        let out = String(raw ?? '').trim();
        if (!out) return '';
        // Drop surrounding quotes if present.
        if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
            out = out.slice(1, -1);
        }
        // Best-effort: unescape common git diff escaping for spaces and quotes.
        out = out.replace(/\\ /g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        out = out.replace(/^a\//, '').replace(/^b\//, '');
        return out;
    };

    const splitGitHeaderTokens = (line: string): string[] => {
        const out: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i] ?? '';
            if (ch === '\\') {
                const next = line[i + 1];
                if (typeof next === 'string') {
                    current += next;
                    i += 1;
                    continue;
                }
            }
            if (ch === '"') {
                inQuotes = !inQuotes;
                current += ch;
                continue;
            }
            if (!inQuotes && ch === ' ') {
                if (current.length > 0) out.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.length > 0) out.push(current);
        return out;
    };

    // Prefer `diff --git a/... b/...` which is robust across new/deleted/renamed files.
    const fromGitHeader: string[] = [];
    for (const line of lines) {
        if (!line.startsWith('diff --git ')) continue;
        const parts = splitGitHeaderTokens(line);
        const bPart = parts[3] ?? null;
        if (!bPart) continue;
        const filePath = normalizeDiffPath(bPart);
        if (filePath && filePath !== '/dev/null') fromGitHeader.push(filePath);
    }
    if (fromGitHeader.length > 0) return Array.from(new Set(fromGitHeader));

    // Fallback: scan `+++` lines if the diff format is missing `diff --git`.
    const fromPlusPlus: string[] = [];
    for (const line of lines) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            const filePath = normalizeDiffPath(line.replace(/^\+\+\+ (b\/)?/, ''));
            if (filePath && filePath !== '/dev/null') fromPlusPlus.push(filePath);
        }
    }
    return Array.from(new Set(fromPlusPlus));
}
