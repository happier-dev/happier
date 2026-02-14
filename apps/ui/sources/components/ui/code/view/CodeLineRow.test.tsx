import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
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
            },
        },
    }),
    StyleSheet: { create: (v: any) => (typeof v === 'function' ? v({ colors: {} }) : v) },
}));

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
});
