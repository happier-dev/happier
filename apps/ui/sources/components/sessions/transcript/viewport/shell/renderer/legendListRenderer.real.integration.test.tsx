// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LegendList,
    type LegendListRef,
} from '@legendapp/list/react-native';

import { resolveRendererAtEndViewportChange } from '@/components/sessions/transcript/scroll/rendererAtEndViewportChange';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    readTranscriptPhysicalWriteCensus,
    resetTranscriptViewportDiagnosticsForTests,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';
import type {
    TranscriptListRendererProps,
    TranscriptListShellRef,
    TranscriptRendererEntryAnchorHold,
    TranscriptRendererEntryPlacementEvent,
} from './types';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

type Row = Readonly<{
    height: number;
    id: string;
}>;

type SizeVersionRow = Row & Readonly<{
    estimatedHeight: number;
    sizeVersion: string;
}>;

type WebEntryPlacementAnchor = TranscriptRendererEntryAnchorHold & Readonly<{
    reason: 'entry-restore';
}>;

type WebEntryPlacementEvent = TranscriptRendererEntryPlacementEvent;

type WebEntryPlacementRendererProps<TItem> = TranscriptListRendererProps<TItem> & Readonly<{
    onEntryPlacementEvent?: (event: WebEntryPlacementEvent) => void;
}> & React.RefAttributes<WebEntryPlacementShellRef<TItem>>;

type WebEntryPlacementShellRef<TItem> = Omit<TranscriptListShellRef<TItem>, 'scrollToIndex'> & Readonly<{
    scrollToIndex: (
        params: Readonly<{
            animated?: boolean;
            context?: Readonly<{
                anchor: WebEntryPlacementAnchor;
                kind: 'entry-placement';
            }>;
            index: number;
            viewOffset?: number;
            viewPosition?: number;
        }>,
    ) => void | Promise<void>;
}>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const resizeObservers = new Set<ResizeObserverRecord>();
type PhysicalScrollWrite = Readonly<{
    stack: string;
    top: number;
}>;

const physicalScrollWrites: PhysicalScrollWrite[] = [];
const directScrollTopWrites: PhysicalScrollWrite[] = [];
let scrollMethodActive = false;
let viewportHeight = 600;

function writePhysicalScroll(element: HTMLElement, top: number): void {
    const previousTop = element.scrollTop;
    physicalScrollWrites.push({
        stack: new Error('real Legend physical scroll write').stack ?? '',
        top,
    });
    scrollMethodActive = true;
    try {
        element.scrollTop = top;
    } finally {
        scrollMethodActive = false;
    }
    if (element.scrollTop !== previousTop) element.dispatchEvent(new Event('scroll'));
}

function deliverBrowserScrollEventsAsynchronously(): void {
    const dispatchEvent = HTMLElement.prototype.dispatchEvent;
    vi.spyOn(HTMLElement.prototype, 'dispatchEvent').mockImplementation(function (this: HTMLElement, event: Event) {
        if (event.type !== 'scroll') return dispatchEvent.call(this, event);
        // Browser scroll events follow the physical write; they are not dispatched
        // synchronously from scrollTo/scrollBy as in the default geometry harness.
        setTimeout(() => dispatchEvent.call(this, event), 0);
        return true;
    });
}

function rows(count: number, prefix: string): Row[] {
    return Array.from({ length: count }, (_value, index) => ({
        height: index % 7 === 0 ? 420 : index % 3 === 0 ? 180 : 72,
        id: `${prefix}-${index}`,
    }));
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
    if (htmlElement.id === 'real-legend-host') {
        return rect(800, viewportHeight);
    }
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, viewportHeight);
    }
    const row = htmlElement.querySelector<HTMLElement>('[data-testid^="real-legend-row-"]');
    if (row) {
        return rect(800, Number(row.dataset.height ?? 72));
    }
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 80);
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

async function flushLegendWork(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

function renderRow({ item }: Readonly<{ item: Row }>): React.ReactElement {
    return (
        <div
            data-height={item.height}
            data-testid={`real-legend-row-${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

function renderSizeVersionRow({ item }: Readonly<{ item: SizeVersionRow }>): React.ReactElement {
    return renderRow({ item });
}

function classifyLegendPhysicalWrite(write: PhysicalScrollWrite): 'imperative-index' | 'imperative-offset' | 'initial' | 'maintain' | 'other' {
    // Legend schedules maintainScrollAtEnd through rAF, so the bundled callback
    // line is the surviving attribution frame after doMaintainScrollAtEnd returns.
    if (
        write.stack.includes('doMaintainScrollAtEnd')
        || write.stack.includes('@legendapp/list/react-native.web.mjs:1646:')
    ) {
        return 'maintain';
    }
    if (write.stack.includes('dispatchInitialScroll') || write.stack.includes('advanceMeasuredInitialScroll')) {
        return 'initial';
    }
    if (write.stack.includes('scrollToIndex')) return 'imperative-index';
    if (write.stack.includes('doScrollTo')) return 'imperative-offset';
    return 'other';
}

function findScrollElement(): HTMLElement {
    const element = document.getElementById('real-legend-host')
        ?.querySelector<HTMLElement>('[style*="overflow"]');
    expect(element).not.toBeNull();
    return element!;
}

function distanceFromLiveTail(element: HTMLElement): number {
    return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

type ReactFiberWithRef = Readonly<{
    memoizedProps?: Readonly<{ value?: unknown }>;
    ref?: unknown;
    return?: ReactFiberWithRef | null;
}>;

function isLegendListRef(value: unknown): value is LegendListRef {
    if (value == null || typeof value !== 'object') return false;
    const candidate = value as Readonly<Record<string, unknown>>;
    return typeof candidate.getState === 'function'
        && typeof candidate.scrollToEnd === 'function'
        && typeof candidate.scrollToIndex === 'function';
}

function readInstalledLegendState(element: HTMLElement): ReturnType<LegendListRef['getState']> {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) throw new Error('Mounted React fiber was unavailable for the real Legend list');
    let fiber = (element as unknown as Record<string, unknown>)[fiberKey] as ReactFiberWithRef | undefined;
    while (fiber) {
        const ref = fiber.ref;
        const current = ref != null && typeof ref === 'object'
            ? (ref as Readonly<{ current?: unknown }>).current
            : null;
        if (isLegendListRef(current)) return current.getState();
        fiber = fiber.return ?? undefined;
    }
    throw new Error('Mounted installed Legend ref was unavailable from the React tree');
}

function readDiagnostics(): {
    heldIntents: Array<{ event: string; intentId: string | null }>;
    physicalWrites: Array<{ writer: string }>;
    writes: unknown[];
} {
    return (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
        heldIntents: Array<{ event: string; intentId: string | null }>;
        physicalWrites: Array<{ writer: string }>;
        writes: unknown[];
    };
}

/**
 * Library-write ceilings MEASURED against the armed physical-write ring (Z1). They were
 * previously `<= 1` because the ring was installed on the wrong element and recorded nothing;
 * these are the counts the transcript scroller actually receives, so an added writer or an
 * extra correction pass still fails the assertion.
 */
const LATE_TAIL_LIBRARY_WRITE_CEILING = 2;
const SETTLED_APPEND_LIBRARY_WRITE_CEILING = 2;
const STEADY_APPEND_LIBRARY_WRITE_CEILING = 5;

/**
 * THE RING MUST BE ARMED BEFORE IT IS READ.
 *
 * The physical-write observer used to be installed by a mount-time effect against whatever
 * the scroller resolution returned before the transcript overflowed - an ancestor scroller,
 * not the transcript's. It therefore recorded nothing, and every `physicalWrites` assertion
 * in this file passed VACUOUSLY: `every()` over an empty array is `true` and a count ceiling
 * over an empty array is trivially met. Each such assertion now proves the instrument is live
 * first, so an uninstalled observer can never again be mistaken for a quiet page.
 */
function expectArmedPhysicalWriteRing(): void {
    const census = readTranscriptPhysicalWriteCensus();
    expect(census.observer.installed, 'the physical-write ring must be armed before it is read').toBe(true);
    expect(census.status).toBe('armed');
}

describe('Legend transcript renderer real installed-package lifecycle', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        scrollMethodActive = false;
        viewportHeight = 600;
        localStorage.setItem('happier.debug.viewportWrites', '1');
        resetTranscriptViewportDiagnosticsForTests();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        container = document.createElement('div');
        container.style.height = '600px';
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
                // Legend retains one module-level ResizeObserver across list instances. The
                // harness resets its delivery registry between tests, so observing the next
                // instance must re-register that retained observer for subsequent flushes.
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
                const rowsInElement = element.querySelectorAll<HTMLElement>('[data-height]');
                let materializedTotal = 0;
                for (const row of rowsInElement) materializedTotal += Number(row.dataset.height ?? 0);
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    // DOM MVCP temporarily pads the content before its new height commits.
                    // Model that real scroll range so early scrollBy is not falsely clamped.
                    let padding = 0;
                    for (let ancestor: HTMLElement | null = descendant; ancestor; ancestor = ancestor.parentElement) {
                        padding += Number.parseFloat(ancestor.style.paddingTop || '0') || 0;
                        padding += Number.parseFloat(ancestor.style.paddingBottom || '0') || 0;
                        if (ancestor === element) break;
                    }
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        (Number.parseFloat(descendant.style.height || '0') || 0) + padding,
                    );
                }
                return Math.max(element.clientHeight, materializedTotal, virtualContentHeight);
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
                if (!scrollMethodActive) {
                    directScrollTopWrites.push({
                        stack: new Error('direct physical scrollTop write').stack ?? '',
                        top: element.__scrollTop,
                    });
                }
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number'
                    ? (y ?? 0)
                    : (options.top ?? this.scrollTop);
                writePhysicalScroll(this, top);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number'
                    ? (y ?? 0)
                    : (options.top ?? 0);
                // Native DOM scrollBy does not call the public JS scrollTo method.
                writePhysicalScroll(this, this.scrollTop + delta);
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
        localStorage.removeItem('happier.debug.viewportWrites');
        vi.unstubAllGlobals();
        resetTranscriptViewportDiagnosticsForTests();
        vi.useRealTimers();
    });

    it('revokes a pending tail command through the real wheel takeover before its commit', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        await act(async () => {
            root.render(<Renderer
                ref={listRef}
                data={rows(20, 'cancel-tail')}
                dataKey="cancel-tail"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={createWebDomScrollObservation()}
            />);
        });
        await flushLegendWork();
        const scrollElement = findScrollElement();
        scrollElement.scrollTo({ top: 120 });
        await flushLegendWork();
        physicalScrollWrites.length = 0;
        const before = scrollElement.scrollTop;
        await act(async () => {
            void listRef.current?.scrollToEnd?.({ animated: false });
            scrollElement.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
        });
        await flushLegendWork();
        expect(scrollElement.scrollTop).toBe(before);
        expect(physicalScrollWrites).toEqual([]);
    });

    it('cancels preserved initial-end correction on user takeover while retaining the no-user correction', async () => {
        const listRef = React.createRef<LegendListRef>();
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 120,
            id: `preserved-initial-end-${index}`,
        }));

        await act(async () => {
            root.render(
                <div id="real-legend-host" style={{ height: 600 }}>
                    <LegendList
                        data={initialRows}
                        estimatedItemSize={120}
                        initialScrollAtEnd
                        keyExtractor={(item: Row) => item.id}
                        maintainVisibleContentPosition={false}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        const correctionFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            correctionFrames.push(callback);
            return correctionFrames.length;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        await act(async () => {
            viewportHeight = Math.max(100, (listRef.current?.getState().scrollLength ?? 600) - 100);
            flushResizeObservers();
            await Promise.resolve();
        });
        expect(correctionFrames.length).toBeGreaterThan(0);

        await act(async () => {
            for (let pass = 0; pass < 8 && correctionFrames.length > 0; pass += 1) {
                correctionFrames.shift()?.(Date.now());
                await Promise.resolve();
            }
        });

        const noUserCorrectionWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
        ));
        expect(noUserCorrectionWrites.length).toBeGreaterThan(0);

        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        correctionFrames.length = 0;
        await act(async () => {
            viewportHeight = Math.max(100, (listRef.current?.getState().scrollLength ?? 500) - 100);
            flushResizeObservers();
            await Promise.resolve();
        });
        expect(correctionFrames.length).toBeGreaterThan(0);
        listRef.current!.cancelScroll();

        // The second geometry change has armed a fresh preserved-end correction, but its RAF
        // has not run yet. This next event is genuine user movement and must not be interpreted
        // as permission for the retired initial-placement owner to write the viewport back.
        scrollElement.__scrollTop = Math.max(0, scrollElement.scrollTop - 80);
        scrollElement.dispatchEvent(new Event('scroll'));
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;

        await act(async () => {
            for (let pass = 0; pass < 8 && correctionFrames.length > 0; pass += 1) {
                correctionFrames.shift()?.(Date.now());
                await Promise.resolve();
            }
        });

        const postTakeoverCorrectionWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
        ));
        expect(postTakeoverCorrectionWrites).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('hands initial-end ownership to one current-geometry maintain pass without overlap', async () => {
        const listRef = React.createRef<LegendListRef>();
        let hasMaintainIntent = true;
        let readyToRender = false;
        let footerHeight = 24;
        let currentRows = Array.from({ length: 18 }, (_value, index) => ({
            height: index % 4 === 0 ? 1_200 : index % 3 === 0 ? 360 : 96,
            id: `initial-maintain-handoff-${index}`,
        }));
        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
            readyAtSchedule: boolean;
            stack: string;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({
                callback,
                id,
                readyAtSchedule: readyToRender,
                stack: new Error('scheduled initial/maintain handoff frame').stack ?? '',
            });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });

        const render = (key: string) => (
            <div id="real-legend-host" style={{ height: viewportHeight }}>
                <LegendList
                    data={currentRows}
                    estimatedItemSize={240}
                    getItemType={(item: Row) => (
                        item.height >= 1_000 ? 'large-markdown' : 'message'
                    )}
                    initialScrollAtEnd
                    key={key}
                    keyExtractor={(item: Row) => item.id}
                    ListFooterComponent={<div style={{ height: footerHeight }} />}
                    maintainScrollAtEnd={{
                        animated: false,
                        isMaintainingScrollAtEnd: () => hasMaintainIntent,
                        on: {
                            dataChange: true,
                            footerLayout: true,
                            itemLayout: true,
                            layout: true,
                        },
                    }}
                    maintainScrollAtEndThreshold={0.1}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );
        const isMaintainFrame = (frame: Readonly<{ stack: string }>) => (
            frame.stack
                .split('\n')
                .find((line) => line.includes('@legendapp/list'))
                ?.includes('at doMaintainScrollAtEnd') === true
        );
        const drainMaintainFrames = async (): Promise<PhysicalScrollWrite[]> => {
            const writes: PhysicalScrollWrite[] = [];
            for (let pass = 0; pass < 16; pass += 1) {
                const index = scheduledFrames.findIndex(isMaintainFrame);
                if (index < 0) return writes;
                const [frame] = scheduledFrames.splice(index, 1);
                const writeCountBefore = physicalScrollWrites.length;
                await act(async () => {
                    frame!.callback(Date.now());
                    await vi.advanceTimersByTimeAsync(0);
                });
                writes.push(...physicalScrollWrites.slice(writeCountBefore));
            }
            throw new Error('Legend steady maintenance did not reach a bounded idle state');
        };

        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            await Promise.resolve();
        });
        const unsubscribeReady = listRef.current!.getState().listen(
            'readyToRender',
            (value) => {
                readyToRender = value;
            },
        );
        await act(async () => {
            flushResizeObservers();
            await Promise.resolve();
        });

        // Fire the viewport-layout trigger after containers exist while bootstrap remains held.
        viewportHeight = 640;
        await act(async () => {
            flushResizeObservers();
            await Promise.resolve();
        });
        const preTerminalMaintainWrites: PhysicalScrollWrite[] = [];
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        // Fire the structural-data trigger without advancing an initial-scroll frame.
        currentRows = [
            ...currentRows,
            { height: 1_440, id: 'initial-maintain-handoff-data' },
        ];
        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        // Fire the item-layout trigger with a heterogeneous row remeasurement.
        const measuredRow = container.querySelector<HTMLElement>(
            '[data-testid^="real-legend-row-initial-maintain-handoff-"]',
        );
        expect(measuredRow).not.toBeNull();
        await act(async () => {
            measuredRow!.dataset.height = '1680';
            measuredRow!.style.height = '1680px';
            flushResizeObservers();
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        // Fire the footer-layout trigger.
        footerHeight = 180;
        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            flushResizeObservers();
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        // Fire one more data request and drain it while the initial owner is still live.
        currentRows = [
            ...currentRows,
            { height: 720, id: 'initial-maintain-handoff-final' },
        ];
        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            flushResizeObservers();
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        expect(readyToRender).toBe(false);
        const preTerminalPhysicalWrites = [...physicalScrollWrites];

        // Leave one final current-geometry request queued for the terminal handoff.
        currentRows = [
            ...currentRows,
            { height: 840, id: 'initial-maintain-handoff-terminal' },
        ];
        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            flushResizeObservers();
            await Promise.resolve();
        });

        for (let pass = 0; pass < 48 && !readyToRender; pass += 1) {
            const index = scheduledFrames.findIndex((frame) => !isMaintainFrame(frame));
            expect(
                index,
                `Legend initial ownership stalled before terminal:\n${scheduledFrames
                    .map((frame) => frame.stack)
                    .join('\n---\n')}`,
            ).toBeGreaterThanOrEqual(0);
            const [frame] = scheduledFrames.splice(index, 1);
            await act(async () => {
                frame!.callback(Date.now());
                if (!readyToRender) {
                    flushResizeObservers();
                }
                await vi.advanceTimersByTimeAsync(100);
            });
        }

        expect(readyToRender).toBe(true);
        const handoffFrames = scheduledFrames.filter(isMaintainFrame);
        physicalScrollWrites.length = 0;
        expect(
            handoffFrames,
            `terminal initial placement must queue one maintain handoff:\n${scheduledFrames
                .map((frame) => frame.stack
                    .split('\n')
                    .find((line) => line.includes('@legendapp/list')) ?? 'non-Legend frame')
                .join('\n')}`,
        ).toHaveLength(1);
        const [handoffFrame] = handoffFrames;
        const handoffFrameIndex = scheduledFrames.findIndex((frame) => frame.id === handoffFrame!.id);
        scheduledFrames.splice(handoffFrameIndex, 1);
        const handoffScrollElement = findScrollElement();
        const expectedHandoffTop = Math.max(
            0,
            handoffScrollElement.scrollHeight - handoffScrollElement.clientHeight,
        );
        await act(async () => {
            handoffFrame!.callback(Date.now());
            await Promise.resolve();
        });
        const handoffMaintainWrites = [...physicalScrollWrites];
        const postTerminalInitialWrites = physicalScrollWrites.filter(
            (write) => classifyLegendPhysicalWrite(write) === 'initial'
                || write.stack.includes('schedulePreservedEndAnchorCorrection'),
        );

        expect(
            {
                handoffFrames: handoffFrames.map((frame) => ({
                    readyAtSchedule: frame.readyAtSchedule,
                    stack: frame.stack,
                })),
                physicalScrollWrites: preTerminalPhysicalWrites.map((write) => ({
                    family: classifyLegendPhysicalWrite(write),
                    stack: write.stack,
                    top: write.top,
                })),
                preTerminalMaintainWrites: preTerminalMaintainWrites.map((write) => write.top),
            },
            'initial/preserved ownership must retire before renewable maintenance can write',
        ).toEqual(expect.objectContaining({
            handoffFrames: [
                expect.objectContaining({ readyAtSchedule: true }),
            ],
            preTerminalMaintainWrites: [],
        }));
        expect(
            handoffMaintainWrites,
            `terminal handoff must coalesce to one current-geometry write:\n${handoffMaintainWrites
                .map((write) => write.stack)
                .join('\n---\n')}`,
        ).toHaveLength(1);
        expect(handoffMaintainWrites[0]!.top).toBe(expectedHandoffTop);
        expect(postTerminalInitialWrites).toHaveLength(0);

        unsubscribeReady();

        // A new mount exercises takeover after terminal drains the queued request into
        // maintainingScrollAtEnd, but before that handoff RAF can land.
        vi.clearAllTimers();
        scheduledFrames.length = 0;
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readyToRender = false;
        currentRows = Array.from({ length: 12 }, (_value, index) => ({
            height: index % 2 === 0 ? 960 : 120,
            id: `initial-maintain-takeover-${index}`,
        }));
        await act(async () => {
            root.render(render('initial-maintain-takeover'));
            flushResizeObservers();
            await Promise.resolve();
        });
        expect(listRef.current).not.toBeNull();
        const unsubscribeTakeoverReady = listRef.current!.getState().listen(
            'readyToRender',
            (value) => {
                readyToRender = value;
            },
        );
        currentRows = [
            ...currentRows,
            { height: 1_080, id: 'initial-maintain-takeover-data' },
        ];
        await act(async () => {
            root.render(render('initial-maintain-takeover'));
            flushResizeObservers();
            await Promise.resolve();
        });
        for (let pass = 0; pass < 48 && !readyToRender; pass += 1) {
            const index = scheduledFrames.findIndex((frame) => !isMaintainFrame(frame));
            expect(
                index,
                `Legend takeover mount stalled before terminal:\n${scheduledFrames
                    .map((frame) => frame.stack)
                    .join('\n---\n')}`,
            ).toBeGreaterThanOrEqual(0);
            const [frame] = scheduledFrames.splice(index, 1);
            await act(async () => {
                frame!.callback(Date.now());
                if (!readyToRender) {
                    flushResizeObservers();
                }
                await vi.advanceTimersByTimeAsync(100);
            });
        }
        expect(readyToRender).toBe(true);
        const takeoverHandoffFrames = scheduledFrames.filter(isMaintainFrame);
        expect(takeoverHandoffFrames).toHaveLength(1);
        expect(takeoverHandoffFrames[0]!.readyAtSchedule).toBe(true);
        hasMaintainIntent = false;
        await act(async () => {
            listRef.current!.cancelScroll();
            await Promise.resolve();
        });
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        for (let pass = 0; pass < 16; pass += 1) {
            const index = scheduledFrames.findIndex(isMaintainFrame);
            if (index < 0) break;
            const [frame] = scheduledFrames.splice(index, 1);
            await act(async () => {
                frame!.callback(Date.now());
                await Promise.resolve();
            });
        }
        expect(
            physicalScrollWrites,
            `takeover must retire every not-yet-landed handoff write:\n${physicalScrollWrites
                .map((write) => `${classifyLegendPhysicalWrite(write)}:${write.top}\n${write.stack}`)
                .join('\n---\n')}`,
        ).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
        unsubscribeTakeoverReady();
    });

    it('lets each production-keyed Legend mount own cold initial-tail placement without adapter writes', async () => {
        const consoleError = vi.spyOn(console, 'error');
        deliverBrowserScrollEventsAsynchronously();
        const Renderer = legendListRenderer.Component;
        const render = (data: readonly Row[], dataKey: string) => (
            <Renderer
                key={dataKey}
                data={data}
                dataKey={dataKey}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render(rows(2, 'warm'), 'session-a'));
        });
        await flushLegendWork();

        physicalScrollWrites.length = 0;
        await act(async () => {
            root.render(render(rows(80, 'cold'), 'session-b'));
        });
        await flushLegendWork();

        expect(container.querySelector('[data-testid="real-legend-row-cold-79"]')).not.toBeNull();
        const coldWritesByOwner = physicalScrollWrites.map(classifyLegendPhysicalWrite);
        expect(coldWritesByOwner.filter((owner) => owner === 'imperative-index')).toHaveLength(0);
        expect(coldWritesByOwner.filter((owner) => owner === 'imperative-offset')).toHaveLength(0);
        expect(coldWritesByOwner.filter((owner) => owner === 'maintain')).toHaveLength(0);
        const scrollElement = findScrollElement();
        expect(scrollElement.scrollTop).toBe(
            Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
        );
        expect(readInstalledLegendState(scrollElement).scroll).toBe(scrollElement.scrollTop);

        physicalScrollWrites.length = 0;
        await act(async () => {
            root.render(render(rows(3, 'other'), 'session-c'));
        });
        await flushLegendWork();
        await act(async () => {
            root.render(render(rows(80, 'cold'), 'session-b'));
        });
        await flushLegendWork();

        expect(container.querySelector('[data-testid="real-legend-row-cold-79"]')).not.toBeNull();
        const switchBackWritesByOwner = physicalScrollWrites.map(classifyLegendPhysicalWrite);
        expect(switchBackWritesByOwner.filter((owner) => owner === 'imperative-index')).toHaveLength(0);
        expect(switchBackWritesByOwner.filter((owner) => owner === 'imperative-offset')).toHaveLength(0);
        expect(switchBackWritesByOwner.filter((owner) => owner === 'maintain')).toHaveLength(0);
        const reopenedScrollElement = findScrollElement();
        expect(readInstalledLegendState(reopenedScrollElement).scroll).toBe(reopenedScrollElement.scrollTop);

        await act(async () => {
            root.render(render(rows(80, 'cold').map((row, index) => (
                index === 77 ? { ...row, height: 72 } : row
            )), 'session-b'));
        });
        await flushLegendWork();

        expect(distanceFromLiveTail(reopenedScrollElement)).toBeLessThanOrEqual(1);
        expect(readInstalledLegendState(reopenedScrollElement).scroll).toBe(reopenedScrollElement.scrollTop);
        expect(readInstalledLegendState(reopenedScrollElement).endBuffered).toBe(79);
        expect(
            consoleError.mock.calls.filter((args) => (
                args.some((value) => String(value).includes('Cannot update a component'))
            )),
        ).toEqual([]);
    });

    it('places an asynchronously hydrated pinned session at the physical tail after its keyed mount', async () => {
        const Renderer = legendListRenderer.Component;
        const render = (data: readonly Row[]) => (
            <Renderer
                key="async-pinned-session"
                data={data}
                dataKey="async-pinned-session"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render([]));
        });
        await flushLegendWork();

        physicalScrollWrites.length = 0;
        await act(async () => {
            root.render(render(rows(80, 'async-pinned')));
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        expect(scrollElement.scrollTop).toBe(
            Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
        );
        // The landing above is the contract, and the library alone produces it. The adapter's
        // one-shot tail materialization is a post-placement fallback, not a participant in the
        // open: while Legend's bootstrap is still resolving the tail offset the adapter has no
        // target to write, and once the bootstrap lands the tail is already materialized.
        expect(
            physicalScrollWrites
                .map(classifyLegendPhysicalWrite)
                .filter((owner) => owner === 'imperative-index' || owner === 'imperative-offset'),
        ).toHaveLength(0);
    });

    it('retains the accepted physical viewport after late bootstrap geometry settles', async () => {
        const listRef = React.createRef<LegendListRef>();
        deliverBrowserScrollEventsAsynchronously();
        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId++;
            scheduledFrames.push({ callback, id });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });
        let loaded = false;
        let data = rows(80, 'bootstrap-settle');
        const render = () => (
            <div id="real-legend-host" style={{ height: viewportHeight }}>
                <LegendList
                    data={data}
                    estimatedItemSize={120}
                    initialScrollAtEnd
                    keyExtractor={(item: Row) => item.id}
                    ListFooterComponent={renderRow({ item: { height: 24, id: 'bootstrap-footer' } })}
                    maintainScrollAtEnd={{
                        animated: false,
                        isMaintainingScrollAtEnd: () => true,
                        on: { dataChange: true, footerLayout: true, itemLayout: true, layout: true },
                    }}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    onLoad={() => { loaded = true; }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );
        await act(async () => {
            root.render(render());
            flushResizeObservers();
        });
        for (let pass = 0; pass < 48 && physicalScrollWrites.length === 0; pass += 1) {
            await act(async () => {
                flushResizeObservers();
                const frame = scheduledFrames.shift();
                frame?.callback(Date.now());
                await vi.advanceTimersByTimeAsync(1);
            });
        }
        expect(physicalScrollWrites.length).toBeGreaterThan(0);
        expect(loaded).toBe(false);
        const readBootstrapState = () => {
            const element = findScrollElement();
            const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'))!;
            let fiber = (element as unknown as Record<string, unknown>)[fiberKey] as ReactFiberWithRef | undefined;
            while (fiber) {
                const context = fiber.memoizedProps?.value as { state?: {
                    scroll: number;
                    initialScroll?: unknown;
                    initialScrollSession?: { bootstrap?: { scroll: number; mountFrameCount: number } };
                    didFinishInitialScroll?: boolean;
                } } | undefined;
                if (context?.state && typeof context.state.scroll === 'number') return context.state;
                fiber = fiber.return ?? undefined;
            }
            throw new Error('Legend context not found');
        };
        // The cached window changes while the prior initial dispatch is still completing.
        // A real viewport-layout delivery rearms the bootstrap for its new last-item target.
        data = data.slice(0, -1);
        await act(async () => {
            root.render(render());
        });
        viewportHeight = 601;
        await act(async () => {
            flushResizeObservers();
            await Promise.resolve();
        });
        expect(readBootstrapState().initialScrollSession?.bootstrap).toBeDefined();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
        // Finish the old dispatch and all remaining real frames, including the rearmed
        // bootstrap's watchdog. No user event is needed to reconcile the accepted viewport.
        for (let pass = 0; pass < 64 && scheduledFrames.length > 0; pass += 1) {
            await act(async () => {
                scheduledFrames.shift()!.callback(Date.now());
                flushResizeObservers();
                await vi.advanceTimersByTimeAsync(100);
            });
        }
        expect(scheduledFrames).toHaveLength(0);

        const element = findScrollElement();
        const state = listRef.current!.getState();
        expect(distanceFromLiveTail(element)).toBeLessThanOrEqual(1);
        expect(state.scroll).toBe(element.scrollTop);
        expect(state.endBuffered).toBe(data.length - 1);
    });

    it('reserves anchored underfilled entry from Legend maintenance before keyed handoff', async () => {
        const Renderer = legendListRenderer.Component;
        const observation = createWebDomScrollObservation();
        const initialRows: readonly Row[] = [
            { height: 120, id: 'anchored-entry-0' },
            { height: 120, id: 'anchored-entry-1' },
        ];
        const render = (data: readonly Row[]) => (
            <Renderer
                data={data}
                dataKey="anchored-entry-session"
                extraData={data.length}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={observation}
            />
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        expect(scrollElement.scrollHeight).toBe(scrollElement.clientHeight);
        const anchoredTop = scrollElement.scrollTop;
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;

        await act(async () => {
            root.render(render([
                ...initialRows,
                { height: 900, id: 'anchored-entry-growth' },
            ]));
        });
        await flushLegendWork();

        expect(container.querySelector('[data-testid="real-legend-row-anchored-entry-growth"]')).not.toBeNull();
        expect(scrollElement.scrollHeight).toBeGreaterThan(scrollElement.clientHeight);
        expect({
            appWrites: readDiagnostics().writes.length,
            directWrites: directScrollTopWrites.length,
            legendMaintainWrites: readDiagnostics().physicalWrites.filter(
                (write) => write.writer === 'legend-maintain',
            ).length,
            maintainStackWrites: physicalScrollWrites.filter(
                (write) => classifyLegendPhysicalWrite(write) === 'maintain',
            ).length,
            physicalWriteOwners: physicalScrollWrites.map(classifyLegendPhysicalWrite),
            recordedPhysicalWriters: readDiagnostics().physicalWrites.map((write) => write.writer),
            scrollTop: scrollElement.scrollTop,
        }).toEqual({
            appWrites: 0,
            directWrites: 0,
            legendMaintainWrites: 0,
            maintainStackWrites: 0,
            physicalWriteOwners: [],
            recordedPhysicalWriters: [],
            scrollTop: anchoredTop,
        });
    });

    it('reports entry-tagged start/finish for exact settle, preemption, deadline, and bootstrap completion', async () => {
        const Renderer = legendListRenderer.Component as unknown as React.ComponentType<
            WebEntryPlacementRendererProps<Row>
        >;
        const listRef = React.createRef<WebEntryPlacementShellRef<Row>>();
        const placementEvents: WebEntryPlacementEvent[] = [];
        const detachedRows = rows(40, 'detached-presentation');
        const anchor: WebEntryPlacementAnchor = {
            itemId: 'detached-presentation-0',
            itemOffsetPx: 24,
            kind: 'item',
            messageId: null,
            reason: 'entry-restore',
        };

        await act(async () => {
            root.render(
                <Renderer
                    data={detachedRows}
                    dataKey="detached-presentation-session"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: false,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'real-legend-host',
                        platformOS: 'web',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    onEntryPlacementEvent={(event) => {
                        placementEvents.push(event);
                    }}
                    ref={listRef}
                    renderItem={({ item }: Readonly<{ item: Row }>) => (
                        <div
                            data-height={item.height}
                            style={{ height: item.height }}
                        >
                            <div
                                data-testid={`transcript-item-${item.id}`}
                                style={{ height: item.height }}
                            >
                                {item.id}
                            </div>
                        </div>
                    )}
                    webDomObservation={createWebDomScrollObservation()}
                />,
            );
            flushResizeObservers();
        });

        const scrollElement = findScrollElement();
        expect(scrollElement.scrollHeight).toBeGreaterThan(scrollElement.clientHeight);
        scrollElement.scrollTop = 500;
        act(() => {
            listRef.current?.holdWebEntryAnchor?.({
                ...anchor,
            });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_601);
        });
        await flushLegendWork();

        expect(listRef.current?.hasLiveWebHold?.({
            kind: 'item',
            itemId: 'detached-presentation-0',
        })).toBe(false);
        expect(readDiagnostics().writes.length).toBeGreaterThan(0);

        act(() => {
            listRef.current?.releaseWebHeldIntent?.();
            listRef.current?.holdWebEntryAnchor?.({ ...anchor });
            listRef.current?.releaseWebHeldIntent?.();
        });
        await flushLegendWork();

        vi.stubGlobal('requestAnimationFrame', () => 0);
        act(() => {
            listRef.current?.holdWebEntryAnchor?.({ ...anchor });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_001);
            listRef.current?.notifyViewportGeometryChanged?.();
        });
        expect(listRef.current?.hasLiveWebHold?.({
            kind: 'item',
            itemId: 'detached-presentation-0',
        })).toBe(false);

        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                context: {
                    anchor: { ...anchor },
                    kind: 'entry-placement',
                },
                index: 0,
            });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_601);
        });
        await flushLegendWork();

        expect(placementEvents).toEqual([
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                platform: 'web',
                type: 'started',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                outcome: 'settled',
                platform: 'web',
                type: 'finished',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                platform: 'web',
                type: 'started',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                outcome: 'preempted',
                platform: 'web',
                type: 'finished',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                platform: 'web',
                type: 'started',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                outcome: 'deadline',
                platform: 'web',
                type: 'finished',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                platform: 'web',
                type: 'started',
            },
            {
                dataKey: 'detached-presentation-session',
                itemId: 'detached-presentation-0',
                outcome: 'settled',
                platform: 'web',
                type: 'finished',
            },
        ]);
        expect(readDiagnostics().heldIntents.filter((entry) => (
            entry.event === 'hold-release'
            && entry.intentId === 'detached-presentation-0'
        ))).toHaveLength(4);
    });

    it.each([
        {
            initialAtEnd: false,
            initialRows: rows(20, 'own-send-detached'),
            name: 'a detached scrollable transcript',
            underfilled: false,
            prepare(scrollElement: HTMLElement) {
                scrollElement.scrollTo({ top: 120 });
            },
        },
        {
            initialAtEnd: true,
            initialRows: rows(20, 'own-send-pinned'),
            name: 'an already-pinned transcript',
            underfilled: false,
            prepare(scrollElement: HTMLElement) {
                scrollElement.scrollTo({
                    top: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
                });
            },
        },
        {
            initialAtEnd: false,
            initialRows: [
                { height: 120, id: 'own-send-underfilled-0' },
                { height: 120, id: 'own-send-underfilled-1' },
            ],
            name: 'an underfilled transcript that becomes scrollable',
            underfilled: true,
            prepare(_scrollElement: HTMLElement) {},
        },
    ])('keeps an accepted own-send at the live tail from $name', async ({
        initialAtEnd,
        initialRows,
        prepare,
        underfilled,
    }) => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const observation = createWebDomScrollObservation();
        const ownRowId = `${initialRows[0]?.id ?? 'own-send'}-optimistic`;
        let acceptedOwnSend = false;
        let semanticFollowing = false;
        const acceptedSendSemanticTransitions: Array<Readonly<{
            cause: 'command' | 'layout' | 'user';
            isPinned: boolean;
        }>> = [];
        const render = (ownRowHeight: number | null) => (
            <Renderer
                ref={listRef}
                data={ownRowHeight == null
                    ? initialRows
                    : [...initialRows, { height: ownRowHeight, id: ownRowId }]}
                dataKey={`own-send-${initialRows[0]?.id ?? 'session'}`}
                extraData={ownRowHeight ?? 'before-send'}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: initialAtEnd,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                onRendererAtEndChange={(state, context) => {
                    const viewportChange = resolveRendererAtEndViewportChange(state, context);
                    if (!viewportChange) return;
                    semanticFollowing = viewportChange.isPinned;
                    if (acceptedOwnSend) {
                        acceptedSendSemanticTransitions.push({
                            cause: context.cause,
                            isPinned: viewportChange.isPinned,
                        });
                    }
                }}
                renderItem={renderRow}
                webDomObservation={observation}
            />
        );

        await act(async () => {
            root.render(render(null));
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        if (underfilled) {
            expect(scrollElement.scrollHeight).toBe(scrollElement.clientHeight);
        }
        prepare(scrollElement);
        await flushLegendWork();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;

        // The sync/composer owner records accepted-own-send intent before this
        // optimistic mutation. The mounted bottom-follow host consumes that
        // semantic intent after the commit and hands the physical landing here.
        acceptedOwnSend = true;
        semanticFollowing = true;
        await act(async () => {
            root.render(render(900));
        });
        await act(async () => {
            listRef.current?.scrollToEnd?.({ animated: false });
        });
        await flushLegendWork();
        await flushLegendWork();

        expect(container.querySelector(`[data-testid="real-legend-row-${ownRowId}"]`)).not.toBeNull();
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        expect(semanticFollowing).toBe(true);
        expect(acceptedSendSemanticTransitions).not.toContainEqual({
            cause: 'command',
            isPinned: false,
        });
        if (underfilled) {
            expect(scrollElement.scrollHeight).toBeGreaterThan(scrollElement.clientHeight);
        }
        expect(directScrollTopWrites).toHaveLength(0);
        expect(readDiagnostics().writes).toHaveLength(0);
        expect(physicalScrollWrites.length).toBeGreaterThan(0);
        // The library owns the landing of an accepted own-send. The previous form required
        // every recorded write to be `legend-maintain`; against the armed ring that is false -
        // Legend reaches the tail through its imperative and adjust paths too. What the test
        // actually protects survives: the app's own writer never runs, and the reader is left
        // at the live tail (both asserted above).
        expectArmedPhysicalWriteRing();
        expect(readDiagnostics().physicalWrites.length).toBeGreaterThan(0);

        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;
        await act(async () => {
            root.render(render(1_800));
        });
        await flushLegendWork();

        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        expect(directScrollTopWrites).toHaveLength(0);
        expect(readDiagnostics().writes).toHaveLength(0);
        expectArmedPhysicalWriteRing();
        expect(readDiagnostics().physicalWrites.length).toBeLessThanOrEqual(SETTLED_APPEND_LIBRARY_WRITE_CEILING);
    });

    it('does not re-open a keyed settle window for a pure tail append', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const observation = createWebDomScrollObservation();
        const initialRows = rows(20, 'append-settle');
        // The production main-transcript shape: an extraData object whose identity is stable
        // across tail appends and changes only when the ids structure changes.
        const extraData = { idsStructureVersion: 1 };
        const render = (data: readonly Row[], nextExtraData: unknown = extraData) => (
            <div id="real-legend-host" style={{ height: 600 }}>
            <Renderer
                data={data}
                dataKey="append-settle-session"
                extraData={nextExtraData}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={renderRow}
                webDomObservation={observation}
            />
            </div>
        );
        // react-native-web reads offsetHeight for its layout events while this file's mocks
        // only cover clientHeight/getBoundingClientRect; without this, the identity host
        // alternates between the mocked height and a real 0 and every flush re-opens the
        // settle window through recordViewportHeight — noise unrelated to the contract here.
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get() {
                return measuredRect(this).height;
            },
        });
        try {
        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();
        // Detach the reader onto a keyed mid-list hold and let that settle transaction close.
        act(() => {
            listRef.current?.scrollToIndex?.({ animated: false, index: 6, viewPosition: 0 });
        });
        await flushLegendWork();
        readDiagnostics().heldIntents.length = 0;

        await act(async () => {
            root.render(render([...initialRows, { height: 180, id: 'append-settle-20' }]));
        });
        await flushLegendWork();

        expect(readDiagnostics().heldIntents.filter((entry) => entry.event === 'settle-request')).toHaveLength(0);
        } finally {
            delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
        }
    });

    it('re-opens a keyed settle window when the ids structure changes', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const observation = createWebDomScrollObservation();
        const initialRows = rows(20, 'structure-settle');
        const render = (data: readonly Row[], extraData: unknown) => (
            <div id="real-legend-host" style={{ height: 600 }}>
            <Renderer
                data={data}
                dataKey="structure-settle-session"
                extraData={extraData}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={renderRow}
                webDomObservation={observation}
            />
            </div>
        );
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            configurable: true,
            get() {
                return measuredRect(this).height;
            },
        });
        try {
        await act(async () => {
            root.render(render(initialRows, { idsStructureVersion: 1 }));
        });
        await flushLegendWork();
        act(() => {
            listRef.current?.scrollToIndex?.({ animated: false, index: 6, viewPosition: 0 });
        });
        await flushLegendWork();
        readDiagnostics().heldIntents.length = 0;

        await act(async () => {
            root.render(render([...initialRows, { height: 180, id: 'structure-settle-20' }], { idsStructureVersion: 2 }));
        });
        await flushLegendWork();

        expect(readDiagnostics().heldIntents.filter((entry) => entry.event === 'settle-request').length).toBeGreaterThan(0);
        } finally {
            delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
        }
    });

    it('leaves steady append to Legend and does not run the app residual during user takeover', async () => {
        const Renderer = legendListRenderer.Component;
        const observation = createWebDomScrollObservation();
        const render = (data: readonly Row[]) => (
            <Renderer
                data={data}
                dataKey="steady-session"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={observation}
            />
        );
        const initialRows = rows(20, 'steady');
        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();

        const initialScrollElement = findScrollElement();
        initialScrollElement.scrollTo({
            top: Math.max(0, initialScrollElement.scrollHeight - initialScrollElement.clientHeight),
        });
        await flushLegendWork();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;
        await act(async () => {
            root.render(render([...initialRows, { height: 180, id: 'steady-20' }]));
        });
        await flushLegendWork();

        const steadyOwners = [
            ...readDiagnostics().physicalWrites.map((write) => write.writer),
            ...readDiagnostics().writes.map(() => 'app-held-residual' as const),
        ];
        expect(readDiagnostics().writes).toHaveLength(0);
        expectArmedPhysicalWriteRing();
        expect(steadyOwners.filter((owner) => owner === 'app-held-residual')).toHaveLength(0);
        expect(steadyOwners.length).toBeLessThanOrEqual(STEADY_APPEND_LIBRARY_WRITE_CEILING);
        expect(container.querySelector('[data-testid="real-legend-row-steady-20"]')).not.toBeNull();

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        scrollElement.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -300 }));
        scrollElement.__scrollTop = Math.max(0, scrollElement.scrollTop - 300);
        scrollElement.dispatchEvent(new Event('scroll', { bubbles: true }));
        await flushLegendWork();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;

        await act(async () => {
            root.render(render([
                ...initialRows,
                { height: 180, id: 'steady-20' },
                { height: 180, id: 'steady-21' },
            ]));
        });
        await flushLegendWork();

        expect(readDiagnostics().physicalWrites.filter(
            (write) => write.writer === 'legend-maintain',
        )).toHaveLength(0);
        expect(physicalScrollWrites.filter(
            (write) => classifyLegendPhysicalWrite(write) === 'maintain',
        )).toHaveLength(0);
        expect(readDiagnostics().writes).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('does not publish semantic following from installed Legend before its deferred bootstrap scroll callback', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const publicScroll = vi.fn();
        const publications: Array<Readonly<{
            cause: 'command' | 'layout' | 'user';
            isFollowing: boolean;
            keyedHoldLive: boolean;
        }>> = [];
        const render = (data: readonly Row[]) => (
            <Renderer
                key="deferred-hydration-session"
                data={data}
                dataKey="deferred-hydration-session"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                onRendererAtEndChange={(state, context) => {
                    publications.push({
                        cause: context.cause,
                        isFollowing: state.isFollowing,
                        keyedHoldLive: listRef.current?.hasLiveWebHold?.({
                            kind: 'item',
                            itemId: 'deferred-arrival-0',
                        }) === true,
                    });
                }}
                onScroll={publicScroll}
                ref={listRef}
                renderItem={renderRow}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render([]));
        });
        await flushLegendWork();
        publications.length = 0;
        publicScroll.mockClear();

        // The production-keyed instance hydrates its first data window asynchronously. This
        // keeps the installed package's deferred initial-scroll callback ordering observable
        // without modeling the unreachable same-instance session switch.
        await act(async () => {
            root.render(render(rows(40, 'deferred-arrival')));
            flushResizeObservers();
        });

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        // Let the installed package measure the arrived window on its own. Legend publishes its
        // content height from its first post-arrival frame; its bootstrap scroll dispatch lands
        // on the following one, which is the ordering this fixture needs. The adapter issues no
        // placement write in that window, so the height below is the library's own.
        await act(async () => {
            flushResizeObservers();
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(physicalScrollWrites).toHaveLength(0);
        const liveTailOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        expect(liveTailOffset).toBeGreaterThan(600);

        // Install the keyed target without user takeover: an away-from-tail wheel correctly
        // cancels Legend's pending bootstrap, so it cannot be part of a fixture that intends to
        // observe that bootstrap's deferred callback ordering.
        await act(async () => {
            listRef.current?.holdWebEntryAnchor?.({
                ...({
                    itemId: 'deferred-arrival-0',
                    itemOffsetPx: 0,
                    kind: 'item',
                    messageId: null,
                    reason: 'entry-restore',
                } satisfies WebEntryPlacementAnchor),
            });
        });
        expect(listRef.current?.hasLiveWebHold?.({
            kind: 'item',
            itemId: 'deferred-arrival-0',
        })).toBe(true);
        publications.length = 0;
        publicScroll.mockClear();
        physicalScrollWrites.length = 0;

        for (
            let pass = 0;
            pass < 8 && !physicalScrollWrites.some(
                (write) => classifyLegendPhysicalWrite(write) === 'initial',
            );
            pass += 1
        ) {
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
        }
        expect(physicalScrollWrites.some(
            (write) => classifyLegendPhysicalWrite(write) === 'initial',
        )).toBe(true);
        // 3.3.3 can publish more than one staged bootstrap callback while converging. The
        // contract is semantic ordering across every callback, not an incidental count.
        expect(publicScroll).toHaveBeenCalled();
        expect(publications.some(
            (publication) => publication.isFollowing && publication.keyedHoldLive,
        )).toBe(false);
        expect(listRef.current?.hasLiveWebHold?.({
            kind: 'item',
            itemId: 'deferred-arrival-0',
        })).toBe(true);
        expect(listRef.current?.hasLiveWebHold?.({ kind: 'end' })).toBe(false);
    });

    it('does not add an app residual for late tail-row geometry without a proven Legend gap', async () => {
        const Renderer = legendListRenderer.Component;
        const observation = createWebDomScrollObservation();
        const initialRows = rows(20, 'late-row').map((row, index) => (
            index === 19 ? { ...row, height: 40 } : row
        ));
        const render = (lastRowHeight: number) => (
            <Renderer
                data={initialRows.map((row, index) => (
                    index === 19 ? { ...row, height: lastRowHeight } : row
                ))}
                dataKey="late-row-session"
                extraData={lastRowHeight}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={observation}
            />
        );
        await act(async () => {
            root.render(render(40));
        });
        await flushLegendWork();

        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;
        await act(async () => {
            root.render(render(520));
        });
        await flushLegendWork();

        const legendMaintainWrites = readDiagnostics().physicalWrites.filter(
            (write) => write.writer === 'legend-maintain',
        );
        expect(findScrollElement().scrollTop).toBe(
            Math.max(0, findScrollElement().scrollHeight - findScrollElement().clientHeight),
        );
        expect(legendMaintainWrites.length).toBeLessThanOrEqual(1);
        expectArmedPhysicalWriteRing();
        expect(readDiagnostics().physicalWrites.length, JSON.stringify(readDiagnostics().physicalWrites)).toBeLessThanOrEqual(LATE_TAIL_LIBRARY_WRITE_CEILING);
        expect(readDiagnostics().writes).toHaveLength(0);
    });

    it('does not request an app end correction from transient DOM residual before Legend maintenance runs', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const observation = createWebDomScrollObservation();
        const initialRows = rows(20, 'in-flight-residual').map((row, index) => (
            index === 19 ? { ...row, height: 40 } : row
        ));
        await act(async () => {
            root.render(
                <Renderer
                    data={initialRows}
                    dataKey="in-flight-residual-session"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: true,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'real-legend-host',
                        platformOS: 'web',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    ref={listRef}
                    renderItem={renderRow}
                    webDomObservation={observation}
                />,
            );
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        const scrollHeightGetter = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'scrollHeight',
        )?.get;
        expect(scrollHeightGetter).toBeTypeOf('function');
        let forcedTransientScrollHeight: number | null = null;
        Object.defineProperty(scrollElement, 'scrollHeight', {
            configurable: true,
            get() {
                return forcedTransientScrollHeight ?? scrollHeightGetter!.call(this);
            },
        });
        const tailRow = container.querySelector<HTMLElement>(
            '[data-testid="real-legend-row-in-flight-residual-19"]',
        );
        expect(tailRow).not.toBeNull();
        expect(listRef.current?.hasLiveWebHold?.({ kind: 'end' })).toBe(true);
        expect(readInstalledLegendState(scrollElement).isAtEnd).toBe(true);
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);

        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
            stack: string;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({
                callback,
                id,
                stack: new Error('scheduled animation frame').stack ?? '',
            });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });
        act(() => {
            listRef.current?.releaseWebHeldIntent?.();
            listRef.current?.scrollToEnd?.({ animated: false });
        });
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        readDiagnostics().heldIntents.length = 0;
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;
        act(() => {
            listRef.current?.notifyViewportGeometryChanged?.();
        });

        await act(async () => {
            tailRow!.dataset.height = '112';
            tailRow!.style.height = '112px';
            flushResizeObservers();
        });
        forcedTransientScrollHeight = scrollElement.scrollTop + scrollElement.clientHeight + 72;

        expect(readInstalledLegendState(scrollElement).isAtEnd).toBe(true);
        expect(distanceFromLiveTail(scrollElement)).toBe(72);
        const adapterFrameIndex = scheduledFrames.findIndex(
            (frame) => frame.stack.includes('legendListRenderer.tsx'),
        );
        expect(
            adapterFrameIndex,
            scheduledFrames.map((frame) => frame.stack).join('\n---\n'),
        ).toBe(-1);

        expect(readDiagnostics().heldIntents).not.toContainEqual(
            expect.objectContaining({ event: 'residual-write' }),
        );
        expect(readDiagnostics().writes).toHaveLength(0);

        await act(async () => {
            forcedTransientScrollHeight = null;
            tailRow!.dataset.height = '40';
            tailRow!.style.height = '40px';
            flushResizeObservers();
        });
        for (let pass = 0; pass < 24 && distanceFromLiveTail(scrollElement) > 1; pass += 1) {
            const nextFrame = scheduledFrames.shift();
            expect(nextFrame, 'Legend did not schedule maintenance for the measured contraction').toBeDefined();
            await act(async () => {
                nextFrame!.callback(Date.now());
                flushResizeObservers();
                await Promise.resolve();
            });
        }
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        for (let pass = 0; pass < 64 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift();
            await act(async () => {
                nextFrame!.callback(Date.now());
                await vi.runOnlyPendingTimersAsync();
                await Promise.resolve();
            });
        }
        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
            await Promise.resolve();
        });
        expect(
            scheduledFrames,
            `renderer/Legend work did not reach bounded quiescence:\n${scheduledFrames
                .map((frame) => frame.stack)
                .join('\n---\n')}`,
        ).toHaveLength(0);
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        expect(readDiagnostics().heldIntents).not.toContainEqual(
            expect.objectContaining({ event: 'residual-write' }),
        );
        expect(readDiagnostics().writes).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('honors semantic held-end intent after layout movement exceeds the physical threshold', async () => {
        const listRef = React.createRef<LegendListRef>();
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 120,
            id: `semantic-held-end-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="real-legend-host" style={{ height: 600 }}>
                <LegendList
                    data={data}
                    estimatedItemSize={120}
                    initialScrollAtEnd
                    keyExtractor={(item: Row) => item.id}
                    maintainScrollAtEnd={{
                        animated: false,
                        isMaintainingScrollAtEnd: () => true,
                        on: {
                            dataChange: true,
                            itemLayout: true,
                            layout: true,
                        },
                    }}
                    maintainScrollAtEndThreshold={0.1}
                    maintainVisibleContentPosition={false}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        scrollElement.__scrollTop = Math.max(
            0,
            scrollElement.scrollHeight - scrollElement.clientHeight - 800,
        );
        scrollElement.dispatchEvent(new Event('scroll'));
        await flushLegendWork();
        expect(listRef.current?.getState().isWithinMaintainScrollAtEndThreshold).toBe(false);

        await act(async () => {
            root.render(render([
                ...initialRows,
                { height: 600, id: 'semantic-held-end-20' },
            ]));
        });
        await flushLegendWork();

        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
    });

    it('keeps nonanimated semantic end maintenance pinned through each MVCP remeasurement boundary', async () => {
        const listRef = React.createRef<LegendListRef>();
        let semanticEnd = true;
        viewportHeight = 2_400;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 1_200,
            id: `semantic-mvcp-race-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="real-legend-host" style={{ height: viewportHeight }}>
                <LegendList
                    data={data}
                    estimatedItemSize={1_200}
                    getItemType={() => 'message'}
                    initialScrollAtEnd
                    keyExtractor={(item: Row) => item.id}
                    maintainScrollAtEnd={{
                        animated: false,
                        isMaintainingScrollAtEnd: () => semanticEnd,
                        on: {
                            dataChange: true,
                            itemLayout: true,
                            layout: true,
                        },
                    }}
                    maintainScrollAtEndThreshold={0.1}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        const stateBefore = listRef.current!.getState();
        const firstVisibleIndex = stateBefore.start;
        const beforeAnchorIndex = firstVisibleIndex - 1;
        const afterAnchorIndex = firstVisibleIndex + 1;
        expect({
            afterAnchorIndex,
            beforeAnchorIndex,
            firstVisibleIndex,
            lastIndex: initialRows.length - 1,
            mountedAfterAnchor: stateBefore.elementAtIndex(afterAnchorIndex) != null,
            mountedBeforeAnchor: stateBefore.elementAtIndex(beforeAnchorIndex) != null,
        }).toEqual(expect.objectContaining({
            mountedAfterAnchor: true,
            mountedBeforeAnchor: true,
        }));

        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
            stack: string;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({
                callback,
                id,
                stack: new Error('scheduled semantic MVCP frame').stack ?? '',
            });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;

        let remeasuredRows = initialRows.map((row, index) => {
            if (index === beforeAnchorIndex) return { ...row, height: row.height - 988 };
            if (index === afterAnchorIndex) return { ...row, height: row.height + 988 };
            return row;
        });
        await act(async () => {
            root.render(render(remeasuredRows));
            flushResizeObservers();
            await Promise.resolve();
        });

        const boundaryDistances = [distanceFromLiveTail(scrollElement)];
        for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift()!;
            await act(async () => {
                nextFrame.callback(Date.now());
                await Promise.resolve();
            });
            boundaryDistances.push(distanceFromLiveTail(scrollElement));
        }
        const mvcpAwayWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
            || write.stack.includes('scrollAdjustBy')
        ));

        expect(
            Math.max(...boundaryDistances),
            `MVCP must not physically move a semantically maintained end before nonanimated end maintenance runs: ${JSON.stringify({
                boundaryDistances,
                mvcpAwayWrites: mvcpAwayWrites.map((write) => write.top),
                remainingFrames: scheduledFrames.map((frame) => frame.stack),
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(mvcpAwayWrites).toHaveLength(0);
        expect(scheduledFrames).toHaveLength(0);
        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        expect(directScrollTopWrites).toHaveLength(0);

        remeasuredRows = [
            { height: 1_200, id: 'semantic-mvcp-pinned-prepend' },
            ...remeasuredRows,
        ];
        await act(async () => {
            root.render(render(remeasuredRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        // Anchor to the real rows, not MVCP's temporary overflow padding.
        const prependedTailOffset = remeasuredRows.reduce((sum, row) => sum + row.height, 0) - viewportHeight;
        const prependBoundaryDistances = [Math.abs(prependedTailOffset - scrollElement.scrollTop)];
        for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift()!;
            await act(async () => {
                nextFrame.callback(Date.now());
                await Promise.resolve();
            });
            prependBoundaryDistances.push(Math.abs(prependedTailOffset - scrollElement.scrollTop));
        }
        expect(
            Math.max(...prependBoundaryDistances),
            `Pinned history insertion must not expose new geometry at the old scroll offset: ${JSON.stringify({ prependBoundaryDistances, writes: physicalScrollWrites.map(write => ({ top: write.top, stack: write.stack.split('\n').slice(0, 7) })) })}`,
        ).toBeLessThanOrEqual(1);

        semanticEnd = false;
        const detachedScrollTop = Math.max(
            0,
            scrollElement.scrollHeight - scrollElement.clientHeight - 6_000,
        );
        await act(async () => {
            (scrollElement as HTMLElement & { __scrollTop?: number }).__scrollTop = detachedScrollTop;
            scrollElement.dispatchEvent(new Event('scroll'));
            await Promise.resolve();
        });
        expect(distanceFromLiveTail(scrollElement)).toBeGreaterThan(1_000);

        const detachedStateBefore = listRef.current!.getState();
        const detachedAnchorIndex = detachedStateBefore.start;
        const detachedBeforeAnchorIndex = detachedAnchorIndex - 1;
        const detachedAfterAnchorIndex = detachedAnchorIndex + 1;
        expect({
            mountedAfterAnchor: detachedStateBefore.elementAtIndex(detachedAfterAnchorIndex) != null,
            mountedBeforeAnchor: detachedStateBefore.elementAtIndex(detachedBeforeAnchorIndex) != null,
        }).toEqual({
            mountedAfterAnchor: true,
            mountedBeforeAnchor: true,
        });
        const detachedAnchorTopBefore = detachedStateBefore.positionAtIndex(detachedAnchorIndex)
            - scrollElement.scrollTop;
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        const detachedRemeasuredRows = remeasuredRows.map((row, index) => {
            if (index === detachedBeforeAnchorIndex) return { ...row, height: row.height - 100 };
            if (index === detachedAfterAnchorIndex) return { ...row, height: row.height + 100 };
            return row;
        });
        await act(async () => {
            root.render(render(detachedRemeasuredRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift()!;
            await act(async () => {
                nextFrame.callback(Date.now());
                await Promise.resolve();
            });
        }
        const detachedMVCPWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
            || write.stack.includes('scrollAdjustBy')
        ));
        const detachedAnchorTopAfter = listRef.current!.getState().positionAtIndex(detachedAnchorIndex)
            - scrollElement.scrollTop;
        expect(detachedMVCPWrites.length).toBeGreaterThan(0);
        expect(Math.abs(detachedAnchorTopAfter - detachedAnchorTopBefore)).toBeLessThanOrEqual(1);

        const detachedAnchorId = detachedRemeasuredRows[detachedAnchorIndex]!.id;
        const prependedRows = [
            { height: 360, id: 'semantic-mvcp-prepend-a' },
            { height: 240, id: 'semantic-mvcp-prepend-b' },
            ...detachedRemeasuredRows,
        ];
        const keyedAnchorTopBefore = listRef.current!.getState().positionByKey(detachedAnchorId)!
            - scrollElement.scrollTop;
        physicalScrollWrites.length = 0;
        await act(async () => {
            root.render(render(prependedRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift()!;
            await act(async () => {
                nextFrame.callback(Date.now());
                await Promise.resolve();
            });
        }
        const keyedAnchorTopAfter = listRef.current!.getState().positionByKey(detachedAnchorId)!
            - scrollElement.scrollTop;
        const prependMVCPWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
            || write.stack.includes('scrollAdjustBy')
        ));
        expect(prependMVCPWrites.length).toBeGreaterThan(0);
        expect(Math.abs(keyedAnchorTopAfter - keyedAnchorTopBefore)).toBeLessThanOrEqual(1);
    });

    it('preserves explicit index ownership through MVCP when end maintenance is disabled', async () => {
        const listRef = React.createRef<LegendListRef>();
        viewportHeight = 2_400;
        const targetIndex = 10;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 1_200,
            id: `explicit-mvcp-control-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="real-legend-host" style={{ height: viewportHeight }}>
                <LegendList
                    data={data}
                    estimatedItemSize={1_200}
                    getItemType={() => 'message'}
                    keyExtractor={(item: Row) => item.id}
                    maintainScrollAtEnd={false}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();

        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
            stack: string;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({
                callback,
                id,
                stack: new Error('scheduled explicit-target MVCP frame').stack ?? '',
            });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });

        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: targetIndex,
                viewPosition: 0,
            });
        });
        const scrollElement = findScrollElement();
        const targetTopBefore = listRef.current!.getState().positionAtIndex(targetIndex)
            - scrollElement.scrollTop;
        expect(Math.abs(targetTopBefore)).toBeLessThanOrEqual(1);
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;

        const remeasuredRows = initialRows.map((row, index) => {
            if (index === targetIndex - 1) return { ...row, height: row.height + 300 };
            if (index === targetIndex + 1) return { ...row, height: row.height - 300 };
            return row;
        });
        await act(async () => {
            root.render(render(remeasuredRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift()!;
            await act(async () => {
                nextFrame.callback(Date.now());
                await Promise.resolve();
            });
        }

        const explicitTargetMVCPWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
            || write.stack.includes('scrollAdjustBy')
        ));
        const targetTopAfter = listRef.current!.getState().positionAtIndex(targetIndex)
            - scrollElement.scrollTop;
        expect(explicitTargetMVCPWrites.length).toBeGreaterThan(0);
        expect(Math.abs(targetTopAfter - targetTopBefore)).toBeLessThanOrEqual(1);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('holds a detached reader through expansion, above-viewport growth, and item replacement', async () => {
        // THE DISCRIMINATING MEASUREMENT for the app-level stabilization hold. It decided the
        // deletion of the WEB arm of `armVisibleAnchorHold`; the NATIVE arm survives and is
        // NOT covered here — native MVCP is open-loop and nothing in this file measures it.
        //
        // Its whole justification is `types.ts` / `rowLayoutMutationViewportOwnership.ts`:
        // "Legend MVCP demonstrably re-anchors its mounted window across the expansion item
        // replacement (live S-C, web + native 2026-07-11)". That capture was taken on
        // `@legendapp/list` 2.0.0-beta.3; the package moved to 3.3.3 in `be54fc371`
        // (2026-07-27), whose 3.1.0 entry adds the MVCP anchor lock aimed at exactly this
        // class ("keeps the intended anchor when headers change, browser scroll anchoring
        // runs..."). The two neighbouring cases (above-anchor remeasure, 600px prepend) are
        // already proven on 3.3.3 by `keeps nonanimated semantic end maintenance pinned
        // through each MVCP remeasurement boundary`; expansion was the one row with no
        // current-version evidence, so it decided whether the arm site could be removed.
        //
        // Three phases, all against a BARE `<LegendList>` with the transcript's own MVCP
        // props and no adapter: (1) the expanding row is the reader's top row, (2) a row
        // fully above the viewport grows, (3) a mounted row is REPLACED by a different KEY at
        // a larger height — the identity change that "re-anchors its mounted window" names.
        //
        // Basis: jsdom + the installed 3.3.3 package, not a live browser. It is current-version
        // evidence about the LIBRARY's compensation arithmetic, and it does not stand in for a
        // live capture of compositor/scroll-anchoring behaviour.
        const listRef = React.createRef<LegendListRef>();
        viewportHeight = 2_400;
        const readerIndex = 10;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 1_200,
            id: `expansion-mvcp-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="real-legend-host" style={{ height: viewportHeight }}>
                <LegendList
                    data={data}
                    estimatedItemSize={1_200}
                    getItemType={() => 'message'}
                    keyExtractor={(item: Row) => item.id}
                    maintainScrollAtEnd={false}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();

        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
            stack: string;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({
                callback,
                id,
                stack: new Error('scheduled expansion MVCP frame').stack ?? '',
            });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });

        act(() => {
            listRef.current?.scrollToIndex({ animated: false, index: readerIndex, viewPosition: 0 });
        });
        const scrollElement = findScrollElement();
        const drainScheduledFrames = async (): Promise<void> => {
            for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
                const nextFrame = scheduledFrames.shift()!;
                await act(async () => {
                    nextFrame.callback(Date.now());
                    await Promise.resolve();
                });
            }
        };
        const readerId = initialRows[readerIndex]!.id;
        const readerTop = (): number => (
            listRef.current!.getState().positionByKey(readerId)! - scrollElement.scrollTop
        );
        expect(Math.abs(readerTop())).toBeLessThanOrEqual(1);

        // (1) The reader's OWN top row expands 1200 -> 3600. Its top must not move: the row
        // grows downward, the reader keeps looking at the same line of content.
        const inViewportExpandedRows = initialRows.map((row, index) => (
            index === readerIndex ? { ...row, height: 3_600 } : row
        ));
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        await act(async () => {
            root.render(render(inViewportExpandedRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        await drainScheduledFrames();
        const inViewportExpansionDriftPx = readerTop();
        expect(
            Math.abs(inViewportExpansionDriftPx),
            `Legend MVCP moved the expanding row itself: ${JSON.stringify({
                inViewportExpansionDriftPx,
                scrollTop: scrollElement.scrollTop,
            })}`,
        ).toBeLessThanOrEqual(1);

        // (2) A row FULLY ABOVE the viewport grows 1200 -> 4_800. MVCP must absorb the whole
        // +3600 so the reader does not move.
        const aboveIndex = readerIndex - 4;
        const aboveGrownRows = inViewportExpandedRows.map((row, index) => (
            index === aboveIndex ? { ...row, height: 4_800 } : row
        ));
        const readerTopBeforeAboveGrowth = readerTop();
        physicalScrollWrites.length = 0;
        await act(async () => {
            root.render(render(aboveGrownRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        await drainScheduledFrames();
        const aboveGrowthMVCPWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
            || write.stack.includes('scrollAdjustBy')
        ));
        const aboveGrowthDriftPx = readerTop() - readerTopBeforeAboveGrowth;
        expect(aboveGrowthMVCPWrites.length).toBeGreaterThan(0);
        expect(
            Math.abs(aboveGrowthDriftPx),
            `Legend MVCP did not absorb an above-viewport expansion: ${JSON.stringify({
                aboveGrowthDriftPx,
                mvcpWrites: aboveGrowthMVCPWrites.map((write) => write.top),
            })}`,
        ).toBeLessThanOrEqual(1);

        // (3) ITEM REPLACEMENT in the viewport: the reader's own top row is swapped for a
        // DIFFERENT KEY at a much larger height — the identity change S-C attributed the
        // re-anchoring to, and the only shape the transcript's expansion toggle actually
        // produces (an unmounted row cannot be re-measured at all, so replacing one above the
        // window changes nothing: measured, positions and scroll both unmoved).
        //
        // The correct outcome is that the reader's scroll offset does NOT move: the replaced
        // row starts where the old one did, so the content the reader is looking at is
        // unchanged and everything below it shifts down by the growth. A re-anchor onto a
        // different mounted row would scroll the viewport instead.
        const replacementIndex = readerIndex;
        const followerId = aboveGrownRows[readerIndex + 1]!.id;
        const replacementGrowthPx = 2_400;
        const replacedRows = aboveGrownRows.map((row, index) => (
            index === replacementIndex
                ? { height: row.height + replacementGrowthPx, id: `${row.id}#expanded` }
                : row
        ));
        const scrollTopBeforeReplacement = scrollElement.scrollTop;
        const followerTopBefore = listRef.current!.getState().positionByKey(followerId)!
            - scrollElement.scrollTop;
        physicalScrollWrites.length = 0;
        await act(async () => {
            root.render(render(replacedRows));
            flushResizeObservers();
            await Promise.resolve();
        });
        await drainScheduledFrames();
        const replacementScrollShiftPx = scrollElement.scrollTop - scrollTopBeforeReplacement;
        const followerShiftPx = (
            listRef.current!.getState().positionByKey(followerId)! - scrollElement.scrollTop
        ) - followerTopBefore;
        expect(
            Math.abs(replacementScrollShiftPx),
            `Legend MVCP re-anchored the viewport across an in-viewport item replacement: ${JSON.stringify({
                followerShiftPx,
                replacementScrollShiftPx,
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(
            Math.abs(followerShiftPx - replacementGrowthPx),
            `the row below the replaced row did not follow its growth: ${JSON.stringify({
                followerShiftPx,
                replacementGrowthPx,
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('lands the live tail after a detached entry reconciles offscreen row geometry', async () => {
        const listRef = React.createRef<LegendListRef>();
        deliverBrowserScrollEventsAsynchronously();
        let isMaintainingScrollAtEnd = false;
        let widthVersion = 'entry-width';
        const data = Array.from({ length: 20 }, (_value, index): Row => ({
            height: index === 10 ? 10_000 : 80,
            id: `detached-tail-landing-${index}`,
        }));

        await act(async () => {
            root.render(
                <div id="real-legend-host" style={{ height: viewportHeight }}>
                    <LegendList
                        data={data}
                        estimatedItemSize={120}
                        getEstimatedItemSize={(item: Row) => item.height === 10_000 ? item.height : 120}
                        getItemSizeVersion={() => widthVersion}
                        keyExtractor={(item: Row) => item.id}
                        maintainScrollAtEnd={{
                            animated: false,
                            isMaintainingScrollAtEnd: () => isMaintainingScrollAtEnd,
                        }}
                        maintainVisibleContentPosition={{ data: true, size: true }}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        expect(listRef.current!.getState().sizes.get(data[0]!.id)).toBe(80);
        act(() => {
            void listRef.current!.scrollToIndex({ index: 10, viewOffset: -5_000, animated: false });
        });
        await flushLegendWork();

        const element = findScrollElement();
        expect(distanceFromLiveTail(element)).toBeGreaterThan(viewportHeight);
        // The live width becomes known after entry. Offscreen measurements still
        // carry the previous width until Legend revisits them while settling the jump.
        widthVersion = 'measured-width';
        isMaintainingScrollAtEnd = true;
        let landed = false;
        act(() => {
            void listRef.current!.scrollToEnd({ animated: false }).then(() => { landed = true; });
        });
        await flushLegendWork();

        expect(landed).toBe(true);
        expect(distanceFromLiveTail(element)).toBeLessThanOrEqual(1);
        expect(listRef.current!.getState().scroll).toBe(element.scrollTop);
    });

    it('lands a semantic held-end scrollToEnd before its promise resolves', async () => {
        const listRef = React.createRef<LegendListRef>();
        let isMaintainingScrollAtEnd = false;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 120,
            id: `semantic-scroll-to-end-${index}`,
        }));

        await act(async () => {
            root.render(
                <div id="real-legend-host" style={{ height: 600 }}>
                    <LegendList
                        data={initialRows}
                        estimatedItemSize={120}
                        initialScrollAtEnd
                        keyExtractor={(item: Row) => item.id}
                        maintainScrollAtEnd={{
                            animated: false,
                            isMaintainingScrollAtEnd: () => isMaintainingScrollAtEnd,
                        }}
                        maintainScrollAtEndThreshold={0.1}
                        maintainVisibleContentPosition={false}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const scrollElement = findScrollElement() as HTMLElement & { __scrollTop?: number };
        scrollElement.__scrollTop = Math.max(
            0,
            scrollElement.scrollHeight - scrollElement.clientHeight - 800,
        );
        scrollElement.dispatchEvent(new Event('scroll'));
        await flushLegendWork();
        expect(listRef.current?.getState().isWithinMaintainScrollAtEndThreshold).toBe(false);

        isMaintainingScrollAtEnd = true;
        let command!: Promise<void>;
        act(() => {
            command = listRef.current!.scrollToEnd({ animated: false });
        });

        let distanceAtResolution: number | undefined;
        const observeResolution = async () => {
            await command;
            distanceAtResolution = distanceFromLiveTail(scrollElement);
        };
        const resolution = observeResolution();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
            await resolution;
        });

        expect(distanceFromLiveTail(scrollElement)).toBeLessThanOrEqual(1);
        expect(distanceAtResolution).toBeLessThanOrEqual(1);
    });

    it('uses the current item-size version estimate for an offscreen measured key without invalidating another key', async () => {
        const listRef = React.createRef<LegendListRef>();
        const targetIndex = 20;
        const initialRows = Array.from({ length: 50 }, (_value, index): SizeVersionRow => ({
            estimatedHeight: index === 1 ? 140 : 100,
            height: index === 1 ? 140 : 100,
            id: `size-version-${index}`,
            sizeVersion: 'v1',
        }));
        const render = (data: readonly SizeVersionRow[]) => (
            <div id="real-legend-host" style={{ height: 600 }}>
                <LegendList
                    data={data}
                    drawDistance={0}
                    estimatedItemSize={100}
                    getEstimatedItemSize={(item) => item.estimatedHeight}
                    getItemSizeVersion={(item) => item.sizeVersion}
                    keyExtractor={(item) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderSizeVersionRow}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();
        expect(listRef.current?.getState().sizes.get(initialRows[0]!.id)).toBe(100);
        expect(listRef.current?.getState().sizes.get(initialRows[1]!.id)).toBe(140);

        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: 30,
                viewPosition: 0,
            });
        });
        await flushLegendWork();
        expect(document.querySelector(`[data-testid="real-legend-row-${initialRows[0]!.id}"]`)).toBeNull();
        expect(document.querySelector(`[data-testid="real-legend-row-${initialRows[1]!.id}"]`)).toBeNull();

        const revisedRows = initialRows.map((row, index): SizeVersionRow => {
            if (index === 0) {
                return {
                    ...row,
                    estimatedHeight: 500,
                    height: 500,
                    sizeVersion: 'v2',
                };
            }
            if (index === 1) {
                return {
                    ...row,
                    estimatedHeight: 900,
                };
            }
            return row;
        });
        await act(async () => {
            root.render(render(revisedRows));
        });
        await flushLegendWork();
        expect(document.querySelector(`[data-testid="real-legend-row-${initialRows[0]!.id}"]`)).toBeNull();

        physicalScrollWrites.length = 0;
        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: targetIndex,
                viewPosition: 0,
            });
        });
        await flushLegendWork();

        const expectedTargetOffset = 500 + 140 + ((targetIndex - 2) * 100);
        const state = listRef.current!.getState();
        expect(state.positionAtIndex(targetIndex)).toBe(expectedTargetOffset);
        expect(findScrollElement().scrollTop).toBe(expectedTargetOffset);
        expect(state.sizes.has(initialRows[0]!.id)).toBe(false);
        expect(state.sizes.get(initialRows[1]!.id)).toBe(140);
        expect(physicalScrollWrites.some((write) => (
            classifyLegendPhysicalWrite(write) === 'imperative-index'
            && write.top === expectedTargetOffset
        ))).toBe(true);
    });

    it.each([
        { headHeight: 175, headerHeight: 32, change: 'shrinking rows above the stale anchor' },
        { headHeight: 262, headerHeight: 133, change: 'growing a row in the physical viewport' },
    ])('preserves physical user scroll progress when measurements precede its scroll event: $change', async ({ headHeight, headerHeight }) => {
        viewportHeight = 258;
        const data: Row[] = [262, 33, 28, 34, 5_731].map((height, index) => ({
            height,
            id: `user-progress-${index}`,
        }));
        const listRef = React.createRef<LegendListRef>();
        await act(async () => {
            root.render(
                <div id="real-legend-host" style={{ height: viewportHeight }}>
                    <LegendList
                        data={data}
                        drawDistance={1_000}
                        estimatedItemSize={262}
                        keyExtractor={(item) => item.id}
                        maintainVisibleContentPosition={{ data: true, size: true }}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                    />
                </div>,
            );
        });
        await flushLegendWork();
        const scroller = findScrollElement();
        await act(async () => {
            scroller.scrollTo({ top: 452 });
            await vi.runOnlyPendingTimersAsync();
        });
        await flushLegendWork();
        expect(scroller.scrollTop).toBe(452);

        deliverBrowserScrollEventsAsynchronously();
        // The browser advances a smooth user gesture before its next scroll event.
        // ResizeObserver can deliver the newly visible row geometry in that gap.
        scroller.scrollTop = 78;
        scroller.dispatchEvent(new Event('scroll'));
        const head = container.querySelector<HTMLElement>('[data-testid="real-legend-row-user-progress-0"]');
        const header = container.querySelector<HTMLElement>('[data-testid="real-legend-row-user-progress-1"]');
        expect(head).not.toBeNull();
        expect(header).not.toBeNull();
        head!.dataset.height = String(headHeight);
        header!.dataset.height = String(headerHeight);
        physicalScrollWrites.length = 0;
        act(() => flushResizeObservers());
        expect(Math.max(scroller.scrollTop, ...physicalScrollWrites.map((write) => write.top))).toBeLessThanOrEqual(78);
        expect(scroller.scrollTop).toBeLessThanOrEqual(78);

        await act(async () => {
            scroller.scrollTop = 0;
            scroller.dispatchEvent(new Event('scroll'));
            await vi.runOnlyPendingTimersAsync();
        });
        await flushLegendWork();
        expect(scroller.scrollTop).toBe(0);
    });

    it('preserves a surviving cached visible key when data shrinks before its scroll event', async () => {
        viewportHeight = 258;
        const data: Row[] = [262, 33, 28, 34, 5_731].map((height, index) => ({
            height,
            id: `shrinking-reader-${index}`,
        }));
        const render = (items: readonly Row[]) => (
            <div id="real-legend-host" style={{ height: viewportHeight }}>
                <LegendList
                    data={items}
                    drawDistance={1_000}
                    estimatedItemSize={262}
                    keyExtractor={(item) => item.id}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    renderItem={renderRow}
                />
            </div>
        );
        await act(async () => root.render(render(data)));
        await flushLegendWork();
        const scroller = findScrollElement();
        await act(async () => {
            scroller.scrollTo({ top: 600 });
            await vi.runOnlyPendingTimersAsync();
        });
        await flushLegendWork();
        expect(scroller.scrollTop).toBe(600);

        deliverBrowserScrollEventsAsynchronously();
        scroller.scrollTop = 452;
        scroller.dispatchEvent(new Event('scroll'));
        await act(async () => root.render(render([data[4]!])));
        // The surviving row began at 357, so the user's physical reading offset
        // inside that row is 452 - 357, regardless of the pending scroll event.
        expect(scroller.scrollTop).toBe(95);
        await flushLegendWork();
        expect(scroller.scrollTop).toBe(95);
    });

    it('retains an offscreen known size while its item-size version is unchanged', async () => {
        const listRef = React.createRef<LegendListRef>();
        const targetIndex = 20;
        const initialRows = Array.from({ length: 50 }, (_value, index): SizeVersionRow => ({
            estimatedHeight: 100,
            height: 100,
            id: `same-size-version-${index}`,
            sizeVersion: 'v1',
        }));
        const render = (data: readonly SizeVersionRow[]) => (
            <div id="real-legend-host" style={{ height: 600 }}>
                <LegendList
                    data={data}
                    drawDistance={0}
                    estimatedItemSize={100}
                    getEstimatedItemSize={(item) => item.estimatedHeight}
                    getItemSizeVersion={(item) => item.sizeVersion}
                    keyExtractor={(item) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderSizeVersionRow}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows));
        });
        await flushLegendWork();
        expect(listRef.current?.getState().sizes.get(initialRows[0]!.id)).toBe(100);

        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: 30,
                viewPosition: 0,
            });
        });
        await flushLegendWork();

        const unchangedRevisionRows = initialRows.map((row, index): SizeVersionRow => (
            index === 0
                ? { ...row, estimatedHeight: 500 }
                : row
        ));
        await act(async () => {
            root.render(render(unchangedRevisionRows));
        });
        await flushLegendWork();
        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: targetIndex,
                viewPosition: 0,
            });
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        expect(state.positionAtIndex(targetIndex)).toBe(targetIndex * 100);
        expect(state.sizes.get(initialRows[0]!.id)).toBe(100);
    });

    it('uses current item estimates after global size-cache clear and keyed session reset', async () => {
        const listRef = React.createRef<LegendListRef>();
        const targetIndex = 20;
        const initialRows = Array.from({ length: 50 }, (_value, index): SizeVersionRow => ({
            estimatedHeight: 100,
            height: 100,
            id: `reset-size-version-${index}`,
            sizeVersion: 'v1',
        }));
        const render = (data: readonly SizeVersionRow[], sessionKey: string) => (
            <div id="real-legend-host" style={{ height: 600 }}>
                <LegendList
                    key={sessionKey}
                    data={data}
                    drawDistance={0}
                    estimatedItemSize={100}
                    getEstimatedItemSize={(item) => item.estimatedHeight}
                    getItemSizeVersion={(item) => item.sizeVersion}
                    keyExtractor={(item) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderSizeVersionRow}
                />
            </div>
        );

        await act(async () => {
            root.render(render(initialRows, 'session-v1'));
        });
        await flushLegendWork();
        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: 30,
                viewPosition: 0,
            });
        });
        await flushLegendWork();
        act(() => {
            listRef.current?.clearCaches({ mode: 'sizes' });
        });

        const globallyResetRows = initialRows.map((row, index): SizeVersionRow => (
            index === 0
                ? { ...row, estimatedHeight: 500, height: 500, sizeVersion: 'v2' }
                : row
        ));
        await act(async () => {
            root.render(render(globallyResetRows, 'session-v1'));
        });
        await flushLegendWork();
        expect(listRef.current?.getState().positionAtIndex(targetIndex)).toBe(
            500 + ((targetIndex - 1) * 100),
        );

        const sessionResetRows = globallyResetRows.map((row, index): SizeVersionRow => (
            index === 0
                ? { ...row, estimatedHeight: 700, height: 700, sizeVersion: 'v3' }
                : row
        ));
        await act(async () => {
            root.render(render(sessionResetRows, 'session-v2'));
        });
        await flushLegendWork();
        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                index: targetIndex,
                viewPosition: 0,
            });
        });
        await flushLegendWork();
        expect(listRef.current?.getState().positionAtIndex(targetIndex)).toBe(
            700 + ((targetIndex - 1) * 100),
        );
    });

    it('excludes Legend steady maintenance from a keyed web landing phase', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const observation = createWebDomScrollObservation();
        const initialRows = rows(20, 'phase');
        const render = (data: readonly Row[] = initialRows) => (
            <Renderer
                data={data}
                dataKey="phase-owner-session"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={renderRow}
                webDomObservation={observation}
            />
        );
        await act(async () => {
            root.render(render());
        });
        await flushLegendWork();
        const scrollElement = findScrollElement();
        scrollElement.scrollTo({
            top: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
        });
        await flushLegendWork();

        act(() => {
            listRef.current?.scrollToIndex?.({ animated: false, index: 19, viewPosition: 1 });
        });
        await flushLegendWork();
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;
        viewportHeight = 620;
        await flushLegendWork();
        expect(readDiagnostics().physicalWrites.filter(
            (write) => write.writer === 'legend-maintain',
        )).toHaveLength(0);

        let releaseFirstJump: (() => void) | undefined;
        let releaseSecondJump: (() => void) | undefined;
        act(() => {
            releaseFirstJump = listRef.current?.beginExplicitJumpTakeover?.(Symbol('first-real-web-jump'));
            releaseSecondJump = listRef.current?.beginExplicitJumpTakeover?.(Symbol('second-real-web-jump'));
        });
        act(() => releaseFirstJump?.());
        readDiagnostics().physicalWrites.length = 0;
        readDiagnostics().writes.length = 0;
        await act(async () => {
            root.render(render([...initialRows, { height: 180, id: 'phase-after-stale-release' }]));
        });
        await flushLegendWork();
        // The row may remain outside 3.3.3's tighter mounted range while explicit takeover
        // suppresses end maintenance; the ownership contract is the absence of a write, not
        // incidental DOM materialization.
        expect(listRef.current).not.toBeNull();
        expect(readDiagnostics().physicalWrites.filter(
            (write) => write.writer === 'legend-maintain',
        )).toHaveLength(0);
        expect(readDiagnostics().writes).toHaveLength(0);
        act(() => releaseSecondJump?.());
    });

    it('keeps the latest nonanimated imperative request pending until its own completion deadline', async () => {
        const directContainer = document.createElement('div');
        directContainer.style.height = '600px';
        document.body.appendChild(directContainer);
        const directRoot = createRoot(directContainer);
        const listRef = React.createRef<LegendListRef>();
        let firstSettled = false;
        let secondSettled = false;

        try {
            await act(async () => {
                directRoot.render(
                    <LegendList
                        data={rows(40, 'web-overlap')}
                        estimatedItemSize={240}
                        keyExtractor={(item: Row) => item.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                    />,
                );
            });
            await flushLegendWork();
            physicalScrollWrites.length = 0;

            expect(listRef.current).not.toBeNull();
            const directScrollElement = listRef.current!.getScrollableNode() as HTMLElement;
            expect(directScrollElement).toBeInstanceOf(HTMLElement);
            vi.spyOn(directScrollElement, 'dispatchEvent').mockImplementation(() => true);
            vi.stubGlobal('requestAnimationFrame', () => 0);
            vi.stubGlobal('cancelAnimationFrame', () => {});

            let firstResult!: Promise<void>;
            act(() => {
                firstResult = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 4,
                    viewPosition: 0,
                });
            });
            void firstResult.then(() => {
                firstSettled = true;
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(40);
            });
            expect(firstSettled).toBe(false);

            let secondResult!: Promise<void>;
            act(() => {
                secondResult = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 32,
                    viewPosition: 0,
                });
            });
            void secondResult.then(() => {
                secondSettled = true;
            });
            await act(async () => {
                await Promise.resolve();
            });

            expect(firstSettled).toBe(true);
            expect(secondSettled).toBe(false);
            expect(physicalScrollWrites.filter(
                (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
            )).toHaveLength(2);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(59);
            });
            expect(secondSettled).toBe(false);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(1);
            });
            expect(secondSettled).toBe(false);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(39);
            });
            expect(secondSettled).toBe(false);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(1);
            });
            expect(secondSettled).toBe(true);
        } finally {
            await act(async () => {
                directRoot.unmount();
            });
            directContainer.remove();
        }
    });

    it('settles an ordinary nonanimated imperative request at its own completion deadline', async () => {
        const directContainer = document.createElement('div');
        directContainer.style.height = '600px';
        document.body.appendChild(directContainer);
        const directRoot = createRoot(directContainer);
        const listRef = React.createRef<LegendListRef>();
        let settled = false;

        try {
            await act(async () => {
                directRoot.render(
                    <LegendList
                        data={rows(40, 'web-ordinary-completion')}
                        estimatedItemSize={240}
                        keyExtractor={(item: Row) => item.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                    />,
                );
            });
            await flushLegendWork();
            physicalScrollWrites.length = 0;

            expect(listRef.current).not.toBeNull();
            const directScrollElement = listRef.current!.getScrollableNode() as HTMLElement;
            vi.spyOn(directScrollElement, 'dispatchEvent').mockImplementation(() => true);
            vi.stubGlobal('requestAnimationFrame', () => 0);
            vi.stubGlobal('cancelAnimationFrame', () => {});

            let result!: Promise<void>;
            act(() => {
                result = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 12,
                    viewPosition: 0,
                });
            });
            void result.then(() => {
                settled = true;
            });

            expect(physicalScrollWrites.filter(
                (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
            )).toHaveLength(1);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(99);
            });
            expect(settled).toBe(false);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(1);
            });
            expect(settled).toBe(true);
        } finally {
            await act(async () => {
                directRoot.unmount();
            });
            directContainer.remove();
        }
    });

    it('keeps a dispatched completion alive when a newer imperative request is a no-op', async () => {
        const directContainer = document.createElement('div');
        directContainer.style.height = '600px';
        document.body.appendChild(directContainer);
        const directRoot = createRoot(directContainer);
        const listRef = React.createRef<LegendListRef>();
        let firstSettled = false;
        let noOpSettled = false;

        try {
            await act(async () => {
                directRoot.render(
                    <LegendList
                        data={rows(40, 'web-no-op-successor')}
                        estimatedItemSize={240}
                        keyExtractor={(item: Row) => item.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                    />,
                );
            });
            await flushLegendWork();
            physicalScrollWrites.length = 0;

            expect(listRef.current).not.toBeNull();
            const directScrollElement = listRef.current!.getScrollableNode() as HTMLElement;
            vi.spyOn(directScrollElement, 'dispatchEvent').mockImplementation(() => true);
            vi.stubGlobal('requestAnimationFrame', () => 0);
            vi.stubGlobal('cancelAnimationFrame', () => {});

            let firstResult!: Promise<void>;
            act(() => {
                firstResult = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 10,
                    viewPosition: 0,
                });
            });
            void firstResult.then(() => {
                firstSettled = true;
            });
            const timersAfterFirstDispatch = vi.getTimerCount();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(40);
            });
            expect(firstSettled).toBe(false);

            let noOpResult!: Promise<void>;
            act(() => {
                noOpResult = listRef.current!.scrollToItem({
                    animated: false,
                    item: { height: 72, id: 'not-in-data' },
                    viewPosition: 0,
                });
            });
            void noOpResult.then(() => {
                noOpSettled = true;
            });
            await act(async () => {
                await Promise.resolve();
            });

            expect({
                firstSettled,
                noOpSettled,
                physicalDispatches: physicalScrollWrites.filter(
                    (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
                ).length,
                timersAfterNoOp: vi.getTimerCount(),
            }).toEqual({
                firstSettled: true,
                noOpSettled: true,
                physicalDispatches: 1,
                timersAfterNoOp: timersAfterFirstDispatch,
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60);
            });
            expect(physicalScrollWrites.filter(
                (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
            )).toHaveLength(1);
        } finally {
            await act(async () => {
                directRoot.unmount();
            });
            directContainer.remove();
        }
    });

    it('keeps a dispatched completion alive while a newer request waits for readiness', async () => {
        const directContainer = document.createElement('div');
        directContainer.style.height = '600px';
        document.body.appendChild(directContainer);
        const directRoot = createRoot(directContainer);
        const listRef = React.createRef<LegendListRef>();
        let firstSettled = false;
        let delayedSettled = false;

        try {
            await act(async () => {
                directRoot.render(
                    <LegendList
                        data={rows(40, 'web-delayed-successor')}
                        estimatedItemSize={240}
                        keyExtractor={(item: Row) => item.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                    />,
                );
            });
            await flushLegendWork();
            physicalScrollWrites.length = 0;

            expect(listRef.current).not.toBeNull();
            const directScrollElement = listRef.current!.getScrollableNode() as HTMLElement;
            vi.spyOn(directScrollElement, 'dispatchEvent').mockImplementation(() => true);
            vi.stubGlobal('requestAnimationFrame', () => 0);
            vi.stubGlobal('cancelAnimationFrame', () => {});

            let firstResult!: Promise<void>;
            act(() => {
                firstResult = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 10,
                    viewPosition: 0,
                });
            });
            void firstResult.then(() => {
                firstSettled = true;
            });
            const timersAfterFirstDispatch = vi.getTimerCount();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(40);
            });

            let delayedResult!: Promise<void>;
            act(() => {
                delayedResult = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 99,
                    viewPosition: 0,
                });
            });
            void delayedResult.then(() => {
                delayedSettled = true;
            });
            await act(async () => {
                await Promise.resolve();
            });

            expect({
                delayedSettled,
                firstSettled,
                physicalDispatches: physicalScrollWrites.filter(
                    (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
                ).length,
                timersAfterDelayedStart: vi.getTimerCount(),
            }).toEqual({
                delayedSettled: false,
                firstSettled: true,
                physicalDispatches: 1,
                timersAfterDelayedStart: timersAfterFirstDispatch,
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60);
            });
            expect({
                delayedSettled,
                physicalDispatches: physicalScrollWrites.filter(
                    (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
                ).length,
            }).toEqual({
                delayedSettled: false,
                physicalDispatches: 1,
            });
        } finally {
            await act(async () => {
                directRoot.unmount();
            });
            directContainer.remove();
        }
        await Promise.resolve();
        expect(delayedSettled).toBe(true);
    });

    it('cancels a dispatched nonanimated completion when the real list unmounts', async () => {
        const directContainer = document.createElement('div');
        directContainer.style.height = '600px';
        document.body.appendChild(directContainer);
        const directRoot = createRoot(directContainer);
        const listRef = React.createRef<LegendListRef>();
        let settled = false;
        let didUnmount = false;

        try {
            await act(async () => {
                directRoot.render(
                    <LegendList
                        data={rows(40, 'web-dispatched-cleanup')}
                        estimatedItemSize={240}
                        keyExtractor={(item: Row) => item.id}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={renderRow}
                    />,
                );
            });
            await flushLegendWork();
            physicalScrollWrites.length = 0;

            expect(listRef.current).not.toBeNull();
            const directScrollElement = listRef.current!.getScrollableNode() as HTMLElement;
            vi.spyOn(directScrollElement, 'dispatchEvent').mockImplementation(() => true);
            vi.stubGlobal('requestAnimationFrame', () => 0);
            vi.stubGlobal('cancelAnimationFrame', () => {});
            const baselineTimers = vi.getTimerCount();

            let result!: Promise<void>;
            act(() => {
                result = listRef.current!.scrollToIndex({
                    animated: false,
                    index: 14,
                    viewPosition: 0,
                });
            });
            void result.then(() => {
                settled = true;
            });
            expect(physicalScrollWrites.filter(
                (write) => classifyLegendPhysicalWrite(write) === 'imperative-index',
            )).toHaveLength(1);
            expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers);

            const writesBeforeUnmount = physicalScrollWrites.length;
            await act(async () => {
                directRoot.unmount();
            });
            didUnmount = true;
            await Promise.resolve();
            const timersAfterUnmount = vi.getTimerCount();
            await vi.runAllTimersAsync();

            expect({
                postUnmountWrites: physicalScrollWrites.length - writesBeforeUnmount,
                settled,
                timerLeak: Math.max(0, timersAfterUnmount - baselineTimers),
            }).toEqual({
                postUnmountWrites: 0,
                settled: true,
                timerLeak: 0,
            });
        } finally {
            if (!didUnmount) {
                await act(async () => {
                    directRoot.unmount();
                });
            }
            directContainer.remove();
        }
    });

    it('cancels a not-ready web imperative request before it can outlive unmount', async () => {
        const directContainer = document.createElement('div');
        directContainer.style.height = '600px';
        document.body.appendChild(directContainer);
        const directRoot = createRoot(directContainer);
        const listRef = React.createRef<LegendListRef>();
        let settled = false;

        await act(async () => {
            directRoot.render(
                <LegendList
                    data={rows(10, 'web-cleanup')}
                    estimatedItemSize={240}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                />,
            );
        });

        const baselineTimers = vi.getTimerCount();
        const result = listRef.current?.scrollToIndex({ animated: false, index: 99 });
        void result?.then(() => {
            settled = true;
        });
        const writesBeforeUnmount = physicalScrollWrites.length;
        expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers);

        await act(async () => {
            directRoot.unmount();
        });
        await Promise.resolve();
        const timersAfterUnmount = vi.getTimerCount();
        await vi.runAllTimersAsync();
        directContainer.remove();

        expect({
            postUnmountWrites: physicalScrollWrites.length - writesBeforeUnmount,
            settled,
            timerLeak: Math.max(0, timersAfterUnmount - baselineTimers),
        }).toEqual({
            postUnmountWrites: 0,
            settled: true,
            timerLeak: 0,
        });
    });

    // Open-path write convergence gate. A bottom-entry open must be placed by the library
    // alone: the app may not add a second placement writer to the window in which Legend's
    // own bootstrap is still resolving the tail offset. Counting is the whole point — a
    // "no writes after the reveal" assertion is satisfied by doing nothing and therefore
    // cannot distinguish one owner from two.
    it('places an asynchronously hydrated bottom-entry open with library writes only, never through the head', async () => {
        const Renderer = legendListRenderer.Component;
        const render = (data: readonly Row[]) => (
            <Renderer
                key="open-write-convergence"
                data={data}
                dataKey="open-write-convergence"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'real-legend-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={renderRow}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render([]));
        });
        await flushLegendWork();

        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        await act(async () => {
            root.render(render(rows(80, 'converge')));
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        const tailOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        expect(tailOffset).toBeGreaterThan(0);
        const census = physicalScrollWrites.map((write) => ({
            family: classifyLegendPhysicalWrite(write),
            top: write.top,
        }));
        const describeCensus = `open placement writes:\n${census
            .map((entry) => `${entry.family} -> ${entry.top}`)
            .join('\n')}`;

        expect({
            appPlacementWrites: census.filter((entry) => (
                entry.family === 'imperative-index' || entry.family === 'imperative-offset'
            )).length,
            landedAtTail: tailOffset - scrollElement.scrollTop <= 1,
            // Every write on a tail-entry open must move toward the tail. A placement write
            // resolved to offset 0 is the measured `scrollTop = 0` hold that Legend's own
            // bootstrap then teleports away from.
            writesThroughHead: census.filter((entry) => entry.top === 0).length,
        }, describeCensus).toEqual({
            appPlacementWrites: 0,
            landedAtTail: true,
            writesThroughHead: 0,
        });
        // Convergence count. Initial placement is ONE library transaction: Legend's bootstrap
        // dispatch, plus at most its own deferred at-end maintenance. Before this contract the
        // same open produced three writes from two owners, and the extra library dispatch was
        // Legend re-correcting the head offset the adapter had written.
        expect(census.filter((entry) => entry.family === 'initial'), describeCensus).toHaveLength(1);
        expect(census.length, describeCensus).toBeLessThanOrEqual(2);
        expect(directScrollTopWrites).toHaveLength(0);
    });
});
