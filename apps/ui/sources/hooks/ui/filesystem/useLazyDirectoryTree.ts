import * as React from 'react';

import { flattenLazyDirectoryTree } from './flattenLazyDirectoryTree';
import { reuseLazyDirectoryTreeNodes } from './reuseLazyDirectoryTreeNodes';
import { collectLazyDirectoryTreeMutationPaths, replaceLazyDirectoryTreeDirectory, resolveLazyDirectoryTreeMutationDirectories } from './reconcileLazyDirectoryTree';
import type { LazyDirectoryTreeEntry, LazyDirectoryTreeLoadResult, LazyDirectoryTreeNode } from './lazyDirectoryTreeTypes';

function normalizeDirectoryPath(input: string): string {
    if (input === '/') return '/';
    const windowsRootMatch = /^([A-Za-z]:)[\\/]*$/.exec(input);
    if (windowsRootMatch) {
        return `${windowsRootMatch[1]}\\`;
    }
    return input.replace(/\/+$/g, '');
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

/** Placeholder entries (the way to an initial folder) paint at once but still need the real listing. */
function isLoadedDirectory(entries: readonly LazyDirectoryTreeEntry[] | undefined): boolean {
    return entries !== undefined && !(entries.length > 0 && entries.every((entry) => entry.source === 'preview'));
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

export function useLazyDirectoryTree<LoadContext = undefined>(input: {
    scopeKey: string;
    enabled: boolean;
    /** An offline workspace keeps authorized cached rows without issuing reads. */
    retainNodesWhenDisabled?: boolean;
    rootDirectoryPath: string;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
    reloadToken?: string | number | null;
    getCachedEntries: (directoryPath: string) => LazyDirectoryTreeEntry[] | null;
    getCachedDirectoryMetadata?: (directoryPath: string) => Readonly<{ truncated?: boolean }> | null;
    loadContext?: LoadContext;
    loadDirectoryEntries: (directoryPath: string, signal: AbortSignal, context?: LoadContext) => Promise<LazyDirectoryTreeLoadResult>;
    warmDirectoryEntries?: ((directoryPath: string, signal: AbortSignal, context?: LoadContext) => Promise<LazyDirectoryTreeLoadResult>) | null;
    warmChildDirectoriesLimit?: number;
    /** Keep settled file mutations queued while a create/rename field owns the tree. */
    reconciliationPaused?: boolean;
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
    const onExpandedPathsChangeRef = React.useRef(onExpandedPathsChange);
    const useExternalExpandedRef = React.useRef(useExternalExpanded);
    React.useEffect(() => {
        expandedPathsRef.current = expandedPaths;
        onExpandedPathsChangeRef.current = onExpandedPathsChange;
        useExternalExpandedRef.current = useExternalExpanded;
    }, [expandedPaths, onExpandedPathsChange, useExternalExpanded]);

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
    const [arrivedPaths, setArrivedPaths] = React.useState<ReadonlySet<string>>(() => new Set());
    const staleDirectoriesRef = React.useRef(new Set<string>());
    const queuedMutationPathsRef = React.useRef(new Set<string>());
    const reconciliationPausedRef = React.useRef(input.reconciliationPaused === true || !enabled);
    reconciliationPausedRef.current = input.reconciliationPaused === true || !enabled;

    const normalizedExternalExpandedPaths = React.useMemo(() => {
        if (!useExternalExpanded) return null;
        return normalizeExpandedPaths(expandedPaths!);
    }, [expandedPaths, useExternalExpanded]);

    const currentExpandedPaths = useExternalExpanded ? normalizedExternalExpandedPaths! : internalExpandedPaths;
    const expandedDirectories = React.useMemo(() => new Set<string>(currentExpandedPaths), [currentExpandedPaths]);
    const expandedCount = expandedDirectories.size;
    const currentExpandedPathsRef = React.useRef(currentExpandedPaths);
    React.useEffect(() => {
        currentExpandedPathsRef.current = currentExpandedPaths;
    }, [currentExpandedPaths]);

    const setExpandedPaths = React.useCallback((next: string[] | ((prev: string[]) => string[])) => {
        if (useExternalExpandedRef.current) {
            const resolvedPrev = currentExpandedPathsRef.current;
            const resolvedNext = typeof next === 'function' ? next(resolvedPrev) : next;
            onExpandedPathsChangeRef.current?.(normalizeExpandedPaths(resolvedNext));
            return;
        }

        setInternalExpandedPaths((prev) => normalizeExpandedPaths(typeof next === 'function' ? next(prev) : next));
    }, []);

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
        setArrivedPaths(new Set());
        staleDirectoriesRef.current.clear();
        queuedMutationPathsRef.current.clear();
    }, [getCachedDirectoryMetadata, getCachedEntries, rootDirectoryPath, scopeKey]);

    const loadingRef = React.useRef<Set<string>>(new Set());
    const pendingForcedReloadsRef = React.useRef(new Map<string, LoadContext | undefined>());
    const loadContextRef = React.useRef(input.loadContext);
    loadContextRef.current = input.loadContext;
    const previousNodesRef = React.useRef<readonly LazyDirectoryTreeNode[]>([]);
    const directoryEntriesByPathRef = React.useRef(directoryEntriesByPath);
    const directoryErrorsRef = React.useRef(directoryErrors);
    const rootDirectoryPathRef = React.useRef(rootDirectoryPath);
    const previousReloadTokenRef = React.useRef(reloadToken);
    const requestLifetimeRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        requestLifetimeRef.current = controller;
        loadingRef.current.clear();
        pendingForcedReloadsRef.current.clear();
        setLoadingDirectories(new Set());
        if (!enabled) {
            controller.abort();
            setRootLoading(false);
        }
        return () => controller.abort();
    }, [enabled, loadDirectoryEntries, reloadToken, rootDirectoryPath, scopeKey, warmChildDirectoriesLimit, warmDirectoryEntries]);
    const shouldForceReloadExpandedDirectories = reloadToken !== previousReloadTokenRef.current;
    React.useEffect(() => {
        directoryEntriesByPathRef.current = directoryEntriesByPath;
        directoryErrorsRef.current = directoryErrors;
        rootDirectoryPathRef.current = rootDirectoryPath;
    }, [directoryEntriesByPath, directoryErrors, rootDirectoryPath]);
    React.useEffect(() => {
        previousReloadTokenRef.current = reloadToken;
    }, [reloadToken]);

    const applyDirectoryLoadResult = React.useCallback((directoryPath: string, result: LazyDirectoryTreeLoadResult) => {
        if (result.ok) {
            staleDirectoriesRef.current.delete(directoryPath);
            if (directoryPath === rootDirectoryPathRef.current) setRootError(null);
            const reconciled = replaceLazyDirectoryTreeDirectory({ directoryEntriesByPath: directoryEntriesByPathRef.current,
                directoryPath, entries: result.entries });
            const pruned = (path: string) => reconciled.prunedDirectoryRoots.some(root => path === root || path.startsWith(`${root}/`));
            for (const path of staleDirectoriesRef.current) if (pruned(path)) staleDirectoriesRef.current.delete(path);
            directoryEntriesByPathRef.current = reconciled.directoryEntriesByPath;
            setDirectoryEntriesByPath(reconciled.directoryEntriesByPath);
            if (reconciled.arrivedPaths.size) setArrivedPaths(reconciled.arrivedPaths);
            setDirectoryErrors((prev) => {
                const next = new Map([...prev].filter(([path]) => path !== directoryPath && !pruned(path)));
                directoryErrorsRef.current = next;
                if (next.size === prev.size) return prev;
                return next;
            });
            setDirectoryTruncationByPath((prev) => {
                const next = new Map([...prev].filter(([path]) => !pruned(path)));
                next.set(directoryPath, result.truncated === true);
                return next;
            });
            return;
        }

        const message = typeof result.error === 'string' ? result.error.trim() : '';
        if (directoryPath === rootDirectoryPathRef.current) setRootError(message || 'unknown_error');
        setDirectoryErrors((prev) => {
            const next = new Map(prev);
            next.set(directoryPath, message || 'unknown_error');
            return next;
        });
    }, []);

    React.useEffect(() => {
        pendingForcedReloadsRef.current.clear();
    }, [scopeKey]);

    const warmChildren = React.useCallback((entries: readonly LazyDirectoryTreeEntry[], context?: LoadContext) => {
        if (!warmDirectoryEntries || warmChildDirectoriesLimit <= 0) return;
        const signal = requestLifetimeRef.current?.signal;
        if (!signal || signal.aborted) return;
        const childDirectories = entries
            .filter((entry) => entry.type === 'directory')
            .slice(0, warmChildDirectoriesLimit);
        for (const entry of childDirectories) {
            // Warming is optional; foreground loading reports its own failures.
            void warmDirectoryEntries(entry.path, signal, context).catch(() => {});
        }
    }, [warmChildDirectoriesLimit, warmDirectoryEntries]);
    const loadDirectoryEntriesRef = React.useRef(loadDirectoryEntries);
    const warmChildrenRef = React.useRef(warmChildren);
    const expandedDirectoriesRef = React.useRef(expandedDirectories);
    React.useEffect(() => {
        loadDirectoryEntriesRef.current = loadDirectoryEntries;
        warmChildrenRef.current = warmChildren;
        expandedDirectoriesRef.current = expandedDirectories;
    }, [expandedDirectories, loadDirectoryEntries, warmChildren]);

    const loadDirectory = React.useCallback(async (directoryPath: string, options?: Readonly<{ forceReload?: boolean; context?: LoadContext }>) => {
        const rootDirectoryPath = rootDirectoryPathRef.current;
        const clean = directoryPath === rootDirectoryPath ? rootDirectoryPath : normalizeDirectoryPath(directoryPath);
        if (!clean && clean !== rootDirectoryPath) return;
        const context = options && 'context' in options ? options.context : loadContextRef.current;
        if (loadingRef.current.has(clean)) {
            if (options?.forceReload) {
                pendingForcedReloadsRef.current.set(clean, context);
            }
            return;
        }
        if (options?.forceReload !== true && !staleDirectoriesRef.current.has(clean)
            && (isLoadedDirectory(directoryEntriesByPathRef.current.get(clean)) || directoryErrorsRef.current.has(clean))) {
            return;
        }

        const requestScopeKey = scopeKeyRef.current;
        const signal = requestLifetimeRef.current?.signal;
        if (!signal || signal.aborted) return;
        loadingRef.current.add(clean);
        if (clean === rootDirectoryPath) setRootLoading(true);
        setLoadingDirectories((prev) => {
            const next = new Set(prev);
            next.add(clean);
            return next;
        });

        try {
            const result = await loadDirectoryEntriesRef.current(clean, signal, context);
            if (signal.aborted || scopeKeyRef.current !== requestScopeKey) {
                return;
            }
            applyDirectoryLoadResult(clean, result);
            if (result.ok) {
                warmChildrenRef.current(result.entries, context);
            }
        } catch (error) {
            if (!signal.aborted) applyDirectoryLoadResult(clean, { ok: false, error: error instanceof Error ? error.message : 'unknown_error' });
        } finally {
            if (signal.aborted) return;
            if (clean === rootDirectoryPath) setRootLoading(false);
            loadingRef.current.delete(clean);
            setLoadingDirectories((prev) => {
                const next = new Set(prev);
                next.delete(clean);
                return next;
            });
            if (pendingForcedReloadsRef.current.has(clean) && scopeKeyRef.current === requestScopeKey) {
                const pendingContext = pendingForcedReloadsRef.current.get(clean);
                pendingForcedReloadsRef.current.delete(clean);
                void loadDirectory(clean, { forceReload: true, context: pendingContext });
            }
        }
    }, [applyDirectoryLoadResult]);

    React.useEffect(() => {
        if (!enabled) return;
        void loadDirectory(rootDirectoryPath, { forceReload: true });
    }, [enabled, loadDirectory, loadDirectoryEntries, reloadToken, rootDirectoryPath, scopeKey, warmChildren]);

    const reconcilePaths = React.useCallback((paths: readonly string[]) => {
        const batch = collectLazyDirectoryTreeMutationPaths({ paths, pendingPaths: queuedMutationPathsRef.current,
            paused: reconciliationPausedRef.current });
        queuedMutationPathsRef.current = batch.pendingPaths;
        if (batch.paths.length === 0) return;
        const directories = resolveLazyDirectoryTreeMutationDirectories({ paths: batch.paths,
            directoryEntriesByPath: directoryEntriesByPathRef.current, expandedDirectories: expandedDirectoriesRef.current,
            loadingDirectories: loadingRef.current, rootDirectoryPath: rootDirectoryPathRef.current });
        for (const path of directories.stale) staleDirectoriesRef.current.add(path);
        for (const directory of directories.reload) void loadDirectory(directory, { forceReload: true });
    }, [loadDirectory]);

    React.useEffect(() => {
        if (reconciliationPausedRef.current || queuedMutationPathsRef.current.size === 0) return;
        reconcilePaths([]);
    }, [enabled, input.reconciliationPaused, reconcilePaths]);

    const toggleDirectory = React.useCallback(async (path: string, context?: LoadContext) => {
        const clean = normalizeDirectoryPath(path);
        if (!clean) return;

        const isExpanded = expandedDirectoriesRef.current.has(clean);
        if (isExpanded) {
            setExpandedPaths((prev) => prev.filter((value) => normalizeDirectoryPath(value) !== clean));
            return;
        }

        setExpandedPaths((prev) => [...prev, clean]);
        await loadDirectory(clean, { context });
    }, [loadDirectory, setExpandedPaths]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, [setExpandedPaths]);

    const retryRoot = React.useCallback(async (context?: LoadContext) => {
        setRootError(null);
        await loadDirectory(rootDirectoryPath, { forceReload: true, context });
    }, [loadDirectory, rootDirectoryPath]);

    const retryDirectory = React.useCallback(async (directoryPath: string, context?: LoadContext) => {
        const clean = normalizeDirectoryPath(directoryPath);
        if (!clean) return;
        setDirectoryErrors((prev) => {
            if (!prev.has(clean)) return prev;
            const next = new Map(prev);
            next.delete(clean);
            return next;
        });
        await loadDirectory(clean, { forceReload: true, context });
    }, [loadDirectory]);

    React.useEffect(() => {
        if (!enabled) return;
        if (expandedDirectories.size === 0) return;

        let cancelled = false;
        const loadExpandedDirectories = async () => {
            for (const dir of expandedDirectories) {
                if (cancelled) return;
                if (!dir) continue;
                if (![...directoryEntriesByPath.values()].some(entries => entries.some(entry => entry.type === 'directory' && entry.path === dir))) continue;
                await loadDirectory(dir, { forceReload: shouldForceReloadExpandedDirectories });
            }
        };

        void loadExpandedDirectories();
        return () => {
            cancelled = true;
        };
    }, [directoryEntriesByPath, enabled, expandedDirectories, loadDirectory, shouldForceReloadExpandedDirectories]);

    const flattenedNodes = React.useMemo(() => {
        if ((!enabled && !input.retainNodesWhenDisabled) || scopeKeyRef.current !== scopeKey) return [];
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
    }, [directoryEntriesByPath, directoryErrors, directoryTruncationByPath, enabled, input.retainNodesWhenDisabled, expandedDirectories, loadingDirectories, rootDirectoryPath, scopeKey]);

    const nodes = React.useMemo(() => {
        const reusedNodes = reuseLazyDirectoryTreeNodes(flattenedNodes, previousNodesRef.current);
        previousNodesRef.current = reusedNodes;
        return reusedNodes;
    }, [flattenedNodes]);

    return {
        rootLoading: scopeKeyRef.current === scopeKey && rootLoading,
        rootError: scopeKeyRef.current === scopeKey ? rootError : null,
        rootLoaded: scopeKeyRef.current === scopeKey && directoryEntriesByPath.has(rootDirectoryPath),
        nodes,
        toggleDirectory,
        collapseAll,
        expandedCount,
        retryRoot,
        retryDirectory,
        reconcilePaths,
        arrivedPaths,
    };
}
