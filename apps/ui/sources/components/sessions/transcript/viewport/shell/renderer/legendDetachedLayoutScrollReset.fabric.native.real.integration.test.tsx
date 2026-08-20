import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import * as LegendNative from '@legendapp/list/react-native';
import { LegendList } from '@legendapp/list/react-native';
import { Platform } from 'react-native';

import {
    assertShippedNativeLegendRuntime,
    createShippedNativeNodeMock,
    readShippedNativeModuleFacts,
    type ShippedNativeNodeMock,
} from '@/dev/testkit/legend/shippedNativeLegendRuntime';

/**
 * A screen going inactive must not move the reader.
 *
 * THE SYMPTOM (reported from the device): open a session from the session list, then half-swipe back
 * to peek at the list. It is already empty, or already scrolled to the top — before the navigation
 * has even completed. The list should simply still be there, exactly as it was left.
 *
 * THE SUSPECTED MECHANISM: a native stack lays the screen underneath out at height 0 while it is
 * inactive. Legend treats that as a real viewport size, and a zero-height viewport makes the content
 * smaller than the list, which trips the reset in `doMaintainScrollAtEnd`:
 *
 *     const contentSize = getContentSize(ctx);
 *     if (contentSize < state.scrollLength) { state.scroll = 0; }
 *
 * The scroll position is then gone before the screen ever comes back, which is why recovering on
 * focus is the wrong place to fix it — by then there is nothing left to restore.
 *
 * This drives the transition directly against the real shipped runtime: scroll down, deliver the
 * zero-height layout a detached screen produces, restore the real layout, and check the reader did
 * not move.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 54;
const ROW_COUNT = 120;
const VIEWPORT_HEIGHT = 715;
const SCROLL_OFFSET = 1_620;

type LegendHandle = Readonly<{
    getState: () => Readonly<{ end: number; scroll: number; scrollLength: number; start: number }>;
}>;

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
    if (mounted) {
        const current = mounted;
        act(() => current.unmount());
        mounted = null;
    }
});

describe('Legend native scroll position across an inactive-screen layout', () => {
    it('keeps the scroll position when the screen lays out at zero height and back', async () => {
        const nodes: ShippedNativeNodeMock = createShippedNativeNodeMock({
            rowHeight: ROW_HEIGHT,
            viewportHeight: VIEWPORT_HEIGHT,
        });
        const ref = React.createRef<LegendHandle | null>();
        const rows: Row[] = Array.from({ length: ROW_COUNT }, (_v, index) => ({ id: `row-${index}` }));

        let screen: ReactTestRenderer | null = null;
        await act(async () => {
            screen = create(
                <LegendList
                    data={rows}
                    estimatedItemSize={ROW_HEIGHT}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={ref as never}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                { createNodeMock: nodes.createNodeMock },
            );
        });
        const created = screen as unknown as ReactTestRenderer;
        mounted = created;

        const layout = async (height: number) => {
            await act(async () => {
                created.root.findByType('ScrollView' as never).props.onLayout({
                    nativeEvent: { layout: { height, width: 800, x: 0, y: 0 } },
                });
                await Promise.resolve();
            });
        };

        await layout(VIEWPORT_HEIGHT);
        assertShippedNativeLegendRuntime(created, readShippedNativeModuleFacts(LegendNative, Platform));

        act(() => {
            (created.root.findByType('ScrollView' as never).props.onScroll as (event: unknown) => void)?.({
                nativeEvent: {
                    contentOffset: { x: 0, y: SCROLL_OFFSET },
                    contentSize: { height: ROW_HEIGHT * ROW_COUNT, width: 800 },
                    layoutMeasurement: { height: VIEWPORT_HEIGHT, width: 800 },
                },
            });
        });

        const before = ref.current?.getState();
        expect(before?.scroll).toBe(SCROLL_OFFSET);
        expect(before?.start).toBeGreaterThan(0);

        // The screen goes inactive underneath a push, then comes back on pop.
        await layout(0);
        const whileDetached = ref.current?.getState();
        await layout(VIEWPORT_HEIGHT);

        let after = ref.current?.getState();
        for (let attempt = 0; attempt < 40 && after?.scroll !== SCROLL_OFFSET; attempt += 1) {
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
            after = ref.current?.getState();
        }

        expect({
            beforeScroll: before?.scroll,
            detachedScroll: whileDetached?.scroll,
            afterScroll: after?.scroll,
        }).toEqual({
            beforeScroll: SCROLL_OFFSET,
            detachedScroll: SCROLL_OFFSET,
            afterScroll: SCROLL_OFFSET,
        });
        expect(after?.start).toBe(before?.start);
    });
});
