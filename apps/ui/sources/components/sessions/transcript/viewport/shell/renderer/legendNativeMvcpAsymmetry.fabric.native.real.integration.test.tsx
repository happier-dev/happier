import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
 * Contracts for the four native-only MVCP gaps in the vendored `@legendapp/list` build.
 *
 * These run in the SHIPPED-native lane (`vitest.legend-fabric.config.ts`): Legend's `react-native`
 * build, `Platform.OS === 'ios'`, New Architecture on. Every one of them is unexpressible on the web
 * build, which has no ignore band (the producer is deleted from that artifact entirely), no pending
 * native adjust machine (`shouldQueueNativeMVCPAdjust` is literally `return false`), and reconciles
 * `state.scroll` against a synchronously readable `element.scrollTop` instead of predicting it.
 *
 * What is asserted here is the ADJUST/OBSERVATION SEQUENCE and the ANCHOR IDENTITY across a data
 * change - not a settled scroll offset. A settled offset is already correct on this build (the
 * rejected crossover observation EQUALS the open-loop prediction), so asserting it would pass both
 * the intended implementation and the defective one.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 300;

type AnchorLock = Readonly<{ id: string; position: number; quietPasses: number; expiresAt: number }>;

type LegendMvcpState = {
    scroll: number;
    idsInView: readonly string[];
    indexByKey: ReadonlyMap<string, number>;
    positions: Readonly<Record<number, number>>;
    mvcpAnchorLock?: AnchorLock;
    ignoreScrollFromMVCP?: { lt?: number; gt?: number };
    pendingNativeMVCPAdjust?: { amount: number; manualApplied: number; startScroll: number };
};

let capturedState: LegendMvcpState | null = null;

/**
 * Reads the list's own internal state through the library's published `internal.useStateContext`.
 *
 * The contracts below are about the list's MVCP bookkeeping, which has no rendered representation
 * beyond a single scroll-adjust offset - an anchor lock and a pending-adjust record are decisions,
 * not pixels. Rendered inside `renderItem` so it sits under the state provider; it renders nothing,
 * so it contributes no size. `ctx.state` is one stable object for the life of the mount, so a single
 * capture stays live even after row 0 scrolls out of the render window.
 */
function StateProbe(): null {
    const ctx = (
        LegendNative as unknown as { internal: { useStateContext: () => { state: LegendMvcpState } } }
    ).internal.useStateContext();
    capturedState = ctx.state;
    return null;
}

function buildRows(count: number, offset = 0): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `row-${offset + index}` }));
}

const moduleFacts = () => readShippedNativeModuleFacts(LegendNative, Platform);

type MountedList = Readonly<{ nodes: ShippedNativeNodeMock; screen: ReactTestRenderer }>;

let mounted: MountedList | null = null;

afterEach(() => {
    if (mounted) {
        const current = mounted;
        act(() => current.screen.unmount());
        mounted = null;
    }
    capturedState = null;
    vi.useRealTimers();
});

function renderRow({ item, index }: { item: Row; index: number }) {
    return index === 0 ? <StateProbe /> : <React.Fragment>{item.id}</React.Fragment>;
}

function listElement(data: readonly Row[]) {
    return (
        <LegendList
            data={[...data]}
            estimatedItemSize={ROW_HEIGHT}
            keyExtractor={(item: Row) => item.id}
            maintainVisibleContentPosition
            recycleItems={false}
            renderItem={renderRow}
        />
    );
}

async function mountList(data: readonly Row[]): Promise<MountedList> {
    const nodes = createShippedNativeNodeMock({ rowHeight: ROW_HEIGHT, viewportHeight: VIEWPORT_HEIGHT });
    let screen: ReactTestRenderer | null = null;
    await act(async () => {
        screen = create(listElement(data), { createNodeMock: nodes.createNodeMock });
    });
    const created = screen as unknown as ReactTestRenderer;
    await act(async () => {
        created.root.findByType('ScrollView' as never).props.onLayout({
            nativeEvent: { layout: { height: VIEWPORT_HEIGHT, width: 800, x: 0, y: 0 } },
        });
        await Promise.resolve();
    });
    mounted = { nodes, screen: created };
    assertShippedNativeLegendRuntime(created, moduleFacts());
    return mounted;
}

/** Delivers one OS scroll observation, exactly as `ScrollView.onScroll` would. */
async function observeScroll(list: MountedList, offset: number): Promise<void> {
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
        list.screen.update(listElement(data));
        await Promise.resolve();
    });
}

function state(): LegendMvcpState {
    if (!capturedState) throw new Error('state probe never rendered');
    return capturedState;
}

function readAnchorLockFacts() {
    const current = state();
    const lock = current.mvcpAnchorLock;
    if (!lock) return { held: false } as const;
    const index = current.indexByKey.get(lock.id);
    return {
        held: true,
        id: lock.id,
        isVisibleRow: current.idsInView.includes(lock.id),
        matchesLaidOutPosition: index !== undefined && current.positions[index] === lock.position,
    } as const;
}

describe('native MVCP contracts across a data change', () => {
    it('holds an anchor lock identity across successive data changes', async () => {
        // The send crossover is a data change at the tail. Web carries the anchor's IDENTITY and
        // POSITION across it in `state.mvcpAnchorLock`; native re-picked an anchor from `idsInView`
        // on every pass because `updateAnchorLock`'s whole body was wrapped in
        // `Platform.OS === "web"`. Nothing in the lock touches the DOM - it reads props and
        // `indexByKey` and writes state - so the platform gate is the defect, not a dependency.
        const list = await mountList(buildRows(40));
        await observeScroll(list, 2000);

        // Freezes `Date.now` ONLY (timers stay real, so the list's own scheduling is untouched) so
        // the lock's 300ms TTL cannot expire between the two data changes on a contended host. The
        // contract under test is identity continuity, not TTL behaviour.
        vi.useFakeTimers({ toFake: ['Date'] });

        await setData(list, [...buildRows(2, -2), ...buildRows(40)]);
        const afterFirstChange = readAnchorLockFacts();

        await setData(list, [...buildRows(2, -2), ...buildRows(40), ...buildRows(1, 40)]);
        const afterSecondChange = readAnchorLockFacts();

        expect({
            firstChange: afterFirstChange,
            sameAnchorAcrossSecondChange:
                afterSecondChange.held && afterFirstChange.held && afterSecondChange.id === afterFirstChange.id,
        }).toEqual({
            firstChange: {
                held: true,
                id: expect.stringMatching(/^row-/) as unknown as string,
                isVisibleRow: true,
                matchesLaidOutPosition: true,
            },
            sameAnchorAcrossSecondChange: true,
        });
    });

    it('retires the pending native adjust on an observation the ignore band rejects', async () => {
        // `shouldQueueNativeMVCPAdjust` arms `pendingNativeMVCPAdjust` when a data change moves
        // content up further than the scroll remaining below the viewport - the send-crossover
        // shape. Arming it calls `requestAdjust`, which arms the ignore band, and the band's early
        // return sat ABOVE `resolvePendingNativeMVCPAdjust`: the adjust blinded the only channel
        // that can retire it. While it survives, native turns off render-range projection,
        // user-scroll detection, the large-jump escape hatch, every subsequent MVCP pass and
        // `doMaintainScrollAtEnd`.
        const list = await mountList(buildRows(20));
        await observeScroll(list, 1600);
        await setData(list, buildRows(20).slice(3));

        expect({
            band: state().ignoreScrollFromMVCP,
            pending: state().pendingNativeMVCPAdjust,
            scroll: state().scroll,
        }).toEqual({
            band: { gt: 1550 },
            pending: { amount: -300, furthestProgressTowardAmount: 0, manualApplied: -100, startScroll: 1600 },
            scroll: 1500,
        });

        // A frame the OS emitted before the adjust landed: 1600 > gt, so the band rejects it.
        await observeScroll(list, 1600);

        expect({ pendingArmed: state().pendingNativeMVCPAdjust !== undefined, scroll: state().scroll }).toEqual({
            pendingArmed: false,
            // The band still SUPPRESSES the offset - retiring the pending adjust must not adopt a
            // rejected observation. If this ever reads 1600 the gate was weakened, not fixed.
            scroll: 1500,
        });
    });

    it('defines the ignore band by the most recent adjust direction alone', async () => {
        // `state.ignoreScrollFromMVCP` is a REUSED object, so two opposite-direction adjusts inside
        // one window leave both bounds set and the accept set collapses to the interval [lt, gt].
        // Measured below: a 40-row list with a two-frame insert+delete produces lt === gt === 2100,
        // so on a 4000px list exactly ONE offset is acceptable - and nothing enforces lt <= gt at
        // all, so the set is empty outright whenever the bounds cross.
        const list = await mountList(buildRows(40));
        await observeScroll(list, 2000);

        // Copied, not aliased: `state.ignoreScrollFromMVCP` is one REUSED object, so holding the
        // reference would silently report the post-delete bounds for both reads - which is the very
        // reuse this contract is about.
        await setData(list, [...buildRows(2, -2), ...buildRows(40)]);
        const afterInsert = { ...state().ignoreScrollFromMVCP };

        await setData(list, buildRows(40));
        const afterDelete = { ...state().ignoreScrollFromMVCP };

        // Real movement inside the window, on the side the LAST adjust cannot explain away: the
        // last adjust was negative, so only offsets ABOVE the threshold look un-caught-up.
        await observeScroll(list, 1950);

        expect({ afterDelete, afterInsert, scroll: state().scroll }).toEqual({
            afterDelete: { gt: 2100 },
            afterInsert: { lt: 2100 },
            scroll: 1950,
        });
    });

    it('reprocesses the rejected observation when the ignore band expires', async () => {
        // The band's expiry timer reprocessed `state.scroll` - the open-loop prediction the native
        // build never verifies against anything - while the offset the band rejected was destroyed
        // on the spot (only a boolean survived). So a suppressed observation was never deferred, it
        // was lost, and the expiry re-decided on the same unchecked number.
        const list = await mountList(buildRows(40));
        await observeScroll(list, 2000);

        await setData(list, [...buildRows(2, -2), ...buildRows(40)]);
        expect({ band: state().ignoreScrollFromMVCP, scroll: state().scroll }).toEqual({
            band: { lt: 2100 },
            scroll: 2200,
        });

        // Below `lt`, so rejected; the prediction stands while the band is armed.
        await observeScroll(list, 2050);
        expect(state().scroll).toBe(2200);

        // Waits out the band's own 100ms window on the real clock. No timer duration is changed by
        // this contract - only WHICH offset the expiry reprocesses.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
        });

        expect({ band: state().ignoreScrollFromMVCP, scroll: state().scroll }).toEqual({
            band: undefined,
            scroll: 2050,
        });
    });
});
