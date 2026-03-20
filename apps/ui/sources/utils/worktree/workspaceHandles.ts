function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function safeBasename(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) return '';
    const parts = trimmed.split(/[\\/]+/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
}

function safePathSegments(path: string): string[] {
    return path.trim().split(/[\\/]+/).filter(Boolean);
}

export function buildSafeWorkspaceLabel(params: Readonly<{ machineLabel: string; path: string }>): string {
    const machine = normalizeId(params.machineLabel) || 'machine';
    const base = safeBasename(params.path) || 'workspace';
    return `${base} — ${machine}`;
}

export function buildSafeWorkspaceLabels(params: Readonly<{ machineLabel: string; paths: ReadonlyArray<string> }>): Map<string, string> {
    const machine = normalizeId(params.machineLabel) || 'machine';
    const uniquePaths = Array.from(new Set(params.paths.map((path) => path.trim()).filter(Boolean)));
    const pathSegments = new Map<string, string[]>(uniquePaths.map((path) => [path, safePathSegments(path)]));
    const depths = new Map<string, number>(uniquePaths.map((path) => [path, 1]));

    let changed = true;
    while (changed) {
        changed = false;
        const grouped = new Map<string, string[]>();

        for (const path of uniquePaths) {
            const segments = pathSegments.get(path) ?? [];
            const depth = Math.min(depths.get(path) ?? 1, Math.max(segments.length, 1));
            const tail = segments.length > 0 ? segments.slice(-depth).join('/') : 'workspace';
            const label = `${tail} — ${machine}`;
            const group = grouped.get(label) ?? [];
            group.push(path);
            grouped.set(label, group);
        }

        for (const group of grouped.values()) {
            if (group.length <= 1) continue;
            for (const path of group) {
                const segments = pathSegments.get(path) ?? [];
                const currentDepth = depths.get(path) ?? 1;
                if (currentDepth < segments.length) {
                    depths.set(path, currentDepth + 1);
                    changed = true;
                }
            }
        }
    }

    return new Map(
        uniquePaths.map((path) => {
            const segments = pathSegments.get(path) ?? [];
            const depth = Math.min(depths.get(path) ?? 1, Math.max(segments.length, 1));
            const tail = segments.length > 0 ? segments.slice(-depth).join('/') : 'workspace';
            return [path, `${tail} — ${machine}`] as const;
        }),
    );
}
