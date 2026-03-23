function hasFilePath(entry: Record<string, unknown>): boolean {
    return ['file_path', 'filePath', 'path'].some((key) => {
        const value = entry[key];
        return typeof value === 'string' && value.trim().length > 0;
    });
}

export function isClaudeExplicitDiffToolInput(toolName: string, input: unknown): boolean {
    if (toolName !== 'Diff') return false;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const rawFiles = (input as Record<string, unknown>).files;
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) return false;
    return rawFiles.some((entry) => Boolean(entry) && typeof entry === 'object' && hasFilePath(entry as Record<string, unknown>));
}
