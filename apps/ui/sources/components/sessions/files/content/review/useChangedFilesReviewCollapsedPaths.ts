import * as React from 'react';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function useChangedFilesReviewCollapsedPaths(input: {
    reviewFiles: readonly ScmFileStatus[];
}) {
    const { reviewFiles } = input;

    const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(() => new Set());

    React.useEffect(() => {
        setCollapsedPaths((prev) => {
            if (prev.size === 0) return prev;
            const allowed = new Set(reviewFiles.map((f) => f.fullPath).filter(Boolean));
            const next = new Set<string>();
            for (const p of prev) {
                if (allowed.has(p)) next.add(p);
            }
            return next.size === prev.size ? prev : next;
        });
    }, [reviewFiles]);

    const isCollapsed = React.useCallback((path: string) => collapsedPaths.has(path), [collapsedPaths]);

    const toggleCollapsed = React.useCallback((path: string) => {
        setCollapsedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const expandPath = React.useCallback((path: string) => {
        setCollapsedPaths((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Set(prev);
            next.delete(path);
            return next;
        });
    }, []);

    return {
        collapsedPaths,
        isCollapsed,
        toggleCollapsed,
        expandPath,
    };
}
