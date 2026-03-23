import * as React from 'react';

import { flattenLazyDirectoryTree } from './flattenLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult } from './lazyDirectoryTreeTypes';

function normalizeDirectoryPath(input: string): string {
    const trimmed = input.trim();
    if (trimmed === '/') return '/';
    const windowsRootMatch = /^([A-Za-z]:)[\\/]*$/.exec(trimmed);
    if (windowsRootMatch) {
        return `${windowsRootMatch[1]}\\`;
    }
    return trimmed.replace(/\/+$/g, '');
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

function seedDirectoryEntriesByPathFromCache(input: Readonly<{
    rootDirectoryPath: string;
    expandedPaths: readonly string[] | null;
    getCachedEntries: (directoryPath: string) => LazyDirectoryTreeEntry[] | null;
}>): Map<string, LazyDirectoryTreeEntry[]> {
    const map = new Map<string, LazyDirectoryTreeEntry[]>();
    const root = input.getCachedEntries(input.rootDirectoryPath);
    if (root) map.set(input.rootDirectoryPath, root);
    if (Array.isArray(input.expandedPaths)) {
        for (const dir of input.expandedPaths) {
            const clean = normalizeDirectoryPath(dir);
            if (!clean) continue;
            const cached = input.getCachedEntries(clean);
            if (cached) map.set(clean, cached);
        }
    }
    return map;
}

function seedDirectoryTruncationByPathFromCache(input: Readonly<{
    rootDirectoryPath: string;
    expandedPaths: readonly string[] | null;
    getCachedDirectoryMetadata?: ((directoryPath: string) => Readonly<{ truncated?: boolean }> | null) | null;
}>): Map<string, boolean> {
    const map = new Map<string, boolean>();
    if (!input.getCachedDirectoryMetadata) return map;

    const includeDirectory = (directoryPath: string) => {
        const metadata = input.getCachedDirectoryMetadata?.(directoryPath);
        if (!metadata) return;
        map.set(directoryPath, metadata.truncated === true);
    };

    includeDirectory(input.rootDirectoryPath);
    if (Array.isArray(input.expandedPaths)) {
        for (const dir of input.expandedPaths) {
            const clean = normalizeDirectoryPath(dir);
            if (!clean) continue;
            includeDirectory(clean);
        }
    }

    return map;
}

export function useLazyDirectoryTree(input: {
    scopeKey: string;
    enabled: boolean;
    rootDirectoryPath: string;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
    reloadToken?: number;
    getCachedEntries: (directoryPath: string) => LazyDirectoryTreeEntry[] | null;
    getCachedDirectoryMetadata?: (directoryPath: string) => Readonly<{ truncated?: boolean }> | null;
    loadDirectoryEntries: (directoryPath: string) => Promise<LazyDirectoryTreeLoadResult>;
    warmDirectoryEntries?: ((directoryPath: string) => Promise<LazyDirectoryTreeLoadResult>) | null;
    warmChildDirectoriesLimit?: number;
}) {
    const {
        scopeKey,
        enabled,
        rootDirectoryPath,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken,
        getCachedEntries,
        getCachedDirectoryMetadata,
        loadDirectoryEntries,
        warmDirectoryEntries,
        warmChildDirectoriesLimit = 0,
    } = input;
    const scopeKeyRef = React.useRef(scopeKey);
    React.useEffect(() => {
        scopeKeyRef.current = scopeKey;
    }, [scopeKey]);

    const useExternalExpanded = Array.isArray(expandedPaths) && typeof onExpandedPathsChange === 'function';
    const expandedPathsRef = React.useRef(expandedPaths);
    const useExternalExpandedRef = React.useRef(useExternalExpanded);
    React.useEffect(() => {
        expandedPathsRef.current = expandedPaths;
        useExternalExpandedRef.current = useExternalExpanded;
    }, [expandedPaths, useExternalExpanded]);

    const [rootLoading, setRootLoading] = React.useState(false);
    const [rootError, setRootError] = React.useState<string | null>(null);
    const [directoryEntriesByPath, setDirectoryEntriesByPath] = React.useState<Map<string, LazyDirectoryTreeEntry[]>>(() => {
        const seedExpandedPaths = useExternalExpanded ? normalizeExpandedPaths(expandedPaths!) : null;
        return seedDirectoryEntriesByPathFromCache({ rootDirectoryPath, expandedPaths: seedExpandedPaths, getCachedEntries });
    });
    const [directoryTruncationByPath, setDirectoryTruncationByPath] = React.useState<Map<string, boolean>>(() => {
        const seedExpandedPaths = useExternalExpanded ? normalizeExpandedPaths(expandedPaths!) : null;
        return seedDirectoryTruncationByPathFromCache({
            rootDirectoryPath,
            expandedPaths: seedExpandedPaths,
            getCachedDirectoryMetadata,
        });
    });
    const [internalExpandedPaths, setInternalExpandedPaths] = React.useState<string[]>([]);
    const [loadingDirectories, setLoadingDirectories] = React.useState<Set<string>>(() => new Set());
    const [directoryErrors, setDirectoryErrors] = React.useState<Map<string, string>>(() => new Map());

    const normalizedExternalExpandedPaths = React.useMemo(() => {
        if (!useExternalExpanded) return null;
        return normalizeExpandedPaths(expandedPaths!);
    }, [expandedPaths, useExternalExpanded]);

    const currentExpandedPaths = useExternalExpanded ? normalizedExternalExpandedPaths! : internalExpandedPaths;
    const expandedDirectories = React.useMemo(() => new Set<string>(currentExpandedPaths), [currentExpandedPaths]);
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
        const seedExpandedPaths =
            useExternalExpandedRef.current
                ? normalizeExpandedPaths(Array.isArray(expandedPathsRef.current) ? expandedPathsRef.current : [])
                : null;
        setDirectoryEntriesByPath(seedDirectoryEntriesByPathFromCache({ rootDirectoryPath, expandedPaths: seedExpandedPaths, getCachedEntries }));
        setDirectoryTruncationByPath(seedDirectoryTruncationByPathFromCache({
            rootDirectoryPath,
            expandedPaths: seedExpandedPaths,
            getCachedDirectoryMetadata,
        }));
        setInternalExpandedPaths([]);
        setLoadingDirectories(new Set());
        setDirectoryErrors(new Map());
        setRootError(null);
    }, [getCachedDirectoryMetadata, getCachedEntries, rootDirectoryPath, scopeKey]);

    const loadingRef = React.useRef<Set<string>>(new Set());
    const pendingForcedReloadsRef = React.useRef<Set<string>>(new Set());
    const previousReloadTokenRef = React.useRef(reloadToken);
    const shouldForceReloadExpandedDirectories = reloadToken !== previousReloadTokenRef.current;
    React.useEffect(() => {
        previousReloadTokenRef.current = reloadToken;
    }, [reloadToken]);

    const applyDirectoryLoadResult = React.useCallback((directoryPath: string, result: LazyDirectoryTreeLoadResult) => {
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
            setDirectoryTruncationByPath((prev) => {
                const next = new Map(prev);
                next.set(directoryPath, result.truncated === true);
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
        pendingForcedReloadsRef.current.clear();
    }, [scopeKey]);

    const warmChildren = React.useCallback((entries: readonly LazyDirectoryTreeEntry[]) => {
        if (!warmDirectoryEntries || warmChildDirectoriesLimit <= 0) return;
        const childDirectories = entries
            .filter((entry) => entry.type === 'directory')
            .slice(0, warmChildDirectoriesLimit);
        for (const entry of childDirectories) {
            void warmDirectoryEntries(entry.path);
        }
    }, [warmChildDirectoriesLimit, warmDirectoryEntries]);

    const loadDirectory = React.useCallback(async (directoryPath: string, options?: Readonly<{ forceReload?: boolean }>) => {
        const clean = directoryPath === rootDirectoryPath ? rootDirectoryPath : normalizeDirectoryPath(directoryPath);
        if (!clean && clean !== rootDirectoryPath) return;
        if (loadingRef.current.has(clean)) {
            if (options?.forceReload) {
                pendingForcedReloadsRef.current.add(clean);
            }
            return;
        }
        if (options?.forceReload !== true && (directoryEntriesByPath.has(clean) || directoryErrors.has(clean))) {
            return;
        }

        const requestScopeKey = scopeKey;
        loadingRef.current.add(clean);
        setLoadingDirectories((prev) => {
            const next = new Set(prev);
            next.add(clean);
            return next;
        });

        try {
            const result = await loadDirectoryEntries(clean);
            if (scopeKeyRef.current !== requestScopeKey) {
                return;
            }
            applyDirectoryLoadResult(clean, result);
            if (result.ok) {
                warmChildren(result.entries);
            }
        } finally {
            loadingRef.current.delete(clean);
            setLoadingDirectories((prev) => {
                const next = new Set(prev);
                next.delete(clean);
                return next;
            });
            if (pendingForcedReloadsRef.current.delete(clean) && scopeKeyRef.current === requestScopeKey) {
                void loadDirectory(clean, { forceReload: true });
            }
        }
    }, [applyDirectoryLoadResult, directoryEntriesByPath, directoryErrors, loadDirectoryEntries, rootDirectoryPath, scopeKey, warmChildren]);

    React.useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        const loadRoot = async () => {
            setRootLoading(true);
            setRootError(null);
            try {
                const result = await loadDirectoryEntries(rootDirectoryPath);
                if (cancelled || scopeKeyRef.current !== scopeKey) return;
                if (result.ok) {
                    setDirectoryEntriesByPath((prev) => {
                        const next = new Map(prev);
                        next.set(rootDirectoryPath, result.entries);
                        return next;
                    });
                    setDirectoryTruncationByPath((prev) => {
                        const next = new Map(prev);
                        next.set(rootDirectoryPath, result.truncated === true);
                        return next;
                    });
                    warmChildren(result.entries);
                } else {
                    const err = typeof result.error === 'string' ? result.error.trim() : '';
                    setRootError(err || 'unknown_error');
                }
            } finally {
                if (!cancelled) setRootLoading(false);
            }
        };

        void loadRoot();
        return () => {
            cancelled = true;
        };
    }, [enabled, loadDirectoryEntries, reloadToken, rootDirectoryPath, scopeKey, warmChildren]);

    const toggleDirectory = React.useCallback(async (path: string) => {
        const clean = normalizeDirectoryPath(path);
        if (!clean) return;

        const isExpanded = expandedDirectories.has(clean);
        if (isExpanded) {
            setExpandedPaths((prev) => prev.filter((value) => normalizeDirectoryPath(value) !== clean));
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
            const result = await loadDirectoryEntries(rootDirectoryPath);
            if (result.ok) {
                setDirectoryEntriesByPath((prev) => {
                    const next = new Map(prev);
                    next.set(rootDirectoryPath, result.entries);
                    return next;
                });
            } else {
                const err = typeof result.error === 'string' ? result.error.trim() : '';
                setRootError(err || 'unknown_error');
            }
        } finally {
            setRootLoading(false);
        }
    }, [loadDirectoryEntries, rootDirectoryPath]);

    const retryDirectory = React.useCallback(async (directoryPath: string) => {
        const clean = normalizeDirectoryPath(directoryPath);
        if (!clean) return;
        setDirectoryErrors((prev) => {
            if (!prev.has(clean)) return prev;
            const next = new Map(prev);
            next.delete(clean);
            return next;
        });
        await loadDirectory(clean, { forceReload: true });
    }, [loadDirectory]);

    React.useEffect(() => {
        if (!enabled) return;
        if (expandedDirectories.size === 0) return;

        let cancelled = false;
        const loadExpandedDirectories = async () => {
            for (const dir of expandedDirectories) {
                if (cancelled) return;
                if (!dir) continue;
                await loadDirectory(dir, { forceReload: shouldForceReloadExpandedDirectories });
            }
        };

        void loadExpandedDirectories();
        return () => {
            cancelled = true;
        };
    }, [enabled, expandedDirectories, loadDirectory, shouldForceReloadExpandedDirectories]);

    const nodes = React.useMemo(() => {
        if (!enabled) return [];
        return flattenLazyDirectoryTree({
            directoryPath: rootDirectoryPath,
            depth: 0,
            directoryEntriesByPath,
            directoryTruncationByPath,
            expandedDirectories,
            loadingDirectories,
            directoryErrors,
            visited: new Set<string>(),
        });
    }, [directoryEntriesByPath, directoryErrors, directoryTruncationByPath, enabled, expandedDirectories, loadingDirectories, rootDirectoryPath]);

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
