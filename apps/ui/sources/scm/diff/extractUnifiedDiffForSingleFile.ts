type ExtractUnifiedDiffForSingleFileInput = Readonly<{
    patch: string;
    path: string;
}>;

function normalizePath(value: string): string {
    return value
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .trim();
}

function containsDiffHeaderForPath(headerLine: string, normalizedPath: string): boolean {
    const path = normalizedPath;
    if (!path) return false;

    // Typical formats:
    // - diff --git a/src/a.txt b/src/a.txt
    // - diff --git "a/src/a.txt" "b/src/a.txt"
    // - diff --git a/src/a.txt\tb/src/a.txt
    const aNeedle = `a/${path}`;
    const bNeedle = `b/${path}`;
    return headerLine.includes(aNeedle) || headerLine.includes(bNeedle);
}

export function extractUnifiedDiffForSingleFile(input: ExtractUnifiedDiffForSingleFileInput): string {
    const patch = typeof input.patch === 'string' ? input.patch : '';
    const normalizedPath = normalizePath(String(input.path ?? ''));
    if (!patch || !normalizedPath) return patch;

    const normalizedPatch = patch.replace(/\r\n/g, '\n');

    const diffHeaderMatches = normalizedPatch.match(/^diff --git /gm) ?? [];
    if (diffHeaderMatches.length <= 1) return patch;

    const lines = normalizedPatch.split('\n');
    const headerIndices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (line.startsWith('diff --git ')) headerIndices.push(i);
    }
    if (headerIndices.length <= 1) return patch;

    for (let i = 0; i < headerIndices.length; i += 1) {
        const start = headerIndices[i]!;
        const end = headerIndices[i + 1] ?? lines.length;
        const headerLine = lines[start] ?? '';

        if (!containsDiffHeaderForPath(headerLine, normalizedPath)) continue;

        const segment = lines.slice(start, end).join('\n');
        // Preserve the original patch's line ending convention at the edges.
        return patch.includes('\r\n') ? segment.replace(/\n/g, '\r\n') : segment;
    }

    return patch;
}
