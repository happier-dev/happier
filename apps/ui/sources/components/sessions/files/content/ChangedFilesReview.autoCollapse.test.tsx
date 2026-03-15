import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmDiffFileSpy: any = vi.fn(async (_sessionId: string, req: any) => ({
    success: true,
    diff: `diff --git a/${req.path} b/${req.path}\n--- a/${req.path}\n+++ b/${req.path}\n@@ -1 +1 @@\n-old\n+new\n`,
    error: null,
}));

vi.mock('@/text', () => ({
    t: (key: string, _vars?: any) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
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

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => React.createElement('DiffReviewCommentsViewer', props),
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => React.createElement('CodeLinesView', props),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
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

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (sessionId: string, req: any) => sessionScmDiffFileSpy(sessionId, req),
    sessionReadFile: vi.fn(async () => ({ success: false, content: '', error: 'nope' })),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'wrapLinesInDiffs') return true;
        if (key === 'showLineNumbers') return true;
        if (key === 'filesDiffInlineVirtualizationLineThreshold') return undefined;
        if (key === 'filesDiffInlineVirtualizationByteThreshold') return undefined;
        return undefined;
    },
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, _ref: any) => {
        const data = Array.isArray(props.data) ? props.data : [];

        React.useEffect(() => {
            if (typeof props.onViewableItemsChanged !== 'function') return;
            // Mark only the first file row as viewable. This allows the hook to compute
            // a stable requestedPaths set, and the review should auto-collapse diffs outside
            // of that set when tooLarge is true.
            const firstFileIndex = data.findIndex((row: any) => row?.kind === 'file');
            const secondFileIndex =
                firstFileIndex >= 0
                    ? data.findIndex((row: any, idx: number) => idx > firstFileIndex && row?.kind === 'file')
                    : -1;
            props.onViewableItemsChanged({
                viewableItems:
                    firstFileIndex >= 0
                        ? [
                            { index: firstFileIndex },
                            ...(secondFileIndex >= 0 ? [{ index: secondFileIndex }] : []),
                        ]
                        : [],
            });
        }, [data, props.onViewableItemsChanged]);

        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
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
        );
    }),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Image: 'Image',
    Pressable: 'Pressable',
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

describe('ChangedFilesReview (tooLarge behavior)', () => {
    it('keeps diff rows expanded by default even when tooLarge', async () => {
        sessionScmDiffFileSpy.mockClear();

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        const theme = {
            colors: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                textSecondary: '#aaa',
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
                pendingFiles: 3,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 3,
                pendingRemoved: 0,
            },
        } as any;

        const fileA = { fileName: 'a.ts', filePath: 'src', fullPath: 'src/a.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;
        const fileB = { fileName: 'b.ts', filePath: 'src', fullPath: 'src/b.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;
        const fileC = { fileName: 'c.ts', filePath: 'src', fullPath: 'src/c.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={theme}
                    sessionId="session-1"
                    snapshot={snapshot}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[fileA, fileB, fileC]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={1}
                    maxChangedLines={2000}
                    onFilePress={vi.fn()}
                />
            );
        });

        const diffBlocks = tree.root.findAll((node: any) => typeof node.props?.testID === 'string' && node.props.testID.startsWith('scm-review-diff-'));
        const diffTestIds = diffBlocks.map((node: any) => node.props.testID);

        // Virtualization now limits render cost, so tooLarge must not auto-collapse rows.
        // All rows remain expanded by default unless the user explicitly collapses them.
        expect(diffTestIds).toContain('scm-review-diff-src_a.ts');
        expect(diffTestIds).toContain('scm-review-diff-src_b.ts');
        expect(diffTestIds).toContain('scm-review-diff-src_c.ts');

        await act(async () => {
            tree.unmount();
        });
    });
});
