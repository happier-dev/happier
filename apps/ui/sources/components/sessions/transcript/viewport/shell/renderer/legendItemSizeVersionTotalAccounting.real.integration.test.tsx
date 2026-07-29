// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Legend maintains its published content height (`totalSize`) as a running ledger: every
 * `setSize` posts the DIFFERENCE against the size the row last contributed, which the
 * renderer remembers in `state.sizes`. `state.sizes` is therefore not a cache - it is the
 * per-key record of what each row already put into the total.
 *
 * The repo-vendored `getItemSizeVersion` support drops a row's remembered size whenever its
 * version moves, so a stale measurement cannot outlive the content that produced it. Dropping
 * the record without withdrawing what it contributed leaves the total holding a size no row
 * claims any more, and the next `setSize` for that key posts its FULL size (there is nothing
 * left to difference against) on top of it.
 *
 * These tests pin the ledger invariant at that seam: what the list publishes as its content
 * height stays equal to the heights the rows actually measured, across a version change.
 *
 * The transcript arms exactly this path in production - `ChatListInternal` wires
 * `getItemSizeVersion` to the row-shell signature and `getEstimatedItemSize` to the
 * signature-keyed measured-height cache - so a row returning to a shape the cache already
 * knows measures to precisely its estimate. That is the case the second test covers: the
 * measurement reports no change, nothing schedules a position walk, and the absolute
 * `updateTotalSize` writer that would otherwise paper over the leak never runs.
 */

type SizedRow = Readonly<{ id: string }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const HOST_ID = 'legend-size-version-host';
const ROW_TESTID_PREFIX = 'legend-size-version-row-';
const ROW_HEIGHT = 100;
const ROW_COUNT = 40;
const VIEWPORT_HEIGHT = 500;
const VERSIONED_INDEX = 1;
const RESHAPED_HEIGHT = 400;

const resizeObservers = new Set<ResizeObserverRecord>();
const measuredHeights = new Map<string, number>();
const rowVersions = new Map<string, string>();
/** Mirrors the transcript's signature-keyed measured-height cache. */
const estimateBySignature = new Map<string, number>();

const DATA: readonly SizedRow[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    id: `row-${index}`,
}));

function versionOf(item: SizedRow): string {
    return rowVersions.get(item.id) ?? 'v0';
}

function signatureOf(item: SizedRow): string {
    return `${item.id}@${versionOf(item)}`;
}

function heightOf(item: SizedRow): number {
    return measuredHeights.get(item.id) ?? ROW_HEIGHT;
}

/** The sum of what every row actually measures - the only true content height. */
function measuredContentHeight(): number {
    return DATA.reduce((total, item) => total + heightOf(item), 0);
}

// Stable identities: `useWrapIfItem` memoizes on the function reference, and both read live
// module state, so a re-render is not needed to publish a new version or estimate.
function getItemSizeVersion(item: SizedRow): React.Key {
    return signatureOf(item);
}

function getEstimatedItemSize(item: SizedRow): number | undefined {
    return estimateBySignature.get(signatureOf(item));
}

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
        const id = row.dataset.rowId ?? '';
        return rect(800, measuredHeights.get(id) ?? ROW_HEIGHT);
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

function keyExtractor(item: SizedRow): string {
    return item.id;
}

function renderSizedRow({ item }: Readonly<{ item: SizedRow }>): React.ReactElement {
    return (
        <div
            data-row-id={item.id}
            data-testid={`${ROW_TESTID_PREFIX}${item.id}`}
            style={{ height: heightOf(item) }}
        >
            {signatureOf(item)}
        </div>
    );
}

describe('Legend item-size-version accounting', () => {
    let container: HTMLDivElement;
    let root: Root;
    let listRef: React.RefObject<LegendListRef | null>;

    function renderList(): React.ReactElement {
        return (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={DATA}
                    drawDistance={0}
                    estimatedItemSize={ROW_HEIGHT}
                    getEstimatedItemSize={getEstimatedItemSize}
                    getItemSizeVersion={getItemSizeVersion}
                    keyExtractor={keyExtractor}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderSizedRow}
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

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        measuredHeights.clear();
        rowVersions.clear();
        estimateBySignature.clear();
        for (const item of DATA) {
            estimateBySignature.set(signatureOf(item), ROW_HEIGHT);
        }
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
                element.__scrollTop = Math.max(0, value);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                (this as HTMLElement).scrollTop += delta;
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

    /**
     * Reshapes one mounted row: its version moves and its measured height moves with it.
     * `estimatedHeightForNewShape` is what the app's cache reports for the NEW signature -
     * the whole point of the version mechanism is that the two are allowed to agree.
     *
     * The re-render is load-bearing, not decoration. Legend memoizes ONE module-level
     * `ResizeObserver` for the whole module (`createResizeObserver.ts`'s
     * `globalResizeObserver`), and this config runs integration files in a single
     * non-isolating thread, so whichever sibling renders a list first owns that observer
     * for the rest of the run and a later file's `flushResizeObservers` reaches nothing.
     * Re-rendering drives the measurement through Legend's layout-effect path
     * (`getBoundingClientRect`, which every file spies per-test), which is also how a real
     * content change reaches the renderer.
     */
    async function reshapeVersionedRow(estimatedHeightForNewShape: number): Promise<void> {
        const item = DATA[VERSIONED_INDEX];
        rowVersions.set(item.id, 'v1');
        measuredHeights.set(item.id, RESHAPED_HEIGHT);
        estimateBySignature.set(signatureOf(item), estimatedHeightForNewShape);
        await act(async () => {
            root.render(renderList());
        });
    }

    it('publishes the measured content height after a version change that also changes the measurement', async () => {
        await act(async () => {
            root.render(renderList());
        });
        await settle();

        expect(listRef.current!.getState().contentLength).toBe(measuredContentHeight());

        // The cache has no exact entry for the new shape yet, so the estimate is wrong and
        // the remeasure reports a real change.
        await reshapeVersionedRow(ROW_HEIGHT);
        await settle();

        const state = listRef.current!.getState();
        // The scenario really happened: the row remeasured at its new height under its new
        // version. Without this a collapsed run would report the invariant instead.
        expect(state.sizes.get(DATA[VERSIONED_INDEX].id)).toBe(RESHAPED_HEIGHT);
        expect(state.contentLength).toBe(measuredContentHeight());
    });

    it('publishes the measured content height when a version change lands on its cached estimate', async () => {
        await act(async () => {
            root.render(renderList());
        });
        await settle();

        expect(listRef.current!.getState().contentLength).toBe(measuredContentHeight());

        // The transcript's cache already knows this shape, so the row measures to exactly
        // its estimate: the renderer sees no size change, schedules no position walk, and
        // the absolute total writer never runs to hide a ledger error.
        await reshapeVersionedRow(RESHAPED_HEIGHT);
        await settle();

        const state = listRef.current!.getState();
        expect(state.sizes.get(DATA[VERSIONED_INDEX].id)).toBe(RESHAPED_HEIGHT);
        expect(state.contentLength).toBe(measuredContentHeight());
    });
});
