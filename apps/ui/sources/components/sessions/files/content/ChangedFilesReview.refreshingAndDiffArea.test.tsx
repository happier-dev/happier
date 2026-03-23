import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { flushHookEffects, pressTestInstance, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Spy is intentionally `any` to allow multiple response shapes (success/failure) without fighting inference.
const sessionScmDiffFileSpy: any = vi.fn(async (_sessionId: string, _req: any) => ({ success: true, diff: 'diff', error: null }));
const flashListScrollToIndexSpy: any = vi.fn();
const deferOnWebSpy: any = vi.fn((cb: any) => cb());

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

let wrapLinesInDiffsSetting: boolean = true;
let showLineNumbersSetting: boolean = true;
let inlineVirtualizationLineThresholdSetting: number | undefined = undefined;
let inlineVirtualizationByteThresholdSetting: number | undefined = undefined;
let scmReviewPrefetchAheadCountWebSetting: number | undefined = undefined;
let scmReviewPrefetchBehindCountWebSetting: number | undefined = undefined;
let scmReviewPrefetchAheadCountNativeSetting: number | undefined = undefined;
let scmReviewPrefetchBehindCountNativeSetting: number | undefined = undefined;
let scmReviewPrefetchDebounceMsSetting: number | undefined = undefined;
let scmReviewPrefetchConcurrencySetting: number | undefined = undefined;
const flashListScrollableNode = {
    scrollTop: 0,
    style: {
        setProperty: vi.fn(),
    },
};

function buildUnifiedDiff(path: string) {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

vi.mock('@/components/ui/code/diff/resolveInlineDiffVirtualization', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/components/ui/code/diff/resolveInlineDiffVirtualization')>();
    return mod;
});

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => React.createElement('DiffReviewCommentsViewer', props),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('CodeLinesView', { ...props, virtualized: props.virtualized }),
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: React.forwardRef((props: any, ref: any) => {
        const [flashListCrashed, setFlashListCrashed] = React.useState(false);

        React.useEffect(() => {
            if (typeof globalThis.window === 'undefined' || typeof globalThis.window.addEventListener !== 'function') return;
            const onError = (event: any) => {
                const message = String(event?.message ?? event?.error?.message ?? '');
                if (message.includes('not enough layouts')) {
                    setFlashListCrashed(true);
                }
            };
            globalThis.window.addEventListener('error', onError);
            return () => {
                globalThis.window?.removeEventListener?.('error', onError);
            };
        }, []);

        React.useImperativeHandle(ref, () => ({
            clearLayoutCacheOnUpdate: vi.fn(),
            scrollToIndex: flashListScrollToIndexSpy,
            scrollToOffset: vi.fn(),
        }));

        const data = Array.isArray(props.files) ? props.files : [];
        const header = props.ListHeaderComponent
            ? (typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent)
            : null;
        const footer = props.ListFooterComponent
            ? (typeof props.ListFooterComponent === 'function' ? props.ListFooterComponent() : props.ListFooterComponent)
            : null;

        React.useEffect(() => {
            if (typeof props.onViewableItemsChanged !== 'function') return;
            props.onViewableItemsChanged({
                viewableItems: data.map((_item: any, index: number) => ({ index })),
            });
        }, [data, props.onViewableItemsChanged]);

        const renderFile = (file: any, index: number) => {
            const expanded = props.expandedKeys?.has?.(file.key) === true;
            const focused = false;
            const onToggleExpanded = () => props.onToggleExpanded?.(file.key);
            const row = props.renderFileRow
                ? props.renderFileRow({ file, index, expanded, focused, onToggleExpanded })
                : React.createElement('ScmChangeRow', { file, index, expanded, focused, onToggleExpanded });
            const inline = props.canRenderInlineDiffs && expanded && props.renderInlineUnifiedDiff
                ? props.renderInlineUnifiedDiff({
                    file,
                    virtualized: typeof file.unifiedDiff === 'string' && file.unifiedDiff.length > 1000,
                    maxVirtualizedHeight: 0,
                    wrapLines: props.wrapLines,
                    showLineNumbers: props.showLineNumbers,
                    showPrefix: props.showPrefix,
                })
                : null;
            return React.createElement(React.Fragment, { key: file.key }, row, inline);
        };

        const content = flashListCrashed
            ? React.createElement(
                'FlatList',
                props,
                header,
                data.map((item: any, index: number) => renderFile(item, index)),
                footer,
            )
            : React.createElement(
                'FlashList',
                props,
                header,
                data.map((item: any, index: number) => renderFile(item, index)),
                footer,
            );

        return content;
    }),
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (cb: any) => deferOnWebSpy(cb),
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            scrollToIndex: flashListScrollToIndexSpy,
            // Some callers may attempt to read the underlying scroll node on web.
            getScrollableNode: () => flashListScrollableNode,
        }));
        const data = Array.isArray(props.data) ? props.data : [];
        React.useEffect(() => {
        if (typeof props.onViewableItemsChanged !== 'function') return;
            props.onViewableItemsChanged({
                viewableItems: data.map((_item: any, index: number) => ({ index })),
            });
        }, [data, props.onViewableItemsChanged]);

        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function'
                    ? props.ListFooterComponent()
                    : props.ListFooterComponent)
                : null;

        return React.createElement(
            'FlashList',
            props,
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.key ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSetting: (key: string) => {
            if (key === 'wrapLinesInDiffs') return wrapLinesInDiffsSetting;
            if (key === 'showLineNumbers') return showLineNumbersSetting;
            if (key === 'filesDiffInlineVirtualizationLineThreshold') return inlineVirtualizationLineThresholdSetting;
            if (key === 'filesDiffInlineVirtualizationByteThreshold') return inlineVirtualizationByteThresholdSetting;
            if (key === 'scmReviewPrefetchConcurrency') return scmReviewPrefetchConcurrencySetting;
            if (key === 'scmReviewPrefetchAheadCountWeb') return scmReviewPrefetchAheadCountWebSetting;
            if (key === 'scmReviewPrefetchBehindCountWeb') return scmReviewPrefetchBehindCountWebSetting;
            if (key === 'scmReviewPrefetchAheadCountNative') return scmReviewPrefetchAheadCountNativeSetting;
            if (key === 'scmReviewPrefetchBehindCountNative') return scmReviewPrefetchBehindCountNativeSetting;
            if (key === 'scmReviewPrefetchDebounceMs') return scmReviewPrefetchDebounceMsSetting;
            return undefined;
        },
    });
});

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: (snapshot: any) => ({
            diffModeConfig: () => ({
                ...(() => {
                    const supportsIncludeExclude = snapshot?.capabilities?.writeInclude === true
                        && snapshot?.capabilities?.writeExclude === true;
                    let availableModes = supportsIncludeExclude ? ['included', 'pending'] : ['pending'];
                    if (Number(snapshot?.totals?.includedFiles ?? 0) > 0 && !availableModes.includes('included')) {
                        availableModes = ['included', ...availableModes];
                    }
                    if (Number(snapshot?.totals?.pendingFiles ?? 0) > 0 && !availableModes.includes('pending')) {
                        availableModes = [...availableModes, 'pending'];
                    }
                    return {
                        defaultMode: availableModes.includes('pending') ? 'pending' : (availableModes[0] ?? 'pending'),
                        availableModes,
                        labels: { included: 'Included', pending: 'Pending', both: 'Combined' },
                    };
                })(),
            }),
            errorNormalizer: (err: unknown) => (err instanceof Error ? err.message : String(err)),
        }),
    },
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewPrefetch', () => ({
    useChangedFilesReviewPrefetch: (input: any) => {
        const [viewableRowIndices, setViewableRowIndices] = React.useState<readonly number[]>([]);
        const viewabilityEnabled = Boolean(input.sessionId) && Array.isArray(input.rows) && input.rows.length > 0;
        const prefetchConcurrency = typeof scmReviewPrefetchConcurrencySetting === 'number' && Number.isFinite(scmReviewPrefetchConcurrencySetting)
            ? Math.max(1, Math.floor(scmReviewPrefetchConcurrencySetting))
            : 0;
        const viewabilityConfig = {
            enabled:
                typeof scmReviewPrefetchAheadCountWebSetting === 'number'
                && Number.isFinite(scmReviewPrefetchAheadCountWebSetting)
                && typeof scmReviewPrefetchBehindCountWebSetting === 'number'
                && Number.isFinite(scmReviewPrefetchBehindCountWebSetting)
                && typeof scmReviewPrefetchDebounceMsSetting === 'number'
                && Number.isFinite(scmReviewPrefetchDebounceMsSetting),
            aheadCount: typeof scmReviewPrefetchAheadCountWebSetting === 'number' ? Math.max(0, Math.floor(scmReviewPrefetchAheadCountWebSetting)) : 0,
            behindCount: typeof scmReviewPrefetchBehindCountWebSetting === 'number' ? Math.max(0, Math.floor(scmReviewPrefetchBehindCountWebSetting)) : 0,
            debounceMs: typeof scmReviewPrefetchDebounceMsSetting === 'number' ? Math.max(0, Math.floor(scmReviewPrefetchDebounceMsSetting)) : 0,
        };

        const onViewableItemsChanged = React.useCallback((info: any) => {
            if (!viewabilityEnabled || !viewabilityConfig.enabled) return;
            const viewableItems = Array.isArray(info?.viewableItems) ? info.viewableItems : [];
            const indices: number[] = [];
            for (const item of viewableItems) {
                const index = item?.index;
                if (typeof index === 'number' && Number.isFinite(index)) indices.push(index);
            }
            indices.sort((a, b) => a - b);
            setViewableRowIndices((prev) => {
                if (prev.length === indices.length && prev.every((value, index) => value === indices[index])) return prev;
                return indices;
            });
        }, [viewabilityConfig.enabled, viewabilityEnabled]);

        const requestedPaths = React.useMemo(() => {
            const rows = Array.isArray(input.rows) ? input.rows : [];
            const out: string[] = [];
            const seen = new Set<string>();
            for (const rowIndex of viewableRowIndices) {
                const row = rows[rowIndex];
                if (!row || row.kind !== 'file') continue;
                const path = row.file?.fullPath;
                if (typeof path !== 'string' || path.trim().length === 0) continue;
                if (seen.has(path)) continue;
                seen.add(path);
                out.push(path);
            }
            if (out.length > 0) return out;

            const initialRequested = Array.isArray(input.initialRequestedPaths)
                ? input.initialRequestedPaths.map((p: string) => (typeof p === 'string' ? p.trim() : '')).filter((p: string) => p.length > 0)
                : [];
            if (initialRequested.length > 0) return initialRequested;

            const initialCount = Math.max(1, viewabilityConfig.aheadCount + viewabilityConfig.behindCount + 1);
            const reviewFiles = Array.isArray(input.reviewFiles) ? input.reviewFiles : [];
            const initial: string[] = [];
            for (const file of reviewFiles.slice(0, initialCount)) {
                if (file?.fullPath) initial.push(file.fullPath);
            }
            if (initial.length > 0) return initial;
            const anchor = reviewFiles[0]?.fullPath;
            return anchor ? [anchor] : null;
        }, [input.initialRequestedPaths, input.reviewFiles, input.rows, viewableRowIndices, viewabilityConfig.aheadCount, viewabilityConfig.behindCount]);

        return {
            prefetchEnabled:
                Boolean(input.sessionId)
                && Boolean(input.snapshotSignature)
                && viewabilityConfig.enabled
                && prefetchConcurrency > 0,
            requestedPaths,
            prefetchWindowPaths: requestedPaths,
            onViewableItemsChanged,
            viewableRowIndices,
            maxDiffLoadConcurrency: prefetchConcurrency > 0 ? prefetchConcurrency : 1,
        };
    },
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewDiffLoading', () => ({
    useChangedFilesReviewDiffLoading: (input: any) => {
        type DiffState = Readonly<{ status: 'idle' | 'loading' | 'loaded' | 'error'; diff: string; error: string | null }>;
        type Listener = () => void;
        const DEFAULT_DIFF_STATE: DiffState = { status: 'idle', diff: '', error: null };

        const storeRef = React.useRef<{
            states: Map<string, DiffState>;
            listeners: Map<string, Set<Listener>>;
            getDiffState: (path: string) => DiffState;
            subscribe: (path: string, listener: Listener) => () => void;
            reset: () => void;
            prune: (livePaths: Set<string>, inFlightPaths: Set<string>) => void;
            setDiffState: (path: string, state: DiffState) => void;
            updateDiffState: (path: string, updater: (prev: DiffState | null) => DiffState) => void;
        } | null>(null);

        if (!storeRef.current) {
            const states = new Map<string, DiffState>();
            const listeners = new Map<string, Set<Listener>>();
            storeRef.current = {
                states,
                listeners,
                getDiffState: (path: string) => states.get(path) ?? DEFAULT_DIFF_STATE,
                subscribe: (path: string, listener: Listener) => {
                    const bucket = listeners.get(path) ?? new Set<Listener>();
                    bucket.add(listener);
                    listeners.set(path, bucket);
                    return () => {
                        const next = listeners.get(path);
                        if (!next) return;
                        next.delete(listener);
                        if (next.size === 0) listeners.delete(path);
                    };
                },
                reset: () => {
                    states.clear();
                    listeners.forEach((bucket) => bucket.forEach((listener) => listener()));
                },
                prune: (livePaths: Set<string>) => {
                    for (const path of Array.from(states.keys())) {
                        if (livePaths.has(path)) continue;
                        states.delete(path);
                    }
                },
                setDiffState: (path: string, state: DiffState) => {
                    states.set(path, state);
                    listeners.get(path)?.forEach((listener) => listener());
                },
                updateDiffState: (path: string, updater: (prev: DiffState | null) => DiffState) => {
                    const next = updater(states.get(path) ?? null);
                    states.set(path, next);
                    listeners.get(path)?.forEach((listener) => listener());
                },
            };
        }

        const diffStateSource = storeRef.current;
        const reviewFiles = Array.isArray(input.reviewFiles) ? input.reviewFiles : [];
        const fileStatusByPath = React.useMemo(() => {
            const map = new Map<string, any>();
            for (const file of reviewFiles) {
                if (file?.fullPath) map.set(file.fullPath, file);
            }
            return map;
        }, [reviewFiles]);
        const lastFetchAtMsByPathRef = React.useRef<Record<string, number>>({});
        const inFlightPathsRef = React.useRef<Set<string>>(new Set());

        React.useEffect(() => {
            diffStateSource.reset();
            lastFetchAtMsByPathRef.current = {};
            inFlightPathsRef.current = new Set();
        }, [input.diffArea, input.sessionId]);

        React.useEffect(() => {
            lastFetchAtMsByPathRef.current = {};
        }, [input.diffArea, input.refreshToken, input.sessionId, input.snapshotSignature]);

        React.useEffect(() => {
            if (!input.providerDiffByPath || input.providerDiffByPath.size === 0) return;
            for (const path of fileStatusByPath.keys()) {
                const providerDiff = input.providerDiffByPath.get(path);
                if (typeof providerDiff !== 'string' || providerDiff.trim().length === 0) continue;
                diffStateSource.setDiffState(path, { status: 'loaded', diff: providerDiff, error: null });
                lastFetchAtMsByPathRef.current[path] = Date.now();
            }
        }, [diffStateSource, fileStatusByPath, input.providerDiffByPath]);

        React.useEffect(() => {
            if (!input.sessionId || !input.isRepo || reviewFiles.length === 0) return;
            const requestedPathsRaw = Array.isArray(input.requestedPaths) ? (input.requestedPaths as readonly unknown[]) : null;
            const requestedPaths = requestedPathsRaw && requestedPathsRaw.length > 0
                ? requestedPathsRaw.filter((path: unknown): path is string => typeof path === 'string' && path.length > 0)
                : [input.selectedPath || reviewFiles[0]?.fullPath].filter((path): path is string => typeof path === 'string' && path.length > 0);
            let cancelled = false;
            const minRefetchMsResolved =
                typeof input.minRefetchMs === 'number' && Number.isFinite(input.minRefetchMs)
                    ? Math.max(0, Math.floor(input.minRefetchMs))
                    : null;

            const loadDiff = async (path: string) => {
                const existing = diffStateSource.getDiffState(path);
                const nowMs = Date.now();
                if ((existing?.status === 'loaded' || existing?.status === 'error')) {
                    const lastFetchAtMs = lastFetchAtMsByPathRef.current[path] ?? 0;
                    if (lastFetchAtMs > 0) {
                        if (minRefetchMsResolved === null) return;
                        if (minRefetchMsResolved > 0 && (nowMs - lastFetchAtMs) < minRefetchMsResolved) return;
                    }
                }
                if (inFlightPathsRef.current.has(path)) return;
                inFlightPathsRef.current.add(path);
                diffStateSource.updateDiffState(path, (prev) => prev?.status === 'loaded' && prev.diff ? prev : { status: 'loading', diff: '', error: null });
                try {
                    const response = await sessionScmDiffFileSpy(input.sessionId, { path, area: input.diffArea });
                    lastFetchAtMsByPathRef.current[path] = Date.now();
                    if (cancelled) return;
                    if (!response.success) {
                        const rawError = typeof response.error === 'string' ? response.error : '';
                        const normalized = rawError.trim() ? input.normalizeError(rawError) : '';
                        diffStateSource.updateDiffState(path, (prev) => prev?.status === 'loaded' && prev.diff
                            ? prev
                            : { status: 'error', diff: '', error: (typeof normalized === 'string' && normalized.trim()) ? normalized : input.fallbackError });
                        return;
                    }
                    diffStateSource.setDiffState(path, { status: 'loaded', diff: response.diff ?? '', error: null });
                } catch (err) {
                    if (cancelled) return;
                    const normalized = input.normalizeError(err);
                    diffStateSource.updateDiffState(path, (prev) => prev?.status === 'loaded' && prev.diff
                        ? prev
                        : { status: 'error', diff: '', error: (typeof normalized === 'string' && normalized.trim()) ? normalized : input.fallbackError });
                } finally {
                    inFlightPathsRef.current.delete(path);
                }
            };

            void Promise.all(requestedPaths.map((path) => loadDiff(path)));
            return () => {
                cancelled = true;
            };
        }, [
            diffStateSource,
            fileStatusByPath,
            input.diffArea,
            input.fallbackError,
            input.isRepo,
            input.minRefetchMs,
            input.normalizeError,
            input.providerDiffByPath,
            input.refreshToken,
            input.requestedPaths,
            input.reviewFiles,
            input.selectedPath,
            input.sessionId,
            input.snapshotSignature,
        ]);

        return { diffStateSource };
    },
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewFocusPath', () => ({
    useChangedFilesReviewFocusPath: (input: any) => {
        const [highlightedPath, setHighlightedPath] = React.useState<string | null>(null);
        const appliedFocusPathRef = React.useRef<string | null>(null);
        const expandPathRef = React.useRef(input.expandPath);
        const scrollToPathRef = React.useRef(input.scrollToPath);
        expandPathRef.current = input.expandPath;
        scrollToPathRef.current = input.scrollToPath;

        React.useEffect(() => {
            const resolved = typeof input.focusPath === 'string' ? input.focusPath : null;
            if (!resolved) {
                appliedFocusPathRef.current = null;
                return;
            }
            if (appliedFocusPathRef.current === resolved) return;
            if (!Array.isArray(input.reviewFiles) || !input.reviewFiles.some((f: any) => f.fullPath === resolved)) return;
            appliedFocusPathRef.current = resolved;
            setHighlightedPath(resolved);
            expandPathRef.current(resolved);
            const scrollTimer = setTimeout(() => scrollToPathRef.current(resolved), 50);
            const clearTimer = setTimeout(() => setHighlightedPath(null), 8000);
            return () => {
                clearTimeout(scrollTimer);
                clearTimeout(clearTimer);
            };
        }, [input.focusPath, input.reviewFiles]);

        return highlightedPath;
    },
}));

vi.mock('@/components/sessions/files/content/review/useScmDiffExpandedKeys', () => ({
    useScmDiffExpandedKeys: (input: any) => {
        const allKeys = React.useMemo<string[]>(() => {
            return Array.isArray(input.allKeys)
                ? (input.allKeys as readonly unknown[]).filter((key: unknown): key is string => typeof key === 'string')
                : [];
        }, [input.allKeys]);

        const initialCollapsedKeysSignature = React.useMemo(() => {
            const raw = Array.isArray(input.initialCollapsedKeys)
                ? input.initialCollapsedKeys.filter((k: any) => typeof k === 'string').map((k: string) => k.trim()).filter((k: string) => k.length > 0)
                : [];
            return Array.from(new Set(raw)).sort().join('\n');
        }, [input.initialCollapsedKeys]);

        const initialCollapsedKeySet = React.useMemo(() => {
            const allowed = new Set(allKeys);
            const out = new Set<string>();
            const initial = initialCollapsedKeysSignature.length > 0 ? initialCollapsedKeysSignature.split('\n') : [];
            for (const key of initial) {
                if (!allowed.has(key)) continue;
                out.add(key);
            }
            return out;
        }, [allKeys, initialCollapsedKeysSignature]);

        const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(() => new Set(initialCollapsedKeySet));
        const toggleCollapsed = React.useCallback((key: string) => {
            setCollapsedKeys((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
            });
        }, []);

        const initialAutoExpandedKeySet = React.useMemo(() => {
            const initialCount = Math.max(1, Number(input.aheadCount ?? 0) + Number(input.behindCount ?? 0) + 1);
            return new Set<string>(allKeys.slice(0, initialCount));
        }, [allKeys, input.aheadCount, input.behindCount]);
        const initialAutoExpandedKeysSignature = React.useMemo(() => {
            return Array.from(initialAutoExpandedKeySet).sort().join('\n');
        }, [initialAutoExpandedKeySet]);
        const initialCollapsedKeysStateSignature = React.useMemo(() => {
            return Array.from(initialCollapsedKeySet).sort().join('\n');
        }, [initialCollapsedKeySet]);
        const [autoExpandedKeys, setAutoExpandedKeys] = React.useState<Set<string>>(() => new Set());

        React.useEffect(() => {
            if (!input.tooLarge) {
                setAutoExpandedKeys((prev) => (prev.size === 0 ? prev : new Set<string>()));
                setCollapsedKeys((prev) => (
                    areStringSetsEqual(prev, initialCollapsedKeySet) ? prev : new Set<string>(initialCollapsedKeySet)
                ));
                return;
            }
            setAutoExpandedKeys((prev) => (
                areStringSetsEqual(prev, initialAutoExpandedKeySet) ? prev : new Set<string>(initialAutoExpandedKeySet)
            ));
            setCollapsedKeys((prev) => (
                areStringSetsEqual(prev, initialCollapsedKeySet) ? prev : new Set<string>(initialCollapsedKeySet)
            ));
        }, [initialAutoExpandedKeysSignature, initialCollapsedKeysStateSignature, input.resetKey, input.tooLarge]);

        React.useEffect(() => {
            if (!input.tooLarge) return;
            const viewable = Array.isArray(input.viewableIndices) ? input.viewableIndices : [];
            if (viewable.length === 0) return;
            const min = Math.max(0, Math.min(...viewable));
            const max = Math.min(Math.max(0, allKeys.length - 1), Math.max(...viewable) + Number(input.aheadCount ?? 0));
            const windowKeys = allKeys.slice(min, max + 1);
            setAutoExpandedKeys((prev) => {
                let changed = false;
                const next = new Set<string>(prev);
                for (const key of windowKeys) {
                    if (next.has(key)) continue;
                    next.add(key);
                    changed = true;
                }
                return changed ? next : prev;
            });
        }, [allKeys, input.aheadCount, input.tooLarge, input.viewableIndices]);

        const expandedKeys = React.useMemo(() => {
            if (!input.tooLarge) {
                const out = new Set<string>();
                for (const key of allKeys) {
                    if (collapsedKeys.has(key)) continue;
                    out.add(key);
                }
                return out;
            }
            const autoKeys = autoExpandedKeys.size > 0 ? autoExpandedKeys : initialAutoExpandedKeySet;
            const out = new Set<string>();
            for (const key of autoKeys) {
                if (collapsedKeys.has(key)) continue;
                out.add(key);
            }
            return out;
        }, [allKeys, autoExpandedKeys, collapsedKeys, initialAutoExpandedKeySet, input.tooLarge]);

        React.useEffect(() => {
            const cb = input.onCollapsedKeysChange;
            if (!cb) return;
            const ordered = allKeys.filter((key) => collapsedKeys.has(key));
            cb(ordered);
        }, [allKeys, collapsedKeys, input.onCollapsedKeysChange]);

        return { collapsedKeys, toggleCollapsed, expandedKeys };
    },
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewDiffBlockRenderer', () => ({
    useChangedFilesReviewDiffBlockRenderer: (input: any) => {
        const DiffBlock = ({ path }: { path: string }) => {
            const state = React.useSyncExternalStore(
                React.useCallback((listener) => input.diffStateSource.subscribe(path, listener), [input.diffStateSource, path]),
                React.useCallback(() => input.diffStateSource.getDiffState(path), [input.diffStateSource, path]),
                React.useCallback(() => input.diffStateSource.getDiffState(path), [input.diffStateSource, path]),
            );

            if (state.status === 'loading' || state.status === 'idle') {
                return React.createElement('ActivityIndicator', { testID: `scm-review-diff-${toTestIdSafeValue(path)}` });
            }

            if (state.status === 'error') {
                return React.createElement(
                    'Text',
                    { testID: `scm-review-diff-${toTestIdSafeValue(path)}` },
                    state.error ?? 'files.reviewUnableToLoadDiff',
                );
            }

            if (input.reviewCommentsEnabled) {
                return React.createElement('DiffReviewCommentsViewer', {
                    testID: `scm-review-diff-${toTestIdSafeValue(path)}`,
                    filePath: path,
                    unifiedDiff: state.diff,
                    reviewCommentsEnabled: true,
                    reviewCommentDrafts: input.reviewCommentDrafts ?? [],
                    wrapLines: showLineNumbersSetting !== false,
                    showLineNumbers: showLineNumbersSetting !== false,
                    onUpsertReviewCommentDraft: input.onUpsertReviewCommentDraft,
                    onDeleteReviewCommentDraft: input.onDeleteReviewCommentDraft,
                    onReviewCommentError: input.onReviewCommentError,
                });
            }

            const virtualized = typeof state.diff === 'string' && state.diff.length > 1000;
            return React.createElement('CodeLinesView', {
                testID: `scm-review-diff-${toTestIdSafeValue(path)}`,
                mode: 'unified',
                unifiedDiff: state.diff,
                filePath: path,
                wrapLines: wrapLinesInDiffsSetting !== false,
                showLineNumbers: showLineNumbersSetting !== false,
                virtualized,
            });
        };

        return (path: string) => React.createElement(DiffBlock, { path });
    },
}));

// Avoid importing SCM project state (which pulls in sync/storage singletons) for this focused unit test.
vi.mock('@/scm/statusSync/projectState', () => ({
    buildSnapshotSignature: () => 'snapshot-sig',
}));

vi.mock('@/scm/diffCache/scmDiffCacheSingleton', () => ({
    scmDiffCache: null,
}));

vi.mock('@/components/sessions/files/changedFiles/ChangedFilesSectionHeader', () => ({
    ChangedFilesSectionHeader: (props: any) => React.createElement('ChangedFilesSectionHeader', props, props.children),
}));

vi.mock('@/components/sessions/files/content/review/ChangedFilesReviewDiffAreaSelector', () => ({
    ChangedFilesReviewDiffAreaSelector: (props: any) => React.createElement(
        'ChangedFilesReviewDiffAreaSelector',
        props,
        ...(Array.isArray(props.availableModes) ? props.availableModes.map((mode: string) => React.createElement(
            'Pressable',
            { key: mode, testID: `scm-review-diff-area-${mode}`, onPress: () => props.onChange(mode) },
            React.createElement('Text', null, props.labels?.[mode] ?? mode),
        )) : []),
    ),
}));

vi.mock('@/scm/review/useScmReviewViewabilityConfig', () => ({
    useScmReviewViewabilityConfig: () => ({
        enabled:
            typeof scmReviewPrefetchAheadCountWebSetting === 'number'
            && Number.isFinite(scmReviewPrefetchAheadCountWebSetting)
            && typeof scmReviewPrefetchBehindCountWebSetting === 'number'
            && Number.isFinite(scmReviewPrefetchBehindCountWebSetting)
            && typeof scmReviewPrefetchDebounceMsSetting === 'number'
            && Number.isFinite(scmReviewPrefetchDebounceMsSetting),
        aheadCount: typeof scmReviewPrefetchAheadCountWebSetting === 'number' ? Math.max(0, Math.floor(scmReviewPrefetchAheadCountWebSetting)) : 0,
        behindCount: typeof scmReviewPrefetchBehindCountWebSetting === 'number' ? Math.max(0, Math.floor(scmReviewPrefetchBehindCountWebSetting)) : 0,
        debounceMs: typeof scmReviewPrefetchDebounceMsSetting === 'number' ? Math.max(0, Math.floor(scmReviewPrefetchDebounceMsSetting)) : 0,
    }),
}));

vi.mock('@/components/ui/scroll/resolveWebScrollableElement', () => ({
    resolveWebScrollableElement: (rootCandidate: any) => rootCandidate,
}));

vi.mock('@/components/sessions/files/content/review/scmEntryDelta', () => ({
    totalsChangedLines: (snapshot: any, area: string) => {
        const totals = snapshot?.totals;
        if (!totals) return 0;
        if (area === 'included') return Number(totals.includedAdded ?? 0) + Number(totals.includedRemoved ?? 0);
        if (area === 'pending') return Number(totals.pendingAdded ?? 0) + Number(totals.pendingRemoved ?? 0);
        return Number(totals.includedAdded ?? 0) + Number(totals.includedRemoved ?? 0)
            + Number(totals.pendingAdded ?? 0) + Number(totals.pendingRemoved ?? 0);
    },
    entryToDelta: (entry: any) => ({
        hasIncludedDelta: Boolean(entry?.hasIncludedDelta),
        hasPendingDelta: Boolean(entry?.hasPendingDelta),
        includedAdded: Number(entry?.stats?.includedAdded ?? 0),
        includedRemoved: Number(entry?.stats?.includedRemoved ?? 0),
        pendingAdded: Number(entry?.stats?.pendingAdded ?? 0),
        pendingRemoved: Number(entry?.stats?.pendingRemoved ?? 0),
    }),
    fileHasDeltaForArea: (file: any, delta: any, area: string) => {
        if (delta) {
            if (area === 'included') return delta.hasIncludedDelta;
            if (area === 'pending') return delta.hasPendingDelta;
            return delta.hasIncludedDelta || delta.hasPendingDelta;
        }
        if (area === 'included') return file.isIncluded === true;
        if (area === 'pending') return file.isIncluded !== true;
        return true;
    },
    toAreaFileStatus: (file: any, delta: any, area: string) => {
        if (!delta) {
            return area === 'included'
                ? { ...file, isIncluded: true }
                : area === 'pending'
                    ? { ...file, isIncluded: false }
                    : file;
        }
        if (area === 'included') {
            return { ...file, isIncluded: true, linesAdded: delta.includedAdded, linesRemoved: delta.includedRemoved };
        }
        if (area === 'pending') {
            return { ...file, isIncluded: false, linesAdded: delta.pendingAdded, linesRemoved: delta.pendingRemoved };
        }
        return {
            ...file,
            linesAdded: delta.includedAdded + delta.pendingAdded,
            linesRemoved: delta.includedRemoved + delta.pendingRemoved,
        };
    },
}));

vi.mock('@/scm/diff/defaultMode', () => ({
    resolveDefaultDiffModeForFile: ({ snapshot, hasIncludedDelta, hasPendingDelta }: any) => {
        const supportsIncludeExclude = snapshot?.capabilities?.writeInclude === true
            && snapshot?.capabilities?.writeExclude === true;
        let availableModes = supportsIncludeExclude ? ['included', 'pending'] : ['pending'];
        if (Number(snapshot?.totals?.includedFiles ?? 0) > 0 && !availableModes.includes('included')) {
            availableModes = ['included', ...availableModes];
        }
        if (Number(snapshot?.totals?.pendingFiles ?? 0) > 0 && !availableModes.includes('pending')) {
            availableModes = [...availableModes, 'pending'];
        }
        if (hasIncludedDelta && !hasPendingDelta && availableModes.includes('included')) return 'included';
        if (hasPendingDelta && !hasIncludedDelta && availableModes.includes('pending')) return 'pending';
        return availableModes.includes('pending') ? 'pending' : (availableModes[0] ?? 'pending');
    },
}));

vi.mock('@/scm/isDirectoryLikeScmFileStatus', () => ({
    isDirectoryLikeScmFileStatus: (file: { fullPath?: string }) => {
        const fullPath = typeof file?.fullPath === 'string' ? file.fullPath.trim() : '';
        return fullPath.endsWith('/') || fullPath.endsWith('\\');
    },
    filterDirectoryLikeScmFileStatuses: (files: readonly any[]) =>
        files.filter((file) => {
            const fullPath = typeof file?.fullPath === 'string' ? file.fullPath.trim() : '';
            return !(fullPath.endsWith('/') || fullPath.endsWith('\\'));
        }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        View: 'View',
                                        Image: 'Image',
                                        Pressable: 'Pressable',
                                        FlatList: 'FlatList',
                                        ScrollView: 'ScrollView',
                                        ActivityIndicator: 'ActivityIndicator',
                                        TextInput: 'TextInput',
                                        Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
                                        AppState: {
                                            addEventListener: () => ({ remove: () => {} }),
                                            currentState: 'active',
                                        },
                                        useWindowDimensions: () => ({ width: 1200, height: 800 }),
                                        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
                                    }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        Text: 'Text',
        TextInput: 'TextInput',
    };
});

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionScmDiffFile: (sessionId: string, req: any) => sessionScmDiffFileSpy(sessionId, req),
            sessionReadFile: vi.fn(async () => ({ success: false as const, content: '', error: 'nope' })),
        },
    });
});

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => React.createElement('CodeLinesView', props),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    // This mock intentionally uses a real React hook so our tests catch hook-order bugs
    // in components that call syntax-highlighting hooks alongside other hooks.
    useCodeLinesSyntaxHighlighting: () =>
        React.useMemo(
            () => ({
                mode: 'off',
                language: null,
                maxBytes: 1_000_000,
                maxLines: 10_000,
                maxLineLength: 10_000,
            }),
            []
        ),
}));

describe('ChangedFilesReview', () => {
    beforeEach(() => {
        sessionScmDiffFileSpy.mockReset();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, _req: any) => ({ success: true, diff: 'diff', error: null }));
        flashListScrollToIndexSpy.mockReset();
        deferOnWebSpy.mockReset();
        deferOnWebSpy.mockImplementation((cb: any) => cb());
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = undefined;
        inlineVirtualizationByteThresholdSetting = undefined;
        scmReviewPrefetchConcurrencySetting = undefined;
        scmReviewPrefetchAheadCountWebSetting = undefined;
        scmReviewPrefetchBehindCountWebSetting = undefined;
        scmReviewPrefetchAheadCountNativeSetting = undefined;
        scmReviewPrefetchBehindCountNativeSetting = undefined;
        scmReviewPrefetchDebounceMsSetting = undefined;
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    const theme = {
        colors: {
            surface: '#111',
            surfaceHigh: '#222',
            divider: '#333',
            text: '#eee',
            textSecondary: '#aaa',
            textLink: '#08f',
            warning: '#f80',
            success: '#0f0',
            textDestructive: '#f00',
        },
        dark: false,
    } as any;

    const snapshot = {
        projectKey: 'p',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: { readDiffFile: true },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 2,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 1,
        },
    } as any;

    const fileA = { fileName: 'a.ts', filePath: 'src', fullPath: 'src/a.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;
    const fileB = { fileName: 'b.ts', filePath: 'src', fullPath: 'src/b.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;
    const fileC = { fileName: 'c.ts', filePath: 'src', fullPath: 'src/c.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;

    async function buildChangedFilesReviewElement(overrides: Record<string, unknown> = {}) {
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        return (
            <ChangedFilesReview
                theme={theme}
                sessionId="session-1"
                snapshot={snapshot}
                changedFilesViewMode="repository"
                attributionReliability="high"
                allRepositoryChangedFiles={[fileA]}
                sessionAttributedFiles={[]}
                repositoryOnlyFiles={[]}
                suppressedInferredCount={0}
                maxFiles={25}
                maxChangedLines={2000}
                onFilePress={vi.fn()}
                {...overrides}
            />
        );
    }

    async function renderChangedFilesReview(overrides: Record<string, unknown> = {}) {
        return renderScreen(await buildChangedFilesReviewElement(overrides));
    }

    async function flushReviewEffects(cycles = 3) {
        await flushHookEffects({ cycles });
    }

    it('enables virtualization for large diffs above the byte threshold when review comments are disabled', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = 50_000;
        inlineVirtualizationByteThresholdSetting = 100;

        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff --git a/${req.path} b/${req.path}\n--- a/${req.path}\n+++ b/${req.path}\n@@\n+${'a'.repeat(2_000)}\n`,
            error: null,
        }));

        const screen = await renderChangedFilesReview();
        await flushReviewEffects();

        const views = screen.findAllByType('CodeLinesView' as any);
        expect(views.length).toBeGreaterThan(0);
        for (const view of views) {
            expect(view.props.virtualized).toBe(true);
        }
    });

    it('keeps loaded diffs visible while refreshing due to snapshot churn', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = undefined;
        inlineVirtualizationByteThresholdSetting = undefined;
        sessionScmDiffFileSpy.mockClear();
        let pendingRefreshResolve: ((value: any) => void) | null = null;
        sessionScmDiffFileSpy
            .mockImplementationOnce(async (_sessionId: string, req: any) => ({
                success: true,
                diff: buildUnifiedDiff(req.path),
                error: null,
            }))
            // Second call simulates a slow refresh so we can assert there is no "loading" flicker.
            .mockImplementationOnce((_sessionId: string, _req: any) => new Promise((resolve) => {
                pendingRefreshResolve = resolve;
            }));

        const screen = await renderChangedFilesReview({
            diffAutoRefreshIntervalMs: 0,
        });
        await flushReviewEffects();

        expect(screen.findAllByType('CodeLinesView' as any).length).toBeGreaterThan(0);
        expect(screen.findAllByType('ActivityIndicator' as any).length).toBe(0);

        await screen.update(await buildChangedFilesReviewElement({
            snapshot: { ...snapshot, fetchedAt: snapshot.fetchedAt + 1 },
            allRepositoryChangedFiles: [{ ...fileA }],
            diffAutoRefreshIntervalMs: 0,
        }));
        await flushReviewEffects();

        // Effect starts a refresh but keeps previous diff visible (no loading spinner).
        expect(screen.findAllByType('CodeLinesView' as any).length).toBeGreaterThan(0);
        expect(screen.findAllByType('ActivityIndicator' as any).length).toBe(0);

        await act(async () => {
            pendingRefreshResolve?.({ success: true, diff: buildUnifiedDiff('src/a.ts'), error: null });
        });
        await flushReviewEffects();
        expect(screen.findAllByType('ActivityIndicator' as any).length).toBe(0);
        expect(screen.findAllByType('CodeLinesView' as any).length).toBeGreaterThan(0);
    });

    it('does not re-fetch diffs again when within the refresh interval', async () => {
        sessionScmDiffFileSpy.mockClear();
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:00:00.000Z').getTime());

        try {
            sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
                success: true,
                diff: `diff:${req.path}:${req.area}`,
                error: null,
            }));

            const screen = await renderChangedFilesReview({
                diffAutoRefreshIntervalMs: 60_000,
            });
            await flushReviewEffects();

            expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);

            await screen.update(await buildChangedFilesReviewElement({
                snapshot: { ...snapshot, fetchedAt: snapshot.fetchedAt + 1 },
                allRepositoryChangedFiles: [{ ...fileA }],
                diffAutoRefreshIntervalMs: 60_000,
            }));
            await flushReviewEffects();

            expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('re-fetches diffs when the refresh token changes even within the refresh interval', async () => {
        sessionScmDiffFileSpy.mockClear();
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-01T00:00:00.000Z').getTime());

        try {
            sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
                success: true,
                diff: `diff:${req.path}:${req.area}`,
                error: null,
            }));

            const screen = await renderChangedFilesReview({
                diffAutoRefreshIntervalMs: 60_000,
                diffRefreshToken: 0,
            });
            await flushReviewEffects();

            expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);

            await screen.update(await buildChangedFilesReviewElement({
                snapshot: { ...snapshot, fetchedAt: snapshot.fetchedAt + 1 },
                allRepositoryChangedFiles: [{ ...fileA }],
                diffAutoRefreshIntervalMs: 60_000,
                diffRefreshToken: 1,
            }));
            await flushReviewEffects();

            expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(2);
            expect(screen.findAllByType('ActivityIndicator' as any).length).toBe(0);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('falls back to single-file loading when thresholds are exceeded', async () => {
        sessionScmDiffFileSpy.mockClear();

        await renderChangedFilesReview({
            allRepositoryChangedFiles: [fileA, fileB],
            maxFiles: 1,
        });
        await flushReviewEffects();

        expect(sessionScmDiffFileSpy.mock.calls.length).toBe(1);
        const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call[1]?.path);
        expect(calledPaths).toEqual(['src/a.ts']);
    });

    it('filters collapsed paths when a file disappears', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: buildUnifiedDiff(req.path),
            error: null,
        }));

        const screen = await renderChangedFilesReview({
            allRepositoryChangedFiles: [fileA, fileB],
        });
        await flushReviewEffects();

        expect(screen.findAllByType('CodeLinesView' as any)).toHaveLength(2);

        const [firstRow] = screen.findAllByType('ScmChangeRow' as any);
        act(() => {
            pressTestInstance(firstRow);
        });
        await flushReviewEffects();
        expect(screen.findAllByType('CodeLinesView' as any)).toHaveLength(1);

        // Update the list so the previously selected file is no longer present.
        await screen.update(await buildChangedFilesReviewElement({
            allRepositoryChangedFiles: [fileC],
        }));
        await flushReviewEffects();

        const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call[1]?.path);
        expect(calledPaths).toContain('src/c.ts');
    });

    it('toggles diff visibility when pressing a file row in stacked review mode', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: buildUnifiedDiff(req.path),
            error: null,
        }));

        const screen = await renderChangedFilesReview({
            allRepositoryChangedFiles: [fileA, fileB],
        });
        await flushReviewEffects();

        expect(screen.findAllByType('CodeLinesView' as any)).toHaveLength(2);

        const [firstRow] = screen.findAllByType('ScmChangeRow' as any);
        act(() => {
            pressTestInstance(firstRow);
        });
        await flushReviewEffects();
        expect(screen.findAllByType('CodeLinesView' as any)).toHaveLength(1);

        act(() => {
            pressTestInstance(firstRow);
        });
        await flushReviewEffects();
        expect(screen.findAllByType('CodeLinesView' as any)).toHaveLength(2);
    });

    it('uses a localized fallback when diff loading fails without an error string', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async () => ({
            success: false,
            diff: null,
            error: null,
        }));

        const screen = await renderChangedFilesReview();
        await flushReviewEffects();

        const texts = screen.findAllByType('Text' as any);
        expect(texts.some((n) => String(n.props?.children) === 'files.reviewDiffRequestFailed')).toBe(true);
    });

    it('supports injecting per-file actions for commit/stage flows', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const renderFileActions = vi.fn((_file: any) => React.createElement('Action'));

        await renderChangedFilesReview({
            allRepositoryChangedFiles: [fileA, fileB],
            renderFileActions: renderFileActions as any,
        });
        await flushReviewEffects();

        const calledPaths = new Set(renderFileActions.mock.calls.map((call) => call[0]?.fullPath));
        expect(Array.from(calledPaths).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('opens a file via the per-row open-file button', async () => {
        deferOnWebSpy.mockClear();
        const onFilePress = vi.fn();

        const screen = await renderChangedFilesReview({
            onFilePress,
        });
        await flushReviewEffects();

        const row = screen.findByType('ScmChangeRow' as any);
        const trailing = row.props.trailingElement;
        expect(trailing).toBeTruthy();

        const trailingScreen = await renderScreen(trailing);
        await flushReviewEffects();

        const button = trailingScreen.findByProps({ testID: 'scm-change-open-file-src_a.ts' });
        await pressTestInstanceAsync(button, 'scm-change-open-file-src_a.ts');

        expect(onFilePress).toHaveBeenCalledTimes(1);
        expect(onFilePress.mock.calls[0]?.[0]?.fullPath).toBe('src/a.ts');
        expect(deferOnWebSpy).toHaveBeenCalledTimes(1);
    });

    it('filters out files that have no delta in the selected diff area', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const indexSnapshot = {
            ...snapshot,
            capabilities: { readDiffFile: true, writeInclude: true, writeExclude: true },
            totals: {
                ...snapshot.totals,
                includedFiles: 0,
                pendingFiles: 1,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 1,
            },
        } as any;

        const screen = await renderChangedFilesReview({
            snapshot: indexSnapshot,
        });
        await flushReviewEffects();

        // Sanity: pending mode shows the file.
        expect(screen.findAllByType('ScmChangeRow' as any)).toHaveLength(1);

        // Switch to Included; this should hide the file entirely (no included delta).
        act(() => {
            screen.pressByTestId('scm-review-diff-area-included');
        });
        await flushReviewEffects();

        expect(screen.findAllByType('ScmChangeRow' as any)).toHaveLength(0);

        const emptyTexts = screen.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return String(((node as any).children ?? []).join('')) === 'files.noChanges';
        });
        expect(emptyTexts.length).toBeGreaterThan(0);
    });

    it('defaults to Included when only included changes exist', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const includedSnapshot = {
            ...snapshot,
            capabilities: {
                ...snapshot.capabilities,
                writeInclude: true,
                writeExclude: true,
            },
            totals: {
                ...snapshot.totals,
                includedFiles: 1,
                pendingFiles: 0,
                includedAdded: 1,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        } as any;

        const includedFile = { ...fileA, isIncluded: true } as any;

        const screen = await renderChangedFilesReview({
            snapshot: includedSnapshot,
            allRepositoryChangedFiles: [includedFile],
        });
        await flushReviewEffects();

        expect(screen.findAllByType('ScmChangeRow' as any)).toHaveLength(1);
    });

    it('auto-switches diff area when the snapshot transitions to included-only (without user selection)', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const pendingSnapshot = {
            ...snapshot,
            capabilities: {
                ...snapshot.capabilities,
                writeInclude: true,
                writeExclude: true,
            },
            totals: {
                ...snapshot.totals,
                includedFiles: 0,
                pendingFiles: 1,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 0,
            },
        } as any;
        const pendingFile = { ...fileA, isIncluded: false } as any;

        const includedSnapshot = {
            ...snapshot,
            capabilities: {
                ...snapshot.capabilities,
                writeInclude: true,
                writeExclude: true,
            },
            totals: {
                ...snapshot.totals,
                includedFiles: 1,
                pendingFiles: 0,
                includedAdded: 1,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        } as any;
        const includedFile = { ...fileA, isIncluded: true } as any;

        const screen = await renderChangedFilesReview({
            snapshot: pendingSnapshot,
            allRepositoryChangedFiles: [pendingFile],
        });
        await flushReviewEffects();

        expect(screen.findAllByType('ScmChangeRow' as any)).toHaveLength(1);

        await screen.update(await buildChangedFilesReviewElement({
            snapshot: includedSnapshot,
            allRepositoryChangedFiles: [includedFile],
        }));
        await flushReviewEffects();

        expect(screen.findAllByType('ScmChangeRow' as any)).toHaveLength(1);
    });

    it('falls back to FlatList on web when FlashList throws "not enough layouts"', async () => {
        sessionScmDiffFileSpy.mockClear();

        const globalWindowContainer = globalThis as unknown as { window?: unknown };
        const prevWindow = globalWindowContainer.window;
        const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
        try {
            globalWindowContainer.window = {
                addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
                    const arr = listeners.get(type) ?? [];
                    arr.push(fn);
                    listeners.set(type, arr);
                },
                removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
                    const arr = listeners.get(type) ?? [];
                    listeners.set(type, arr.filter((f) => f !== fn));
                },
            };

            const screen = await renderChangedFilesReview({
                allRepositoryChangedFiles: [fileA, fileB],
            });
            await flushReviewEffects();

            expect(screen.findAllByType('FlashList' as any)).toHaveLength(1);
            expect(listeners.get('error')?.length ?? 0).toBeGreaterThan(0);

            const errorMessage = 'index out of bounds, not enough layouts';
            const handler = (listeners.get('error') ?? [])[0];
            const fakeEvent = {
                message: errorMessage,
                error: new Error(errorMessage),
                preventDefault: vi.fn(),
                stopImmediatePropagation: vi.fn(),
            } as unknown as ErrorEvent;

            await act(async () => {
                (handler as EventListener)(fakeEvent);
            });
            await flushReviewEffects();

            expect(screen.findAllByType('FlatList' as any).length).toBeGreaterThan(0);
            expect(screen.findAllByType('FlashList' as any)).toHaveLength(0);
        } finally {
            globalWindowContainer.window = prevWindow;
        }
    });
});
