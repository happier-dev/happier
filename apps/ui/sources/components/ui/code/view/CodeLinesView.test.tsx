import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findAllByType, findFirstByType, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { codeViewListRef, installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import type { CodeEditorLanguageIntelligence } from '../editor/codeEditorTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Platform: {
                OS: 'ios',
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

// Compile/load the real view graph during collection, before timing viewport behavior.
await import('./CodeLinesViewCore');
await import('../model/buildCodeLinesFromFile');

async function findCodeRows(tree: renderer.ReactTestRenderer) {
    const { CodeLineRow } = await import('./CodeLineRow');
    return tree.root.findAllByType(CodeLineRow);
}

describe('CodeLinesView', () => {
    it.each([true, false])('requests semantic tokens only for visible lines and retires an old viewport or disabled preference (native range: %s)', async (nativeRange) => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 5000 }, () => 'const target = 1;').join('\n') });
        const request = vi.fn<CodeEditorLanguageIntelligence['request']>();
        const snapshot = { mode: 'server' as const, status: 'ready' as const, selection: null, querySelection: null, kind: null, result: null,
            capabilities: { hover: false, definition: false, references: false, documentSymbol: false, diagnostics: 'none' as const,
                acceptsExternalChanges: false, semanticTokensRange: nativeRange, semanticTokensDelta: !nativeRange } };
        const controller = { getSnapshot: () => snapshot, subscribe: () => () => undefined, request };
        let finish!: (value: Awaited<ReturnType<typeof request>>) => void;
        request.mockImplementation(() => new Promise(done => { finish = done; }));
        const intelligence = { onPointerToken: vi.fn(), onActivateToken: vi.fn(), semantic: { controller, enabled: true } };
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} intelligence={intelligence} />);
        expect(request).not.toHaveBeenCalled();
        const visible = (indices: number[]) => findFirstByType(screen.tree, 'LegendList')!.props.onViewableItemsChanged({ viewableItems: indices.map(index => ({ index })) });
        await renderer.act(async () => visible([100, 101]));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        expect(request.mock.calls[0].slice(0, 2)).toEqual(['semanticTokens', { range: { start: { line: 100, character: 0 }, end: { line: 101, character: 17 } } }]);
        await renderer.act(async () => visible([100, 101]));
        expect(request).toHaveBeenCalledTimes(1);
        const stale = finish;
        await renderer.act(async () => visible([200, 201]));
        expect(request.mock.calls[0][2]?.aborted).toBe(true);
        await renderer.act(async () => stale({ status: 'ok', kind: 'semanticTokens', tokens: [{ serverId: 's', legend: { tokenTypes: ['function'], tokenModifiers: [] }, data: [100, 6, 6, 0, 0] }] }));
        expect((await findCodeRows(screen.tree))[100].props.semanticTokens).toBeUndefined();
        await renderer.act(async () => finish({ status: 'ok', kind: 'semanticTokens', tokens: [{ serverId: 's', legend: { tokenTypes: ['function'], tokenModifiers: [] }, data: [200, 6, 6, 0, 0, 200, 6, 6, 0, 0] }] }));
        const rows = await findCodeRows(screen.tree);
        expect(rows[200].props.semanticTokens).toEqual([{ start: 6, end: 12, role: 'function' }]);
        expect(rows[400].props.semanticTokens).toBeUndefined();
        await screen.update(<CodeLinesViewCore lines={lines} intelligence={{ ...intelligence, semantic: { controller, enabled: false } }} />);
        expect((await findCodeRows(screen.tree))[200].props.semanticTokens).toBeUndefined();
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('keeps native text naming and long-press line selection distinct in a selectable read view', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: 'target();' });
        const activate = vi.fn(() => true), select = vi.fn();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} interactionMode="commitSelection"
            onPressLine={select} onPressLineRange={vi.fn()} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />);
        const text = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.onTextLayout)[0]!;
        await renderer.act(async () => {
            text.props.onTextLayout({ nativeEvent: { lines: [{ text: 'target();', x: 0, y: 0, width: 90, height: 20 }] } });
            text.props.onPress({ nativeEvent: { locationX: 35, locationY: 10 }, stopPropagation: vi.fn() });
        });
        expect(activate).toHaveBeenCalledExactlyOnceWith(lines[0]!.id, 3, { via: 'touch', rect: null }, 1);
        expect(select).not.toHaveBeenCalled();
        activate.mockClear();
        await renderer.act(async () => {
            text.props.onLongPress();
            text.props.onPress({ nativeEvent: { locationX: 35, locationY: 10 }, stopPropagation: vi.fn() });
        });
        expect(select).toHaveBeenCalledExactlyOnceWith(lines[0], undefined);
        expect(activate).not.toHaveBeenCalled();
        select.mockClear(); activate.mockReturnValue(false);
        await renderer.act(async () => {
            text.props.onPress({ nativeEvent: { locationX: 35, locationY: 10 }, stopPropagation: vi.fn() });
        });
        expect(select).toHaveBeenCalledExactlyOnceWith(lines[0], expect.anything());
        await screen.unmount();
    });
    it('uses the file-wide digit count for every number column while keeping the review inset stable', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: 'one\ntwo' });
        const screen = await renderScreen(<CodeLinesView virtualized={false}
            lines={[lines[0]!, { ...lines[1]!, newLine: 10000 }]}
            onPressAddComment={() => {}} showInactiveCommentAffordance={false}
            isCommentActive={line => line.newLine === 10000} />);
        const sizingText = findAllByType(screen.tree, 'Text').filter(node => node.props.accessible === false && node.props['aria-hidden'] === true);
        expect(sizingText.map(node => node.children.join(''))).toEqual(['00000', '00000']);
        expect(findAllByType(screen.tree, 'View').filter(node => node.props.testID === 'review-comment-line-affordance-lane')).toHaveLength(2);
    });
    it('does not render VirtualizedList when virtualized=false', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    virtualized={false}
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0, hunkIndex: null,
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

        expect(findAllByType(tree, 'LegendList')).toHaveLength(0);

        const rows = await findCodeRows(tree);
        expect(rows).toHaveLength(1);
    });

    // A comment composer under a line of unwrapped code spans the visible code column and stays there while
    // the code scrolls sideways, so its Save / Cancel never sit past the pane edge on a wide file.
    it('pins what renders after a line to the visible width of a sideways-scrolling code column', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');
        const { DiffHunkRowViewportContext } = await import('@/components/ui/code/diff/hunks/DiffHunkRow');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const line = {
            id: '1', sourceIndex: 0, hunkIndex: null, kind: 'context', oldLine: 1, newLine: 1,
            renderPrefixText: '', renderCodeText: 'const x = 1;', renderIsHeaderLine: false, selectable: false,
        } as const;
        const tree = (await renderScreen(
            <DiffHunkRowViewportContext.Provider value={{ width: 584, offsetX: 120 }}>
                <CodeLinesView lines={[line]} virtualized={false} wrapLines={false}
                    renderAfterLine={() => React.createElement('After', { testID: 'after' })} />
            </DiffHunkRowViewportContext.Provider>,
        )).tree;
        const after = tree.root.findByProps({ testID: 'after' });
        const pin = flattenTestStyle(after.parent!.props.style);
        expect(pin.width).toBe(584);
        expect(pin.transform).toEqual([{ translateX: 120 }]);
    });

    it('passes extraData to VirtualizedList when renderAfterLine is provided', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0, hunkIndex: null,
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

        const list = findFirstByType(tree, 'LegendList');
        if (!list) {
            throw new Error('expected VirtualizedList');
        }
        expect(list.props.extraData).toBeTruthy();
    });

    it('keeps virtualized VirtualizedList structural props stable across equivalent rerenders', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        const lines = [
            {
                id: '1',
                sourceIndex: 0, hunkIndex: null,
                kind: 'context',
                oldLine: 1,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const x = 1;',
                renderIsHeaderLine: false,
                selectable: false,
            },
        ] as const;

        const rendered = await renderScreen(<CodeLinesView lines={lines} />);
        const before = findFirstByType(rendered.tree, 'LegendList');
        if (!before) {
            throw new Error('expected VirtualizedList');
        }
        const beforeRenderItem = before.props.renderItem;
        const beforeStyle = before.props.style;
        const beforeContentContainerStyle = before.props.contentContainerStyle;
        const beforeListFooterComponent = before.props.ListFooterComponent;

        await rendered.update(<CodeLinesView lines={lines} />);

        const after = findFirstByType(rendered.tree, 'LegendList');
        if (!after) {
            throw new Error('expected VirtualizedList');
        }

        expect(after.props.renderItem).toBe(beforeRenderItem);
        expect(after.props.style).toBe(beforeStyle);
        expect(after.props.contentContainerStyle).toBe(beforeContentContainerStyle);
        expect(after.props.ListFooterComponent).toBe(beforeListFooterComponent);
    });

    it('passes commentActive to CodeLineRow when isCommentActive reports true', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    virtualized={false}
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0, hunkIndex: null,
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

        const rows = await findCodeRows(tree);
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
                            sourceIndex: 0, hunkIndex: null,
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
                            sourceIndex: 1, hunkIndex: null,
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

        const rows = await findCodeRows(tree);
        const highlighted = rows.filter((r) => r.props.highlighted === true);
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0]!.props.line.id).toBe('2');
    });

    it('keeps a landed line banded until the reader presses into the code, then bands a new landing again', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');
        const line = (n: number) => ({ id: String(n), sourceIndex: n - 1, hunkIndex: null, kind: 'context' as const, oldLine: n, newLine: n,
            renderPrefixText: '', renderCodeText: `const v${n} = ${n};`, renderIsHeaderLine: false, selectable: false });
        const lines = [line(1), line(2), line(3)];
        const view = (ids: ReadonlySet<string>) => <CodeLinesView virtualized={false} highlightLineId="2" highlightLineIds={ids} lines={lines} />;
        const screen = await renderScreen(view(new Set(['2'])));
        const banded = async () => (await findCodeRows(screen.tree)).filter((row) => row.props.highlighted === true).map((row) => row.props.line.id);
        expect(await banded()).toEqual(['2']);
        const [first] = await findCodeRows(screen.tree);
        await renderer.act(async () => { first!.props.onPressLine?.(first!.props.line); });
        expect(await banded()).toEqual([]);
        // The same landing re-rendered stays released; a new landing (a new range) bands again.
        await screen.update(view(new Set(['2'])));
        expect(await banded()).toEqual(['2']);
    });

    it('marks every row in highlightLineIds as highlighted while preserving highlightLineId', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    virtualized={false}
                    highlightLineId="2"
                    highlightLineIds={new Set(['2', '3'])}
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0, hunkIndex: null,
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
                            sourceIndex: 1, hunkIndex: null,
                            kind: 'context',
                            oldLine: 2,
                            newLine: 2,
                            renderPrefixText: '',
                            renderCodeText: 'const y = 2;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                        {
                            id: '3',
                            sourceIndex: 2, hunkIndex: null,
                            kind: 'context',
                            oldLine: 3,
                            newLine: 3,
                            renderPrefixText: '',
                            renderCodeText: 'const z = 3;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                />)).tree;

        const rows = await findCodeRows(tree);
        const highlightedLineIds = rows
            .filter((r) => r.props.highlighted === true)
            .map((r) => r.props.line.id);
        expect(highlightedLineIds).toEqual(['2', '3']);
    });

    it('does not downgrade advanced syntax highlighting mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0, hunkIndex: null,
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

        const rows = await findCodeRows(tree);
        expect(rows).toHaveLength(1);
        const syntaxHighlighting = rows[0]!.props.syntaxHighlighting;
        if (!syntaxHighlighting) throw new Error('Expected advanced syntax highlighting on the rendered row');
        expect(syntaxHighlighting.mode).toBe('advanced');
    });

    it('extends a range with Shift-click in an explicit interaction mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        const onPressLine = vi.fn();
        const onPressLineRange = vi.fn();
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'one',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:2',
                sourceIndex: 1, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 2,
                renderPrefixText: '',
                renderCodeText: 'two',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:3',
                sourceIndex: 2, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 3,
                renderPrefixText: '',
                renderCodeText: 'three',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ];

        const screen = await renderScreen(<CodeLinesView
            virtualized={false}
            interactionMode="comment"
            lines={lines}
            onPressLine={onPressLine}
            onPressLineRange={onPressLineRange}
        />);

        const rows = await findCodeRows(screen.tree);
        const { Pressable } = await import('react-native');
        await pressTestInstanceAsync(rows[0]!.findByType(Pressable), 'range anchor row');
        await renderer.act(async () => {
            invokeTestInstanceHandler(rows[2]!.findByType(Pressable), 'onPress', { nativeEvent: { shiftKey: true } }, 'Shift-click range row');
        });

        expect(onPressLine).toHaveBeenCalledTimes(1);
        expect(onPressLineRange).toHaveBeenCalledTimes(1);
        expect(onPressLineRange.mock.calls[0]?.[0].map((line: any) => line.id)).toEqual(['f:1', 'f:2', 'f:3']);
    });

    it('does not start drag range selection in read mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        const onPressLineRange = vi.fn();
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'one',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:2',
                sourceIndex: 1, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 2,
                renderPrefixText: '',
                renderCodeText: 'two',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ];

        const screen = await renderScreen(<CodeLinesView
            virtualized={false}
            interactionMode="read"
            lines={lines}
            onPressLineRange={onPressLineRange}
        />);

        const rows = await findCodeRows(screen.tree);
        expect(rows[0]!.props.onPressInLine).toBeUndefined();
        expect(rows[1]!.props.onHoverLine).toBeUndefined();
        expect(rows[1]!.props.onPressOutLine).toBeUndefined();
        expect(onPressLineRange).not.toHaveBeenCalled();
    });

    it('uses explicit native range selection taps when range selection is active', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        const onPressLine = vi.fn();
        const onPressLineRange = vi.fn();
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'one',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:2',
                sourceIndex: 1, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 2,
                renderPrefixText: '',
                renderCodeText: 'two',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ];

        const screen = await renderScreen(<CodeLinesView
            virtualized={false}
            interactionMode="comment"
            rangeSelectionActive
            lines={lines}
            onPressLine={onPressLine}
            onPressLineRange={onPressLineRange}
        />);

        const rows = await findCodeRows(screen.tree);
        const onPressFirstLine = rows[0]!.props.onPressLine;
        const onPressSecondLine = rows[1]!.props.onPressLine;
        if (!onPressFirstLine || !onPressSecondLine) throw new Error('Expected range-selection row press callbacks');
        onPressFirstLine(lines[0]);
        onPressSecondLine(lines[1]);

        expect(onPressLine).not.toHaveBeenCalled();
        expect(onPressLineRange).toHaveBeenCalledTimes(1);
        expect(onPressLineRange.mock.calls[0]?.[0].map((line: any) => line.id)).toEqual(['f:1', 'f:2']);
    });

    it('selects a touch range: long-press starts it, taps extend it, and the lone row clears it', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');
        const lines = ['one', 'two', 'three'].map((code, index) => ({ id: `f:${index + 1}`, sourceIndex: index, hunkIndex: null,
            kind: 'file' as const, oldLine: null, newLine: index + 1, renderPrefixText: '', renderCodeText: code,
            renderIsHeaderLine: false, selectable: true }));
        const onPressLineRange = vi.fn();
        const onPressLine = vi.fn();
        const view = (selected: string[]) => <CodeLinesView virtualized={false} interactionMode="selectRange" lines={lines}
            selectedLineIds={new Set(selected)} rangeSelectionActive={selected.length > 0}
            onPressLine={onPressLine} onPressLineRange={onPressLineRange} pressLineWhenNotSelectable />;
        const screen = await renderScreen(view([]));
        const rowProps = async () => (await findCodeRows(screen.tree)).map((row) => row.props);
        // Nothing selected: a tap is not a range gesture.
        (await rowProps())[2]!.onPressLine!(lines[2]);
        expect(onPressLineRange).not.toHaveBeenCalled();
        (await rowProps())[0]!.onLongPressLine!(lines[0]);
        expect(onPressLineRange.mock.calls.at(-1)?.[0].map((line: any) => line.id)).toEqual(['f:1']);
        await screen.update(view(['f:1']));
        (await rowProps())[2]!.onPressLine!(lines[2]);
        expect(onPressLineRange.mock.calls.at(-1)?.[0].map((line: any) => line.id)).toEqual(['f:1', 'f:2', 'f:3']);
        await screen.update(view(['f:1']));
        (await rowProps())[0]!.onPressLine!(lines[0]);
        expect(onPressLineRange.mock.calls.at(-1)?.[0]).toEqual([]);
        expect(onPressLine).not.toHaveBeenCalled();
    });

    it('reveals a native line target through the shared index-scroll path', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeLinesView
                    scrollToLineId="b"
                    lines={[
                        {
                            id: 'a',
                            sourceIndex: 0, hunkIndex: null,
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
                            sourceIndex: 1, hunkIndex: null,
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

        const list = findFirstByType(tree, 'LegendList');
        if (!list) {
            throw new Error('expected VirtualizedList');
        }
        expect(codeViewListRef.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
    });


});
