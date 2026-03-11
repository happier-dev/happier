import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
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
    resolveInlineDiffVirtualization: () => false,
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => ({ lineThreshold: 1, byteThreshold: 1 }),
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isKnownBinaryPath: () => false,
    isKnownImagePath: () => true,
}));

vi.mock('./useChangedFilesReviewImagePreview', () => ({
    useChangedFilesReviewImagePreview: () => ({
        status: 'loaded',
        uri: 'data:image/svg+xml;base64,PHN2Zy8+',
        svgXml: '<svg/>',
        error: null,
    }),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => React.createElement('DiffReviewCommentsViewer', props),
}));

vi.mock('react-native-svg', () => ({
    SvgXml: (props: any) => React.createElement('SvgXml', props),
}));

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: { ...rn.Platform, OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
        Image: (props: any) => React.createElement('Image', props, props.children),
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, props.children),
        AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
        Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
        useWindowDimensions: () => ({ width: 1200, height: 800 }),
    };
});

describe('ChangedFilesReviewDiffBlock (svg previews)', () => {
    it('renders an SvgXml preview for svg images on native when no diff is available', () => {
        const loadedState = { status: 'loaded', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadedState,
            subscribe: () => () => {},
        } as any;

        const theme = { colors: { textSecondary: '#999', divider: '#333', surfaceHigh: '#111', surface: '#000' } } as any;

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/icon.svg"
                    estimatedChangedLines={0}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />,
            );
        });

        expect(tree.root.findAllByType('SvgXml' as any).length).toBe(1);
    });
});
