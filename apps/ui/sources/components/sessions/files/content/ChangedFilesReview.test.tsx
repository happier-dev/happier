import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Spy is intentionally `any` to allow multiple response shapes (success/failure) without fighting inference.
const sessionScmDiffFileSpy: any = vi.fn(async (_sessionId: string, _req: any) => ({ success: true, diff: 'diff', error: null }));
const flashListScrollToIndexSpy: any = vi.fn();
const deferOnWebSpy: any = vi.fn((cb: any) => cb());

const resolveInlineDiffVirtualizationSpy = vi.hoisted(() => vi.fn());
const diffFilesListViewSpy = vi.hoisted(() => vi.fn());

let wrapLinesInDiffsSetting: boolean = true;
let showLineNumbersSetting: boolean = true;
let inlineVirtualizationLineThresholdSetting: number | undefined = undefined;
let inlineVirtualizationByteThresholdSetting: number | undefined = undefined;
let scmReviewPrefetchAheadCountWebSetting: number | undefined = undefined;
let scmReviewPrefetchBehindCountWebSetting: number | undefined = undefined;
let scmReviewPrefetchAheadCountNativeSetting: number | undefined = undefined;
let scmReviewPrefetchBehindCountNativeSetting: number | undefined = undefined;
let scmReviewPrefetchDebounceMsSetting: number | undefined = undefined;
let flashListViewableIndicesOverride: number[] | null = null;

function buildUnifiedDiff(path: string) {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

vi.mock('@/components/ui/code/diff/resolveInlineDiffVirtualization', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/components/ui/code/diff/resolveInlineDiffVirtualization')>();
    return {
        ...mod,
        resolveInlineDiffVirtualization: (...args: any[]) => {
            resolveInlineDiffVirtualizationSpy(...args);
            return (mod as any).resolveInlineDiffVirtualization(...args);
        },
    };
});

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => React.createElement('DiffReviewCommentsViewer', props),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('CodeLinesView', { ...props, virtualized: props.virtualized }),
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/components/ui/code/diff/DiffFilesListView')>();
    return {
        ...mod,
        DiffFilesListView: React.forwardRef((props: any, ref: any) => {
            diffFilesListViewSpy(props);
            return React.createElement((mod as any).DiffFilesListView, { ...props, ref });
        }),
    };
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (cb: any) => deferOnWebSpy(cb),
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            scrollToIndex: flashListScrollToIndexSpy,
            // Some callers may attempt to read the underlying scroll node on web.
            getScrollableNode: () => null,
        }));
        const data = Array.isArray(props.data) ? props.data : [];
        React.useEffect(() => {
        if (typeof props.onViewableItemsChanged !== 'function') return;
            const indices = Array.isArray(flashListViewableIndicesOverride)
                ? flashListViewableIndicesOverride
                : data.map((_item: any, index: number) => index);
            props.onViewableItemsChanged({
                viewableItems: indices.map((index: number) => ({ index })),
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'wrapLinesInDiffs') return wrapLinesInDiffsSetting;
        if (key === 'showLineNumbers') return showLineNumbersSetting;
        if (key === 'filesDiffInlineVirtualizationLineThreshold') return inlineVirtualizationLineThresholdSetting;
        if (key === 'filesDiffInlineVirtualizationByteThreshold') return inlineVirtualizationByteThresholdSetting;
        if (key === 'scmReviewPrefetchAheadCountWeb') return scmReviewPrefetchAheadCountWebSetting;
        if (key === 'scmReviewPrefetchBehindCountWeb') return scmReviewPrefetchBehindCountWebSetting;
        if (key === 'scmReviewPrefetchAheadCountNative') return scmReviewPrefetchAheadCountNativeSetting;
        if (key === 'scmReviewPrefetchBehindCountNative') return scmReviewPrefetchBehindCountNativeSetting;
        if (key === 'scmReviewPrefetchDebounceMs') return scmReviewPrefetchDebounceMsSetting;
        return undefined;
    },
}));

vi.mock('react-native', () => ({
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
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (sessionId: string, req: any) => sessionScmDiffFileSpy(sessionId, req),
    sessionReadFile: vi.fn(async () => ({ success: false, content: '', error: 'nope' })),
}));

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
        vi.resetModules();
        scmReviewPrefetchAheadCountWebSetting = undefined;
        scmReviewPrefetchBehindCountWebSetting = undefined;
        scmReviewPrefetchAheadCountNativeSetting = undefined;
        scmReviewPrefetchBehindCountNativeSetting = undefined;
        scmReviewPrefetchDebounceMsSetting = undefined;
        flashListViewableIndicesOverride = null;
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

    it('limits auto-expanded diffs when large and viewability config is enabled', async () => {
        // Enable viewability windowing.
        scmReviewPrefetchAheadCountWebSetting = 3;
        scmReviewPrefetchBehindCountWebSetting = 2;
        scmReviewPrefetchDebounceMsSetting = 0;
        flashListViewableIndicesOverride = [0];

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        const files = Array.from({ length: 10 }, (_unused, index) => ({
            fileName: `file-${index}.ts`,
            filePath: 'src',
            fullPath: `src/file-${index}.ts`,
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        })) as any[];

        diffFilesListViewSpy.mockClear();

        await act(async () => {
            renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={files}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={1}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />,
            );
        });

        for (let i = 0; i < 3; i++) {
            await act(async () => {
                await Promise.resolve();
            });
        }

        const lastProps = diffFilesListViewSpy.mock.calls.at(-1)?.[0];
        expect(lastProps).toBeTruthy();

        // Initial window expands `ahead+behind+1` files only.
        expect(lastProps.expandedKeys.size).toBe(6);
        expect(lastProps.expandedKeys.has('src/file-0.ts')).toBe(true);
        expect(lastProps.expandedKeys.has('src/file-5.ts')).toBe(true);
        expect(lastProps.expandedKeys.has('src/file-6.ts')).toBe(false);
        expect(lastProps.expandedKeys.has('src/file-9.ts')).toBe(false);

        // Reset per-test overrides.
        scmReviewPrefetchAheadCountWebSetting = undefined;
        scmReviewPrefetchBehindCountWebSetting = undefined;
        scmReviewPrefetchDebounceMsSetting = undefined;
        flashListViewableIndicesOverride = null;
    });
    const directoryLike = { fileName: 'src/some-dir/', filePath: 'src/some-dir/', fullPath: 'src/some-dir/', status: 'added', isIncluded: false, linesAdded: 1, linesRemoved: 0 } as any;

    it('renders the review list via DiffFilesListView', async () => {
        diffFilesListViewSpy.mockClear();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        await act(async () => {
            renderer.create(
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
                />
            );
        });

        expect(diffFilesListViewSpy).toHaveBeenCalled();
    });

    it('loads diffs for all files when within thresholds', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = undefined;
        inlineVirtualizationByteThresholdSetting = undefined;
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        await act(async () => {
            renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (sessionScmDiffFileSpy.mock.calls.length >= 2) break;
        }

        expect(sessionScmDiffFileSpy.mock.calls.length).toBe(2);
        const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call[1]?.path);
        expect(calledPaths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('keeps FlashList renderItem stable while diffs load', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        sessionScmDiffFileSpy.mockClear();
        let resolveDiff: null | ((value: any) => void) = null;
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => {
            return await new Promise((resolve) => {
                resolveDiff = () => resolve({
                    success: true,
                    diff: buildUnifiedDiff(req.path),
                    error: null,
                });
            });
        });

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="s1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={() => {}}
                />,
            );
        });

        await act(async () => {
            await Promise.resolve();
        });

        const listBefore = tree!.root.findByType('FlashList' as any);
        const renderItemBefore = listBefore.props.renderItem;

        await act(async () => {
            expect(resolveDiff).not.toBeNull();
            resolveDiff?.(null);
            await Promise.resolve();
        });

        const listAfter = tree!.root.findByType('FlashList' as any);
        expect(listAfter.props.renderItem).toBe(renderItemBefore);
    });

    it('filters directory-like SCM entries from review rows', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: buildUnifiedDiff(req.path),
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, directoryLike]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await Promise.resolve();
            });
        }

        const rows = tree!.root.findAllByType('ScmChangeRow' as any);
        expect(rows).toHaveLength(1);

        const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call?.[1]?.path);
        expect(calledPaths).toEqual(['src/a.ts']);
    });

    it('highlights a focused path when provided', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = undefined;
        inlineVirtualizationByteThresholdSetting = undefined;
        sessionScmDiffFileSpy.mockClear();
        flashListScrollToIndexSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                    focusPath="src/b.ts"
                />
            );
        });

        // Allow effects to run.
        await act(async () => {
            await Promise.resolve();
        });

        const rows = tree!.root.findAllByType('ScmChangeRow' as any);
        const bRow = rows.find((n) => n.props?.file?.fullPath === 'src/b.ts');
        expect(bRow).toBeTruthy();
        expect(bRow!.props.highlighted).toBe(true);

        await act(async () => {
            tree!.unmount();
        });
    });

    it('scrolls to a focused path without animation on web to avoid scroll/event glitches', async () => {
        vi.useFakeTimers();
        try {
            wrapLinesInDiffsSetting = true;
            showLineNumbersSetting = true;
            inlineVirtualizationLineThresholdSetting = undefined;
            inlineVirtualizationByteThresholdSetting = undefined;
            sessionScmDiffFileSpy.mockClear();
            flashListScrollToIndexSpy.mockClear();
            sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
                success: true,
                diff: `diff:${req.path}:${req.area}`,
                error: null,
            }));

            const { ChangedFilesReview } = await import('./ChangedFilesReview');

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(
                    <ChangedFilesReview
                        theme={theme}
                        sessionId="session-1"
                        snapshot={snapshot}
                        changedFilesViewMode="repository"
                        attributionReliability="high"
                        allRepositoryChangedFiles={[fileA, fileB]}
                        sessionAttributedFiles={[]}
                        repositoryOnlyFiles={[]}
                        suppressedInferredCount={0}
                        maxFiles={25}
                        maxChangedLines={2000}
                        onFilePress={vi.fn()}
                        focusPath="src/b.ts"
                    />
                );
            });

            // Run focus effect timers (scroll after a short delay).
            await act(async () => {
                vi.advanceTimersByTime(60);
            });

            expect(flashListScrollToIndexSpy).toHaveBeenCalled();
            const args = flashListScrollToIndexSpy.mock.calls[0]?.[0] ?? null;
            expect(args).toBeTruthy();
            expect(args.animated).toBe(false);

            await act(async () => {
                tree!.unmount();
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('wires onFilePressPinned to ScmChangeRow.onPressPinned', async () => {
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const onFilePressPinned = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                    onFilePressPinned={onFilePressPinned}
                />
            );
        });

        const row = tree!.root.findByType('ScmChangeRow' as any);
        expect(typeof row.props.onPressPinned).toBe('function');

        act(() => {
            row.props.onPressPinned();
        });

        expect(onFilePressPinned).toHaveBeenCalledTimes(1);
        expect(onFilePressPinned).toHaveBeenCalledWith(fileA);
    });

        it('disables virtualization for diff blocks when review comments are enabled', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = undefined;
        inlineVirtualizationByteThresholdSetting = undefined;
            resolveInlineDiffVirtualizationSpy.mockClear();
            sessionScmDiffFileSpy.mockClear();
            sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
                success: true,
                diff: buildUnifiedDiff(req.path),
                error: null,
            }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                    reviewCommentsEnabled
                    reviewCommentDrafts={[]}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const views = tree!.root.findAllByType('DiffReviewCommentsViewer' as any);
            if (views.length > 0) break;
        }

        const views = tree!.root.findAllByType('DiffReviewCommentsViewer' as any);
        expect(views.length).toBeGreaterThan(0);
        expect(resolveInlineDiffVirtualizationSpy).toHaveBeenCalledTimes(0);
    });

        it('does not force virtualization for small diffs when review comments are disabled', async () => {
        wrapLinesInDiffsSetting = true;
        showLineNumbersSetting = true;
        inlineVirtualizationLineThresholdSetting = undefined;
            inlineVirtualizationByteThresholdSetting = undefined;
            sessionScmDiffFileSpy.mockClear();
            sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
                success: true,
                diff: buildUnifiedDiff(req.path),
                error: null,
            }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const views = tree!.root.findAllByType('CodeLinesView' as any);
            if (views.length > 0) break;
        }

        const views = tree!.root.findAllByType('CodeLinesView' as any);
        expect(views.length).toBeGreaterThan(0);
        for (const view of views) {
            expect(view.props.virtualized).toBe(false);
        }
    });

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

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const views = tree!.root.findAllByType('CodeLinesView' as any);
            if (views.length > 0) break;
        }

        const views = tree!.root.findAllByType('CodeLinesView' as any);
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
                .mockImplementationOnce((_sessionId: string, req: any) => new Promise((resolve) => {
                    pendingRefreshResolve = resolve;
                }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                    diffAutoRefreshIntervalMs={0}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const views = tree!.root.findAllByType('CodeLinesView' as any);
            if (views.length > 0) break;
        }

        expect(tree!.root.findAllByType('CodeLinesView' as any).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBe(0);

        await act(async () => {
            tree!.update(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={{ ...snapshot, fetchedAt: snapshot.fetchedAt + 1 }}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[{ ...fileA }]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                    diffAutoRefreshIntervalMs={0}
                />
            );
        });

        // Effect starts a refresh but keeps previous diff visible (no loading spinner).
        expect(tree!.root.findAllByType('CodeLinesView' as any).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBe(0);

            await act(async () => {
                pendingRefreshResolve?.({ success: true, diff: buildUnifiedDiff('src/a.ts'), error: null });
                await Promise.resolve();
            });
        });

    it('does not re-fetch diffs again when within the refresh interval', async () => {
        sessionScmDiffFileSpy.mockClear();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                    diffAutoRefreshIntervalMs={60_000}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const views = tree!.root.findAllByType('CodeLinesView' as any);
            if (views.length > 0) break;
        }

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree!.update(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={{ ...snapshot, fetchedAt: snapshot.fetchedAt + 1 }}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[{ ...fileA }]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                    diffAutoRefreshIntervalMs={60_000}
                />
            );
            await Promise.resolve();
        });

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });

    it('re-fetches diffs when the refresh token changes even within the refresh interval', async () => {
        sessionScmDiffFileSpy.mockClear();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                    diffAutoRefreshIntervalMs={60_000}
                    diffRefreshToken={0}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const views = tree!.root.findAllByType('CodeLinesView' as any);
            if (views.length > 0) break;
        }

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree!.update(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={{ ...snapshot, fetchedAt: snapshot.fetchedAt + 1 }}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[{ ...fileA }]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                    diffAutoRefreshIntervalMs={60_000}
                    diffRefreshToken={1}
                />
            );
            await Promise.resolve();
        });

        expect(sessionScmDiffFileSpy).toHaveBeenCalledTimes(2);
        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBe(0);

        vi.useRealTimers();
    });

    it('falls back to single-file loading when thresholds are exceeded', async () => {
        sessionScmDiffFileSpy.mockClear();

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        await act(async () => {
            renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={1}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            if (sessionScmDiffFileSpy.mock.calls.length >= 2) break;
        }

        expect(sessionScmDiffFileSpy.mock.calls.length).toBe(2);
        const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call[1]?.path);
        expect(calledPaths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('filters collapsed paths when a file disappears', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: buildUnifiedDiff(req.path),
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const diffs = tree!.root.findAllByType('CodeLinesView' as any);
            if (diffs.length >= 2) break;
        }

        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(2);

        const items = tree!.root.findAllByType('ScmChangeRow' as any);
        expect(items.length).toBe(2);

        await act(async () => {
            items[0]!.props.onPress();
        });
        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(1);

        // Update the list so the previously selected file is no longer present.
        await act(async () => {
            tree!.update(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileC]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const diffs = tree!.root.findAllByType('CodeLinesView' as any);
            if (diffs.length >= 1) break;
        }

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

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const diffs = tree!.root.findAllByType('CodeLinesView' as any);
            if (diffs.length >= 2) break;
        }

        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(2);

        const items = tree!.root.findAllByType('ScmChangeRow' as any);
        expect(items.length).toBe(2);

        await act(async () => {
            items[0]!.props.onPress();
        });
        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(1);

        await act(async () => {
            items[0]!.props.onPress();
        });
        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(2);
    });

    it('uses a localized fallback when diff loading fails without an error string', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async () => ({
            success: false,
            diff: null,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                />
            );
        });

        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const texts = tree!.root.findAllByType('Text' as any);
            if (texts.some((n) => String(n.props?.children) === 'files.reviewDiffRequestFailed')) break;
        }

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((n) => String(n.props?.children) === 'files.reviewDiffRequestFailed')).toBe(true);
    });

    it('supports injecting per-file actions for commit/stage flows', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const renderFileActions = vi.fn((_file: any) => React.createElement('Action'));

        await act(async () => {
            renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                    renderFileActions={renderFileActions as any}
                />
            );
        });

        const calledPaths = new Set(renderFileActions.mock.calls.map((call) => call[0]?.fullPath));
        expect(Array.from(calledPaths).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('opens a file via the per-row open-file button', async () => {
        deferOnWebSpy.mockClear();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const onFilePress = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                    onFilePress={onFilePress}
                />
            );
        });

        const row = tree!.root.findByType('ScmChangeRow' as any);
        const trailing = row.props.trailingElement;
        expect(trailing).toBeTruthy();

        let trailingTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            trailingTree = renderer.create(trailing);
        });

        const button = trailingTree!.root.findByProps({ testID: 'scm-change-open-file-src_a.ts' });
        act(() => {
            const eventWithThrowingNativeEvent = {
                stopPropagation: vi.fn(),
                preventDefault: vi.fn(),
                get nativeEvent() {
                    throw new Error('nativeEvent getter should not be required');
                },
            };
            if (typeof button.props.onPress === 'function') {
                button.props.onPress(eventWithThrowingNativeEvent);
            } else if (typeof button.props.onClick === 'function') {
                button.props.onClick(eventWithThrowingNativeEvent);
            }
        });

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

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={indexSnapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        // Sanity: pending mode shows the file.
        expect(tree!.root.findAllByType('ScmChangeRow' as any)).toHaveLength(1);

        // Switch to Included; this should hide the file entirely (no included delta).
        const includedPressables = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            const textNodes = (node as any).findAll?.((n: any) => n.type === 'Text') ?? [];
            return textNodes.some((n: any) => String((n.children ?? []).join('')) === 'Included');
        });
        expect(includedPressables.length).toBeGreaterThan(0);

        await act(async () => {
            includedPressables[0]!.props.onPress();
            await Promise.resolve();
        });

        expect(tree!.root.findAllByType('ScmChangeRow' as any)).toHaveLength(0);

        const emptyTexts = tree!.root.findAll((node) => {
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

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        const includedSnapshot = {
            ...snapshot,
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={includedSnapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[includedFile]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        expect(tree!.root.findAllByType('ScmChangeRow' as any)).toHaveLength(1);
    });

    it('auto-switches diff area when the snapshot transitions to included-only (without user selection)', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        const pendingSnapshot = {
            ...snapshot,
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={pendingSnapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[pendingFile]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        expect(tree!.root.findAllByType('ScmChangeRow' as any)).toHaveLength(1);

        await act(async () => {
            tree!.update(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={includedSnapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[includedFile]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        expect(tree!.root.findAllByType('ScmChangeRow' as any)).toHaveLength(1);
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

            const { ChangedFilesReview } = await import('./ChangedFilesReview');

            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(
                    <ChangedFilesReview
                        theme={theme}
                        sessionId="session-1"
                        snapshot={snapshot}
                        changedFilesViewMode="repository"
                        attributionReliability="high"
                        allRepositoryChangedFiles={[fileA, fileB]}
                        sessionAttributedFiles={[]}
                        repositoryOnlyFiles={[]}
                        suppressedInferredCount={0}
                        maxFiles={25}
                        maxChangedLines={2000}
                        onFilePress={vi.fn()}
                    />,
                );
            });

            expect(tree.root.findAllByType('FlashList' as any)).toHaveLength(1);
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

            expect(tree.root.findAllByType('FlatList' as any).length).toBeGreaterThan(0);
            expect(tree.root.findAllByType('FlashList' as any)).toHaveLength(0);
        } finally {
            globalWindowContainer.window = prevWindow;
        }
    });
});
