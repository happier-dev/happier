import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: 'View',
                                    ScrollView: 'ScrollView',
                                    Platform: {
                                        OS: 'web',
                                        select: (options: any) => options?.web ?? options?.default ?? null,
                                    },
                                    AppState: {
                                        addEventListener: () => ({ remove: () => {} }),
                                    },
                                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: 'CodeLinesView',
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: 'DiffViewer',
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => ({ lineThreshold: 50_000, byteThreshold: 120_000 }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('FileContentPanel (web read-only diff)', () => {
    const theme = { colors: { textSecondary: '#999' } };

    it('uses DiffViewer when diff is read-only (no comments/selection)', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<FileContentPanel
                    theme={theme as any}
                displayMode="diff"
                sessionId="s1"
                filePath="src/a.ts"
                diffContent={['@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n')}
                fileContent={null}
                language="typescript"
                selectedLineKeys={new Set()}
                lineSelectionEnabled={false}
                onToggleLine={vi.fn()}
            />)).tree;

        expect(tree.findAllByType('DiffViewer' as any)).toHaveLength(1);
        expect(tree.findAllByType('CodeLinesView' as any)).toHaveLength(0);
    });
});
