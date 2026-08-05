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
 * Characterizes the SHIPPED NATIVE tail command - the external contract the transcript's
 * bottom-pin owner (`createTranscriptViewportController`) depends on when it resolves a bottom
 * intent as a settled write instead of an animation.
 *
 * Native-exclusive by construction: the web build assigns its own scroll position FROM the DOM's
 * `scrollTop` inside the same statement it writes, so it has no equivalent open transaction. This
 * lane executes `react-native.mjs` with `Platform.OS === 'ios'` and New Architecture on; the web
 * build cannot express the contract at all.
 *
 * Contract basis: `@legendapp/list@3.3.3`, `react-native.mjs#doScrollTo` (the unanimated branch
 * assigns `state.scroll = offset` and runs the completion fallback inline; the animated branch does
 * neither and leaves the target armed for a native scroll event to retire).
 *
 * What this lane does NOT cover: there is no real `UIScrollView` here, so the platform's own
 * behaviour during an animated `setContentOffset` - clamping against a content size that changes
 * mid-flight - is NOT simulated. That is the measured field defect; this test covers only the
 * JS-side window the animated form opens for it.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 300;
const ROW_COUNT = 20;

type LegendTailHandle = Readonly<{
    getState: () => Readonly<{ scroll: number }>;
    scrollToEnd: (options?: Readonly<{ animated?: boolean }>) => Promise<unknown>;
}>;

type MountedList = Readonly<{
    handle: LegendTailHandle;
    nodes: ShippedNativeNodeMock;
    screen: ReactTestRenderer;
}>;

let mounted: MountedList | null = null;

afterEach(() => {
    if (mounted) {
        const current = mounted;
        act(() => current.screen.unmount());
        mounted = null;
    }
});

function buildRows(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `row-${index}` }));
}

async function mountList(): Promise<MountedList> {
    const nodes = createShippedNativeNodeMock({ rowHeight: ROW_HEIGHT, viewportHeight: VIEWPORT_HEIGHT });
    const ref = React.createRef<LegendTailHandle>();
    let screen: ReactTestRenderer | null = null;
    await act(async () => {
        screen = create(
            <LegendList
                data={buildRows(ROW_COUNT)}
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
    await act(async () => {
        created.root.findByType('ScrollView' as never).props.onLayout({
            nativeEvent: { layout: { height: VIEWPORT_HEIGHT, width: 800, x: 0, y: 0 } },
        });
        await Promise.resolve();
    });
    const handle = ref.current;
    if (!handle) throw new Error('The shipped native LegendList did not expose its imperative handle.');
    mounted = { handle, nodes, screen: created };
    return mounted;
}

async function flushFrames(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

async function commandTail(list: MountedList, animated: boolean): Promise<void> {
    await act(async () => {
        void list.handle.scrollToEnd({ animated });
        await Promise.resolve();
    });
    await flushFrames(4);
}

describe('shipped native Legend tail command', () => {
    it('settles its own scroll position when the tail command is unanimated', async () => {
        const list = await mountList();
        assertShippedNativeLegendRuntime(list.screen, readShippedNativeModuleFacts(LegendNative, Platform));

        await commandTail(list, false);

        const write = list.nodes.scroller.scrollWrites.at(-1);
        // A real end target, not 0 - otherwise "settled" and "unreconciled" would be the same
        // number and neither test below would discriminate anything.
        expect(write).toMatchObject({ animated: false, y: ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT });
        // The whole point of the unanimated form: the list's own position is already the commanded
        // offset when the call returns, so no later scroll event has to arrive for it to be right.
        expect(list.handle.getState().scroll).toBe(write?.y);
    });

    it('leaves its scroll position unreconciled while an animated tail command is in flight', async () => {
        const list = await mountList();
        assertShippedNativeLegendRuntime(list.screen, readShippedNativeModuleFacts(LegendNative, Platform));

        await commandTail(list, true);

        const write = list.nodes.scroller.scrollWrites.at(-1);
        expect(write).toMatchObject({ animated: true, y: ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT });
        // Same command, same target, no native scroll event delivered in either case - yet here the
        // list still believes it is where it started. That gap is the window an animated pin holds
        // open while content keeps hydrating underneath it, and it is why the transcript's bottom
        // intent resolves unanimated.
        expect(list.handle.getState().scroll).not.toBe(write?.y);
        expect(list.handle.getState().scroll).toBe(0);
    });
});
