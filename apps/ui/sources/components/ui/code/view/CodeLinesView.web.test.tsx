import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rowSpy = vi.fn();

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Platform: { OS: 'web' },
    FlatList: (props: any) => {
        const items = Array.isArray(props.data)
            ? props.data.map((item: any, index: number) =>
                React.createElement(
                    React.Fragment,
                    { key: props.keyExtractor ? props.keyExtractor(item) : String(index) },
                    props.renderItem ? props.renderItem({ item, index }) : null,
                )
            )
            : null;
        return React.createElement('FlatList', props, items);
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false, colors: {} } }),
}));

vi.mock('./CodeLineRow', () => ({
    CodeLineRow: (props: any) => {
        rowSpy(props);
        return React.createElement('CodeLineRow', props);
    },
}));

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    codeToTokens: () => ({
        fg: '#000',
        tokens: [[{ content: 'const', color: '#f00' }]],
    }),
}));

vi.mock('shiki', () => ({
    createHighlighter: (...args: any[]) => createHighlighterSpy(...args),
}));

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 25; i++) {
        // Allow state updates scheduled by async effects to flush.
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

async function flushReactAsyncWork(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await renderer.act(async () => {
            await flushMicrotasks();
        });
    }
}

describe('CodeLinesView (web)', () => {
    it('computes Shiki tokens when advanced syntax highlighting is enabled', async () => {
        rowSpy.mockClear();
        createHighlighterSpy.mockClear();
        const { CodeLinesView } = await import('./CodeLinesView.web');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
                    lines={[
                        {
                            id: 'f:1',
                            sourceIndex: 0,
                            kind: 'file',
                            oldLine: null,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    syntaxHighlighting={{
                        mode: 'advanced',
                        language: 'typescript',
                        maxBytes: 1_000_000,
                        maxLines: 10_000,
                        maxLineLength: 10_000,
                    }}
                />,
            );
        });

        // The row will be rendered at least once; after async tokenization, it should receive advancedTokens.
        let hasAdvanced = false;
        for (let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop
            await flushReactAsyncWork();
            const calls = rowSpy.mock.calls.map((c) => c[0]);
            if (calls.length === 0) continue;
            hasAdvanced = calls.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0);
            if (hasAdvanced) break;
        }
        expect(hasAdvanced).toBe(true);

        // Keep tree referenced to avoid act warnings about unmounted trees.
        expect(tree.root.findAllByType('CodeLineRow' as any).length).toBe(1);
    });
});
