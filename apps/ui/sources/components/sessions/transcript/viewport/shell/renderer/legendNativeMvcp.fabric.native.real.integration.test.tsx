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
    readShippedNativeTreeFacts,
    resolveShippedNativeHarnessPlatform,
    type ShippedNativeNodeMock,
} from '@/dev/testkit/legend/shippedNativeLegendRuntime';

/**
 * The first tests in this repository that execute the code path the user runs: Legend's NATIVE
 * build, `Platform.OS === 'ios'`, New Architecture ON.
 *
 * Every other transcript-renderer test resolves `react-native.web.mjs` (see
 * `vitest.integration.config.ts`), and the one pre-existing native lane runs OLD architecture. The
 * contracts below are native-exclusive by construction - the web build has no scroll-adjust view to
 * read, because it drives `el.scrollTop` directly instead.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 300;

function buildRows(count: number, offset = 0): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `row-${offset + index}` }));
}

const moduleFacts = () => readShippedNativeModuleFacts(LegendNative, Platform);

type MountedList = Readonly<{
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

async function mountList(data: readonly Row[]): Promise<MountedList> {
    const nodes = createShippedNativeNodeMock({ rowHeight: ROW_HEIGHT, viewportHeight: VIEWPORT_HEIGHT });
    let screen: ReactTestRenderer | null = null;
    await act(async () => {
        screen = create(
            <LegendList
                data={[...data]}
                estimatedItemSize={ROW_HEIGHT}
                keyExtractor={(item: Row) => item.id}
                maintainVisibleContentPosition
                recycleItems={false}
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
    mounted = { nodes, screen: created };
    return mounted;
}

async function scrollTo(list: MountedList, offset: number): Promise<void> {
    await act(async () => {
        list.screen.root.findByType('ScrollView' as never).props.onScroll({
            nativeEvent: {
                contentOffset: { x: 0, y: offset },
                contentSize: { height: 1e6, width: 800 },
                layoutMeasurement: { height: VIEWPORT_HEIGHT, width: 800 },
            },
        });
        await Promise.resolve();
    });
}

async function setData(list: MountedList, data: readonly Row[]): Promise<void> {
    await act(async () => {
        list.screen.update(
            <LegendList
                data={[...data]}
                estimatedItemSize={ROW_HEIGHT}
                keyExtractor={(item: Row) => item.id}
                maintainVisibleContentPosition
                recycleItems={false}
                renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
            />,
        );
        await Promise.resolve();
    });
}

describe('shipped native Legend lane', () => {
    it('executes the native build on a mobile OS with New Architecture on', async () => {
        const list = await mountList(buildRows(20));

        // Throws with a per-violation breakdown if the lane degraded to the web build, to
        // `Platform.OS = 'node'`, or to old architecture.
        const facts = assertShippedNativeLegendRuntime(list.screen, moduleFacts());

        expect({
            hasDomHosts: facts.renderedDomHosts,
            hostTypes: facts.hostTypes,
            isNewArchitecture: moduleFacts().isNewArchitecture,
            platformOS: moduleFacts().platformOS,
            rowFlavors: [...new Set(facts.positionViews.map((view) => view.flavor))],
        }).toEqual({
            hasDomHosts: false,
            // `Animated.View` is the content container; `View` covers the scroll-adjust carrier and
            // every row. A `div` here would mean the web artifact resolved.
            hostTypes: ['Animated.View', 'ScrollView', 'View'],
            isNewArchitecture: true,
            // Defaults to iOS; `HAPPIER_LEGEND_NATIVE_OS=android` reruns the whole lane as Android.
            // Not vacuous: the resolver rejects any value other than those two, and the guard above
            // independently fails the run if the library ever sees 'node' or 'web'.
            platformOS: resolveShippedNativeHarnessPlatform(),
            rowFlavors: ['fabric-state'],
        });
    });

    it('measures the scroller in a layout effect, which only New Architecture does', async () => {
        // `useOnLayoutSync` mounts its measuring layout effect inside `if (IsNewArchitecture)`
        // (react-native.mjs:5490) and the scroller call site takes the default
        // `measureInLayoutEffect = true` (react-native.mjs:7572). On old architecture the hook is
        // never installed, so the list only ever learns its viewport from an `onLayout` event.
        const nodes = createShippedNativeNodeMock({ rowHeight: ROW_HEIGHT, viewportHeight: VIEWPORT_HEIGHT });
        let measuredScroller = false;
        const measuringNodes: ShippedNativeNodeMock = {
            createNodeMock: (element) => {
                const node = nodes.createNodeMock(element);
                if (node === nodes.scroller) {
                    return {
                        ...nodes.scroller,
                        measure: (callback: (x: number, y: number, w: number, h: number) => void) => {
                            measuredScroller = true;
                            callback(0, 0, 800, VIEWPORT_HEIGHT);
                        },
                    };
                }
                return node;
            },
            scroller: nodes.scroller,
        };

        let screen: ReactTestRenderer | null = null;
        await act(async () => {
            screen = create(
                <LegendList
                    data={buildRows(20)}
                    estimatedItemSize={ROW_HEIGHT}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                { createNodeMock: measuringNodes.createNodeMock },
            );
        });
        mounted = { nodes: measuringNodes, screen: screen as unknown as ReactTestRenderer };

        expect(measuredScroller).toBe(true);
    });

    it('compensates a data prepend through the open-loop native scroll adjust', async () => {
        const list = await mountList(buildRows(20));
        assertShippedNativeLegendRuntime(list.screen, moduleFacts());
        await scrollTo(list, 500);

        const before = readShippedNativeTreeFacts(list.screen).scrollAdjustPx;

        const PREPENDED_ROWS = 5;
        await setData(list, [...buildRows(PREPENDED_ROWS, -PREPENDED_ROWS), ...buildRows(20)]);

        const after = readShippedNativeTreeFacts(list.screen).scrollAdjustPx;

        // `requestAdjust` (react-native.mjs:1664) is the whole native MVCP mechanism: it moves
        // `scrollAdjust` by the position delta and lets the biased `ScrollAdjust` view carry it.
        // Content inserted ABOVE the anchor pushes it down, so the adjust must grow by exactly the
        // inserted height to hold the anchor still. If maintainVisibleContentPosition regressed to
        // a no-op the adjust stays at 0 and the user's content jumps by that same height - which is
        // the class of defect this lane exists to catch.
        expect({ after, before }).toEqual({
            after: PREPENDED_ROWS * ROW_HEIGHT,
            before: 0,
        });
    });
});
