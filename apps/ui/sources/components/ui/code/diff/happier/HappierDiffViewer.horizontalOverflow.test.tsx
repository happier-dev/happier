import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: (options: any) => options?.android ?? options?.native ?? options?.default ?? options?.web ?? options?.ios,
        },
    });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: () => false,
    });
});

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () => ({
        mode: 'off',
        language: null,
        maxBytes: 1_000_000,
        maxLines: 10_000,
        maxLineLength: 10_000,
    }),
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: Record<string, unknown>) =>
        React.createElement('CodeLinesView', props),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('Happier diff viewers horizontal overflow', () => {
    it('does not force flex sizing for inline non-virtualized diff bodies', async () => {
        const { HappierTextDiffViewer } = await import('./HappierTextDiffViewer');
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        const textScreen = await renderScreen(
            <HappierTextDiffViewer
                mode="text"
                oldText={'const value = 1;'}
                newText={'const value = 2;'}
                virtualized={false}
            />,
        );
        const textRootView = textScreen.tree.root.findAllByType('View' as any)[0];
        expect(flattenStyle(textRootView.props.style).flex).toBeUndefined();

        const unifiedScreen = await renderScreen(
            <HappierUnifiedDiffViewer
                mode="unified"
                unifiedDiff={'@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n'}
                virtualized={false}
            />,
        );
        const unifiedRootView = unifiedScreen.tree.root.findAllByType('View' as any)[0];
        expect(flattenStyle(unifiedRootView.props.style).flex).toBeUndefined();
    });

    it('passes inactive comment affordance visibility through text diffs', async () => {
        const { HappierTextDiffViewer } = await import('./HappierTextDiffViewer');

        const screen = await renderScreen(
            <HappierTextDiffViewer
                mode="text"
                oldText={'const value = 1;'}
                newText={'const value = 2;'}
                showInactiveCommentAffordance={false}
            />,
        );

        const codeLinesView = screen.tree.findByType('CodeLinesView' as any);
        expect(codeLinesView.props.showInactiveCommentAffordance).toBe(false);
    });

    it('uses a gesture-handler ScrollView for no-wrap text diffs on Android', async () => {
        const { HappierTextDiffViewer } = await import('./HappierTextDiffViewer');

        const screen = await renderScreen(
            <HappierTextDiffViewer
                mode="text"
                oldText={'const value = 1;'}
                newText={'const value = 2;'}
                wrapLines={false}
            />,
        );

        const scrollView = screen.tree.findByType('GestureHandlerScrollView' as any);
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
        expect(scrollView.props.disallowInterruption).toBe(true);
    });

    it('uses a gesture-handler ScrollView for no-wrap unified diffs on Android', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        const screen = await renderScreen(
            <HappierUnifiedDiffViewer
                mode="unified"
                unifiedDiff={'@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n'}
                wrapLines={false}
            />,
        );

        const scrollView = screen.tree.findByType('GestureHandlerScrollView' as any);
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
        expect(scrollView.props.disallowInterruption).toBe(true);
    });
});
