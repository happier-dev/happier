export function changedFilesReviewAnchorId(fullPath: string): string {
    // Stable and DOM-safe anchor id for RN-web `nativeID` and document queries.
    // We keep it human-readable for debugging.
    return `scm-review:${encodeURIComponent(fullPath)}`;
}

