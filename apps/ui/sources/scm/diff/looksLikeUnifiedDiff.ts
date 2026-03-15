export function looksLikeUnifiedDiff(diff: string): boolean {
    const text = typeof diff === 'string' ? diff.trim() : '';
    if (!text) return false;
    // Binary placeholders can appear either as a standalone line or inside a `diff --git` header.
    // Pierre's diff renderer expects real hunks or at least the unified `---/+++` prelude.
    if (/\bbinary files\b/i.test(text) || /\bgit binary patch\b/i.test(text)) return false;

    // Unified diffs always include at least one hunk marker.
    // Header-only diffs (rename-only, mode-only, empty-file adds/deletes, etc.) are not reliably renderable
    // and can trigger crashes in third-party viewers like Pierre.
    return text.includes('@@');
}
