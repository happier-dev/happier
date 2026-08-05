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
 * The published content size must never describe FEWER rows than the list's own position model
 * holds.
 *
 * MEASURED DEFECT (`.project/reviews/2026-08-01-send-transition/`, lanes V1/V2, traces W51):
 * during the send crossover the transcript published `totalSize = 240` — its `estimatedItemSize`,
 * i.e. exactly ONE unmeasured row — while `data`, the item keys, `positions`, `indexByKey` and the
 * size cache were all intact. `alignItemsAtEndPadding` then grew to 297 to fill the viewport
 * (12 header + 142 footer + 240 + 297 = 691 exactly), `UIScrollView` adopted that one-viewport
 * content size and clamped `contentOffset` to its bound, and the transcript was thrown to the top.
 * The value was 240 on a 43-row/2,322 px transcript AND on a 419-row/266,020 px one — a constant,
 * not a sum, which is what identifies it as one row rather than lost data.
 *
 * MECHANISM. `state.props` is mutated during Legend's RENDER phase (`react-native.mjs:7437`), so
 * `state.props.data` can be newer than the position model any time an event-driven
 * `calculateItemsInView` pass runs before the list reconciles (`checkResetContainers`, the
 * `dataChanged` pass). When the new `data` is SHORTER, `updateItemPositions`' walk range
 * (`startIndex = minIndexSizeChanged ?? startBuffered`, `:4441`) is already past the new end, so
 * the loop body never runs and `didBreakEarly` stays false — and `updateTotalSize` (`:3468`) then
 * publishes `positions[data.length - 1] + size(data.length - 1)` from positions computed for the
 * LONGER list. With a one-row `data`, `positions[0]` is 0 (the first row is always at the top) and
 * the row's size is unknown, so the absolute total published is `estimatedItemSize`, whatever the
 * real transcript height is.
 *
 * Legend already refuses the mirror-image case: when `data` GREW past the model, `positions[last]`
 * is `undefined` and the `lastPosition !== void 0` guard suppresses the publish. This lane pins the
 * shrink direction to the same rule.
 *
 * The injector below fires the list's own `onScroll` from a layout effect INSIDE the list, which
 * React runs before the list's own layout effects. That is the deterministic expression of the
 * device window: `state.props.data` already advanced, position model not yet reconciled.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 54;
const ROW_COUNT = 43;
const VIEWPORT_HEIGHT = 691;
/** The transcript's own value (`legendListRenderer.tsx`), and the exact collapsed total measured. */
const ESTIMATED_ITEM_SIZE = 240;
const MEASURED_CONTENT = ROW_HEIGHT * ROW_COUNT; // 2322, the measured pre-send total
const LAST_ROW_TOP = MEASURED_CONTENT - ROW_HEIGHT; // 2268

function buildRows(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `msg-${index}` }));
}

type LegendStateHandle = Readonly<{
    getState: () => Readonly<{
        contentLength: number;
        positionAtIndex: (index: number) => number | undefined;
        startBuffered: number;
    }>;
}>;

type Harness = Readonly<{
    /** Reads the model + published size the way a consumer (and `UIScrollView`) sees them. */
    read: () => Readonly<{ contentLength: number; lastRowTop: number | undefined; startBuffered: number }>;
    render: (data: readonly Row[]) => Promise<void>;
    /** Runs `data` through one commit with a scroll event delivered before the list reconciles. */
    renderWithScrollBeforeReconcile: (data: readonly Row[]) => Promise<
        Readonly<{ contentLength: number; lastRowTop: number | undefined }>
    >;
    scroll: (offset: number) => Promise<void>;
}>;

function ScrollInjector(props: Readonly<{ armed: () => boolean; fire: () => void }>): null {
    const { armed, fire } = props;
    React.useLayoutEffect(() => {
        if (armed()) fire();
    });
    return null;
}

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
    if (mounted) {
        const current = mounted;
        act(() => current.unmount());
        mounted = null;
    }
});

async function mountHarness(initial: readonly Row[]): Promise<Harness> {
    const nodes: ShippedNativeNodeMock = createShippedNativeNodeMock({
        rowHeight: ROW_HEIGHT,
        viewportHeight: VIEWPORT_HEIGHT,
    });
    const ref = React.createRef<LegendStateHandle | null>();
    let armed = false;
    let injected: Readonly<{ contentLength: number; lastRowTop: number | undefined }> | null = null;
    let scrollOffset = 0;

    const readState = () => {
        const state = ref.current?.getState();
        return {
            contentLength: state?.contentLength ?? -1,
            lastRowTop: state?.positionAtIndex(ROW_COUNT - 1),
            startBuffered: state?.startBuffered ?? -1,
        };
    };

    let scrollHandler: ((event: unknown) => void) | null = null;
    const dispatchScroll = (offset: number) => {
        scrollHandler?.({
            nativeEvent: {
                contentOffset: { x: 0, y: offset },
                contentSize: { height: MEASURED_CONTENT, width: 800 },
                layoutMeasurement: { height: VIEWPORT_HEIGHT, width: 800 },
            },
        });
    };

    const element = (data: readonly Row[]) => (
        <LegendList
            ref={ref as never}
            data={[...data]}
            estimatedItemSize={ESTIMATED_ITEM_SIZE}
            keyExtractor={(item: Row) => item.id}
            ListHeaderComponent={(
                <ScrollInjector
                    armed={() => armed}
                    fire={() => {
                        armed = false;
                        dispatchScroll(scrollOffset);
                        const observed = readState();
                        injected = { contentLength: observed.contentLength, lastRowTop: observed.lastRowTop };
                    }}
                />
            )}
            maintainVisibleContentPosition={{ data: true, size: true }}
            recycleItems={false}
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
    scrollHandler = created.root.findByType('ScrollView' as never).props.onScroll as never;

    return {
        read: readState,
        render: async (data) => {
            await act(async () => {
                created.update(element(data));
                await Promise.resolve();
            });
        },
        renderWithScrollBeforeReconcile: async (data) => {
            armed = true;
            injected = null;
            await act(async () => {
                created.update(element(data));
                await Promise.resolve();
            });
            if (injected === null) throw new Error('the scroll injector never fired');
            return injected;
        },
        scroll: async (offset) => {
            scrollOffset = offset;
            await act(async () => {
                dispatchScroll(offset);
                await Promise.resolve();
            });
        },
    };
}

const moduleFacts = () => readShippedNativeModuleFacts(LegendNative, Platform);

describe('shipped native Legend published content size vs its own position model', () => {
    it('never publishes a content size shorter than the rows its positions still describe', async () => {
        const base = buildRows(ROW_COUNT);
        const harness = await mountHarness(base);
        await harness.scroll(MEASURED_CONTENT - VIEWPORT_HEIGHT);

        const settled = harness.read();
        // Preconditions, so a green cannot come from a list that never laid out or never left the
        // top: the model holds 43 rows and the viewport is anchored far from index 0.
        expect({ lastRowTop: settled.lastRowTop, startedFarFromZero: settled.startBuffered > 0 })
            .toEqual({ lastRowTop: LAST_ROW_TOP, startedFarFromZero: true });

        // One commit whose `data` is a single row, with a scroll event delivered before the list
        // reconciles - the measured device window.
        const observed = await harness.renderWithScrollBeforeReconcile([{ id: 'pending-queue' }]);

        // The position model is still the 43-row one at that instant; only the published size is in
        // question. Asserting both together is what makes this a contradiction rather than a
        // coincidence: 240 (== ESTIMATED_ITEM_SIZE) describes one unmeasured row while positions
        // describe 2,322 px of them.
        expect({
            describesFewerRowsThanTheModel: observed.contentLength < LAST_ROW_TOP + ROW_HEIGHT,
            lastRowTop: observed.lastRowTop,
        }).toEqual({
            describesFewerRowsThanTheModel: false,
            lastRowTop: LAST_ROW_TOP,
        });
    });

    it('still publishes an exact total on every reconciling pass', async () => {
        const base = buildRows(ROW_COUNT);
        const harness = await mountHarness(base);
        await harness.scroll(MEASURED_CONTENT - VIEWPORT_HEIGHT);
        // Header-agnostic baseline: every assertion below is relative to the settled publish, so
        // the list's own header/footer contribution cannot be mistaken for content.
        const settled = harness.read().contentLength;

        await harness.render([...base, { id: 'pending-queue' }]);
        const grownDelta = harness.read().contentLength - settled;

        await harness.render(base);
        const reverted = harness.read().contentLength;

        await harness.render([]);
        await harness.render(base);
        const repopulated = harness.read().contentLength;

        // The rule must only suppress a publish computed from a STALE model. A reconciling pass
        // walks from index 0 and leaves `positions.length === data.length`, so every ordinary
        // transition - grow, shrink, empty and refill - still publishes its exact measured total.
        // Without this, "never shrink the published size" could be satisfied by never updating it.
        expect({ grownDelta, repopulated, reverted }).toEqual({
            grownDelta: ROW_HEIGHT,
            repopulated: settled,
            reverted: settled,
        });
    });
});
