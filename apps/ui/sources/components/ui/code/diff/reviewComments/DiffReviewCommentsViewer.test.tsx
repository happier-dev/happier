import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };

vi.mock('react-native', () => ({
    View: 'View',
    Platform: {
        OS: 'ios',
        select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
    },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => thresholds,
}));

vi.mock('@/components/sessions/reviews/comments/useCodeLinesReviewComments', () => ({
    useCodeLinesReviewComments: () => null,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'wrapLinesInDiffs') return true;
        if (key === 'showLineNumbers') return true;
        return null;
    },
}));

describe('DiffReviewCommentsViewer', () => {
    it('keeps non-virtual rendering for small diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />,
            );
        });

        const view = tree.root.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(false);
    });

    it('enables virtualization for large diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 100 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a'.repeat(2_000)}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />,
            );
        });

        const view = tree.root.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(true);
    });

    it('plumbs display configuration into DiffViewer', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                    wrapLines={false}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        const view = tree.root.findByType('DiffViewer' as any);
        expect(view.props.wrapLines).toBe(false);
        expect(view.props.showLineNumbers).toBe(true);
        expect(view.props.showPrefix).toBe(true);
    });
});
