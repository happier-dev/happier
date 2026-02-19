export function parseUnifiedDiffFilePaths(unifiedDiff: string): string[] {
    const lines = unifiedDiff.split('\n');

    // Prefer `diff --git a/... b/...` which is robust across new/deleted/renamed files.
    const fromGitHeader: string[] = [];
    for (const line of lines) {
        if (!line.startsWith('diff --git ')) continue;
        const parts = line.split(' ');
        const bPart = parts[3] ?? null;
        if (!bPart) continue;
        const filePath = bPart.replace(/^b\//, '');
        if (filePath && filePath !== '/dev/null') fromGitHeader.push(filePath);
    }
    if (fromGitHeader.length > 0) return Array.from(new Set(fromGitHeader));

    // Fallback: scan `+++` lines if the diff format is missing `diff --git`.
    const fromPlusPlus: string[] = [];
    for (const line of lines) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            const filePath = line.replace(/^\+\+\+ (b\/)?/, '');
            if (filePath && filePath !== '/dev/null') fromPlusPlus.push(filePath);
        }
    }
    return Array.from(new Set(fromPlusPlus));
}

