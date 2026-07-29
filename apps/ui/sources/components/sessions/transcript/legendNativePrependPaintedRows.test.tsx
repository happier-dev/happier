import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub');
    return {
        ...actual,
        Animated: { ...actual.Animated, ScrollView: 'ScrollView' },
        I18nManager: { isRTL: false },
        Platform: { ...actual.Platform, OS: 'ios' },
        unstable_batchedUpdates: (callback: () => void) => callback(),
    };
});

/**
 * Load the REAL native Legend dist (`react-native.mjs`).
 *
 * `@legendapp/list/react-native` cannot be imported by specifier here: the package `exports` map
 * has no `react-native` condition under Vitest's node environment, so it resolves to the WEB dist,
 * where every native branch is constant-folded away by the bundler (`shouldQueueNativeMVCPAdjust`
 * is literally `{ return false; }` in `react-native.web.mjs`). A prepend test written against that
 * entry point exercises the web scroll-restoration path, not the native one.
 *
 * Importing the native dist by file path externalizes it (it lives in `node_modules`), so Node
 * loads it directly and chokes on React Native's Flow entry point. Copying the untouched bytes
 * outside `node_modules` makes Vitest process the module, which applies the repo's `react-native`
 * alias and the `vi.mock` above. Only the two bare specifiers Vite cannot resolve from a temp
 * directory (`react`, `use-sync-external-store/shim`) are rewritten to their resolved paths; the
 * `react-native` specifier is deliberately left intact so `Platform.OS` is the mocked `'ios'`.
 */
function loadNativeLegendDist(): Promise<Record<string, unknown>> {
    const distPath = resolve(process.cwd(), 'node_modules/@legendapp/list/react-native.mjs');
    const reactPath = resolve(process.cwd(), 'node_modules/react/index.js');
    const shimPath = resolve(process.cwd(), 'node_modules/use-sync-external-store/shim/index.js');
    const source = readFileSync(distPath, 'utf8')
        .replaceAll(" from 'react';", ` from '${reactPath}';`)
        .replaceAll(" from 'use-sync-external-store/shim';", ` from '${shimPath}';`);
    const directory = join(tmpdir(), 'happier-legend-native-dist');
    mkdirSync(directory, { recursive: true });
    const digest = createHash('sha1').update(source).digest('hex').slice(0, 16);
    const modulePath = join(directory, `legend-native-${digest}.mjs`);
    writeFileSync(modulePath, source);
    return import(/* @vite-ignore */ modulePath);
}

type Row = Readonly<{ id: string }>;
type LegendState = Readonly<Record<string, unknown>>;

const ROW_TEST_ID_PREFIX = 'probe-row:';
const VIEWPORT_HEIGHT_PX = 600;
const ROW_HEIGHT_PX = 120;
const TAIL_ROW_COUNT = 30;
const OLDER_PAGE_ROW_COUNT = 30;

let LegendList: React.ComponentType<Record<string, unknown>>;

function makeRows(prefix: string, count: number): Row[] {
    return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));
}

function createNativeScroller() {
    const nativeScrollHost = {};
    const nativeScroller = {
        flashScrollIndicators: vi.fn(),
        getNativeScrollRef: vi.fn(() => nativeScrollHost),
        getInnerViewRef: vi.fn(() => nativeScrollHost),
        getScrollableNode: vi.fn(() => 41),
        getScrollResponder: vi.fn(),
        scrollTo: vi.fn(),
        scrollToEnd: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
    nativeScroller.getScrollResponder.mockReturnValue(nativeScroller);
    return nativeScroller;
}

function ProbeRow(props: Readonly<{ id: string }>): React.ReactElement {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { View } = require('react-native') as typeof import('react-native');
    return <View testID={`${ROW_TEST_ID_PREFIX}${props.id}`} />;
}

function readRenderedRowIds(screen: ReactTestRenderer): string[] {
    return screen.root
        .findAll(
            (node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith(ROW_TEST_ID_PREFIX),
            { deep: true },
        )
        .map((node) => String(node.props.testID).slice(ROW_TEST_ID_PREFIX.length));
}

type Harness = Readonly<{
    screen: ReactTestRenderer;
    setRows(rows: readonly Row[]): Promise<void>;
    flushLayouts(): Promise<void>;
    readState(): LegendState;
    readRows(): string[];
}>;

async function mountTailHarness(initialRows: readonly Row[]): Promise<Harness> {
    const nativeScroller = createNativeScroller();
    const listRef = React.createRef<unknown>();
    let setRowsState: ((rows: readonly Row[]) => void) | null = null;

    function Host() {
        const [rows, setRows] = React.useState<readonly Row[]>(() => initialRows);
        setRowsState = setRows;
        // The transcript's native positioning contract: chronological data, entry pinned to the
        // newest row, Legend-owned visible-content-position restoration, no row recycling.
        return (
            <LegendList
                ref={listRef}
                alignItemsAtEnd={true}
                data={rows}
                dataKey="probe-session"
                estimatedItemSize={ROW_HEIGHT_PX}
                initialScrollAtEnd={true}
                keyExtractor={(item: Row) => item.id}
                maintainVisibleContentPosition={{ data: true, size: true }}
                recycleItems={false}
                renderItem={({ item }: { item: Row }) => <ProbeRow id={item.id} />}
                style={{ flex: 1 }}
            />
        );
    }

    let screen: ReactTestRenderer | null = null;
    await act(async () => {
        screen = create(<Host />, {
            createNodeMock: (element: React.ReactElement) => {
                if (String(element.type) === 'ScrollView') return nativeScroller;
                return {
                    measure: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 0, 800, ROW_HEIGHT_PX),
                    measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 0, 800, ROW_HEIGHT_PX),
                    measureLayout: (
                        _relative: unknown,
                        cb: (x: number, y: number, w: number, h: number) => void,
                    ) => cb(0, 0, 800, ROW_HEIGHT_PX),
                    addEventListener: () => {},
                    removeEventListener: () => {},
                };
            },
        });
        await Promise.resolve();
    });
    const mounted = screen as unknown as ReactTestRenderer;

    // Legend attaches `onLayout` to its own per-item containers as well as to enclosing views, so
    // a node wrapping exactly one probe row is measured with the row height and every other layout
    // host keeps the viewport height.
    async function flushLayouts(): Promise<void> {
        await act(async () => {
            const layoutNodes = mounted.root.findAll((node) => typeof node.props.onLayout === 'function');
            for (const node of layoutNodes) {
                const wrappedRowCount = node.findAll(
                    (candidate) => typeof candidate.props?.testID === 'string'
                        && candidate.props.testID.startsWith(ROW_TEST_ID_PREFIX),
                    { deep: true },
                ).length;
                const height = wrappedRowCount === 1 ? ROW_HEIGHT_PX : VIEWPORT_HEIGHT_PX;
                node.props.onLayout({ nativeEvent: { layout: { height, width: 800, x: 0, y: 0 } } });
            }
            await vi.advanceTimersByTimeAsync(50);
        });
    }

    for (let pass = 0; pass < 4; pass += 1) {
        await flushLayouts();
    }

    return {
        screen: mounted,
        async setRows(rows) {
            await act(async () => {
                setRowsState?.(rows);
                await Promise.resolve();
            });
        },
        flushLayouts,
        readState: () => (listRef.current as { getState?: () => LegendState }).getState?.() ?? {},
        readRows: () => readRenderedRowIds(mounted),
    };
}

describe('native Legend prepend', () => {
    let harness: Harness | null = null;

    beforeAll(async () => {
        const module = await loadNativeLegendDist();
        LegendList = module.LegendList as React.ComponentType<Record<string, unknown>>;
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 16) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    });

    afterEach(() => {
        if (harness) {
            act(() => harness?.screen.unmount());
            harness = null;
        }
        vi.clearAllTimers();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('does not hide already-painted rows on the commit that lands an older page', async () => {
        harness = await mountTailHarness(makeRows('tail', TAIL_ROW_COUNT));

        const paintedRowIds = harness.readRows();
        const settledState = harness.readState();
        expect(paintedRowIds).toContain(`tail-${TAIL_ROW_COUNT - 1}`);
        expect(settledState.endBuffered).toBe(TAIL_ROW_COUNT - 1);

        await harness.setRows([
            ...makeRows('older', OLDER_PAGE_ROW_COUNT),
            ...makeRows('tail', TAIL_ROW_COUNT),
        ]);

        // The commit that lands the older page must keep the reading position mounted. Legend
        // recycles containers from the freshly computed window, so a window built from a stale
        // viewport offset evicts the painted rows and leaves the physically visible band empty
        // for at least one frame — the reported native "transcript disappears and reappears".
        const stateOnPrependCommit = harness.readState();
        expect({
            mountedRowIds: harness.readRows(),
            windowEnd: stateOnPrependCommit.endBuffered,
        }).toEqual({
            mountedRowIds: expect.arrayContaining(paintedRowIds),
            windowEnd: OLDER_PAGE_ROW_COUNT + TAIL_ROW_COUNT - 1,
        });

        // ...and the position preservation that the prepend already had must survive the fix.
        await harness.flushLayouts();
        const stateAfterSettle = harness.readState();
        expect({
            mountedRowIds: harness.readRows(),
            windowEnd: stateAfterSettle.endBuffered,
        }).toEqual({
            mountedRowIds: expect.arrayContaining([`tail-${TAIL_ROW_COUNT - 1}`]),
            windowEnd: OLDER_PAGE_ROW_COUNT + TAIL_ROW_COUNT - 1,
        });
    });
});
