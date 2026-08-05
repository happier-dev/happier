// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    readTranscriptPhysicalWriteCensus,
    resetTranscriptViewportDiagnosticsForTests,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * ONE PLACEMENT TRANSACTION PER ENTRY, COMMANDED BY INTENT.
 *
 * Measured live on web (session `cms4aenky5lnktm72sfmya6uk`, cold route load, 2026-07-30,
 * reproduced twice with identical numbers): a single open issued **16 `scrollToIndex`
 * commands, 8 of which landed at `scrollTop: 0` while `maxScroll` was ~1936** — the reader
 * was parked on the fork divider at the head of the content for up to 1425ms, oscillating
 * between the head and the tail seven times before settling. `scrollToEnd` scored 0 wrong
 * landings out of 7 in the same capture, and the app's own `el.scrollTop` writer never ran
 * at all (`physicalWrites: 0`).
 *
 * The mechanism is a frozen index plus a re-arming idempotence key:
 *   - `requestWebHeldEndMaterialization` commanded the tail as
 *     `scrollToIndex({ index: dataLength - 1, viewPosition: 1 })`. Legend resolves that
 *     index against its own position table when the request RUNS
 *     (`calculateOffsetForIndex` -> `positions[index] || 0`), and `runWhenReady` runs a
 *     deferred request regardless of readiness once `IMPERATIVE_SCROLL_SETTLE_MAX_WAIT_MS`
 *     (800ms) elapses. A forked transcript publishes a 1-row placeholder list first, whose
 *     tail index is 0 — and index 0 is the HEAD once the messages arrive.
 *   - the "one materialization EVER" guard was keyed `${dataLength}:${keyExtractor(tail)}`,
 *     so every hydration wave re-armed it (measured content growth 324 -> 2291 -> 2253 ->
 *     12241px).
 *
 * The contract pinned here: a multi-wave held-end open places the viewport at the tail
 * WITHOUT ever commanding an imperative index, and never rests at the head while a real
 * scroll range exists. Legend's own end command re-derives `data.length - 1` and
 * re-evaluates its readiness predicate at run time, so it cannot go stale between the
 * request and the run.
 *
 * This is deliberately NOT a delay, cover, or suppression window — those hide movement and
 * one of them was itself a shipped defect (`legendListRenderer.tsx` records the app-side
 * corrector that was visible). The assertion is on physical landings.
 */

type Row = Readonly<{ height: number; id: string }>;

type PhysicalScrollWrite = Readonly<{
    /** Physical scroll range at the instant of the write — `0` is only a landing if this is 0. */
    maxScroll: number;
    stack: string;
    /** Which element actually moved, so a ring armed elsewhere is provable, not assumed. */
    target: HTMLElement;
    top: number;
}>;

type ViewportSample = Readonly<{ label: string; maxScroll: number; scrollTop: number }>;

type ResizeObserverRecord = Readonly<{ callback: ResizeObserverCallback; elements: Set<Element> }>;

const ROW_HEIGHT = 140;
const VIEWPORT_HEIGHT = 600;
/** A scroll range this large makes "resting at 0" unambiguous rather than a small residual. */
const MEANINGFUL_SCROLL_RANGE_PX = 200;

const resizeObservers = new Set<ResizeObserverRecord>();
const physicalScrollWrites: PhysicalScrollWrite[] = [];
const directScrollTopWrites: PhysicalScrollWrite[] = [];
let scrollMethodActive = false;

function childRows(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({
        height: ROW_HEIGHT,
        id: `child-${index}`,
    }));
}

/** The fork divider the producer publishes ahead of the child's own rows. */
const FORK_DIVIDER_ROW: Row = { height: 64, id: 'fork-divider' };

function forkedWave(childCount: number): Row[] {
    return [FORK_DIVIDER_ROW, ...childRows(childCount)];
}

function rect(width: number, height: number): DOMRectReadOnly {
    return {
        bottom: height, height, left: 0, right: width, top: 0, width, x: 0, y: 0,
        toJSON: () => ({}),
    };
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === 'real-legend-host') return rect(800, VIEWPORT_HEIGHT);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const row = htmlElement.querySelector<HTMLElement>('[data-testid^="tail-placement-row-"]');
    if (row) return rect(800, Number(row.dataset.height ?? ROW_HEIGHT));
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

async function flushLegendWork(passes: number): Promise<void> {
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
            data-height={item.height}
            data-testid={`tail-placement-row-${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

/**
 * Physical write attribution by captured stack, matching the live census: the frozen-index
 * form is `imperative-index`, Legend's end command reaches the DOM through `doScrollTo`
 * without a `scrollToIndex` frame of its own only when it is dispatched as a pending
 * end scroll, so `scrollToEnd` frames are classified before the index check.
 */
function classifyPhysicalWrite(write: PhysicalScrollWrite): 'end' | 'imperative-index' | 'initial' | 'maintain' | 'other' {
    if (
        write.stack.includes('doMaintainScrollAtEnd')
        || write.stack.includes('maintainScrollAtEnd')
    ) return 'maintain';
    if (write.stack.includes('dispatchInitialScroll') || write.stack.includes('advanceMeasuredInitialScroll')) {
        return 'initial';
    }
    if (write.stack.includes('scrollToEnd') || write.stack.includes('runPendingScrollToEnd')) return 'end';
    if (write.stack.includes('scrollToIndex')) return 'imperative-index';
    return 'other';
}

function findScrollElement(): HTMLElement {
    const element = document.getElementById('real-legend-host')
        ?.querySelector<HTMLElement>('[style*="overflow"]');
    expect(element).not.toBeNull();
    return element!;
}

function sampleViewport(label: string): ViewportSample {
    const element = findScrollElement();
    return {
        label,
        maxScroll: Math.max(0, element.scrollHeight - element.clientHeight),
        scrollTop: element.scrollTop,
    };
}

function describeCensus(samples: readonly ViewportSample[]): string {
    const writes = physicalScrollWrites
        .map((write) => `${classifyPhysicalWrite(write)}@${write.top}/max${write.maxScroll}`)
        .join(', ');
    const trace = samples
        .map((sample) => `${sample.label}: scrollTop=${sample.scrollTop} max=${sample.maxScroll}`)
        .join('\n  ');
    return `writes: [${writes}]\n  ${trace}`;
}

/**
 * The live census metric: a write that parks the scroller at the head of the content while a
 * real scroll range exists. Eight of these were measured per cold open.
 */
function wrongLandings(): Array<{ family: string; maxScroll: number; top: number }> {
    return physicalScrollWrites
        .filter((write) => write.top <= 0 && write.maxScroll > MEANINGFUL_SCROLL_RANGE_PX)
        .map((write) => ({
            family: classifyPhysicalWrite(write),
            maxScroll: write.maxScroll,
            top: write.top,
        }));
}

describe('web held-end placement is one transaction per entry, never a frozen index', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        scrollMethodActive = false;
        localStorage.setItem('happier.debug.viewportWrites', '1');
        resetTranscriptViewportDiagnosticsForTests();
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
            get() { return measuredRect(this).height; },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() { return measuredRect(this).width; },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let materializedTotal = 0;
                for (const row of element.querySelectorAll<HTMLElement>('[data-height]')) {
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
            get() { return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0; },
            set(value: number) {
                const element = this as HTMLElement & { __scrollTop?: number };
                const max = Math.max(0, element.scrollHeight - element.clientHeight);
                element.__scrollTop = Math.max(0, Math.min(value, max));
                if (!scrollMethodActive) {
                    directScrollTopWrites.push({
                        maxScroll: max,
                        stack: new Error('direct physical scrollTop write').stack ?? '',
                        target: element,
                        top: element.__scrollTop,
                    });
                }
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                physicalScrollWrites.push({
                    maxScroll: Math.max(0, this.scrollHeight - this.clientHeight),
                    stack: new Error('physical scroll write').stack ?? '',
                    target: this,
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
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => { clearTimeout(handle); });
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        localStorage.removeItem('happier.debug.viewportWrites');
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function renderWave(data: readonly Row[]): React.ReactElement {
        const Renderer = legendListRenderer.Component;
        return (
            <Renderer
                key="multipass-entry"
                data={data}
                dataKey="multipass-entry"
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
    }

    it('places a multi-wave forked open at the tail without any frozen-index command', async () => {
        const samples: ViewportSample[] = [];

        // Wave 1: the producer's first publish. A forked transcript reached Legend with the
        // boundary divider alone before any message existed; the tail index of that list is 0.
        await act(async () => { root.render(renderWave(forkedWave(0))); });
        await flushLegendWork(1);
        samples.push(sampleViewport('wave1-divider-only'));

        // Waves 2..4 arrive while the held-end settle loop is still converging — the measured
        // shape (four distinct content sizes inside one open, ~90ms apart). Each wave gets a
        // single flush pass so a request issued in one wave can still be pending in the next,
        // which is exactly how a frozen index goes stale.
        for (const [waveIndex, childCount] of [9, 15, 17, 20].entries()) {
            await act(async () => { root.render(renderWave(forkedWave(childCount))); });
            await flushLegendWork(1);
            samples.push(sampleViewport(`wave${waveIndex + 2}-child-${childCount}`));
        }

        // Let every deferred imperative request drain, including Legend's 800ms readiness
        // escape hatch, which is what ran the stale index in the live capture.
        await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
        await flushLegendWork(10);
        samples.push(sampleViewport('settled'));

        const frozenIndexWrites = physicalScrollWrites.filter(
            (write) => classifyPhysicalWrite(write) === 'imperative-index',
        );
        expect(
            frozenIndexWrites.map((write) => write.top),
            `the tail must be commanded by intent, never by an index frozen at request time\n  ${describeCensus(samples)}`,
        ).toEqual([]);

        expect(
            wrongLandings(),
            `no physical write may land at the head while a real scroll range exists\n  ${describeCensus(samples)}`,
        ).toEqual([]);

        const headLandings = samples.filter(
            (sample) => sample.scrollTop === 0 && sample.maxScroll > MEANINGFUL_SCROLL_RANGE_PX,
        );
        expect(
            headLandings,
            `no wave may rest at the head of the content while a real scroll range exists\n  ${describeCensus(samples)}`,
        ).toEqual([]);

        const settled = sampleViewport('final');
        expect(
            settled.scrollTop,
            `a held-end entry must finish at the physical tail\n  ${describeCensus(samples)}`,
        ).toBe(settled.maxScroll);
        expect(settled.maxScroll).toBeGreaterThan(MEANINGFUL_SCROLL_RANGE_PX);
    });

    it('keeps the tail after the ancestor context prepends, still without a frozen-index command', async () => {
        const samples: ViewportSample[] = [];

        await act(async () => { root.render(renderWave(forkedWave(0))); });
        await flushLegendWork(1);
        await act(async () => { root.render(renderWave(forkedWave(9))); });
        await flushLegendWork(6);
        samples.push(sampleViewport('child-hydrated'));

        // The parent context can only arrive after the child's own transcript, as a prepend
        // (`useTranscriptRootMessages` gates the prefetch behind the child's own isLoaded).
        const withAncestor = [
            ...Array.from({ length: 40 }, (_value, index) => ({
                height: ROW_HEIGHT,
                id: `ancestor-${index}`,
            })),
            ...forkedWave(9),
        ];
        await act(async () => { root.render(renderWave(withAncestor)); });
        await flushLegendWork(1);
        samples.push(sampleViewport('ancestor-prepended'));

        await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
        await flushLegendWork(10);
        samples.push(sampleViewport('settled'));

        expect(
            physicalScrollWrites
                .filter((write) => classifyPhysicalWrite(write) === 'imperative-index')
                .map((write) => write.top),
            `a prepend must be compensated and re-pinned without a frozen-index command\n  ${describeCensus(samples)}`,
        ).toEqual([]);

        expect(
            wrongLandings(),
            `no physical write may land at the head while a real scroll range exists\n  ${describeCensus(samples)}`,
        ).toEqual([]);

        const settled = sampleViewport('final');
        expect(
            settled.scrollTop,
            `the reader must still be at the tail after the ancestor prepend\n  ${describeCensus(samples)}`,
        ).toBe(settled.maxScroll);
        expect(settled.maxScroll).toBeGreaterThan(MEANINGFUL_SCROLL_RANGE_PX);
    });

    /**
     * THE INSTRUMENT ITSELF IS UNDER TEST.
     *
     * The live capture above was read three times as "the app never writes" because
     * `__happierViewportDiagnostics.physicalWrites` was empty. It was empty because the ring
     * was armed on the wrong element: the install was a mount-time effect, and at mount the
     * transcript content does not overflow yet, so the scroller resolution falls back past
     * the transcript root (live: onto the 384px left rail). With unchanging effect deps it
     * could never re-arm once the real scroller attached.
     *
     * This test measures the same open twice — once through the harness's own
     * prototype-level recorder, once through the in-app ring — and requires them to agree on
     * the transcript scroller. It also requires the end-materialization placement to be
     * countable, which it was not: only the keyed-identity path emitted lifecycle events, so
     * no in-app instrument could count tail placements at all.
     */
    it('arms the physical-write ring on the transcript scroller and counts end placements', async () => {
        await act(async () => { root.render(renderWave(forkedWave(0))); });
        await flushLegendWork(1);
        for (const childCount of [9, 15, 20]) {
            await act(async () => { root.render(renderWave(forkedWave(childCount))); });
            await flushLegendWork(1);
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
        await flushLegendWork(10);

        const scroller = findScrollElement();
        const census = readTranscriptPhysicalWriteCensus();

        expect(
            census.observer,
            'the ring must report WHERE it is armed; an unarmed ring reporting 0 is not evidence',
        ).toMatchObject({ installed: true, reason: 'armed' });
        expect(
            census.observer.armedOnElement,
            'the ring must be armed on the transcript scroller, not on an ancestor or the rail',
        ).toBe(scroller);
        expect(document.getElementById('real-legend-host')!.contains(scroller)).toBe(true);

        // The harness sees every physical write at the prototype; the ring must see the same
        // ones on the element it claims to observe.
        const scrollerWrites = physicalScrollWrites.filter((write) => write.target === scroller);
        expect(scrollerWrites.length).toBeGreaterThan(0);
        expect(
            census.writes?.length,
            `the ring must not miss writes the page actually made: harness saw ${scrollerWrites.length}`,
        ).toBe(scrollerWrites.length);
        expect(census.writes?.map((write) => write.landedScrollTop))
            .toEqual(scrollerWrites.map((write) => write.top));

        const heldIntents = (globalThis as Record<string, unknown>).__happierViewportDiagnostics as {
            heldIntents: Array<{ event: string; intentKind: string }>;
        };
        const endPlacements = heldIntents.heldIntents.filter(
            (entry) => entry.intentKind === 'end' && entry.event.startsWith('materialization-'),
        );
        expect(
            endPlacements.map((entry) => entry.event),
            'end materialization must be countable, symmetric with the keyed-identity path',
        ).toEqual(['materialization-start', 'materialization-settled']);
    });
});
