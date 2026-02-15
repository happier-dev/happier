export function changedFilesListAnchorId(fullPath: string): string {
    // Stable and DOM-safe anchor id for RN-web `nativeID` and document queries.
    return `scm-list:${encodeURIComponent(fullPath)}`;
}

