import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangedFilesReviewDiffBlock } from './ChangedFilesReviewDiffBlock';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffReviewCommentsViewerMock = vi.hoisted(() => ({
    renderCount: 0,
}));

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: {
                    OS: 'web',
                    select: (values: any) => values?.web ?? values?.default ?? null,
                },
                View: (props: any) => React.createElement('View', props, props.children),
                Image: (props: any) => React.createElement('Image', props, props.children),
                ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, props.children),
                AppState: {
                    currentState: 'active',
                    addEventListener: () => ({ remove: () => {} }),
                },
                Dimensions: {
                    get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }),
                },
                useWindowDimensions: () => ({ width: 1200, height: 800 }),
            },
        );
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (_key: string) => true,
        });
    },
});

vi.mock('@/components/ui/code/diff/resolveInlineDiffVirtualization', () => ({
    resolveInlineDiffVirtualization: () => true,
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => ({ lineThreshold: 1, byteThreshold: 1 }),
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isKnownBinaryPath: () => false,
    isKnownImagePath: () => false,
}));

vi.mock('./useChangedFilesReviewImagePreview', () => ({
    useChangedFilesReviewImagePreview: () => ({ status: 'idle' }),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => {
        diffReviewCommentsViewerMock.renderCount += 1;
        return React.createElement('DiffReviewCommentsViewer', props);
    },
}));

describe('ChangedFilesReviewDiffBlock', () => {
    beforeEach(() => {
        diffReviewCommentsViewerMock.renderCount = 0;
    });

    it('reserves a fixed height while loading for large diffs (prevents scroll jumps)', async () => {
        const loadingState = { status: 'loading', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadingState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = {
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        } as any;

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    estimatedChangedLines={2}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />)).tree;

        // Loading UI should include a container that reserves height (to reduce scroll jumps).
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const views = tree!.findAllByType('View' as any);
        const hasHeightReservation = views.some((view) => {
            const style = view.props.style;
            const arr = Array.isArray(style) ? style : [style];
            return arr.some((entry) => entry && typeof entry === 'object' && typeof entry.height === 'number' && entry.height > 0);
        });
        expect(hasHeightReservation).toBe(true);
    });

    it('bounds loaded virtualized diffs with explicit height so native lists do not collapse', async () => {
        const loadedState = { status: 'loaded', diff: '@@ -1 +1 @@\n-old\n+new', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadedState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = {
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        } as any;

        const screen = await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />);

        const boundedContainers = screen.findAll((node) => {
            const styles = Array.isArray(node.props?.style) ? node.props.style : [node.props?.style];
            return String(node.type) === 'View'
                && styles.some((entry) => entry && typeof entry === 'object' && typeof (entry as any).maxHeight === 'number');
        });
        expect(boundedContainers).toHaveLength(1);
        const styles = Array.isArray(boundedContainers[0].props.style)
            ? boundedContainers[0].props.style
            : [boundedContainers[0].props.style];
        const boundedStyle = styles.find((entry) => entry && typeof entry === 'object' && typeof (entry as any).maxHeight === 'number') as any;
        expect(boundedStyle.height).toBe(boundedStyle.maxHeight);
    });

    it('does not reserve the max diff height while loading for small diffs (avoids blank whitespace gaps)', async () => {
        const loadingState = { status: 'loading', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadingState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = {
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        } as any;

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    estimatedChangedLines={0}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />)).tree;

        // Loading UI should not reserve the large virtualized height for small diffs.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const views = tree!.findAllByType('View' as any);
        const reservedHeights = views
            .map((view) => view.props.style)
            .flatMap((style) => (Array.isArray(style) ? style : [style]))
            .filter((entry) => entry && typeof entry === 'object' && typeof (entry as any).height === 'number')
            .map((entry) => (entry as any).height as number);

        // The max virtualized height for this test window is ~440px; assert we don't reserve that.
        expect(reservedHeights.some((height) => height >= 400)).toBe(false);
    });

    it('does not rerender the diff viewer when only unrelated review drafts change', async () => {
        const loadedState = { status: 'loaded', diff: '@@ -1 +1 @@\n-old\n+new', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadedState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = {
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        } as any;

        const unrelatedDraft = {
            id: 'draft-1',
            filePath: 'src/b.ts',
            source: 'diff',
            anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: null, newLine: 1 },
            snapshot: { selectedLines: [], beforeContext: [], afterContext: [] },
            body: 'first',
            createdAt: 1,
        } as const;

        const screen = await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[unrelatedDraft]}
                />);

        expect(diffReviewCommentsViewerMock.renderCount).toBe(1);

        await renderer.act(async () => {
            screen.tree.update(<ChangedFilesReviewDiffBlock
                        theme={theme}
                        sessionId="s1"
                        snapshotSignature="sig"
                        filePath="src/a.ts"
                        diffStateSource={diffStateSource}
                        reviewCommentsEnabled={true}
                        reviewCommentDrafts={[{ ...unrelatedDraft, body: 'changed elsewhere' }]}
                    />);
        });

        expect(diffReviewCommentsViewerMock.renderCount).toBe(1);

        await renderer.act(async () => {
            screen.tree.update(<ChangedFilesReviewDiffBlock
                        theme={theme}
                        sessionId="s1"
                        snapshotSignature="sig"
                        filePath="src/a.ts"
                        diffStateSource={diffStateSource}
                        reviewCommentsEnabled={true}
                        reviewCommentDrafts={[{ ...unrelatedDraft, filePath: 'src/a.ts' }]}
                    />);
        });

        expect(diffReviewCommentsViewerMock.renderCount).toBe(2);
    });
});
