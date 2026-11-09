import React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { codeViewListRef, installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import { buildCodeLinesFromFile } from '../model/buildCodeLinesFromFile';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/store/hooks', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1 });
});
installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});

await import('./CodeLinesViewCore');
beforeEach(() => { Object.values(codeViewListRef).forEach(mock => mock.mockReset()); });

describe('native code reading continuity', () => {
    it('lets only the native viewer covering the viewport top restore a shared scroll owner', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let scrollY = 55;
        let inserted = false;
        const prefixes = new Map<string, number>();
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            // Native host geometry boundary.
            contentRef: { current: {} as View },
            offsetRef: { current: scrollY },
        };
        const render = () => <>
            <CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: inserted ? 'inserted\na\nb\nreading\nd' : 'a\nb\nreading\nd' })} />
            <CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: inserted ? 'one\ntwo\nlower\nend' : 'lower\nend' })} />
        </>;
        let roots = 0;
        const screen = await renderScreen(render(), {
            createNodeMock: (element) => {
                const id = (element.props as Record<string, unknown>).nativeID;
                if (typeof id === 'string') {
                    const prefix = id.split('-f:')[0];
                    if (!prefixes.has(prefix)) prefixes.set(prefix, prefixes.size);
                    const group = prefixes.get(prefix)!;
                    return { measureLayout: (_relative: unknown, done: (x: number, y: number, w: number, h: number) => void) => done(0, (group ? 300 + (inserted ? 25 : 0) : 0) + (Number(id.split(':').at(-1)) - 1) * 25, 100, 25) };
                }
                const style = (element.props as Record<string, unknown>).style;
                if (style && typeof style === 'object' && 'paddingVertical' in style) {
                    const group = roots++;
                    return { measureLayout: (_relative: unknown, done: (x: number, y: number, w: number, h: number) => void) => done(0, group ? 300 : 0, 100, 200) };
                }
                return null;
            },
        });
        await act(async () => {
            for (const node of screen.tree.root.findAll((node) => String(node.type) === 'View')) node.props.onLayout?.();
        });
        inserted = true;
        await screen.update(render());
        expect(scrollY).toBe(80);
    });

    it('uses measured row geometry when refreshed lines above the passage wrap', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let scrollY = 55;
        let inserted = false;
        codeViewListRef.getNativeScrollRef.mockReturnValue({ measureInWindow: (success: (x: number, y: number) => void) => success(0, 0) });
        codeViewListRef.scrollToOffset.mockImplementation(({ offset }: { offset: number }) => { scrollY = offset; });
        codeViewListRef.scrollToIndex.mockImplementation(({ index, viewOffset }: { index: number; viewOffset: number }) => { scrollY = index * 25 - viewOffset; });
        const screen = await renderScreen(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'a\nb\nreading\nd' })} />, {
            createNodeMock: (element) => typeof (element.props as Record<string, unknown>).nativeID === 'string' ? {
                measureInWindow: (success: (x: number, y: number) => void) => {
                    const index = Number(String((element.props as Record<string, unknown>).nativeID).split(':').at(-1)) - 1;
                    const y = inserted && index > 0 ? 60 + (index - 1) * 25 : index * 25;
                    success(0, y - scrollY);
                },
            } : null,
        });
        await act(async () => {
            screen.findByType('LegendList').props.onScroll({ nativeEvent: { contentOffset: { y: scrollY } } });
            screen.findByType('LegendList').props.onViewableItemsChanged({ viewableItems: [{ index: 2 }] });
        });
        inserted = true;
        await screen.update(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'wrapped insertion\na\nb\nreading\nd' })} />);
        expect(scrollY).toBe(115);
    });

    it.each([{ tail: 'c\nreading', initial: 80 }, { tail: 'reading\nd', initial: 55 }])('preserves consecutive external refreshes at offset $initial', async ({ tail, initial }) => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let scrollY = initial;
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            // Native host measurement boundary is supplied by createNodeMock.
            contentRef: { current: {} as View },
            offsetRef: { current: scrollY },
        };
        const screen = await renderScreen(<CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: `a\nb\n${tail}` })} />, {
            createNodeMock: (element) => typeof (element.props as Record<string, unknown>).nativeID === 'string' ? {
                measureLayout: (_relative: unknown, success: (x: number, y: number, width: number, height: number) => void) => {
                    const index = Number(String((element.props as Record<string, unknown>).nativeID).split(':').at(-1)) - 1;
                    success(0, index * 25, 100, 25);
                },
            } : null,
        });
        await act(async () => {
            for (const row of screen.tree.root.findAll((node) => String(node.type) === 'View' && typeof node.props.nativeID === 'string')) row.props.onLayout?.();
        });
        await screen.update(<CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: `inserted\na\nb\n${tail}` })} />);
        expect(scrollY).toBe(initial + 25);
        // A second refresh can commit before the native onScroll echo arrives.
        await screen.update(<CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: `second\ninserted\na\nb\n${tail}` })} />);
        expect(scrollY).toBe(initial + 50);
    });

    it('retains the mapped passage through index navigation without a measured target row', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let visible: { index: number; viewOffset?: number; viewPosition?: number } = { index: 2 };
        codeViewListRef.scrollToIndex.mockImplementation((target: typeof visible) => { visible = target; });
        const screen = await renderScreen(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'a\nb\nreading\nd' })} />);
        await act(async () => {
            screen.findByType('LegendList').props.onViewableItemsChanged({ viewableItems: [{ index: 2 }] });
        });
        await screen.update(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'inserted\na\nb\nreading\nd' })} />);
        expect(visible.index).toBe(3);
        expect(visible.viewOffset).toBe(0);
        expect(visible.viewPosition).toBeUndefined();
    });
});
