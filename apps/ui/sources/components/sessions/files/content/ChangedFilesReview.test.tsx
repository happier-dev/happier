import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Spy is intentionally `any` to allow multiple response shapes (success/failure) without fighting inference.
const sessionScmDiffFileSpy: any = vi.fn(async (_sessionId: string, _req: any) => ({ success: true, diff: 'diff', error: null }));

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
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

    it('loads diffs for all files when within thresholds', async () => {
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

    it('highlights a focused path when provided', async () => {
        sessionScmDiffFileSpy.mockClear();
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

        const items = tree!.root.findAllByType('Item' as any);
        const bItem = items.find((n) => n.props?.title === 'b.ts');
        expect(bItem).toBeTruthy();
        expect(bItem!.props.style).toBeTruthy();
        expect(bItem!.props.style.backgroundColor).toBe(theme.colors.surfaceHigh);
    });

    it('disables virtualization for diff blocks when review comments are enabled', async () => {
        sessionScmDiffFileSpy.mockClear();
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
                    reviewCommentsEnabled
                    reviewCommentDrafts={[]}
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
            if (sessionScmDiffFileSpy.mock.calls.length >= 1) break;
        }

        expect(sessionScmDiffFileSpy.mock.calls.length).toBe(1);
        expect(sessionScmDiffFileSpy.mock.calls[0]?.[1]?.path).toBe('src/a.ts');
    });

    it('resets too-large selectedPath when the selected file disappears', async () => {
        sessionScmDiffFileSpy.mockClear();

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
            if (sessionScmDiffFileSpy.mock.calls.length >= 1) break;
        }
        expect(sessionScmDiffFileSpy.mock.calls[0]?.[1]?.path).toBe('src/a.ts');

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
            const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call[1]?.path);
            if (calledPaths.includes('src/c.ts')) break;
        }

        const calledPaths = sessionScmDiffFileSpy.mock.calls.map((call: any) => call[1]?.path);
        expect(calledPaths).toContain('src/c.ts');
    });

    it('renders a changed-files outline panel on wide web viewports', async () => {
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

        const outline = tree!.root.findAll((node) => node.props?.testID === 'scm-review-outline');
        expect(outline.length).toBe(1);
    });

    it('expands a collapsed diff when selecting from outline in too-large mode', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionScmDiffFileSpy.mockImplementation(async (_sessionId: string, req: any) => ({
            success: true,
            diff: `diff:${req.path}:${req.area}`,
            error: null,
        }));

        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { ChangedFilesReviewOutline } = await import('./review/ChangedFilesReviewOutline');

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
                    maxFiles={1}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        // Wait until at least one diff loads.
        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await Promise.resolve();
            });
            const diffs = tree!.root.findAllByType('CodeLinesView' as any);
            if (diffs.length >= 1) break;
        }

        // Select fileB (unselected -> select), then collapse it (selected -> toggle collapse).
        const items = tree!.root.findAllByType('Item' as any);
        await act(async () => {
            items[1]!.props.onPress();
        });
        await act(async () => {
            items[1]!.props.onPress();
        });
        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(0);

        const outline = tree!.root.findByType(ChangedFilesReviewOutline as any);
        await act(async () => {
            outline.props.onSelectFile(fileB);
        });
        expect(tree!.root.findAllByType('CodeLinesView' as any)).toHaveLength(1);
    });

    it('toggles diff visibility when pressing a file row in stacked review mode', async () => {
        sessionScmDiffFileSpy.mockClear();
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

        const items = tree!.root.findAllByType('Item' as any);
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
});
