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
 * A row that no longer exists must not be able to write the list's content total.
 *
 * THE DEFECT (a sentinel collision, measured on device — `.project/reviews/2026-08-01-send-transition/`,
 * lanes U3/U4, traces W52):
 *
 *   - `getId(state, index)` returns `null` for any `index >= data.length` (react-native.mjs:1044) —
 *     "there is no such row".
 *   - `addTotalSize(ctx, key, add)` treats `key === null` as its ABSOLUTE-WRITE sentinel
 *     (`:1074`) — "this number IS the total".
 *
 * Those two `null`s are the same value, so one probe of a row index that the current `data` no
 * longer contains assigns the whole content size to be one unmeasured row:
 *
 *   getId -> null -> getItemSize falls through to `estimatedItemSize` (240 for the transcript)
 *         -> setSize(ctx, null, 240) -> addTotalSize(ctx, null, 240) -> totalSize = 240, ABSOLUTE.
 *
 * MEASURED on device, stack captured 4/4 identical, and the collapsed value is a CONSTANT rather
 * than a sum — `totalSize` 2,322 -> 240 on a 43-row transcript AND 266,020 -> 240 on a 419-row one.
 * `updateContentMetricsState` then grew `alignItemsAtEndPadding` to 297 (12 header + 142 footer +
 * 240 + 297 = 691, the viewport, to the pixel), `UIScrollView` adopted that one-viewport content
 * size and clamped `contentOffset`, and the transcript went blank on send.
 *
 * THE REACHING CALLER, read off the captured stack (`traces/W52/U3/captures/tsw_R09.json`):
 * `checkResetContainers -> calculateItemsInView -> unstable_batchedUpdates -> prepareMVCP`'s
 * returned closure -> `getItemSize(ctx, targetId, scrollTarget, data[scrollTarget])`
 * (react-native.mjs:2004), where `targetId = getId(state, scrollTarget)` (`:1917`) and
 * `scrollTarget = state.scrollingTo.index` — an index captured when the scroll was requested,
 * against the LONGER data. `getItemSizeAtIndex` is NOT on that path, which is why a guard there
 * alone would not have covered the measured device stack.
 *
 * THE TRIGGER, reproduced below exactly as the app produces it: the transcript pins to the newly
 * appended pending row (`scrollToIndex` on the last index, which Legend gives `viewPosition = 1`),
 * and the send crossover then reverts `data` to its pre-send array for ~0.5–1.2 s while the outbox
 * projection hands off to the server pending queue. The pinned index is now past the end.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 54;
const ROW_COUNT = 43;
const VIEWPORT_HEIGHT = 691;
/** The transcript's own value (`legendListRenderer.tsx`), and the exact collapsed total measured. */
const ESTIMATED_ITEM_SIZE = 240;
const MEASURED_CONTENT = ROW_HEIGHT * ROW_COUNT; // 2322, the measured pre-send total
const LAST_ROW_TOP = MEASURED_CONTENT - ROW_HEIGHT; // 2268
const PENDING_INDEX = ROW_COUNT; // 43 - the appended pending row, and the pinned scroll target

type LegendCtx = Readonly<Record<string, never>>;

/**
 * `internal` is a real runtime export that the package's `.d.ts` does not declare (the same
 * structural read `readShippedNativeModuleFacts` makes for `IsNewArchitecture`). `peek$` reads a
 * published signal without subscribing, which is exactly what a consumer — and `UIScrollView` —
 * sees.
 */
const legendInternal = (LegendNative as unknown as {
    internal?: {
        peek$?: (ctx: LegendCtx, name: string) => unknown;
        useStateContext?: () => LegendCtx;
    };
}).internal;

function requireLegendInternal(): Readonly<{
    peek: (ctx: LegendCtx, name: string) => unknown;
    useStateContext: () => LegendCtx;
}> {
    const peek = legendInternal?.peek$;
    const useStateContext = legendInternal?.useStateContext;
    if (typeof peek !== 'function' || typeof useStateContext !== 'function') {
        throw new Error(
            '@legendapp/list/react-native no longer exposes `internal.peek$` / `internal.useStateContext`. '
            + 'This test reads the PUBLISHED content total through them; find the new signal before '
            + 'trusting any result here.',
        );
    }
    return { peek, useStateContext };
}

function buildRows(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `msg-${index}` }));
}

type PublishedTotals = Readonly<{
    alignItemsAtEndPadding: number;
    headerSize: number;
    totalSize: number;
}>;

type LegendHandle = Readonly<{
    getState: () => Readonly<{ positionAtIndex: (index: number) => number | undefined }>;
    scrollToIndex: (params: Readonly<{ animated?: boolean; index: number; viewPosition?: number }>) => Promise<void>;
}>;

type Harness = Readonly<{
    handle: () => LegendHandle;
    lastRowTop: () => number | undefined;
    render: (data: readonly Row[]) => Promise<void>;
    scroll: (offset: number, contentHeight: number) => Promise<void>;
    scrollWriteCount: () => number;
    totals: () => PublishedTotals;
}>;

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
    if (mounted) {
        const current = mounted;
        act(() => current.unmount());
        mounted = null;
    }
});

const moduleFacts = () => readShippedNativeModuleFacts(LegendNative, Platform);

async function mountHarness(initial: readonly Row[]): Promise<Harness> {
    const { peek, useStateContext } = requireLegendInternal();
    const nodes: ShippedNativeNodeMock = createShippedNativeNodeMock({
        rowHeight: ROW_HEIGHT,
        viewportHeight: VIEWPORT_HEIGHT,
    });
    const ref = React.createRef<LegendHandle | null>();
    let ctx: LegendCtx | null = null;

    // Rendered INSIDE the list, so it resolves the list's own state context. Reading the published
    // signals is the only way to separate `totalSize` from `alignItemsAtEndPadding`; the ref's
    // `contentLength` sums them and would let a collapse hide inside the padding that replaces it.
    function ContextProbe(): null {
        ctx = useStateContext();
        return null;
    }

    const element = (data: readonly Row[]) => (
        <LegendList
            alignItemsAtEnd
            data={[...data]}
            estimatedItemSize={ESTIMATED_ITEM_SIZE}
            keyExtractor={(item: Row) => item.id}
            ListHeaderComponent={<ContextProbe />}
            maintainVisibleContentPosition={{ data: true, size: true }}
            recycleItems={false}
            ref={ref as never}
            renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
        />
    );

    let screen: ReactTestRenderer | null = null;
    await act(async () => {
        screen = create(element(initial), { createNodeMock: nodes.createNodeMock });
    });
    const created = screen as unknown as ReactTestRenderer;
    mounted = created;
    await act(async () => {
        created.root.findByType('ScrollView' as never).props.onLayout({
            nativeEvent: { layout: { height: VIEWPORT_HEIGHT, width: 800, x: 0, y: 0 } },
        });
        await Promise.resolve();
    });
    assertShippedNativeLegendRuntime(created, moduleFacts());

    const readNumber = (name: string): number => {
        if (ctx === null) throw new Error('the list state context was never resolved');
        const value = peek(ctx, name);
        return typeof value === 'number' ? value : 0;
    };

    const dispatchScroll = (offset: number, contentHeight: number) => {
        const handler = created.root.findByType('ScrollView' as never).props.onScroll as
            | ((event: unknown) => void)
            | undefined;
        handler?.({
            nativeEvent: {
                contentOffset: { x: 0, y: offset },
                contentSize: { height: contentHeight, width: 800 },
                layoutMeasurement: { height: VIEWPORT_HEIGHT, width: 800 },
            },
        });
    };

    return {
        handle: () => {
            const current = ref.current;
            if (!current) throw new Error('the LegendList ref was never populated');
            return current;
        },
        lastRowTop: () => ref.current?.getState().positionAtIndex(ROW_COUNT - 1),
        render: async (data) => {
            await act(async () => {
                created.update(element(data));
                await Promise.resolve();
            });
        },
        scroll: async (offset, contentHeight) => {
            await act(async () => {
                dispatchScroll(offset, contentHeight);
                await Promise.resolve();
            });
        },
        scrollWriteCount: () => nodes.scroller.scrollWrites.length,
        totals: () => ({
            alignItemsAtEndPadding: readNumber('alignItemsAtEndPadding'),
            headerSize: readNumber('headerSize'),
            totalSize: readNumber('totalSize'),
        }),
    };
}

/** Lets the list's deferred work (its `requestAnimationFrame`-gated imperative scroll) run. */
async function settle(): Promise<void> {
    await act(async () => {
        for (let tick = 0; tick < 8; tick++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    });
}

/**
 * Drives the exact measured device sequence: append the pending row, pin to it, then revert `data`
 * to the pre-send array while that pin is still the list's scroll target.
 */
async function runSendCrossover(harness: Harness): Promise<PublishedTotals> {
    const base = buildRows(ROW_COUNT);
    await harness.scroll(MEASURED_CONTENT - VIEWPORT_HEIGHT, MEASURED_CONTENT);
    await settle();

    await harness.render([...base, { id: 'pending-queue' }]);
    await settle();

    const writesBeforePin = harness.scrollWriteCount();
    void harness.handle().scrollToIndex({ animated: true, index: PENDING_INDEX, viewPosition: 1 });
    await settle();
    if (harness.scrollWriteCount() === writesBeforePin) {
        throw new Error('the pin never reached the scroller, so `state.scrollingTo` was never armed');
    }

    // The void frame: `data` reverts to its exact pre-send content (the device measured the tail key
    // byte-identical to pre-send) while index 43 is still the pinned scroll target.
    await harness.render(base);
    return harness.totals();
}

describe('shipped native Legend content total vs a row that no longer exists', () => {
    it('does not publish a one-estimated-row content total when the pinned index falls past the end', async () => {
        const harness = await mountHarness(buildRows(ROW_COUNT));
        const totals = await runSendCrossover(harness);

        // Asserting the model alongside the publish is what makes this a contradiction rather than
        // a coincidence: 240 describes ONE unmeasured row while `positions` still describe 2,322 px
        // of them, and the end padding that grows to replace the missing content is the value the
        // platform actually clamps against.
        expect({
            alignItemsAtEndPadding: totals.alignItemsAtEndPadding,
            lastRowTop: harness.lastRowTop(),
            totalSize: totals.totalSize,
        }).toEqual({
            alignItemsAtEndPadding: 0,
            lastRowTop: LAST_ROW_TOP,
            totalSize: MEASURED_CONTENT,
        });
    });

    it('still writes the content total absolutely on every reconciling pass', async () => {
        const base = buildRows(ROW_COUNT);
        const harness = await mountHarness(base);
        await harness.scroll(MEASURED_CONTENT - VIEWPORT_HEIGHT, MEASURED_CONTENT);
        await settle();

        await harness.render([...base, { id: 'pending-queue' }]);
        const grown = harness.totals().totalSize;

        await harness.render(base);
        const reverted = harness.totals().totalSize;

        await harness.render([]);
        const emptied = harness.totals().totalSize;

        await harness.render(base);
        const repopulated = harness.totals().totalSize;

        // `updateTotalSize`'s ABSOLUTE write is the only producer of these exact numbers: it assigns
        // `positions[last] + size(last)` rather than accumulating. If the disambiguated sentinel
        // stopped reaching that branch the writes would become relative and carry the removed rows
        // forward - 2,376 after the revert instead of 2,322, and 2,322 + 2,322 after the refill -
        // and an emptied list could never reach exactly 0 at all. So this fails loudly if the
        // intentional absolute path was broken by giving it a private sentinel.
        //
        // `emptied` is also a second measurement of the defect itself: on pre-fix bytes it read 240,
        // because the legitimate `0` publish was immediately overwritten by the null-key write that
        // an entirely empty `data` makes reachable at every index.
        expect({ emptied, grown, repopulated, reverted }).toEqual({
            emptied: 0,
            grown: ROW_HEIGHT * (ROW_COUNT + 1),
            repopulated: MEASURED_CONTENT,
            reverted: MEASURED_CONTENT,
        });
    });
});
