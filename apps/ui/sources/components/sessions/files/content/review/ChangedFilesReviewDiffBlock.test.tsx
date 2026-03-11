import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ChangedFilesReviewDiffBlock } from './ChangedFilesReviewDiffBlock';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (_key: string) => true,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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
    DiffReviewCommentsViewer: (props: any) => React.createElement('DiffReviewCommentsViewer', props),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default ?? null },
    View: (props: any) => React.createElement('View', props, props.children),
    Image: (props: any) => React.createElement('Image', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, props.children),
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));

describe('ChangedFilesReviewDiffBlock', () => {
    it('reserves a fixed height while loading for large diffs (prevents scroll jumps)', () => {
        const loadingState = { status: 'loading', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadingState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = { colors: { textSecondary: '#999', divider: '#333', surfaceHigh: '#111', surface: '#000' } } as any;

        let tree: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    estimatedChangedLines={2}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />,
            );
        });

        // Loading UI should include a container that reserves height (to reduce scroll jumps).
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const views = tree!.root.findAllByType('View' as any);
        const hasHeightReservation = views.some((view) => {
            const style = view.props.style;
            const arr = Array.isArray(style) ? style : [style];
            return arr.some((entry) => entry && typeof entry === 'object' && typeof entry.height === 'number' && entry.height > 0);
        });
        expect(hasHeightReservation).toBe(true);
    });

    it('does not reserve the max diff height while loading for small diffs (avoids blank whitespace gaps)', () => {
        const loadingState = { status: 'loading', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadingState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = { colors: { textSecondary: '#999', divider: '#333', surfaceHigh: '#111', surface: '#000' } } as any;

        let tree: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    estimatedChangedLines={0}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />,
            );
        });

        // Loading UI should not reserve the large virtualized height for small diffs.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const views = tree!.root.findAllByType('View' as any);
        const reservedHeights = views
            .map((view) => view.props.style)
            .flatMap((style) => (Array.isArray(style) ? style : [style]))
            .filter((entry) => entry && typeof entry === 'object' && typeof (entry as any).height === 'number')
            .map((entry) => (entry as any).height as number);

        // The max virtualized height for this test window is ~440px; assert we don't reserve that.
        expect(reservedHeights.some((height) => height >= 400)).toBe(false);
    });
});
