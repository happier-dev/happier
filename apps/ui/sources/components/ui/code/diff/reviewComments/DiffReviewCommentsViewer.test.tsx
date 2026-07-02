import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeDiffCommonModuleMocks } from '../codeDiffTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 120_000 };
let reviewCommentControls: any = null;
const diffViewerRenderSpy = vi.fn();

installCodeDiffCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'wrapLinesInDiffs') return true;
                if (key === 'showLineNumbers') return true;
                return null;
            },
        });
    },
});

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => {
        diffViewerRenderSpy(props);
        return React.createElement('DiffViewer', props);
    },
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => thresholds,
}));

vi.mock('@/components/ui/code/reviewComments/useCodeLinesReviewComments', () => ({
    useCodeLinesReviewComments: () => reviewCommentControls,
}));

vi.mock('@/components/ui/code/diff/useIntraLineWordDiffConfig', () => ({
    useIntraLineWordDiffConfig: () => ({
        enabled: true,
        maxLines: 10_000,
        maxLineLength: 10_000,
        maxPairs: 100,
    }),
}));

describe('DiffReviewCommentsViewer', () => {
    beforeEach(() => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 120_000 };
        reviewCommentControls = null;
        diffViewerRenderSpy.mockClear();
    });

    it('keeps non-virtual rendering for small diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(false);
    });

    it('enables virtualization for large diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 100 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a'.repeat(2_000)}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(true);
    });

    it('hides inactive line comment affordances for virtualized review diffs', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 100 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a'.repeat(2_000)}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(true);
        expect(view.props.showInactiveCommentAffordance).toBe(false);
    });

    it('hides inactive line comment affordances for non-virtualized native review diffs', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(false);
        expect(view.props.showInactiveCommentAffordance).toBe(false);
    });

    it('uses the review-comments line threshold for medium diffs', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 10, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={Array.from({ length: 24 }, (_, index) => `+line${index}`).join('\n')}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(true);
    });

    it('bounds large virtualized review diffs so native lists do not mount as unbounded content', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 100 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a'.repeat(2_000)}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const boundedContainers = screen.findAll((node) => (
            String(node.type) === 'View'
            && typeof node.props?.style?.maxHeight === 'number'
            && node.props.style.maxHeight > 0
        ));
        expect(boundedContainers).toHaveLength(1);
        expect(boundedContainers[0].props.style.height).toBe(boundedContainers[0].props.style.maxHeight);
    });

    it('reuses precomputed diff lines and disables word segmentation for virtualized review diffs', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 100 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a'.repeat(2_000)}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.precomputedLines).toBeTruthy();
        expect(view.props.precomputedLines.some((line: any) => Array.isArray(line.segments) && line.segments.length > 1)).toBe(false);
    });

    it('plumbs whole-line and range comment targets into DiffViewer', async () => {
        const onPressAddComment = vi.fn();
        const onPressAddCommentRange = vi.fn();
        reviewCommentControls = {
            onPressAddComment,
            onPressAddCommentRange,
            isCommentActive: () => false,
            renderAfterLine: () => null,
        };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'@@ -1,1 +1,1 @@\n+const a = 1;\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.onPressLine).toBe(onPressAddComment);
        expect(view.props.onPressLineRange).toBe(onPressAddCommentRange);
        expect(view.props.pressLineWhenNotSelectable).toBe(true);
    });

    it('keeps equivalent parent rerenders from invalidating DiffViewer props', async () => {
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        function Wrapper(props: Readonly<{ tick: number }>) {
            return (
                <>
                    {React.createElement('TickMarker', { value: props.tick })}
                    <DiffReviewCommentsViewer
                        filePath="src/a.ts"
                        unifiedDiff={'a\nb\n'}
                        reviewCommentsEnabled={true}
                        reviewCommentDrafts={[]}
                    />
                </>
            );
        }

        const { tree } = await renderScreen(<Wrapper tick={0} />);
        const firstCallCount = diffViewerRenderSpy.mock.calls.length;

        await act(async () => {
            tree.update(<Wrapper tick={1} />);
        });

        expect(diffViewerRenderSpy.mock.calls).toHaveLength(firstCallCount);
    });

    it('plumbs display configuration into DiffViewer', async () => {
        thresholds = { lineThreshold: 50_000, reviewCommentsLineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                    wrapLines={false}
                    showLineNumbers={true}
                    showPrefix={true}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.wrapLines).toBe(false);
        expect(view.props.showLineNumbers).toBe(true);
        expect(view.props.showPrefix).toBe(true);
    });
});
