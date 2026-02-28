export type SaplingDiffStats = Readonly<{
    pendingAdded: number;
    pendingRemoved: number;
    isBinary: boolean;
}>;

export function parseGitPatchDiffStats(diff: string): ReadonlyMap<string, SaplingDiffStats> {
    const stats = new Map<string, { pendingAdded: number; pendingRemoved: number; isBinary: boolean }>();
    let currentPath: string | null = null;

    const ensure = (path: string) => {
        const existing = stats.get(path);
        if (existing) return existing;
        const created = { pendingAdded: 0, pendingRemoved: 0, isBinary: false };
        stats.set(path, created);
        return created;
    };

    const lines = diff.split(/\r?\n/g);
    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            currentPath = match ? (match[2] || match[1] || null) : null;
            if (currentPath) ensure(currentPath);
            continue;
        }

        if (!currentPath) continue;

        if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
            ensure(currentPath).isBinary = true;
            continue;
        }

        if (!line) continue;
        const first = line[0];
        if (first !== '+' && first !== '-') continue;

        // Skip diff headers.
        if (line.startsWith('+++') || line.startsWith('---')) continue;

        const entry = ensure(currentPath);
        if (entry.isBinary) continue;

        if (first === '+') entry.pendingAdded += 1;
        else entry.pendingRemoved += 1;
    }

    return stats;
}

