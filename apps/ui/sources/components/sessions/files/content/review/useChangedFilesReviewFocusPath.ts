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
    const appliedFocusPathRef = React.useRef<string | null>(null);
    const expandPathRef = React.useRef(expandPath);
    const scrollToPathRef = React.useRef(scrollToPath);

    expandPathRef.current = expandPath;
    scrollToPathRef.current = scrollToPath;

    React.useEffect(() => {
        const resolved = typeof focusPath === 'string' ? focusPath : null;
        if (!resolved) {
            appliedFocusPathRef.current = null;
            return;
        }
        if (appliedFocusPathRef.current === resolved) return;
        if (!reviewFiles.some((f) => f.fullPath === resolved)) return;
        appliedFocusPathRef.current = resolved;

        setHighlightedPath(resolved);
        expandPathRef.current(resolved);

        const scrollTimer = setTimeout(() => {
            scrollToPathRef.current(resolved);
        }, 50);
        const clearTimer = setTimeout(() => {
            setHighlightedPath(null);
        }, 8000);
        return () => {
            clearTimeout(scrollTimer);
            clearTimeout(clearTimer);
        };
    }, [focusPath, reviewFiles]);

    return highlightedPath;
}
