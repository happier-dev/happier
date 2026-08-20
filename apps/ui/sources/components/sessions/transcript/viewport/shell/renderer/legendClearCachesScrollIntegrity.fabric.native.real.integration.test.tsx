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
 * `clearCaches({ mode: 'sizes' })` must not move a scrolled reader.
 *
 * WHY THIS EXISTS: `LegendListCompat` calls exactly this when the screen regains focus, to re-apply
 * container layout the native stack dropped while the screen was detached (see
 * `LegendListCompat.focusRecheck.test.tsx` and
 * `.project/reviews/2026-08-19-legend-session-list-blank/sentinel-scroll-offset.md`). That fix is
 * only acceptable if it is invisible to a reader who had scrolled: `sizes` resets measurement
 * caches, and the obvious failure mode is the list snapping back to the top or re-deriving a
 * different render range.
 *
 * The device runs that proved the blank fixed all started at the top of the list, so they could not
 * have caught this. This pins it against the real shipped runtime instead.
 *
 * MEASURED shape of the invalidation: immediately after the call the engine reports the top of the
 * list (start 0, end 13) and then re-derives the original range asynchronously. The re-derive is
 * scheduled rather than synchronous, so this test settles until the range returns instead of
 * sampling one tick - an earlier version sampled once and flaked.
 *
 * This test does NOT discriminate `sizes` from `full`; both recover once given long enough. The
 * adapter uses `sizes` because it is the narrower invalidation (measurement caches only, leaving
 * key and position caches intact), not because `full` was measured to break this.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 54;
const ROW_COUNT = 120;
const VIEWPORT_HEIGHT = 715;
const SCROLL_OFFSET = 1_620; // 30 rows down, comfortably inside the content

type LegendHandle = Readonly<{
    clearCaches: (options?: { mode?: 'sizes' | 'full' }) => void;
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

describe('Legend native scroll integrity across clearCaches', () => {
    it('keeps the scroll position and render range when the size cache is reset', async () => {
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

        await act(async () => {
            created.root.findByType('ScrollView' as never).props.onLayout({
                nativeEvent: { layout: { height: VIEWPORT_HEIGHT, width: 800, x: 0, y: 0 } },
            });
            await Promise.resolve();
        });
        assertShippedNativeLegendRuntime(created, readShippedNativeModuleFacts(LegendNative, Platform));

        const dispatchScroll = (offset: number) => {
            const handler = created.root.findByType('ScrollView' as never).props.onScroll as
                | ((event: unknown) => void)
                | undefined;
            act(() => {
                handler?.({
                    nativeEvent: {
                        contentOffset: { x: 0, y: offset },
                        contentSize: { height: ROW_HEIGHT * ROW_COUNT, width: 800 },
                        layoutMeasurement: { height: VIEWPORT_HEIGHT, width: 800 },
                    },
                });
            });
        };

        dispatchScroll(SCROLL_OFFSET);
        const before = ref.current?.getState();
        expect(before?.scroll).toBe(SCROLL_OFFSET);
        expect(before?.start).toBeGreaterThan(0);

        await act(async () => {
            ref.current?.clearCaches({ mode: 'sizes' });
            await Promise.resolve();
        });
        // MEASURED: the invalidation briefly reports the top of the list (start 0, end 13) before it
        // re-derives. That intermediate state is not the contract - reading it was what made an
        // earlier version of this test fail - so settle a frame the way a real one would.
        const immediatelyAfter = ref.current?.getState();
        expect(immediatelyAfter?.scroll).toBe(SCROLL_OFFSET);

        // The re-derive is scheduled, not synchronous, and a single tick is not reliably enough -
        // an earlier version of this test used one and flaked. Settle until the range comes back,
        // bounded so a genuine failure to recover still fails the test rather than hanging.
        let after = ref.current?.getState();
        for (let attempt = 0; attempt < 40 && after?.start !== before?.start; attempt += 1) {
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
            after = ref.current?.getState();
        }

        expect(after?.scroll).toBe(SCROLL_OFFSET);
        expect(after?.start).toBe(before?.start);
        expect(after?.end).toBe(before?.end);

        // And a subsequent real scroll still moves from where the reader was, not from the top.
        dispatchScroll(SCROLL_OFFSET + 40);
        const afterRealScroll = ref.current?.getState();
        expect(afterRealScroll?.scroll).toBe(SCROLL_OFFSET + 40);
        expect(afterRealScroll?.start).toBe(before?.start);
    });
});
