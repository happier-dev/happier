// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Characterizes the external contract the transcript first-paint policy rests on:
 * on web, `@legendapp/list` 3.3.3 renders its row container at `opacity: 0` until the
 * SAME readiness flag that emits `onLoad` flips
 * (`react-native.web.mjs`: `setInitialRenderState` sets `readyToRender` and calls `onLoad`
 * in the same block; `ContainersInner` styles the row container `opacity: readyToRender ? 1 : 0`).
 *
 * So on this renderer, rows being present in the DOM is NOT evidence that the reader can
 * see anything: `onLoad` is the paint signal, and `firstListPaintObserved` is consuming
 * the right fact. Revealing the placeholder on row presence instead would uncover an
 * invisible list - the blank-screen class, not a faster paint.
 *
 * `firstListPaintObserved` is produced in `ChatListInternal` from the renderer's `onLoad` and
 * consumed by the first-paint policy in
 * `@/components/sessions/transcript/items/useTranscriptItemsPipeline#useTranscriptFirstPaintState`,
 * which decides when `TranscriptFirstPaintPlaceholder` stops covering the list.
 *
 * This is also the premise the sibling `legendReadyToRenderLiveness.real.integration.test.tsx`
 * argues from: that a stalled `readyToRender` is a blank transcript rather than a slow one, and
 * therefore that its liveness repair is load-bearing rather than cosmetic. That test asserts the
 * repair; this one pins the premise, so the premise cannot silently stop being true.
 *
 * The test pins the coupling in both directions across the whole mount, so it fails if a
 * future Legend version paints rows before `onLoad` (which would make row presence a valid
 * reveal signal) or emits `onLoad` while the rows are still transparent (which would make
 * `onLoad` unsafe as one).
 */

type Row = Readonly<{ id: string }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const HOST_ID = 'legend-visibility-host';
const ROW_TESTID_PREFIX = 'legend-visibility-row-';
const ROW_HEIGHT = 100;
const ROW_COUNT = 30;
const VIEWPORT_HEIGHT = 500;

const resizeObservers = new Set<ResizeObserverRecord>();

const DATA: readonly Row[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    id: `row-${index}`,
}));

function keyExtractor(item: Row): string {
    return item.id;
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
    if (htmlElement.id === HOST_ID) return rect(800, VIEWPORT_HEIGHT);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    if (htmlElement.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`)) {
        return rect(800, ROW_HEIGHT);
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

function renderRow({ item }: Readonly<{ item: Row }>): React.ReactElement {
    return (
        <div data-testid={`${ROW_TESTID_PREFIX}${item.id}`} style={{ height: ROW_HEIGHT }}>
            {item.id}
        </div>
    );
}

/**
 * The row container is the nearest ancestor of a mounted row that carries an explicit
 * opacity - the element `ContainersInner` styles from `readyToRender`.
 */
function readRowContainerOpacity(): number | null {
    const row = document.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    let element: HTMLElement | null = row?.parentElement ?? null;
    while (element) {
        const declared = element.style.opacity;
        if (declared !== '') return Number.parseFloat(declared);
        element = element.parentElement;
    }
    return null;
}

function countMountedRows(): number {
    return document.querySelectorAll(`[data-testid^="${ROW_TESTID_PREFIX}"]`).length;
}

describe('Legend web row visibility contract', () => {
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
                (this as HTMLElement & { __scrollTop?: number }).__scrollTop = Math.max(0, value);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
                this.scrollTop = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
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

    it('keeps mounted rows transparent until onLoad, and paints them with it', async () => {
        const loadCalls: number[] = [];
        let sampleIndex = 0;
        const samples: { index: number; rows: number; opacity: number | null; loaded: boolean }[] = [];

        const tree = (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={DATA}
                    drawDistance={0}
                    estimatedItemSize={ROW_HEIGHT}
                    initialScrollAtEnd
                    keyExtractor={keyExtractor}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    onLoad={() => {
                        loadCalls.push(sampleIndex);
                    }}
                    recycleItems={false}
                    renderItem={renderRow}
                />
            </div>
        );

        const sample = (): void => {
            samples.push({
                index: sampleIndex,
                rows: countMountedRows(),
                opacity: readRowContainerOpacity(),
                loaded: loadCalls.length > 0,
            });
            sampleIndex += 1;
        };

        await act(async () => {
            root.render(tree);
        });
        sample();
        for (let pass = 0; pass < 12; pass += 1) {
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
            sample();
        }

        // The scenario really happened: rows were mounted while the list had not loaded.
        const preLoadWithRows = samples.filter((entry) => !entry.loaded && entry.rows > 0);
        expect(preLoadWithRows.length).toBeGreaterThan(0);

        // Direction 1: mounted-but-unloaded rows are transparent. Row presence alone is not
        // a paint, so it must not be used to reveal a first-paint placeholder.
        for (const entry of preLoadWithRows) {
            expect(entry.opacity).toBe(0);
        }

        // Direction 2: the list does load, and once it has, the rows are opaque - so `onLoad`
        // is a sufficient paint signal and never leaves the placeholder waiting on nothing.
        expect(loadCalls).toHaveLength(1);
        const settled = samples[samples.length - 1];
        expect(settled.loaded).toBe(true);
        expect(settled.rows).toBeGreaterThan(0);
        expect(settled.opacity).toBe(1);
    });

    it('never re-covers an already painted dataset when a transient empty snapshot refills', async () => {
        let loadCount = 0;
        const render = (data: readonly Row[]) => (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={data}
                    dataKey="stable-transcript"
                    drawDistance={0}
                    estimatedItemSize={ROW_HEIGHT}
                    initialScrollAtEnd
                    keyExtractor={keyExtractor}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    onLoad={() => {
                        loadCount += 1;
                    }}
                    recycleItems={false}
                    renderItem={renderRow}
                />
            </div>
        );

        await act(async () => {
            root.render(render(DATA));
        });
        for (let pass = 0; pass < 12; pass += 1) {
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
        }
        expect(loadCount).toBe(1);
        expect(readRowContainerOpacity()).toBe(1);

        await act(async () => {
            root.render(render([]));
            await vi.runOnlyPendingTimersAsync();
        });
        expect(countMountedRows()).toBe(0);
        await act(async () => {
            root.render(render(DATA));
        });

        const refilledSamples: Array<Readonly<{ opacity: number | null; rows: number }>> = [];
        for (let pass = 0; pass < 12; pass += 1) {
            refilledSamples.push({ opacity: readRowContainerOpacity(), rows: countMountedRows() });
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
        }

        expect(refilledSamples.some((sample) => sample.rows > 0)).toBe(true);
        expect(
            refilledSamples.filter((sample) => sample.rows > 0).map((sample) => sample.opacity),
        ).toEqual(refilledSamples.filter((sample) => sample.rows > 0).map(() => 1));
        expect(loadCount).toBe(1);
    });
});
