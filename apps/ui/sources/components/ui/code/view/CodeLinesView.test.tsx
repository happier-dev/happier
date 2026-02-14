import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Platform: { OS: 'ios' },
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
    CodeLineRow: (props: any) => React.createElement('CodeLineRow', props),
}));

describe('CodeLinesView', () => {
    it('passes extraData to FlatList when renderAfterLine is provided', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
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
                />,
            );
        });

        const list = (tree as renderer.ReactTestRenderer).root.findByType('FlatList' as any);
        expect(list.props.extraData).toBeTruthy();
    });

    it('passes commentActive to CodeLineRow when isCommentActive reports true', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
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
                />,
            );
        });

        const list = (tree as renderer.ReactTestRenderer).root.findByType('FlatList' as any);
        expect(list.props.disableVirtualization).toBe(true);

        const rows = (tree as renderer.ReactTestRenderer).root.findAllByType('CodeLineRow' as any);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.props.commentActive).toBe(true);
    });

    it('marks a row as highlighted when highlightLineId matches', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
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
                />,
            );
        });

        const rows = (tree as renderer.ReactTestRenderer).root.findAllByType('CodeLineRow' as any);
        const highlighted = rows.filter((r) => r.props.highlighted === true);
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0]!.props.line.id).toBe('2');
    });

    it('does not downgrade advanced syntax highlighting mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
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
                />,
            );
        });

        const rows = (tree as renderer.ReactTestRenderer).root.findAllByType('CodeLineRow' as any);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.props.syntaxHighlighting.mode).toBe('advanced');
    });

    it('sets initialScrollIndex when scrollToLineId is provided', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
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
                />,
            );
        });

        const list = (tree as renderer.ReactTestRenderer).root.findByType('FlatList' as any);
        expect(list.props.initialScrollIndex).toBe(1);
    });

    it('attempts a DOM scrollIntoView fallback when scrollToLineId is provided', async () => {
        vi.useFakeTimers();
        const getElementById = vi.fn();
        const scrollIntoView = vi.fn();
        getElementById.mockReturnValue({ scrollIntoView });
        const previousDocument = (globalThis as any).document;
        (globalThis as any).document = { getElementById };

        try {
            const { CodeLinesView } = await import('./CodeLinesView');

            renderer.act(() => {
                renderer.create(
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
                    />,
                );
            });

            // Effect uses a 0ms timeout.
            vi.runAllTimers();

            expect(getElementById).toHaveBeenCalledWith('b');
            expect(scrollIntoView).toHaveBeenCalled();
        } finally {
            (globalThis as any).document = previousDocument;
            vi.useRealTimers();
        }
    });

    it('falls back to setting scrollTop on the nearest scroll container when the target element is not mounted', async () => {
        vi.useFakeTimers();

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

            renderer.act(() => {
                renderer.create(
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
                    />,
                );
            });

            vi.runAllTimers();

            // Estimated row height is 22px; index 1 should land at ~22px.
            expect(scrollContainer.scrollTop).toBe(22);
        } finally {
            (globalThis as any).document = previousDocument;
            vi.useRealTimers();
        }
    });
});
