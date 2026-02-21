import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            textSecondary: '#666',
            syntaxKeyword: '#b00',
            syntaxString: '#070',
            syntaxNumber: '#00b',
            syntaxFunction: '#850',
            syntaxDefault: '#111',
            syntaxComment: '#777',
            syntaxBracket1: '#a00',
            syntaxBracket2: '#0a0',
            syntaxBracket3: '#00a',
            syntaxBracket4: '#aa0',
            syntaxBracket5: '#0aa',
            surfaceHigh: '#eee',
            diff: {
                addedBg: '#e6ffed',
                removedBg: '#ffeef0',
                hunkHeaderBg: '#f6f8fa',
                addedText: '#22863a',
                removedText: '#b31d28',
                hunkHeaderText: '#111',
                contextText: '#24292e',
            },
            shadow: { color: '#000', opacity: 0.2 },
        },
    };

    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (v: any) => (typeof v === 'function' ? v(theme) : v) },
    };
});

describe('CodeLineRow', () => {
    it('renders prefix and code segments', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <CodeLineRow
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
                />,
            );
        });

        const serialized = JSON.stringify(tree!.toJSON());
        expect(serialized).toContain('+');
        expect(serialized).toContain('const x = 1;');
    });

    it('applies simple syntax highlighting when enabled', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <CodeLineRow
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
                />,
            );
        });

        const keywordNodes = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return (node.children || []).join('') === 'const';
        });

        expect(keywordNodes.length).toBeGreaterThan(0);
        const keywordStyle = keywordNodes[0]!.props.style;
        const flattened = Array.isArray(keywordStyle) ? keywordStyle.flat() : [keywordStyle];
        expect(flattened.some((s: any) => s?.color === '#b00')).toBe(true);
    });

    it('falls back to simple tokenization while advanced tokens are unavailable', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <CodeLineRow
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
                />,
            );
        });

        const keywordNodes = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return (node.children || []).join('') === 'const';
        });

        expect(keywordNodes.length).toBeGreaterThan(0);
        const keywordStyle = keywordNodes[0]!.props.style;
        const flattened = Array.isArray(keywordStyle) ? keywordStyle.flat() : [keywordStyle];
        expect(flattened.some((s: any) => s?.color === '#b00')).toBe(true);
    });

    it('shows a close-comment affordance when the inline comment is active', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <CodeLineRow
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
                />,
            );
        });

        const rowPressable = tree!.root.findAllByType('Pressable' as any)[0]!;
        act(() => {
            rowPressable.props.onHoverIn();
        });

        const buttons = tree!.root.findAll((node) => (node as any).type === 'Pressable' && (node as any).props.accessibilityRole === 'button');
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
        act(() => {
            tree = renderer.create(
                <CodeLineRow
                    line={line}
                    selected={false}
                    onPressAddComment={onPressAddComment}
                />,
            );
        });

        const rowPressable = tree!.root.findAllByType('Pressable' as any)[0]!;
        act(() => {
            rowPressable.props.onHoverIn();
        });

        const buttons = tree!.root.findAll((node) => (node as any).type === 'Pressable' && (node as any).props.accessibilityRole === 'button');
        expect(buttons).toHaveLength(1);

        act(() => {
            buttons[0]!.props.onPress();
        });

        expect(onPressAddComment).toHaveBeenCalledTimes(1);
        expect(onPressAddComment).toHaveBeenCalledWith(line);
    });

    it('sets nativeID to enable deep-link line scrolling on web', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <CodeLineRow
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
                />,
            );
        });

        const rootView = tree!.root.findAllByType('View' as any)[0]!;
        expect(rootView.props.nativeID).toBe('f:120');
    });

    it('preserves indentation on web by using pre-wrap whitespace', async () => {
        const { CodeLineRow } = await import('./CodeLineRow');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <CodeLineRow
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
                />,
            );
        });

        const codeNode = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Text') return false;
            return (node.children || []).join('') === '    if (x) {';
        })[0]!;

        const style = codeNode.props.style;
        const flattened = Array.isArray(style) ? style.flat() : [style];
        expect(flattened.some((s: any) => s?.whiteSpace === 'pre-wrap')).toBe(true);
    });
});
