import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
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
        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('CodeLineRow', () => {
    it('renders prefix and code segments', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('+');
        expect(serialized).toContain('const x = 1;');
    });

    it('applies simple syntax highlighting when enabled', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const keywordNodes = tree!.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return (node.children || []).join('') === 'const';
        });

        expect(keywordNodes.length).toBeGreaterThan(0);
        const keywordStyle = keywordNodes[0]!.props.style;
        const flattened = Array.isArray(keywordStyle) ? keywordStyle.flat() : [keywordStyle];
        const theme = createThemeFixture() as any;
        expect(flattened.some((s: any) => s?.color === theme.colors.syntaxKeyword)).toBe(true);
        expect(flattened.some((s: any) => s?.fontWeight === '600' || s?.fontWeight === 600)).toBe(true);
    });

    it('falls back to simple tokenization while advanced tokens are unavailable', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const keywordNodes = tree!.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return (node.children || []).join('') === 'const';
        });

        expect(keywordNodes.length).toBeGreaterThan(0);
        const keywordStyle = keywordNodes[0]!.props.style;
        const flattened = Array.isArray(keywordStyle) ? keywordStyle.flat() : [keywordStyle];
        const theme = createThemeFixture() as any;
        expect(flattened.some((s: any) => s?.color === theme.colors.syntaxKeyword)).toBe(true);
        expect(flattened.some((s: any) => s?.fontWeight === '600' || s?.fontWeight === 600)).toBe(true);
    });

    it('shows a close-comment affordance when the inline comment is active', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const rowPressable = tree!.findAllByType('Pressable' as any)[0]!;
        act(() => {
            rowPressable.props.onHoverIn();
        });

        const buttons = tree!.findAll((node) => (node as any).type === 'Pressable' && (node as any).props.accessibilityRole === 'button');
        expect(buttons.map((b) => b.props.accessibilityLabel)).toContain('Close comment');
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

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
                    line={line}
                    selected={false}
                    onPressAddComment={onPressAddComment}
                />)).tree;

        const rowPressable = tree!.findAllByType('Pressable' as any)[0]!;
        act(() => {
            rowPressable.props.onHoverIn();
        });

        const buttons = tree!.findAll((node) => (node as any).type === 'Pressable' && (node as any).props.accessibilityRole === 'button');
        expect(buttons).toHaveLength(1);

        await pressTestInstanceAsync(buttons[0]!, 'close comment button');

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        expect(onPressAddComment).toHaveBeenCalledWith(line);
    });

    it('sets nativeID to enable deep-link line scrolling on web', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const rootView = tree!.findAllByType('View' as any)[0]!;
        expect(rootView.props.nativeID).toBe('f:120');
    });

    it('preserves indentation on web by using pre-wrap whitespace', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const codeNode = tree!.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return (node.children || []).join('') === '    if (x) {';
        })[0]!;

        const style = codeNode.props.style;
        const flattened = Array.isArray(style) ? style.flat() : [style];
        expect(flattened.some((s: any) => s?.whiteSpace === 'pre-wrap')).toBe(true);
    });

    it('renders intra-line diff segments when provided', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<CodeLineRow
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
                />)).tree;

        const addedNodes = tree!.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            const style = node.props?.style;
            if (!style) return false;
            const flattened = Array.isArray(style) ? style.flat() : [style];
            const theme = createThemeFixture() as any;
            return flattened.some((s: any) => s?.backgroundColor === theme.colors.diff.inlineAddedBg);
        });

        expect(addedNodes.length).toBeGreaterThan(0);
        expect(JSON.stringify(tree!.toJSON())).toContain('x');
    });
});
