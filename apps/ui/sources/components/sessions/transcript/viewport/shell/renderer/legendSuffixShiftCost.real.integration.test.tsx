// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as legendReactNative from '@legendapp/list/react-native';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Cost of the position-suffix shift inside `updateItemPositions`.
 *
 * The correctness fix (S-1) replaced an O(1) `break` with a constant-shift walk over
 * `positions[i..last]`, and made `updateTotalSize` run on early-break passes. That walk runs on
 * every measurement-driven pass while the list is moving, so its cost is a product question, not
 * a theoretical one.
 *
 * This file measures it rather than arguing about it:
 *
 *  - it mounts the real installed Legend web build at transcript scale (>= the 104118px of
 *    content measured on the live session that exposed the defect) and captures the real
 *    `positions` array and the real signal context;
 *  - it then times the *shipped source of the shift block itself*, extracted verbatim from
 *    `node_modules/@legendapp/list/react-native.web.mjs` and compiled with `new Function`, so the
 *    benchmark cannot drift away from the code that ships;
 *  - it times the worst case a transcript can produce: a break at index 0, i.e. the whole list
 *    below the break. A real pass sweeps `dataLength - breakAt - 1` rows, which is strictly fewer.
 *
 * The assertions are deliberately loose regression guards (two orders of magnitude of headroom).
 * They exist to catch a *shape* regression - someone reintroducing per-row `getItemSize`,
 * `getId`, or a signal notification into the sweep - not to police machine speed.
 */

type SizedRow = Readonly<{ id: string; height: number }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

/**
 * The shape the shift block touches on the Legend signal context. `internal.useStateContext` is a
 * real runtime export of the installed build but is absent from its `.d.ts`, so this harness
 * declares the narrow slice it reads and casts once, at the boundary, below.
 */
type LegendSignalContext = Readonly<{
    positionListeners: Map<unknown, Set<unknown>>;
    state: Readonly<{
        idCache: unknown[];
        positions: number[];
    }>;
}>;

const HOST_ID = 'legend-suffix-shift-host';
const ROW_TESTID_PREFIX = 'legend-suffix-shift-row-';
const VIEWPORT_HEIGHT = 800;

// A transcript is not uniform: short tool rows, ordinary text rows, and tall code/diff blocks.
// This cycle averages 116.8px, so 900 rows publish 105_120px - just past the 104_118px of content
// the live session carried when the stale-suffix defect was captured.
const ROW_HEIGHT_CYCLE = [44, 72, 120, 260, 88] as const;
const ROW_COUNT = 900;
const LIVE_SESSION_CONTENT_PX = 104_118;

// One "pass" below is one execution of the early-break block. Batching amortises the ~60ns
// `hrtime` call so the O(1) fast path is measurable at all; the median over the samples is
// reported so a GC pause or a scheduler preemption cannot dominate the number.
const WARMUP_BATCHES = 30;
const SAMPLE_BATCHES = 60;
const PASSES_PER_BATCH = 200;

const resizeObservers = new Set<ResizeObserverRecord>();

function rowHeight(index: number): number {
    return ROW_HEIGHT_CYCLE[index % ROW_HEIGHT_CYCLE.length];
}

const DATA: readonly SizedRow[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    id: `row-${index}`,
    height: rowHeight(index),
}));

const CONTENT_HEIGHT_PX = DATA.reduce((total, row) => total + row.height, 0);
const HEIGHT_BY_ID = new Map(DATA.map((row) => [row.id, row.height]));

function rect(width: number, height: number): DOMRectReadOnly {
    return {
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    };
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === HOST_ID) {
        return rect(800, VIEWPORT_HEIGHT);
    }
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const row = htmlElement.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    if (row) {
        return rect(800, HEIGHT_BY_ID.get(row.dataset.rowId ?? '') ?? 0);
    }
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 0);
}

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map((element) => ({
            borderBoxSize: [],
            contentBoxSize: [],
            contentRect: measuredRect(element),
            devicePixelContentBoxSize: [],
            target: element,
        })) as ResizeObserverEntry[];
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

function resolveInstalledWebBuild(): string {
    const require = createRequire(import.meta.url);
    const candidates = [
        (): string => resolvePath(
            dirname(require.resolve('@legendapp/list/react-native')),
            'react-native.web.mjs',
        ),
        (): string => resolvePath(process.cwd(), 'node_modules/@legendapp/list/react-native.web.mjs'),
    ];
    for (const candidate of candidates) {
        try {
            const path = candidate();
            readFileSync(path, 'utf8');
            return path;
        } catch {
            // try the next candidate
        }
    }
    throw new Error('could not locate the installed @legendapp/list web build');
}

/**
 * Lifts the early-break block out of the installed build by brace matching from its `if` header,
 * so what this file times is the shipped bytes and a Legend upgrade that changes the block changes
 * the benchmark with it.
 */
function extractEarlyBreakBlock(source: string): string {
    const header = 'if (shouldOptimize && breakAt !== void 0 && i > breakAt) {';
    const start = source.indexOf(header);
    if (start < 0) {
        throw new Error('early-break guard not found in the installed build');
    }
    let depth = 0;
    for (let index = start + header.length - 1; index < source.length; index += 1) {
        const character = source[index];
        if (character === '{') depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error('early-break guard is unbalanced in the installed build');
}

type EarlyBreakBlock = (
    ctx: unknown,
    state: unknown,
    positions: number[],
    idCache: unknown[],
    dataLength: number,
    hasPositionListeners: boolean,
    getId: (state: unknown, index: number) => unknown,
    notifyPosition$: (ctx: unknown, key: unknown, value: number) => void,
    shouldOptimize: boolean,
    breakAt: number,
    i: number,
    currentRowTop: number,
) => boolean;

const BLOCK_PARAMETERS = [
    'ctx',
    'state',
    'positions',
    'idCache',
    'dataLength',
    'hasPositionListeners',
    'getId',
    'notifyPosition$',
    'shouldOptimize',
    'breakAt',
    'i',
    'currentRowTop',
] as const;

function compileEarlyBreakBlock(blockSource: string): EarlyBreakBlock {
    // `for (;;)` restores the enclosing loop the block's `break` statements belong to; the trailing
    // break makes a false guard terminate instead of spinning.
    const body = `let didBreakEarly = false;
for (;;) {
${blockSource}
didBreakEarly = true;
break;
}
return didBreakEarly;`;
    // Narrow harness boundary: `new Function` is untyped by construction.
    return new Function(...BLOCK_PARAMETERS, body) as EarlyBreakBlock;
}

function nsPerPass(
    block: EarlyBreakBlock,
    positions: number[],
    idCache: unknown[],
    breakAt: number,
    shift: number,
): number {
    const index = breakAt + 1;
    const dataLength = positions.length;
    const noopGetId = (_state: unknown, itemIndex: number): unknown => itemIndex;
    const noopNotify = (): void => {};
    const samples: number[] = [];
    for (let batch = 0; batch < WARMUP_BATCHES + SAMPLE_BATCHES; batch += 1) {
        const started = process.hrtime.bigint();
        for (let pass = 0; pass < PASSES_PER_BATCH; pass += 1) {
            // Alternating the sign keeps the shift non-zero forever without letting the positions
            // drift, so every timed pass takes the same branch on identical data.
            block(
                undefined,
                undefined,
                positions,
                idCache,
                dataLength,
                false,
                noopGetId,
                noopNotify,
                true,
                breakAt,
                index,
                positions[index] + (pass % 2 === 0 ? shift : -shift),
            );
        }
        const elapsed = Number(process.hrtime.bigint() - started);
        if (batch >= WARMUP_BATCHES) {
            samples.push(elapsed / PASSES_PER_BATCH);
        }
        // Keep the array observably alive so the engine cannot elide the sweep.
        if (!Number.isFinite(positions[dataLength - 1])) {
            throw new Error('positions were corrupted by the benchmark');
        }
    }
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length / 2)];
}

function microseconds(nanoseconds: number): string {
    return `${(nanoseconds / 1000).toFixed(3)}us`;
}

/**
 * The fix's second cost: `updateTotalSize` now runs on early-break passes too. Its single-column
 * body is `peek$(numColumns)` + `getId(last)` + `positions[last]` + `getItemSize(last)` +
 * `addTotalSize(ctx, null, total)` (a compare that no-ops when the total is unchanged). This times
 * the dominant, app-reachable part of that through the real build - `getId` + the size lookup -
 * so the reported figure is a lower bound on an O(1) body, not an estimate of an O(n) one.
 */
function nsPerSizeLookup(lookup: () => number | undefined): number {
    const samples: number[] = [];
    for (let batch = 0; batch < WARMUP_BATCHES + SAMPLE_BATCHES; batch += 1) {
        const started = process.hrtime.bigint();
        for (let pass = 0; pass < PASSES_PER_BATCH; pass += 1) {
            if (lookup() === -1) throw new Error('unreachable');
        }
        const elapsed = Number(process.hrtime.bigint() - started);
        if (batch >= WARMUP_BATCHES) {
            samples.push(elapsed / PASSES_PER_BATCH);
        }
    }
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length / 2)];
}

describe('Legend position-suffix shift cost at transcript scale', () => {
    let container: HTMLDivElement;
    let root: Root;
    let listRef: React.RefObject<LegendListRef | null>;
    let capturedContext: LegendSignalContext | undefined;
    let scroller: HTMLElement | undefined;

    function CapturedRow({ item }: Readonly<{ item: SizedRow }>): React.ReactElement {
        // `internal.useStateContext` is a runtime export of the installed build that its bundled
        // `.d.ts` omits; this single cast is the harness boundary that reaches it.
        const legendInternal = (legendReactNative as unknown as {
            internal: { useStateContext: () => LegendSignalContext };
        }).internal;
        capturedContext = legendInternal.useStateContext();
        return (
            <div
                data-row-id={item.id}
                data-testid={`${ROW_TESTID_PREFIX}${item.id}`}
                style={{ height: item.height }}
            >
                {item.id}
            </div>
        );
    }

    function renderList(): React.ReactElement {
        return (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={DATA}
                    estimatedItemSize={240}
                    getEstimatedItemSize={(_item, index) => rowHeight(index)}
                    keyExtractor={(item) => item.id}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }) => <CapturedRow item={item} />}
                />
            </div>
        );
    }

    async function settle(passes = 8): Promise<void> {
        for (let pass = 0; pass < passes; pass += 1) {
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
        }
    }

    async function settleWhileMoving(passes = 6, delta = 8): Promise<void> {
        if (!scroller) return;
        for (let pass = 0; pass < passes; pass += 1) {
            await act(async () => {
                (scroller as HTMLElement & { __scrollTop?: number }).__scrollTop =
                    scroller!.scrollTop + delta;
                scroller!.dispatchEvent(new Event('scroll'));
                flushResizeObservers();
                await vi.advanceTimersByTimeAsync(16);
            });
        }
    }

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        capturedContext = undefined;
        scroller = undefined;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        listRef = React.createRef<LegendListRef>();
        container = document.createElement('div');
        container.style.height = `${VIEWPORT_HEIGHT}px`;
        document.body.appendChild(container);
        root = createRoot(container);

        class TestResizeObserver implements ResizeObserver {
            private readonly record: ResizeObserverRecord;

            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }

            disconnect(): void {
                this.record.elements.clear();
                resizeObservers.delete(this.record);
            }

            observe(target: Element): void {
                resizeObservers.add(this.record);
                this.record.elements.add(target);
            }

            unobserve(target: Element): void {
                this.record.elements.delete(target);
            }
        }

        vi.stubGlobal('ResizeObserver', TestResizeObserver);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
            function getBoundingClientRect(this: HTMLElement) {
                return measuredRect(this);
            },
        );
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get() {
                return measuredRect(this).height;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() {
                return measuredRect(this).width;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() {
                return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0;
            },
            set(value: number) {
                (this as HTMLElement & { __scrollTop?: number }).__scrollTop = Math.max(0, value);
            },
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
            clearTimeout(handle);
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('sweeps the whole position suffix in a small fraction of a frame', async () => {
        await act(async () => {
            root.render(renderList());
        });
        await settle();
        scroller = [...container.querySelectorAll<HTMLElement>('div')].find(
            (element) => element.style.overflowY === 'auto' || element.style.overflow === 'auto',
        );
        await settleWhileMoving();

        // The list really is at (past) the scale of the session that exposed the defect.
        expect(CONTENT_HEIGHT_PX).toBeGreaterThanOrEqual(LIVE_SESSION_CONTENT_PX);
        expect(listRef.current!.getState().contentLength).toBe(CONTENT_HEIGHT_PX);

        const context = capturedContext;
        expect(context).toBeDefined();
        const livePositions = context!.state.positions;
        expect(livePositions.length).toBe(ROW_COUNT);

        // The per-row `notifyPosition$` branch of the sweep is unreachable in this app: the only
        // writer of `positionListeners` is `listenPosition$`, reachable solely through the
        // imperative handle's `listenToPosition`, which no Happier code calls. Pinning it here
        // means a future subscriber that changes the sweep's cost class fails this benchmark
        // instead of silently regressing scroll.
        expect(context!.positionListeners.size).toBe(0);

        const positions = livePositions.slice();
        const definedPositions = positions.filter((value) => value !== undefined).length;
        expect(definedPositions).toBe(ROW_COUNT);
        const idCache = context!.state.idCache.slice();

        const source = readFileSync(resolveInstalledWebBuild(), 'utf8');
        const blockSource = extractEarlyBreakBlock(source);
        // Guard the extraction: these are the load-bearing tokens of the shape being measured.
        expect(blockSource).toContain('positionShift');
        expect(blockSource).toContain('for (let j = i; j < dataLength; j++)');
        expect(blockSource).not.toContain('getItemSize');

        const shiftBlock = compileEarlyBreakBlock(blockSource);
        // The upstream shape the fix replaced: an unconditional O(1) exit.
        const upstreamBlock = compileEarlyBreakBlock(
            'if (shouldOptimize && breakAt !== void 0 && i > breakAt) {\ndidBreakEarly = true;\nbreak;\n}',
        );

        // Real timers only: `hrtime` must not be reachable by the fake clock.
        vi.useRealTimers();

        const sweepLengths = [ROW_COUNT - 1, Math.floor(ROW_COUNT / 2), Math.floor(ROW_COUNT / 4), 100];
        const scaling = sweepLengths.map((rows) => {
            const breakAt = ROW_COUNT - rows - 1;
            return {
                rows,
                sweepNs: nsPerPass(shiftBlock, positions, idCache, breakAt, 1),
                zeroShiftNs: nsPerPass(shiftBlock, positions, idCache, breakAt, 0),
                upstreamNs: nsPerPass(upstreamBlock, positions, idCache, breakAt, 1),
            };
        });

        // Extrapolation check on a same-shaped dense array well past any real transcript.
        const hugeRowCount = 20_000;
        const hugePositions = Array.from({ length: hugeRowCount }, (_value, index) => index * 100);
        const hugeIdCache = Array.from({ length: hugeRowCount }, (_value, index) => `row-${index}`);
        const hugeSweepNs = nsPerPass(shiftBlock, hugePositions, hugeIdCache, 0, 1);

        const listState = listRef.current!.getState();
        const lastIndex = ROW_COUNT - 1;
        const totalSizeProbeNs = nsPerSizeLookup(() => listState.sizeAtIndex(lastIndex));

        const worst = scaling[0];
        const addedNs = worst.sweepNs - worst.upstreamNs;

        const lines = [
            '',
            'F-3 - cost of the position-suffix shift (shipped block, real positions array)',
            `  content ${CONTENT_HEIGHT_PX}px over ${ROW_COUNT} rows (live session: ${LIVE_SESSION_CONTENT_PX}px)`,
            `  positionListeners: ${context!.positionListeners.size} (notify branch dead)`,
            '  rows swept | pre-fix break |  zero-shift |  full sweep | added per pass',
            ...scaling.map((row) => (
                `  ${String(row.rows).padStart(10)} | ${microseconds(row.upstreamNs).padStart(13)}`
                + ` | ${microseconds(row.zeroShiftNs).padStart(11)} | ${microseconds(row.sweepNs).padStart(11)}`
                + ` | ${microseconds(row.sweepNs - row.upstreamNs).padStart(14)}`
            )),
            `  extrapolation ${hugeRowCount} rows: ${microseconds(hugeSweepNs)}`
            + ` (${(hugeSweepNs / hugeRowCount).toFixed(2)}ns/row)`,
            `  updateTotalSize O(1) probe (getId + size lookup, last row): ${microseconds(totalSizeProbeNs)}`,
            `  worst real case: +${microseconds(addedNs)} per pass`
            + ` = ${((addedNs / 16_666_667) * 100).toFixed(4)}% of a 60fps frame`,
            '',
        ];
        console.log(lines.join('\n'));

        // Shape guards, not speed guards: ~100x headroom over the measured cost. They fail if the
        // sweep stops being a bare numeric walk (per-row size lookups, id resolution, or signal
        // notifications), which is the only way this becomes a real regression.
        expect(worst.sweepNs / ROW_COUNT).toBeLessThan(200);
        expect(addedNs).toBeLessThan(1_000_000);
        // The zero-shift fast path must stay O(1): it is the common moving frame.
        expect(scaling[0].zeroShiftNs).toBeLessThan(scaling[0].sweepNs);
        expect(scaling[0].zeroShiftNs).toBeLessThan(5_000);
        // The reconciler the fix un-skipped stays O(1) - it must never grow a per-row term.
        expect(totalSizeProbeNs).toBeLessThan(5_000);
    });
});
