import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ChangedFilesReviewDiffBlock } from './ChangedFilesReviewDiffBlock';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from '../filesContentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default ?? null,
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
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (_key: string) => true,
        });
    },
});

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

describe('ChangedFilesReviewDiffBlock (svg previews)', () => {
    it('renders an SvgXml preview for svg images on native when no diff is available', async () => {
        const loadedState = { status: 'loaded', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadedState,
            subscribe: () => () => {},
        } as any;

        const theme = { colors: { textSecondary: '#999', divider: '#333', surfaceHigh: '#111', surface: '#000' } } as any;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/icon.svg"
                    estimatedChangedLines={0}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />)).tree;

        expect(tree.findAllByType('SvgXml' as any).length).toBe(1);
    });
});
