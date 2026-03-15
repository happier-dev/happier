import * as React from 'react';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function useChangedFilesReviewCollapsedPaths(input: {
    reviewFiles: readonly ScmFileStatus[];
    initialCollapsedPaths?: readonly string[] | null;
    onCollapsedPathsChange?: (paths: string[]) => void;
}) {
    const { reviewFiles } = input;

    const hasHydratedRef = React.useRef(false);
    const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(
        () => new Set(Array.isArray(input.initialCollapsedPaths) ? input.initialCollapsedPaths : [])
    );

    React.useEffect(() => {
        if (hasHydratedRef.current) return;
        hasHydratedRef.current = true;
        if (!Array.isArray(input.initialCollapsedPaths)) return;
        setCollapsedPaths(new Set(input.initialCollapsedPaths));
    }, [input.initialCollapsedPaths]);

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

    const lastPersistedRef = React.useRef<string[] | null>(null);
    React.useEffect(() => {
        if (!input.onCollapsedPathsChange) return;
        if (!hasHydratedRef.current) return;
        const next = Array.from(collapsedPaths);
        next.sort();
        const prev = lastPersistedRef.current;
        if (prev && prev.length === next.length && prev.every((v, i) => v === next[i])) return;
        lastPersistedRef.current = next;
        input.onCollapsedPathsChange(next);
    }, [collapsedPaths, input.onCollapsedPathsChange]);

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
