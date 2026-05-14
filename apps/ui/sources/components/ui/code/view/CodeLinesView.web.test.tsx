import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rowSpy = vi.fn();

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
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
            theme: {
                dark: false,
                colors: {
                    surface: { base: '#fff', inset: '#fff' },
                    text: { primary: '#111', secondary: '#666' },
                    syntax: {
                        default: '#111',
                        keyword: '#123456',
                        string: '#0a3069',
                        comment: '#666',
                        number: '#0550ae',
                        function: '#8250df',
                    },
                },
            },
        });
    },
});

vi.mock('./CodeLineRow', () => ({
    CodeLineRow: (props: any) => {
        rowSpy(props);
        return React.createElement('CodeLineRow', props);
    },
}));

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    loadLanguage: async () => {},
    codeToTokens: () => ({
        fg: '#000',
        tokens: [[{ content: 'const', color: '#f00' }]],
    }),
}));

vi.mock('shiki', () => ({
    bundledLanguages: {
        ts: {},
        js: {},
        python: {},
    },
    createHighlighter: (...args: any[]) => createHighlighterSpy(...args),
}));

async function flushReactAsyncWork(): Promise<void> {
    await flushHookEffects({ cycles: 10, turns: 25 });
}

describe('CodeLinesView (web)', () => {
    it('completes a web drag range in an explicit interaction mode', async () => {
        rowSpy.mockClear();
        const { CodeLinesView } = await import('./CodeLinesView.web');

        const onPressLineRange = vi.fn();
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0,
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
                sourceIndex: 1,
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
                sourceIndex: 2,
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
            interactionMode="commitSelection"
            lines={lines}
            onPressLineRange={onPressLineRange}
        />);

        const rows = screen.findAllByType('CodeLineRow' as any);
        const event = { preventDefault: vi.fn(), nativeEvent: { preventDefault: vi.fn() } };
        rows[0]!.props.onPressInLine(lines[0], event);
        rows[2]!.props.onHoverLine(lines[2], event);
        rows[2]!.props.onPressOutLine(lines[2], event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.nativeEvent.preventDefault).toHaveBeenCalled();
        expect(onPressLineRange).toHaveBeenCalledTimes(1);
        expect(onPressLineRange.mock.calls[0]?.[0].map((line: any) => line.id)).toEqual(['f:1', 'f:2', 'f:3']);
    });

    it('retries highlighter initialization after a cached failure', async () => {
        rowSpy.mockClear();
        createHighlighterSpy.mockReset();
        createHighlighterSpy
            .mockImplementationOnce(async () => {
                throw new Error('shiki_init_failed');
            })
            .mockImplementation(async () => ({
                loadLanguage: async () => {},
                codeToTokens: () => ({
                    fg: '#000',
                    tokens: [[{ content: 'const', color: '#f00' }]],
                }),
            }));

        const { CodeLinesView } = await import('./CodeLinesView.web');

        const view = (
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
            />
        );

        const screen1 = await renderScreen(view);
        await flushReactAsyncWork();

        // Uses Happier themes instead of generic GitHub themes.
        expect(createHighlighterSpy.mock.calls[0]?.[0]?.themes?.[0]?.name).toMatch(/^happier-light-/);

        const calls1 = rowSpy.mock.calls.map((c) => c[0]);
        expect(calls1.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0)).toBe(false);

        renderer.act(() => {
            screen1.tree.unmount();
        });

        rowSpy.mockClear();

        const screen2 = await renderScreen(view);
        await flushReactAsyncWork();

        const calls2 = rowSpy.mock.calls.map((c) => c[0]);
        expect(calls2.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0)).toBe(true);
        expect(createHighlighterSpy).toHaveBeenCalledTimes(2);

        expect(screen2.findAllByType('CodeLineRow' as any).length).toBe(1);
    });

    it('computes Shiki tokens when advanced syntax highlighting is enabled', async () => {
        rowSpy.mockClear();
        createHighlighterSpy.mockClear();
        const { CodeLinesView } = await import('./CodeLinesView.web');

        const screen = await renderScreen(<CodeLinesView
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
                />);

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
        expect(screen.findAllByType('CodeLineRow' as any).length).toBe(1);
    });
});
