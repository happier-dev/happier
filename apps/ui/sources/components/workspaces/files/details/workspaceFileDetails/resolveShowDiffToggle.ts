export function resolveShowDiffToggle(input: Readonly<{
    diffContent: string | null;
    hasPendingDelta: boolean;
    hasIncludedDelta: boolean;
    fileIsBinary: boolean;
}>): boolean {
    if (input.fileIsBinary) {
        // Binary diffs are often placeholders or non-hunk headers; prefer the file preview instead.
        // Only show the diff toggle when we have an explicit unified diff string to render.
        const diff = input.diffContent;
        return typeof diff === 'string' && diff.trim().length > 0;
    }

    if (input.hasPendingDelta || input.hasIncludedDelta) return true;
    const diff = input.diffContent;
    if (!diff) return false;
    // Only show the diff toggle when we have strong evidence that the diff actually contains changes.
    // Some SCM implementations return a "no changes" message string instead of an empty diff.
    return diff.includes('diff --git ') || diff.includes('@@');
}
