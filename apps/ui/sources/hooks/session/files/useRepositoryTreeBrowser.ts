import * as React from 'react';

import {
    listRepositoryDirectoryEntries,
    type ListRepositoryDirectoryEntriesResult,
    type RepositoryDirectoryEntry,
} from '@/sync/domains/input/repositoryDirectory';

type RepositoryTreeNode = {
    path: string;
    name: string;
    type: 'file' | 'directory' | 'error';
    depth: number;
    isExpanded: boolean;
    isLoadingChildren: boolean;
    parentDirectoryPath?: string;
    errorMessage?: string;
};

function joinPath(parent: string, name: string): string {
    const trimmedParent = parent.trim().replace(/\/+$/g, '');
    const trimmedName = name.trim().replace(/^\/+/g, '');
    if (!trimmedParent) return trimmedName;
    if (!trimmedName) return trimmedParent;
    return `${trimmedParent}/${trimmedName}`;
}

function normalizeDirectoryPath(input: string): string {
    return input.trim().replace(/\/+$/g, '');
}

function normalizeExpandedPaths(paths: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of paths) {
        if (typeof raw !== 'string') continue;
        const clean = normalizeDirectoryPath(raw);
        if (!clean) continue;
        if (seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

function flattenTree(input: {
    directoryPath: string;
    depth: number;
    directoryEntriesByPath: Map<string, RepositoryDirectoryEntry[]>;
    expandedDirectories: Set<string>;
    loadingDirectories: Set<string>;
    directoryErrors: Map<string, string>;
    visited: Set<string>;
}): RepositoryTreeNode[] {
    if (input.visited.has(input.directoryPath)) return [];
    input.visited.add(input.directoryPath);

    const entries = input.directoryEntriesByPath.get(input.directoryPath) ?? [];
    const out: RepositoryTreeNode[] = [];

    for (const entry of entries) {
        const entryPath = joinPath(input.directoryPath, entry.name);
        const isExpanded = entry.type === 'directory' && input.expandedDirectories.has(entryPath);
        const hasChildrenLoaded = entry.type === 'directory' && input.directoryEntriesByPath.has(entryPath);
        const dirErrorMessage = entry.type === 'directory' ? input.directoryErrors.get(entryPath) : undefined;
        const isLoadingChildren = entry.type === 'directory'
            && (input.loadingDirectories.has(entryPath) || (isExpanded && !hasChildrenLoaded && !dirErrorMessage));

        out.push({
            path: entryPath,
            name: entry.name,
            type: entry.type,
            depth: input.depth,
            isExpanded,
            isLoadingChildren,
        });

        if (entry.type === 'directory' && isExpanded) {
            if (dirErrorMessage) {
                out.push({
                    path: entryPath,
                    name: '',
                    type: 'error',
                    depth: input.depth + 1,
                    isExpanded: false,
                    isLoadingChildren: false,
                    parentDirectoryPath: entryPath,
                    errorMessage: dirErrorMessage,
                });
                continue;
            }

            out.push(
                ...flattenTree({
                    directoryPath: entryPath,
                    depth: input.depth + 1,
                    directoryEntriesByPath: input.directoryEntriesByPath,
                    expandedDirectories: input.expandedDirectories,
                    loadingDirectories: input.loadingDirectories,
                    directoryErrors: input.directoryErrors,
                    visited: input.visited,
                })
            );
        }
    }

    return out;
}

export function useRepositoryTreeBrowser(input: {
    sessionId: string;
    enabled: boolean;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
}) {
    const { sessionId, enabled, expandedPaths, onExpandedPathsChange } = input;
    const sessionIdRef = React.useRef(sessionId);
    React.useEffect(() => {
        sessionIdRef.current = sessionId;
    }, [sessionId]);
    const useExternalExpanded = Array.isArray(expandedPaths) && typeof onExpandedPathsChange === 'function';

    const [rootLoading, setRootLoading] = React.useState(false);
    const [rootError, setRootError] = React.useState<string | null>(null);
    const [directoryEntriesByPath, setDirectoryEntriesByPath] = React.useState<Map<string, RepositoryDirectoryEntry[]>>(
        () => new Map()
    );
    const [internalExpandedPaths, setInternalExpandedPaths] = React.useState<string[]>([]);
    const [loadingDirectories, setLoadingDirectories] = React.useState<Set<string>>(() => new Set());
    const [directoryErrors, setDirectoryErrors] = React.useState<Map<string, string>>(() => new Map());

    const normalizedExternalExpandedPaths = React.useMemo(() => {
        if (!useExternalExpanded) return null;
        return normalizeExpandedPaths(expandedPaths!);
    }, [expandedPaths, useExternalExpanded]);

    const currentExpandedPaths = useExternalExpanded ? normalizedExternalExpandedPaths! : internalExpandedPaths;
    const expandedDirectories = React.useMemo(
        () => new Set<string>(currentExpandedPaths),
        [currentExpandedPaths]
    );
    const expandedCount = expandedDirectories.size;

    const setExpandedPaths = React.useCallback((next: string[] | ((prev: string[]) => string[])) => {
        if (useExternalExpanded) {
            const resolvedPrev = currentExpandedPaths;
            const resolvedNext = typeof next === 'function' ? next(resolvedPrev) : next;
            onExpandedPathsChange!(normalizeExpandedPaths(resolvedNext));
            return;
        }

        setInternalExpandedPaths((prev) => normalizeExpandedPaths(typeof next === 'function' ? next(prev) : next));
    }, [currentExpandedPaths, onExpandedPathsChange, useExternalExpanded]);

    React.useEffect(() => {
        setDirectoryEntriesByPath(new Map());
        setInternalExpandedPaths([]);
        setLoadingDirectories(new Set());
        setDirectoryErrors(new Map());
        setRootError(null);
    }, [sessionId]);

    const loadingRef = React.useRef<Set<string>>(new Set());

    const applyDirectoryLoadResult = React.useCallback((directoryPath: string, result: ListRepositoryDirectoryEntriesResult) => {
        if (result.ok) {
            setDirectoryEntriesByPath((prev) => {
                const next = new Map(prev);
                next.set(directoryPath, result.entries);
                return next;
            });
            setDirectoryErrors((prev) => {
                if (!prev.has(directoryPath)) return prev;
                const next = new Map(prev);
                next.delete(directoryPath);
                return next;
            });
            return;
        }

        const message = typeof result.error === 'string' ? result.error.trim() : '';
        setDirectoryErrors((prev) => {
            const next = new Map(prev);
            next.set(directoryPath, message || 'unknown_error');
            return next;
        });
    }, []);

    React.useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        const loadRoot = async () => {
            setRootLoading(true);
            setRootError(null);
            try {
                const result = await listRepositoryDirectoryEntries({ sessionId, directoryPath: '' });
                if (cancelled) return;
                if (result.ok) {
                    setDirectoryEntriesByPath((prev) => {
                        const next = new Map(prev);
                        next.set('', result.entries);
                        return next;
                    });
                } else {
                    const err = typeof result.error === 'string' ? result.error.trim() : '';
                    setRootError(err || 'unknown_error');
                }
            } finally {
                if (!cancelled) setRootLoading(false);
            }
        };

        loadRoot();
        return () => {
            cancelled = true;
        };
    }, [enabled, sessionId]);

    const loadDirectory = React.useCallback(async (directoryPath: string) => {
        const clean = normalizeDirectoryPath(directoryPath);
        if (!clean) return;
        if (directoryEntriesByPath.has(clean) || loadingRef.current.has(clean)) {
            return;
        }

        const requestSessionId = sessionId;
        loadingRef.current.add(clean);
        setLoadingDirectories((prev) => {
            const next = new Set(prev);
            next.add(clean);
            return next;
        });

        try {
            const result = await listRepositoryDirectoryEntries({ sessionId: requestSessionId, directoryPath: clean });
            if (sessionIdRef.current !== requestSessionId) {
                return;
            }
            applyDirectoryLoadResult(clean, result);
        } finally {
            loadingRef.current.delete(clean);
            setLoadingDirectories((prev) => {
                const next = new Set(prev);
                next.delete(clean);
                return next;
            });
        }
    }, [applyDirectoryLoadResult, directoryEntriesByPath, sessionId]);

    const toggleDirectory = React.useCallback(async (path: string) => {
        const clean = normalizeDirectoryPath(path);
        if (!clean) return;

        const isExpanded = expandedDirectories.has(clean);
        if (isExpanded) {
            setExpandedPaths((prev) => prev.filter((p) => normalizeDirectoryPath(p) !== clean));
            return;
        }

        setExpandedPaths((prev) => [...prev, clean]);
        await loadDirectory(clean);
    }, [expandedDirectories, loadDirectory, setExpandedPaths]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, [setExpandedPaths]);

    const retryRoot = React.useCallback(async () => {
        setRootError(null);
        setRootLoading(true);
        try {
            const result = await listRepositoryDirectoryEntries({ sessionId, directoryPath: '' });
            if (result.ok) {
                setDirectoryEntriesByPath((prev) => {
                    const next = new Map(prev);
                    next.set('', result.entries);
                    return next;
                });
            } else {
                const err = typeof result.error === 'string' ? result.error.trim() : '';
                setRootError(err || 'unknown_error');
            }
        } finally {
            setRootLoading(false);
        }
    }, [sessionId]);

    const retryDirectory = React.useCallback(async (directoryPath: string) => {
        const clean = normalizeDirectoryPath(directoryPath);
        if (!clean) return;
        setDirectoryErrors((prev) => {
            if (!prev.has(clean)) return prev;
            const next = new Map(prev);
            next.delete(clean);
            return next;
        });
        await loadDirectory(clean);
    }, [loadDirectory]);

    React.useEffect(() => {
        if (!enabled) return;
        if (directoryEntriesByPath.size === 0) return;
        if (expandedDirectories.size === 0) return;

        let cancelled = false;
        const loadMissing = async () => {
            for (const dir of expandedDirectories) {
                if (cancelled) return;
                if (!dir) continue;
                if (directoryEntriesByPath.has(dir)) continue;
                if (directoryErrors.has(dir)) continue;
                if (loadingRef.current.has(dir)) continue;

                loadingRef.current.add(dir);
                setLoadingDirectories((prev) => {
                    const next = new Set(prev);
                    next.add(dir);
                    return next;
                });

                try {
                    const result = await listRepositoryDirectoryEntries({ sessionId, directoryPath: dir });
                    if (cancelled) return;
                    applyDirectoryLoadResult(dir, result);
                } finally {
                    loadingRef.current.delete(dir);
                    if (!cancelled) {
                        setLoadingDirectories((prev) => {
                            const next = new Set(prev);
                            next.delete(dir);
                            return next;
                        });
                    }
                }
            }
        };

        loadMissing();
        return () => {
            cancelled = true;
        };
    }, [applyDirectoryLoadResult, directoryEntriesByPath, directoryErrors, enabled, expandedDirectories, sessionId]);

    const nodes = React.useMemo(() => {
        if (!enabled) return [];
        return flattenTree({
            directoryPath: '',
            depth: 0,
            directoryEntriesByPath,
            expandedDirectories,
            loadingDirectories,
            directoryErrors,
            visited: new Set<string>(),
        });
    }, [directoryEntriesByPath, directoryErrors, enabled, expandedDirectories, loadingDirectories]);

    return {
        rootLoading,
        rootError,
        nodes,
        toggleDirectory,
        collapseAll,
        expandedCount,
        retryRoot,
        retryDirectory,
    };
}
