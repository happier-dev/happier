import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findAllByType, findFirstByType, renderScreen } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Platform: {
                OS: 'ios',
            },
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
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { dark: false, colors: {} },
        });
    },
});

vi.mock('./CodeLineRow', () => ({
    CodeLineRow: (props: any) => React.createElement('CodeLineRow', props),
}));

async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    return await run();
}

async function waitForCodeLinesViewScrollFallback(): Promise<void> {
    await renderer.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 75));
    });
}

describe('CodeLinesView', () => {
    it('does not render FlatList when virtualized=false', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    virtualized={false}
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                />)).tree;

        expect(findAllByType(tree, 'FlatList')).toHaveLength(0);

        const rows = findAllByType(tree, 'CodeLineRow');
        expect(rows).toHaveLength(1);
    });

    it('passes extraData to FlatList when renderAfterLine is provided', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    renderAfterLine={() => React.createElement('After')}
                />)).tree;

        const list = findFirstByType(tree, 'FlatList');
        if (!list) {
            throw new Error('expected FlatList');
        }
        expect(list.props.extraData).toBeTruthy();
    });

    it('passes commentActive to CodeLineRow when isCommentActive reports true', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    virtualized={false}
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    isCommentActive={(line) => line.id === '1'}
                />)).tree;

        const rows = findAllByType(tree, 'CodeLineRow');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.props.commentActive).toBe(true);
    });

    it('marks a row as highlighted when highlightLineId matches', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    virtualized={false}
                    highlightLineId="2"
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                        {
                            id: '2',
                            sourceIndex: 1,
                            kind: 'context',
                            oldLine: 2,
                            newLine: 2,
                            renderPrefixText: '',
                            renderCodeText: 'const y = 2;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                />)).tree;

        const rows = findAllByType(tree, 'CodeLineRow');
        const highlighted = rows.filter((r) => r.props.highlighted === true);
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0]!.props.line.id).toBe('2');
    });

    it('does not downgrade advanced syntax highlighting mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    syntaxHighlighting={{
                        mode: 'advanced',
                        language: 'ts',
                        maxBytes: 1_000_000,
                        maxLines: 10_000,
                        maxLineLength: 10_000,
                    }}
                />)).tree;

        const rows = findAllByType(tree, 'CodeLineRow');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.props.syntaxHighlighting.mode).toBe('advanced');
    });

    it('sets initialScrollIndex when scrollToLineId is provided', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    scrollToLineId="b"
                    lines={[
                        {
                            id: 'a',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'a',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                        {
                            id: 'b',
                            sourceIndex: 1,
                            kind: 'context',
                            oldLine: 2,
                            newLine: 2,
                            renderPrefixText: '',
                            renderCodeText: 'b',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                />)).tree;

        const list = findFirstByType(tree, 'FlatList');
        if (!list) {
            throw new Error('expected FlatList');
        }
        expect(list.props.initialScrollIndex).toBe(1);
    });

    it('attempts a DOM scrollIntoView fallback when scrollToLineId is provided', async () => {
        await withFakeTimers(async () => {
            const getElementById = vi.fn();
            const scrollIntoView = vi.fn();
            getElementById.mockReturnValue({ scrollIntoView });
            const previousDocument = (globalThis as any).document;
            (globalThis as any).document = { getElementById };

            try {
                const { CodeLinesView } = await import('./CodeLinesView');
                const screen = await renderScreen(
                    <CodeLinesView
                        scrollToLineId="b"
                        lines={[
                            {
                                id: 'a',
                                sourceIndex: 0,
                                kind: 'context',
                                oldLine: 1,
                                newLine: 1,
                                renderPrefixText: '',
                                renderCodeText: 'a',
                                renderIsHeaderLine: false,
                                selectable: false,
                            },
                            {
                                id: 'b',
                                sourceIndex: 1,
                                kind: 'context',
                                oldLine: 2,
                                newLine: 2,
                                renderPrefixText: '',
                                renderCodeText: 'b',
                                renderIsHeaderLine: false,
                                selectable: false,
                            },
                        ]}
                    />
                );
                await waitForCodeLinesViewScrollFallback();

                expect(getElementById).toHaveBeenCalledWith('b');
                expect(scrollIntoView).toHaveBeenCalled();
                await screen.unmount();
            } finally {
                (globalThis as any).document = previousDocument;
            }
        });
    });

    it('falls back to setting scrollTop on the nearest scroll container when the target element is not mounted', async () => {
        await withFakeTimers(async () => {
            const scrollContainer: any = {
                scrollTop: 0,
                clientHeight: 100,
                scrollHeight: 1000,
                parentElement: null,
                scrollTo: vi.fn(({ top }: { top: number }) => {
                    scrollContainer.scrollTop = top;
                }),
            };

            const anchorElement: any = {
                id: 'a',
                parentElement: scrollContainer,
            };

            const getElementById = vi.fn((id: string) => {
                if (id === 'b') return null; // target line not mounted yet
                if (id === 'a') return anchorElement; // first rendered row
                return null;
            });

            const previousDocument = (globalThis as any).document;
            (globalThis as any).document = { getElementById };

            try {
                const { CodeLinesView } = await import('./CodeLinesView');
                const screen = await renderScreen(
                    <CodeLinesView
                        scrollToLineId="b"
                        lines={[
                            {
                                id: 'a',
                                sourceIndex: 0,
                                kind: 'context',
                                oldLine: 1,
                                newLine: 1,
                                renderPrefixText: '',
                                renderCodeText: 'a',
                                renderIsHeaderLine: false,
                                selectable: false,
                            },
                            {
                                id: 'b',
                                sourceIndex: 1,
                                kind: 'context',
                                oldLine: 2,
                                newLine: 2,
                                renderPrefixText: '',
                                renderCodeText: 'b',
                                renderIsHeaderLine: false,
                                selectable: false,
                            },
                        ]}
                    />
                );
                await waitForCodeLinesViewScrollFallback();

                // Estimated row height is 22px; index 1 should land at ~22px.
                expect(scrollContainer.scrollTop).toBe(22);
                await screen.unmount();
            } finally {
                (globalThis as any).document = previousDocument;
            }
        });
    });
});
