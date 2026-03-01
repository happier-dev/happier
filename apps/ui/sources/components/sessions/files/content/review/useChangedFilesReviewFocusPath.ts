import * as React from 'react';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function useChangedFilesReviewFocusPath(input: Readonly<{
    focusPath: string | null;
    reviewFiles: readonly ScmFileStatus[];
    expandPath: (path: string) => void;
    scrollToPath: (path: string) => void;
}>): string | null {
    const focusPath = input.focusPath;
    const reviewFiles = input.reviewFiles;
    const expandPath = input.expandPath;
    const scrollToPath = input.scrollToPath;

    const [highlightedPath, setHighlightedPath] = React.useState<string | null>(null);

    React.useEffect(() => {
        const resolved = typeof focusPath === 'string' ? focusPath : null;
        if (!resolved) return;
        if (!reviewFiles.some((f) => f.fullPath === resolved)) return;

        setHighlightedPath(resolved);
        expandPath(resolved);

        const scrollTimer = setTimeout(() => {
            scrollToPath(resolved);
        }, 50);
        const clearTimer = setTimeout(() => {
            setHighlightedPath(null);
        }, 8000);
        return () => {
            clearTimeout(scrollTimer);
            clearTimeout(clearTimer);
        };
    }, [expandPath, focusPath, reviewFiles, scrollToPath]);

    return highlightedPath;
}
