// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resetTranscriptViewportDiagnosticsForTests } from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';
import type {
    TranscriptListShellRef,
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

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const resizeObservers = new Set<ResizeObserverRecord>();
let useMeasuredLegendGeometry = false;
type PhysicalScrollWrite = Readonly<{
    stack: string;
    top: number;
}>;
const physicalScrollWrites: PhysicalScrollWrite[] = [];
const directScrollTopWrites: PhysicalScrollWrite[] = [];
let scrollMethodActive = false;
let viewportHeight = 600;

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
    if (
        htmlElement.id === 'installed-pinned-host'
        || htmlElement.id === 'installed-entry-host'
        || htmlElement.style.overflowY === 'auto'
        || htmlElement.style.overflow === 'auto'
    ) {
        return rect(800, viewportHeight);
    }
    const row = htmlElement.querySelector<HTMLElement>('[data-height]');
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
            contentRect: useMeasuredLegendGeometry
                ? measuredRect(element)
                : rect(800, 600),
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

function distanceFromLiveTail(element: HTMLElement): number {
    return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

/**
 * Attribute a captured physical scroll write to the owner that issued it. Legend's own
 * bootstrap placement lands through `dispatchInitialScroll`/`advanceMeasuredInitialScroll`
 * and its at-end maintenance through `doMaintainScrollAtEnd`; an adapter-issued placement
 * request reaches the DOM synchronously through the library's imperative `scrollToIndex` /
 * `doScrollTo` entry points, so those frames are still on the stack.
 */
function classifyLegendPlacementWriteOwner(
    write: PhysicalScrollWrite,
): 'app' | 'library-initial' | 'library-maintain' | 'other' {
    if (write.stack.includes('doMaintainScrollAtEnd')) return 'library-maintain';
    if (
        write.stack.includes('dispatchInitialScroll')
        || write.stack.includes('advanceMeasuredInitialScroll')
    ) {
        return 'library-initial';
    }
    if (write.stack.includes('scrollToIndex') || write.stack.includes('doScrollTo')) return 'app';
    return 'other';
}

function findInstalledScrollElement(): HTMLElement {
    const element = document.getElementById('installed-pinned-host')
        ?.querySelector<HTMLElement>('[style*="overflow"]');
    if (!element) throw new Error('Installed Legend scroll element was unavailable');
    return element;
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

type ReactFiberWithRef = Readonly<{
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
    writes: unknown[];
} {
    return (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
        heldIntents: Array<{ event: string; intentId: string | null }>;
        writes: unknown[];
    };
}

describe('Legend installed web-package cleanup', () => {
    let container: HTMLDivElement;
    let root: Root;
    let physicalWrites = 0;

    beforeEach(() => {
        vi.useFakeTimers();
        physicalWrites = 0;
        useMeasuredLegendGeometry = false;
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        scrollMethodActive = false;
        viewportHeight = 600;
        resizeObservers.clear();
        container = document.createElement('div');
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
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
            function getBoundingClientRect(this: HTMLElement) {
                return useMeasuredLegendGeometry ? measuredRect(this) : rect(0, 0);
            },
        );
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get() {
                return useMeasuredLegendGeometry ? measuredRect(this).height : 600;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() {
                return useMeasuredLegendGeometry ? measuredRect(this).width : 800;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                if (!useMeasuredLegendGeometry) return 2_000;
                const element = this as HTMLElement;
                const rowsInElement = element.querySelectorAll<HTMLElement>('[data-height]');
                let materializedTotal = 0;
                for (const row of rowsInElement) {
                    materializedTotal += Number(row.dataset.height ?? 0);
                }
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        Number.parseFloat(descendant.style.height || '0') || 0,
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
                if (!useMeasuredLegendGeometry) {
                    element.__scrollTop = value;
                    return;
                }
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
                physicalWrites += 1;
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                physicalScrollWrites.push({
                    stack: new Error('real Legend physical scroll write').stack ?? '',
                    top,
                });
                scrollMethodActive = true;
                try {
                    this.scrollTop = top;
                } finally {
                    scrollMethodActive = false;
                }
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
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        localStorage.removeItem('happier.debug.viewportWrites');
        resetTranscriptViewportDiagnosticsForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('cancels preserved initial-end correction on user takeover while retaining the no-user correction', async () => {
        const listRef = React.createRef<LegendListRef>();
        useMeasuredLegendGeometry = true;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 120,
            id: `preserved-initial-end-${index}`,
        }));

        await act(async () => {
            root.render(
                <div id="installed-pinned-host" style={{ height: 600 }}>
                    <LegendList
                        data={initialRows}
                        estimatedItemSize={120}
                        initialScrollAtEnd
                        keyExtractor={(item: Row) => item.id}
                        maintainVisibleContentPosition={false}
                        recycleItems={false}
                        ref={listRef}
                        renderItem={({ item }: { item: Row }) => (
                            <div data-height={item.height} style={{ height: item.height }}>
                                {item.id}
                            </div>
                        )}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        const scrollElement = document.getElementById('installed-pinned-host')
            ?.querySelector<HTMLElement>('[style*="overflow"]') as
            | (HTMLElement & { __scrollTop?: number })
            | null;
        expect(scrollElement).not.toBeNull();
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);
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
        listRef.current!.cancelInitialScrollPreservation();

        scrollElement!.__scrollTop = Math.max(0, scrollElement!.scrollTop - 80);
        scrollElement!.dispatchEvent(new Event('scroll'));
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
        useMeasuredLegendGeometry = true;
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
            <div id="installed-pinned-host" style={{ height: viewportHeight }}>
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

        // Exercise every maintainScrollAtEnd trigger while bootstrap owns placement.
        viewportHeight = 640;
        await act(async () => {
            flushResizeObservers();
            await Promise.resolve();
        });
        const preTerminalMaintainWrites: PhysicalScrollWrite[] = [];
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        currentRows = [
            ...currentRows,
            { height: 1_440, id: 'initial-maintain-handoff-data' },
        ];
        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        const measuredRow = container.querySelector<HTMLElement>('[data-height]');
        expect(measuredRow).not.toBeNull();
        await act(async () => {
            measuredRow!.dataset.height = '1680';
            measuredRow!.style.height = '1680px';
            flushResizeObservers();
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

        footerHeight = 180;
        await act(async () => {
            root.render(render('initial-maintain-handoff'));
            flushResizeObservers();
            await Promise.resolve();
        });
        preTerminalMaintainWrites.push(...await drainMaintainFrames());

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

        // Leave one current-geometry request pending for the terminal handoff.
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
        expect(handoffFrames).toHaveLength(1);
        expect(handoffFrames[0]!.readyAtSchedule).toBe(true);
        const [handoffFrame] = handoffFrames;
        const handoffFrameIndex = scheduledFrames.findIndex((frame) => frame.id === handoffFrame!.id);
        scheduledFrames.splice(handoffFrameIndex, 1);
        const scrollElement = document.getElementById('installed-pinned-host')
            ?.querySelector<HTMLElement>('[style*="overflow"]');
        expect(scrollElement).not.toBeNull();
        const expectedHandoffTop = Math.max(
            0,
            scrollElement!.scrollHeight - scrollElement!.clientHeight,
        );
        physicalScrollWrites.length = 0;
        await act(async () => {
            handoffFrame!.callback(Date.now());
            await Promise.resolve();
        });
        expect(
            preTerminalMaintainWrites,
            'no maintain-family physical write may run while initial placement is live',
        ).toHaveLength(0);
        expect(
            physicalScrollWrites,
            'the terminal handoff must drain once at current geometry',
        ).toHaveLength(1);
        expect(physicalScrollWrites[0]!.top).toBe(expectedHandoffTop);

        unsubscribeReady();

        // A genuine takeover after terminal drains the request, but before its RAF lands,
        // cancels both placement and that not-yet-landed maintenance.
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
            listRef.current!.cancelInitialScrollPreservation();
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
                .map((write) => `${write.top}\n${write.stack}`)
                .join('\n---\n')}`,
        ).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
        unsubscribeTakeoverReady();
    });

    it('cancels a not-ready imperative request before it can outlive unmount', async () => {
        const listRef = React.createRef<LegendListRef>();
        let settled = false;

        await act(async () => {
            root.render(
                <LegendList
                    data={rows(10, 'row')}
                    estimatedItemSize={240}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <div>{item.id}</div>}
                />,
            );
        });

        const baselineTimers = vi.getTimerCount();
        let result: Promise<void> | undefined;
        act(() => {
            result = listRef.current?.scrollToIndex({ animated: false, index: 99 });
        });
        void result?.then(() => {
            settled = true;
        });
        const writesBeforeUnmount = physicalWrites;
        expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers);

        await act(async () => root.unmount());
        await Promise.resolve();
        const timersAfterUnmount = vi.getTimerCount();
        await vi.runAllTimersAsync();

        expect({
            postUnmountWrites: physicalWrites - writesBeforeUnmount,
            settled,
            timerLeak: Math.max(0, timersAfterUnmount - baselineTimers),
        }).toEqual({
            postUnmountWrites: 0,
            settled: true,
            timerLeak: 0,
        });
    });

    it('does not request an app end correction from transient DOM residual before Legend maintenance runs', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        useMeasuredLegendGeometry = true;
        localStorage.setItem('happier.debug.viewportWrites', '1');
        resetTranscriptViewportDiagnosticsForTests();
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
                        nativeID: 'installed-pinned-host',
                        platformOS: 'web',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => (
                        <div
                            data-height={item.height}
                            data-testid={`real-legend-row-${item.id}`}
                            style={{ height: item.height }}
                        >
                            {item.id}
                        </div>
                    )}
                    webDomObservation={createWebDomScrollObservation()}
                />,
            );
        });
        await flushLegendWork();

        const scrollElement = listRef.current?.getScrollableNode?.() as HTMLElement | null;
        expect(scrollElement).not.toBeNull();
        const scrollHeightGetter = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'scrollHeight',
        )?.get;
        expect(scrollHeightGetter).toBeTypeOf('function');
        let forcedTransientScrollHeight: number | null = null;
        Object.defineProperty(scrollElement!, 'scrollHeight', {
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
        expect(readInstalledLegendState(scrollElement!).isAtEnd).toBe(true);
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);

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
        physicalWrites = 0;
        readDiagnostics().heldIntents.length = 0;
        readDiagnostics().writes.length = 0;
        act(() => {
            listRef.current?.notifyViewportGeometryChanged?.();
        });

        await act(async () => {
            tailRow!.dataset.height = '112';
            tailRow!.style.height = '112px';
            flushResizeObservers();
        });
        forcedTransientScrollHeight = scrollElement!.scrollTop + scrollElement!.clientHeight + 72;

        expect(readInstalledLegendState(scrollElement!).isAtEnd).toBe(true);
        expect(distanceFromLiveTail(scrollElement!)).toBe(72);
        const adapterFrameIndex = scheduledFrames.findIndex(
            (frame) => frame.stack.includes('useLegendHeldIntent.ts'),
        );
        expect(
            adapterFrameIndex,
            scheduledFrames.map((frame) => frame.stack).join('\n---\n'),
        ).toBeGreaterThanOrEqual(0);
        expect(scheduledFrames.slice(0, adapterFrameIndex).some(
            (frame) => frame.stack.includes('doMaintainScrollAtEnd'),
        )).toBe(false);

        const [adapterFrame] = scheduledFrames.splice(adapterFrameIndex, 1);
        act(() => {
            adapterFrame?.callback(Date.now());
        });

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
        for (let pass = 0; pass < 24 && distanceFromLiveTail(scrollElement!) > 1; pass += 1) {
            const nextFrame = scheduledFrames.shift();
            expect(nextFrame, 'Legend did not schedule maintenance for the measured contraction').toBeDefined();
            await act(async () => {
                nextFrame!.callback(Date.now());
                flushResizeObservers();
                await Promise.resolve();
            });
        }
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        for (let pass = 0; pass < 64 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift();
            await act(async () => {
                nextFrame!.callback(Date.now());
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
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);
        expect(readDiagnostics().heldIntents).not.toContainEqual(
            expect.objectContaining({ event: 'residual-write' }),
        );
        expect(readDiagnostics().writes).toHaveLength(0);
    });

    it('keeps nonanimated semantic end maintenance pinned through each MVCP remeasurement boundary', async () => {
        const listRef = React.createRef<LegendListRef>();
        let semanticEnd = true;
        useMeasuredLegendGeometry = true;
        viewportHeight = 2_400;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 1_200,
            id: `semantic-mvcp-race-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="installed-pinned-host" style={{ height: viewportHeight }}>
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

        const scrollElement = document.getElementById('installed-pinned-host')
            ?.querySelector<HTMLElement>('[style*="overflow"]');
        expect(scrollElement).not.toBeNull();
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);
        const stateBefore = listRef.current!.getState();
        const firstVisibleIndex = stateBefore.start;
        const beforeAnchorIndex = firstVisibleIndex - 1;
        const afterAnchorIndex = firstVisibleIndex + 1;
        expect({
            mountedAfterAnchor: stateBefore.elementAtIndex(afterAnchorIndex) != null,
            mountedBeforeAnchor: stateBefore.elementAtIndex(beforeAnchorIndex) != null,
        }).toEqual({
            mountedAfterAnchor: true,
            mountedBeforeAnchor: true,
        });

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

        const remeasuredRows = initialRows.map((row, index) => {
            if (index === beforeAnchorIndex) return { ...row, height: row.height - 988 };
            if (index === afterAnchorIndex) return { ...row, height: row.height + 988 };
            return row;
        });
        await act(async () => {
            root.render(render(remeasuredRows));
            flushResizeObservers();
            await Promise.resolve();
        });

        const boundaryDistances = [distanceFromLiveTail(scrollElement!)];
        for (let pass = 0; pass < 32 && scheduledFrames.length > 0; pass += 1) {
            const nextFrame = scheduledFrames.shift()!;
            await act(async () => {
                nextFrame.callback(Date.now());
                await Promise.resolve();
            });
            boundaryDistances.push(distanceFromLiveTail(scrollElement!));
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
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);
        expect(directScrollTopWrites).toHaveLength(0);

        semanticEnd = false;
        const detachedScrollTop = Math.max(
            0,
            scrollElement!.scrollHeight - scrollElement!.clientHeight - 6_000,
        );
        await act(async () => {
            (scrollElement as HTMLElement & { __scrollTop?: number }).__scrollTop = detachedScrollTop;
            scrollElement!.dispatchEvent(new Event('scroll'));
            await Promise.resolve();
        });
        expect(distanceFromLiveTail(scrollElement!)).toBeGreaterThan(1_000);

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
            - scrollElement!.scrollTop;
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
            - scrollElement!.scrollTop;
        expect(detachedMVCPWrites.length).toBeGreaterThan(0);
        expect(Math.abs(detachedAnchorTopAfter - detachedAnchorTopBefore)).toBeLessThanOrEqual(1);

        const detachedAnchorId = detachedRemeasuredRows[detachedAnchorIndex]!.id;
        const prependedRows = [
            { height: 360, id: 'semantic-mvcp-prepend-a' },
            { height: 240, id: 'semantic-mvcp-prepend-b' },
            ...detachedRemeasuredRows,
        ];
        const keyedAnchorTopBefore = listRef.current!.getState().positionByKey(detachedAnchorId)!
            - scrollElement!.scrollTop;
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
            - scrollElement!.scrollTop;
        const prependMVCPWrites = physicalScrollWrites.filter((write) => (
            write.stack.includes('requestAdjust')
            || write.stack.includes('ScrollAdjust')
            || write.stack.includes('scrollAdjustBy')
        ));
        expect(prependMVCPWrites.length).toBeGreaterThan(0);
        expect(Math.abs(keyedAnchorTopAfter - keyedAnchorTopBefore)).toBeLessThanOrEqual(1);
    });
    it('holds a detached reader through expansion, above-viewport growth, and item replacement', async () => {
        // THE DISCRIMINATING MEASUREMENT for the app-level stabilization hold. It decided the
        // deletion of the WEB arm of `armVisibleAnchorHold`; the NATIVE arm survives and is
        // NOT covered here — native MVCP is open-loop and nothing in this file measures it.
        //
        // Its whole justification is `types.ts` / `rowLayoutMutationViewportOwnership.ts`:
        // "Legend MVCP demonstrably re-anchors its mounted window across the expansion item
        // replacement (live S-C, web + native 2026-07-11)". That capture was taken on
        // `@legendapp/list` 2.0.0-beta.3; the package moved to 3.3.3, whose 3.1.0 entry adds
        // the MVCP anchor lock aimed at exactly this class ("keeps the intended anchor when
        // headers change, browser scroll anchoring runs..."). The two neighbouring cases
        // (above-anchor remeasure, 600px prepend) are already proven on 3.3.3 by `keeps
        // nonanimated semantic end maintenance pinned through each MVCP remeasurement
        // boundary`; expansion was the one row with no current-version evidence, so it decided
        // whether the arm site could be removed.
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
        useMeasuredLegendGeometry = true;
        viewportHeight = 2_400;
        const readerIndex = 10;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 1_200,
            id: `expansion-mvcp-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="installed-pinned-host" style={{ height: viewportHeight }}>
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
        const scrollElement = findInstalledScrollElement();
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

    it('preserves explicit index ownership through MVCP when end maintenance is disabled', async () => {
        const listRef = React.createRef<LegendListRef>();
        useMeasuredLegendGeometry = true;
        viewportHeight = 2_400;
        const targetIndex = 10;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 1_200,
            id: `explicit-mvcp-control-${index}`,
        }));
        const render = (data: readonly Row[]) => (
            <div id="installed-pinned-host" style={{ height: viewportHeight }}>
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
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({ callback, id });
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
        const scrollElement = document.getElementById('installed-pinned-host')
            ?.querySelector<HTMLElement>('[style*="overflow"]');
        expect(scrollElement).not.toBeNull();
        const targetTopBefore = listRef.current!.getState().positionAtIndex(targetIndex)
            - scrollElement!.scrollTop;
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
            - scrollElement!.scrollTop;
        expect(explicitTargetMVCPWrites.length).toBeGreaterThan(0);
        expect(Math.abs(targetTopAfter - targetTopBefore)).toBeLessThanOrEqual(1);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('lands a semantic held-end scrollToEnd before its promise resolves', async () => {
        const listRef = React.createRef<LegendListRef>();
        let isMaintainingScrollAtEnd = false;
        useMeasuredLegendGeometry = true;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 120,
            id: `semantic-scroll-to-end-${index}`,
        }));

        await act(async () => {
            root.render(
                <div id="installed-pinned-host" style={{ height: 600 }}>
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
                        renderItem={({ item }: { item: Row }) => (
                            <div data-height={item.height} style={{ height: item.height }}>
                                {item.id}
                            </div>
                        )}
                        style={{ flex: 1, minHeight: 0 }}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const scrollElement = document.getElementById('installed-pinned-host')
            ?.querySelector<HTMLElement>('[style*="overflow"]') as
            | (HTMLElement & { __scrollTop?: number })
            | null;
        expect(scrollElement).not.toBeNull();
        const distanceFromLiveTail = () => Math.max(
            0,
            scrollElement!.scrollHeight - scrollElement!.clientHeight - scrollElement!.scrollTop,
        );
        scrollElement!.__scrollTop = Math.max(
            0,
            scrollElement!.scrollHeight - scrollElement!.clientHeight - 800,
        );
        scrollElement!.dispatchEvent(new Event('scroll'));
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
            distanceAtResolution = distanceFromLiveTail();
        };
        const resolution = observeResolution();
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
            await resolution;
        });

        expect(distanceFromLiveTail()).toBeLessThanOrEqual(1);
        expect(distanceAtResolution).toBeLessThanOrEqual(1);
    });

    it('uses the current item-size version estimate for an offscreen measured key without invalidating another key', async () => {
        const listRef = React.createRef<LegendListRef>();
        const targetIndex = 20;
        useMeasuredLegendGeometry = true;
        const initialRows = Array.from({ length: 50 }, (_value, index): SizeVersionRow => ({
            estimatedHeight: index === 1 ? 140 : 100,
            height: index === 1 ? 140 : 100,
            id: `size-version-${index}`,
            sizeVersion: 'v1',
        }));
        const render = (data: readonly SizeVersionRow[]) => (
            <div id="installed-pinned-host" style={{ height: 600 }}>
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
        expect(findInstalledScrollElement().scrollTop).toBe(expectedTargetOffset);
        expect(state.sizes.has(initialRows[0]!.id)).toBe(false);
        expect(state.sizes.get(initialRows[1]!.id)).toBe(140);
        expect(physicalScrollWrites.some((write) => write.top === expectedTargetOffset)).toBe(true);
    });

    it('retains an offscreen known size while its item-size version is unchanged', async () => {
        const listRef = React.createRef<LegendListRef>();
        const targetIndex = 20;
        useMeasuredLegendGeometry = true;
        const initialRows = Array.from({ length: 50 }, (_value, index): SizeVersionRow => ({
            estimatedHeight: 100,
            height: 100,
            id: `same-size-version-${index}`,
            sizeVersion: 'v1',
        }));
        const render = (data: readonly SizeVersionRow[]) => (
            <div id="installed-pinned-host" style={{ height: 600 }}>
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
        useMeasuredLegendGeometry = true;
        const initialRows = Array.from({ length: 50 }, (_value, index): SizeVersionRow => ({
            estimatedHeight: 100,
            height: 100,
            id: `reset-size-version-${index}`,
            sizeVersion: 'v1',
        }));
        const render = (data: readonly SizeVersionRow[], sessionKey: string) => (
            <div id="installed-pinned-host" style={{ height: 600 }}>
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

    it('acknowledges initial rich content only after installed Legend physically maintains the tail', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const settled = vi.fn();
        useMeasuredLegendGeometry = true;
        const initialRows = rows(20, 'rich-settlement');
        const render = (lastHeight: number) => (
            <Renderer
                data={[
                    ...initialRows.slice(0, -1),
                    { ...initialRows[initialRows.length - 1]!, height: lastHeight },
                ]}
                dataKey="rich-settlement-session"
                extraData={lastHeight}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'installed-pinned-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={({ item }: { item: Row }) => (
                    <div data-height={item.height} style={{ height: item.height }}>
                        {item.id}
                    </div>
                )}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render(120));
        });
        await flushLegendWork();
        const scrollElement = listRef.current?.getScrollableNode?.() as HTMLElement | null;
        expect(scrollElement).not.toBeNull();
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);

        await act(async () => {
            root.render(render(900));
        });
        act(() => {
            listRef.current?.observeInitialPresentationSettlement?.({
                dataKey: 'rich-settlement-session',
                revision: 7,
                onSettled: settled,
            });
        });
        expect(settled).not.toHaveBeenCalled();

        await act(async () => {
            flushResizeObservers();
            await Promise.resolve();
        });
        expect(distanceFromLiveTail(scrollElement!)).toBeGreaterThan(1);
        expect(settled).not.toHaveBeenCalled();

        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
        });
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);
        expect(settled).toHaveBeenCalledTimes(1);
    });

    it('terminally releases initial rich-content presentation when steady tail maintenance misses its bounded settle window', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const settled = vi.fn();
        useMeasuredLegendGeometry = true;
        const initialRows = rows(20, 'rich-settlement-deadline');
        const render = (lastHeight: number) => (
            <Renderer
                data={[
                    ...initialRows.slice(0, -1),
                    { ...initialRows[initialRows.length - 1]!, height: lastHeight },
                ]}
                dataKey="rich-settlement-deadline-session"
                extraData={lastHeight}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'installed-pinned-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={({ item }: { item: Row }) => (
                    <div data-height={item.height} style={{ height: item.height }}>
                        {item.id}
                    </div>
                )}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render(120));
        });
        await flushLegendWork();
        const scrollElement = listRef.current?.getScrollableNode?.() as HTMLElement | null;
        expect(scrollElement).not.toBeNull();
        expect(distanceFromLiveTail(scrollElement!)).toBeLessThanOrEqual(1);

        Object.defineProperty(scrollElement!, 'scrollTo', {
            configurable: true,
            value() {
                // Model a browser/Legend maintenance attempt that cannot physically land
                // during the renderer's bounded initial-presentation settle window.
            },
        });
        try {
            // The deadline contract is only observable while the viewport is left measurably
            // short of the live tail, so the growth must be one the same render's measurement
            // pass cannot cancel. A fixed delta is not: this mount lands with cold per-row
            // over-estimate still in the content length, and the corrections that arrive with
            // the grown row subtract it, which can erase a similarly sized growth outright.
            // Sizing the grown tail row past the parked offset plus a full viewport leaves a
            // gap larger than the rest of the list, so no estimate correction can close it.
            const grownLastHeight = 120 + scrollElement!.scrollTop + scrollElement!.clientHeight;
            await act(async () => {
                root.render(render(grownLastHeight));
            });
            act(() => {
                listRef.current?.observeInitialPresentationSettlement?.({
                    dataKey: 'rich-settlement-deadline-session',
                    revision: 8,
                    onSettled: settled,
                });
            });
            await act(async () => {
                flushResizeObservers();
                vi.setSystemTime(Date.now() + 2_000);
                for (let pass = 0; pass < 8; pass += 1) {
                    await vi.runOnlyPendingTimersAsync();
                }
            });

            expect(distanceFromLiveTail(scrollElement!)).toBeGreaterThan(1);
            expect(readInstalledLegendState(scrollElement!).endBuffered).toBe(initialRows.length - 1);
            expect(settled).toHaveBeenCalledTimes(1);
        } finally {
            Reflect.deleteProperty(scrollElement!, 'scrollTo');
        }
    });

    it('settles synchronously and read-only when user takeover has already removed the hold', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const settled = vi.fn();
        useMeasuredLegendGeometry = true;
        const initialRows = Array.from({ length: 20 }, (_value, index) => ({
            height: 120,
            id: `detached-rich-settlement-${index}`,
        }));
        const render = (firstHeight: number) => (
            <Renderer
                data={[
                    { ...initialRows[0]!, height: firstHeight },
                    ...initialRows.slice(1),
                ]}
                dataKey="detached-rich-settlement-session"
                extraData={firstHeight}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'installed-entry-host',
                    platformOS: 'web',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={({ item }: { item: Row }) => (
                    <div data-height={item.height} style={{ height: item.height }}>
                        {item.id}
                    </div>
                )}
                webDomObservation={createWebDomScrollObservation()}
            />
        );

        await act(async () => {
            root.render(render(120));
        });
        await flushLegendWork();
        const scrollElement = listRef.current?.getScrollableNode?.() as HTMLElement | null;
        expect(scrollElement).not.toBeNull();
        scrollElement!.scrollTo({ top: 500 });
        await flushLegendWork();
        act(() => {
            listRef.current?.releaseWebHeldIntent?.();
        });

        await act(async () => {
            root.render(render(900));
        });
        const scheduledFrames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            scheduledFrames.push(callback);
            return scheduledFrames.length;
        });
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        act(() => {
            listRef.current?.observeInitialPresentationSettlement?.({
                dataKey: 'detached-rich-settlement-session',
                revision: 11,
                onSettled: settled,
            });
        });
        expect(settled).toHaveBeenCalledTimes(1);
        expect(scheduledFrames).toHaveLength(0);
        expect(physicalScrollWrites).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);

        await act(async () => {
            flushResizeObservers();
            await Promise.resolve();
            await vi.runOnlyPendingTimersAsync();
        });
        expect(settled).toHaveBeenCalledTimes(1);
        expect(scheduledFrames).toHaveLength(0);
        expect(physicalScrollWrites).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('settles synchronously and read-only when takeover cancels the held settle frame', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const settled = vi.fn();
        useMeasuredLegendGeometry = true;
        const underfilledRows: readonly Row[] = [
            { height: 120, id: 'takeover-settlement-0' },
            { height: 120, id: 'takeover-settlement-1' },
        ];

        await act(async () => {
            root.render(
                <Renderer
                    data={underfilledRows}
                    dataKey="takeover-settlement-session"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: false,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'installed-pinned-host',
                        platformOS: 'web',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => (
                        <div data-height={item.height} style={{ height: item.height }}>
                            {item.id}
                        </div>
                    )}
                    webDomObservation={createWebDomScrollObservation()}
                />,
            );
        });
        await flushLegendWork();

        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({ callback, id });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });
        act(() => {
            listRef.current?.holdWebEntryAnchor?.({
                itemId: 'takeover-settlement-0',
                itemOffsetPx: 24,
                kind: 'item',
                messageId: null,
            });
            listRef.current?.observeInitialPresentationSettlement?.({
                dataKey: 'takeover-settlement-session',
                revision: 19,
                onSettled: settled,
            });
        });
        expect(scheduledFrames).toHaveLength(1);
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;

        act(() => {
            listRef.current?.releaseWebHeldIntent?.();
        });
        expect(settled).toHaveBeenCalledTimes(1);
        expect(scheduledFrames).toHaveLength(0);
        expect(physicalScrollWrites).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);

        const deadlineSettled = vi.fn();
        act(() => {
            listRef.current?.holdWebEntryAnchor?.({
                itemId: 'takeover-settlement-missing',
                itemOffsetPx: 0,
                kind: 'item',
                messageId: null,
                reason: 'entry-restore',
            });
            listRef.current?.observeInitialPresentationSettlement?.({
                dataKey: 'takeover-settlement-session',
                revision: 20,
                onSettled: deadlineSettled,
            });
        });
        expect(scheduledFrames).toHaveLength(1);

        vi.setSystemTime(Date.now() + 2_000);
        const deadlineFrame = scheduledFrames.shift();
        act(() => {
            deadlineFrame?.callback(2_000);
        });
        expect(deadlineSettled).toHaveBeenCalledTimes(1);
        expect(scheduledFrames).toHaveLength(0);
        expect(physicalScrollWrites).toHaveLength(0);
        expect(directScrollTopWrites).toHaveLength(0);
    });

    it('does not report installed-Legend bootstrap geometry as exact DOM settlement', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const placementEvents: TranscriptRendererEntryPlacementEvent[] = [];
        const anchor = {
            itemId: 'entry-row-0',
            itemOffsetPx: 0,
            kind: 'item' as const,
            messageId: null,
            reason: 'entry-restore' as const,
        };

        await act(async () => {
            root.render(
                <Renderer
                    data={Array.from({ length: 10 }, (_value, index) => ({
                        height: 240,
                        id: `entry-row-${index}`,
                    }))}
                    dataKey="installed-entry-session"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: false,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'installed-entry-host',
                        platformOS: 'web',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    onEntryPlacementEvent={(event) => placementEvents.push(event)}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => (
                        <div
                            data-testid={`transcript-item-${item.id}`}
                            style={{ height: item.height }}
                        >
                            {item.id}
                        </div>
                    )}
                    webDomObservation={createWebDomScrollObservation()}
                />,
            );
        });
        await flushLegendWork();

        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                context: {
                    anchor,
                    kind: 'entry-placement',
                },
                index: 0,
                viewOffset: 0,
                viewPosition: 0,
            });
            listRef.current?.holdWebEntryAnchor?.(anchor);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_601);
        });
        await flushLegendWork();

        expect(placementEvents).toEqual([
            {
                dataKey: 'installed-entry-session',
                itemId: 'entry-row-0',
                platform: 'web',
                type: 'started',
            },
            {
                dataKey: 'installed-entry-session',
                itemId: 'entry-row-0',
                outcome: 'deadline',
                platform: 'web',
                type: 'finished',
            },
        ]);
    });

    // Initial placement on a tail-entry open belongs to ONE owner: the library. The adapter's
    // held-end materialization request resolves its target through Legend's own position table
    // (`positions[index] || 0`), so while that entry is unresolved the request cannot approach
    // the tail — it pins the viewport at the HEAD and Legend's bootstrap then has to teleport
    // away from it. Counting the writes is the whole point: a "no writes after the reveal"
    // assertion is satisfied by doing nothing and cannot distinguish one owner from two.
    it('places an asynchronously hydrated bottom-entry open with library writes only, never through the head', async () => {
        const Renderer = legendListRenderer.Component;
        useMeasuredLegendGeometry = true;
        const render = (data: readonly Row[]) => (
            <Renderer
                key="open-write-convergence"
                data={data}
                dataKey="open-write-convergence"
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: 'installed-pinned-host',
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

        const scrollElement = findInstalledScrollElement();
        const tailOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
        expect(tailOffset).toBeGreaterThan(0);
        const census = physicalScrollWrites.map((write) => ({
            family: classifyLegendPlacementWriteOwner(write),
            top: write.top,
        }));
        const describeCensus = `open placement writes:\n${census
            .map((entry) => `${entry.family} -> ${entry.top}`)
            .join('\n')}`;

        expect({
            appPlacementWrites: census.filter((entry) => entry.family === 'app').length,
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
        expect(
            census.filter((entry) => entry.family === 'library-initial'),
            describeCensus,
        ).toHaveLength(1);
        expect(census.length, describeCensus).toBeLessThanOrEqual(2);
        expect(directScrollTopWrites).toHaveLength(0);
    });
});
