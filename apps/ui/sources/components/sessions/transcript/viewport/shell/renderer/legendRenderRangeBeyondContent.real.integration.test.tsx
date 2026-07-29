// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LegendList } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Legend's render range is computed against `state.scroll`, which `calculateItemsInView`
 * clamps only against `getContentSize(ctx)` — the CONTENT box, which is
 * `positions[last] + size(last)` PLUS header, footer, style padding, align-at-end padding
 * and the end content inset. Whenever that additive gap exceeds one viewport, the resting
 * bottom offset lands past every laid-out item.
 *
 * At that offset `visibleRange.startNoBuffer` stays null (no item has `top + size > scroll`),
 * and upstream gates `endBuffered` on `startNoBuffer` rather than on the BUFFERED start. Both
 * ends of the buffered range therefore stay null, `calculateItemsInView` writes no containers,
 * and the mounted set freezes wherever it happened to be — with no item mounted, nothing
 * measures, so `positions`/`totalSize` can never grow or correct, and the list cannot recover
 * on its own. Live web capture (session cms3bvdv13hlutm9p19hw1n9s, 2026-07-28) showed exactly
 * this shape: scrollTop 14960 of a 15732 content box with three rows mounted at the very top
 * (tops 0, 0, 3870, last bottom 3896) and an 11836px empty tail, reproduced on four opens.
 *
 * The fix keeps the buffered range TOTAL for a non-empty list — when the probe lands past the
 * last laid-out item the range anchors on that item — so the list keeps a mounted anchor and
 * keeps measuring. It deliberately does NOT touch the scroll extent: shrinking the extent to
 * the mounted rows would only hide the symptom by disabling virtualization.
 */

type Row = Readonly<{ height: number; id: string; index: number }>;

type ResizeObserverRecord = Readonly<{ callback: ResizeObserverCallback; elements: Set<Element> }>;

type LegendHandle = Readonly<{
    getState: () => {
        contentLength: number;
        endBuffered: number | null;
        positionAtIndex: (index: number) => number | undefined;
        scroll: number;
        sizeAtIndex: (index: number) => number | undefined;
        startBuffered: number | null;
    };
}>;

const ROW_COUNT = 52;
const REAL_ROW_HEIGHT = 26;
/** Four times the real row height, matching the live estimate-vs-measured ratio. */
const ESTIMATED_ROW_HEIGHT = 240;
/** A visual-bottom slot taller than the viewport — the reachable source of the extent gap. */
const BOTTOM_SLOT_HEIGHT = 11_800;
const VIEWPORT_HEIGHT = 772;

const resizeObservers = new Set<ResizeObserverRecord>();

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
    if (htmlElement.id === 'range-legend-host') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const measurable = htmlElement.querySelector<HTMLElement>('[data-measured-height]');
    if (measurable) {
        return rect(800, Number(measurable.dataset.measuredHeight ?? REAL_ROW_HEIGHT));
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

async function flushLegendWork(passes = 10): Promise<void> {
    for (let pass = 0; pass < passes; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

function renderRow({ item }: Readonly<{ item: Row }>): React.ReactElement {
    return (
        <div
            data-index={item.index}
            data-measured-height={item.height}
            data-testid={`range-row-${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

function mountedRowIndices(): number[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid^="range-row-"]')]
        .map((element) => Number(element.dataset.index))
        .filter((index) => Number.isFinite(index))
        .sort((a, b) => a - b);
}

function findScrollElement(): HTMLElement {
    const element = document.getElementById('range-legend-host')
        ?.querySelector<HTMLElement>('[style*="overflow"]');
    expect(element).not.toBeNull();
    return element!;
}

function buildRows(): Row[] {
    return Array.from({ length: ROW_COUNT }, (_value, index) => ({
        height: REAL_ROW_HEIGHT,
        id: `range-${index}`,
        index,
    }));
}

describe('Legend keeps a render range when the scroll offset lands past the last laid-out item', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
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
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect(this: HTMLElement) {
            return measuredRect(this);
        });
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
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        Number.parseFloat(descendant.style.height || '0') || 0,
                    );
                }
                return Math.max(element.clientHeight, virtualContentHeight);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() {
                return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0;
            },
            set(value: number) {
                const element = this as HTMLElement & { __scrollTop?: number };
                const max = Math.max(0, element.scrollHeight - element.clientHeight);
                element.__scrollTop = Math.max(0, Math.min(value, max));
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                this.scrollTop = top;
                this.dispatchEvent(new Event('scroll'));
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                this.scrollTo({ top: this.scrollTop + delta });
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
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    async function renderList(listRef: React.RefObject<LegendHandle | null>): Promise<void> {
        await act(async () => {
            root.render(
                <div id="range-legend-host" style={{ height: VIEWPORT_HEIGHT }}>
                    <LegendList
                        alignItemsAtEnd
                        data={buildRows()}
                        estimatedItemSize={ESTIMATED_ROW_HEIGHT}
                        initialScrollAtEnd
                        keyExtractor={(item: Row) => item.id}
                        ListFooterComponent={(
                            <div
                                data-measured-height={BOTTOM_SLOT_HEIGHT}
                                style={{ height: BOTTOM_SLOT_HEIGHT }}
                            />
                        )}
                        maintainVisibleContentPosition={{ data: true, size: true }}
                        recycleItems={false}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        ref={listRef as any}
                        renderItem={renderRow}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await flushLegendWork(12);
    }

    /** Item extent as laid out — the last position plus its seeded-or-measured size. */
    function readItemExtent(state: ReturnType<LegendHandle['getState']>): number {
        return Math.max(
            ...Array.from({ length: ROW_COUNT }, (_value, index) => (
                (state.positionAtIndex(index) ?? 0) + (state.sizeAtIndex(index) ?? ESTIMATED_ROW_HEIGHT)
            )),
        );
    }

    it('keeps a buffered range at the resting bottom offset instead of freezing the mounted set', async () => {
        const listRef = React.createRef<LegendHandle>();
        await renderList(listRef);

        const scroller = findScrollElement();
        const state = listRef.current!.getState();
        const itemExtent = readItemExtent(state);

        // Precondition, true with or without the fix: the content box really is more than a
        // viewport taller than the items, which is what puts the end-anchored probe past them.
        expect(
            state.contentLength - itemExtent,
            `content box must exceed the item extent by more than a viewport (content=${state.contentLength} itemExtent=${itemExtent})`,
        ).toBeGreaterThan(VIEWPORT_HEIGHT);

        expect(
            state.startBuffered,
            `buffered range start must exist for a non-empty list (scroll=${state.scroll} scrollTop=${scroller.scrollTop} itemExtent=${itemExtent})`,
        ).not.toBeNull();
        expect(
            state.endBuffered,
            `buffered range end must exist for a non-empty list (scroll=${state.scroll} scrollTop=${scroller.scrollTop} itemExtent=${itemExtent})`,
        ).not.toBeNull();

        const mounted = mountedRowIndices();
        expect(
            mounted,
            `the item nearest the probe must stay mounted so the list keeps measuring; mounted=[${mounted.join(',')}]`,
        ).toContain(ROW_COUNT - 1);
    });

    it('still converges its own item extent from the estimate seed to the measured truth', async () => {
        const listRef = React.createRef<LegendHandle>();
        await renderList(listRef);

        // Measurement is only possible while containers are being allocated. A frozen range
        // leaves every row on the 240px seed forever, and that seeded extent is precisely the
        // phantom empty tail the live capture showed.
        const tailSize = listRef.current!.getState().sizeAtIndex(ROW_COUNT - 1);
        expect(
            tailSize,
            `the tail row must be measured, not left on the ${ESTIMATED_ROW_HEIGHT}px seed (size=${tailSize})`,
        ).toBe(REAL_ROW_HEIGHT);

        const itemExtent = readItemExtent(listRef.current!.getState());
        const seededExtent = ROW_COUNT * ESTIMATED_ROW_HEIGHT;
        const measuredExtent = ROW_COUNT * REAL_ROW_HEIGHT;
        expect(
            itemExtent,
            `item extent must collapse to the measured rows, not stay near the ${seededExtent}px seed (extent=${itemExtent} measured=${measuredExtent})`,
        ).toBeLessThan(measuredExtent + VIEWPORT_HEIGHT);
    });
});
