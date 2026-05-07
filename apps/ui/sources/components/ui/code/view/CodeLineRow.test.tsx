import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import {
    findTestInstanceByTypeWithProps,
    renderScreen,
} from '@/dev/testkit';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    icons: async () => ({
        Ionicons: 'Ionicons',
    }),
});

describe('CodeLineRow', () => {
    it('renders prefix and code segments', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: '1',
                sourceIndex: 0,
                kind: 'add',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '+',
                renderCodeText: 'const x = 1;',
                renderIsHeaderLine: false,
                selectable: true,
            }}
            selected={false}
            onPressLine={() => {}}
        />);

        const serialized = JSON.stringify(screen.tree.toJSON());
        expect(serialized).toContain('+');
        expect(serialized).toContain('const x = 1;');
    });

    it('applies simple syntax highlighting when enabled', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: '1',
                sourceIndex: 0,
                kind: 'context',
                oldLine: 1,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const x = \"hi\";',
                renderIsHeaderLine: false,
                selectable: false,
            }}
            selected={false}
            syntaxHighlighting={{
                mode: 'simple',
                language: 'typescript',
                maxLineLength: 10_000,
            }}
        />);

        const keywordNode = findTestInstanceByTypeWithProps(screen.tree, 'Text' as any, { children: 'const' });

        expect(keywordNode).toBeTruthy();
        const keywordStyle = keywordNode!.props.style;
        const flattened = Array.isArray(keywordStyle) ? keywordStyle.flat() : [keywordStyle];
        const theme = createThemeFixture() as any;
        expect(flattened.some((s: any) => s?.color === theme.colors.syntaxKeyword)).toBe(true);
        expect(flattened.some((s: any) => s?.fontWeight === '600' || s?.fontWeight === 600)).toBe(true);
    });

    it('falls back to simple tokenization while advanced tokens are unavailable', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: '1',
                sourceIndex: 0,
                kind: 'context',
                oldLine: 1,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const x = \"hi\";',
                renderIsHeaderLine: false,
                selectable: false,
            }}
            selected={false}
            // No advancedTokens prop passed yet (e.g. while Shiki is loading / failed).
            syntaxHighlighting={{
                mode: 'advanced',
                language: 'typescript',
                maxLineLength: 10_000,
            }}
        />);

        const keywordNode = findTestInstanceByTypeWithProps(screen.tree, 'Text' as any, { children: 'const' });

        expect(keywordNode).toBeTruthy();
        const keywordStyle = keywordNode!.props.style;
        const flattened = Array.isArray(keywordStyle) ? keywordStyle.flat() : [keywordStyle];
        const theme = createThemeFixture() as any;
        expect(flattened.some((s: any) => s?.color === theme.colors.syntaxKeyword)).toBe(true);
        expect(flattened.some((s: any) => s?.fontWeight === '600' || s?.fontWeight === 600)).toBe(true);
    });

    it('shows a close-comment affordance when the inline comment is active', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: '1',
                sourceIndex: 0,
                kind: 'context',
                oldLine: 1,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const x = 1;',
                renderIsHeaderLine: false,
                selectable: true,
            }}
            selected={false}
            onPressAddComment={() => {}}
            commentActive
        />);

        const rowPressable = findTestInstanceByTypeWithProps(screen.tree, 'Pressable' as any, { onPress: undefined })!;
        act(() => {
            rowPressable.props.onHoverIn();
        });

        const closeCommentButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable' as any, {
            accessibilityRole: 'button',
            accessibilityLabel: 'Close comment',
        });
        expect(closeCommentButton).toBeTruthy();
    });

    it('invokes onPressAddComment when pressing the comment affordance', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const onPressAddComment = vi.fn();

        const line = {
            id: '1',
            sourceIndex: 0,
            kind: 'context' as const,
            oldLine: 1,
            newLine: 1,
            renderPrefixText: '',
            renderCodeText: 'const x = 1;',
            renderIsHeaderLine: false,
            selectable: true,
        };

        const screen = await renderScreen(<CodeLineRow
            line={line}
            selected={false}
            onPressAddComment={onPressAddComment}
        />);

        const rowPressable = findTestInstanceByTypeWithProps(screen.tree, 'Pressable' as any, { onPress: undefined })!;
        act(() => {
            rowPressable.props.onHoverIn();
        });

        const lane = screen.findByProps({ testID: 'review-comment-line-affordance-lane' });
        expect(flattenTestStyle(lane.props.style)).toMatchObject({
            width: 32,
            alignItems: 'center',
        });

        const buttons = findTestInstanceByTypeWithProps(screen.tree, 'Pressable' as any, {
            accessibilityRole: 'button',
            testID: 'review-comment-line-affordance',
        });
        expect(buttons).toBeTruthy();

        const icon = findTestInstanceByTypeWithProps(screen.tree, 'Ionicons' as any, {
            testID: 'review-comment-line-affordance-icon',
        });
        expect(icon?.props.name).toBe('chatbox-ellipses-outline');

        const stopPropagation = vi.fn();
        const stopImmediatePropagation = vi.fn();

        act(() => {
            buttons!.props.onPress({
                stopPropagation,
                nativeEvent: {
                    stopImmediatePropagation,
                },
            });
        });

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        expect(onPressAddComment).toHaveBeenCalledWith(line);
    });

    it('sets nativeID to enable deep-link line scrolling on web', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: 'f:120',
                sourceIndex: 0,
                kind: 'context',
                oldLine: 120,
                newLine: 120,
                renderPrefixText: '',
                renderCodeText: 'const x = 1;',
                renderIsHeaderLine: false,
                selectable: false,
            }}
            selected={false}
        />);

        expect(findTestInstanceByTypeWithProps(screen.tree, 'View' as any, { nativeID: 'f:120' })).toBeTruthy();
    });

    it('preserves indentation on web by using pre-wrap whitespace', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: '1',
                sourceIndex: 0,
                kind: 'context',
                oldLine: 1,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: '    if (x) {',
                renderIsHeaderLine: false,
                selectable: false,
            }}
            selected={false}
        />);

        const codeNode = findTestInstanceByTypeWithProps(screen.tree, 'Text' as any, { children: '    if (x) {' });

        const style = codeNode!.props.style;
        const flattened = Array.isArray(style) ? style.flat() : [style];
        expect(flattened.some((s: any) => s?.whiteSpace === 'pre-wrap')).toBe(true);
    });

    it('renders intra-line diff segments when provided', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        const screen = await renderScreen(<CodeLineRow
            line={{
                id: '1',
                sourceIndex: 0,
                kind: 'add',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '+',
                renderCodeText: 'const x = 1;',
                renderIsHeaderLine: false,
                selectable: false,
                renderIntraLineDiffSegments: [
                    { text: 'const ', kind: 'context' },
                    { text: 'x', kind: 'added' },
                    { text: ' = 1;', kind: 'context' },
                ],
            } as any}
            selected={false}
            syntaxHighlighting={{
                mode: 'simple',
                language: 'typescript',
                maxLineLength: 10_000,
            }}
        />);

        const theme = createThemeFixture() as any;
        const addedNodes = screen.tree.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            const style = node.props?.style;
            if (!style) return false;
            const flattened = Array.isArray(style) ? style.flat() : [style];
            return flattened.some((s: any) => s?.backgroundColor === theme.colors.diff.inlineAddedBg);
        });

        expect(addedNodes.length).toBeGreaterThan(0);
        const addedNode = addedNodes[0]!;
        const flattened = Array.isArray(addedNode.props.style) ? addedNode.props.style.flat() : [addedNode.props.style];

        expect(flattened.some((s: any) => s?.backgroundColor === theme.colors.diff.inlineAddedBg)).toBe(true);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('x');
    });
});
