function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveSessionWorkspacePath(input: Readonly<{
    sessionPath?: string | null;
    projectPath?: string | null;
}>): string | null {
    return normalizeNonEmptyString(input.sessionPath) ?? normalizeNonEmptyString(input.projectPath);
}

