// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList } from '@legendapp/list/react-native';
import * as legendReactNative from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * A footer height change must never re-hide a transcript that has already been revealed.
 *
 * Legend keeps its whole row container at `opacity: readyToRender ? 1 : 0`
 * (`react-native.web.mjs` `ContainersInner`, and identically in `react-native.mjs`), and the only
 * writer of `readyToRender = false` is `resetInitialRenderState` (`:865`). For a list mounted with
 * `initialScrollAtEnd`, `handleBootstrapInitialScrollFooterLayout` reaches that writer on a footer
 * layout whose recomputed at-end target moved:
 *
 *   :2836  const didFinishInitialScroll = !!state.didFinishInitialScroll;
 *   :2837  setInitialScrollTarget(ctx, updatedInitialScroll, { resetDidFinish: didFinishInitialScroll });
 *   :2289  if (options?.resetDidFinish) resetInitialRenderState(ctx, { resetInitialScroll: true });
 *   :865   set$(ctx, "readyToRender", false);
 *
 * `resetDidFinish` is the RAW `didFinishInitialScroll`, which is `true` for the whole life of a
 * settled list — so the guard passes precisely when the list is already revealed. Its sibling, the
 * data-change path, passes a properly qualified `shouldResetDidFinish` instead (`:2775`, guarded at
 * `:2741` by `previousDataLength === 0 && dataLength > 0`), so an ordinary append does NOT reset.
 * Only the footer path is unguarded, and `:2840 rearmBootstrapInitialScroll` re-arms the very
 * session that gates it at `:2811`, so each footer-driven hide licenses the next one.
 *
 * The transcript arms exactly this in production: the Legend `ListFooterComponent` is not a spacer
 * but the live streaming tail plus the composer inset (`useTranscriptRowHost.tsx:588-612`), so its
 * height moves continuously while an agent produces output.
 *
 * The defect is invisible to the app: `resetInitialRenderState` never clears `state.didLoad`
 * (`:853-867` assigns only `didContainersLayout`/`didFinishInitialScroll`), so `onLoad` does not
 * re-fire and no app-level paint fact learns that the list went blank. This test therefore reads
 * Legend's own reveal state through the `internal.useStateContext` runtime export and samples
 * container opacity on EVERY frame after the footer moves — a flicker that recovers is still a
 * flicker, and an end-state-only assertion cannot see it.
 */

type FooterRow = Readonly<{ id: string }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

type LegendRevealContext = Readonly<{
    state: Readonly<{
        containerItemKeys: Map<string, number>;
        didContainersLayout?: boolean;
        didFinishInitialScroll?: boolean;
        sizesKnown: Map<string, number>;
    }>;
}>;

const HOST_ID = 'legend-footer-host';
const ROW_TESTID_PREFIX = 'legend-footer-row-';
const FOOTER_TESTID = 'legend-footer-slot';
const ROW_COUNT = 40;
const VIEWPORT_HEIGHT = 500;
const ESTIMATED_ROW_HEIGHT = 100;
const MOUNT_PASSES = 8;
const SETTLE_FRAMES = 12;
/** Frames to watch after the footer moves. A flicker that recovers still fails. */
const OBSERVE_FRAMES = 16;

const resizeObservers = new Set<ResizeObserverRecord>();
const lastDeliveredSize = new WeakMap<Element, Readonly<{ height: number; width: number }>>();

const DATA: readonly FooterRow[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    id: `row-${index}`,
}));

/** The live footer height, read by both the render and the measurement stub. */
let footerHeight = 48;
let capturedContext: LegendRevealContext | null = null;

function heightOfRowId(id: string): number {
    const index = Number.parseInt(id.slice('row-'.length), 10);
    return 70 + (index % 4) * 45;
}

function keyExtractor(item: FooterRow): string {
    return item.id;
}

function rect(width: number, height: number): DOMRectReadOnly {
    return {
        bottom: height, height, left: 0, right: width, top: 0, width, x: 0, y: 0,
        toJSON: () => ({}),
    };
}

function rowIdOfElement(element: HTMLElement): string | null {
    const row = element.matches(`[data-testid^="${ROW_TESTID_PREFIX}"]`)
        ? element
        : element.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    const testId = row?.dataset.testid;
    return testId ? testId.slice(ROW_TESTID_PREFIX.length) : null;
}

function isFooterElement(element: HTMLElement): boolean {
    return element.matches(`[data-testid="${FOOTER_TESTID}"]`)
        || element.querySelector(`[data-testid="${FOOTER_TESTID}"]`) !== null;
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === HOST_ID) return rect(800, VIEWPORT_HEIGHT);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const rowId = rowIdOfElement(htmlElement);
    if (rowId !== null) return rect(800, heightOfRowId(rowId));
    // The footer's measured height is the live value, so moving it models the streaming tail.
    if (isFooterElement(htmlElement)) return rect(800, footerHeight);
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 0);
}

/** Footer resize entries actually handed to Legend — the test's non-vacuity witness. */
let footerDeliveries = 0;

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries: ResizeObserverEntry[] = [];
        for (const element of observer.elements) {
            const next = measuredRect(element);
            const previous = lastDeliveredSize.get(element);
            if (previous && previous.height === next.height && previous.width === next.width) continue;
            lastDeliveredSize.set(element, { height: next.height, width: next.width });
            if (isFooterElement(element as HTMLElement)) footerDeliveries += 1;
            entries.push({
                borderBoxSize: [], contentBoxSize: [], contentRect: next,
                devicePixelContentBoxSize: [], target: element,
            } as unknown as ResizeObserverEntry);
        }
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

function useCapturedLegendContext(): void {
    const legendInternal = (legendReactNative as unknown as {
        internal: { useStateContext: () => LegendRevealContext };
    }).internal;
    capturedContext = legendInternal.useStateContext();
}

function ProbeRow({ item }: Readonly<{ item: FooterRow }>): React.ReactElement {
    useCapturedLegendContext();
    return (
        <div data-testid={`${ROW_TESTID_PREFIX}${item.id}`} style={{ height: heightOfRowId(item.id) }}>
            {item.id}
        </div>
    );
}

function renderRow({ item }: Readonly<{ item: FooterRow }>): React.ReactElement {
    return <ProbeRow item={item} />;
}

function readRowContainerOpacity(scope: HTMLElement): number | null {
    const row = scope.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    let element: HTMLElement | null = row?.parentElement ?? null;
    while (element && element !== scope.parentElement) {
        const declared = element.style.opacity;
        if (declared !== '') return Number.parseFloat(declared);
        element = element.parentElement;
    }
    return null;
}

describe('Legend reveal stability across a footer height change', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        capturedContext = null;
        footerHeight = 48;
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        class TestResizeObserver implements ResizeObserver {
            private readonly record: ResizeObserverRecord;
            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }
            disconnect(): void { this.record.elements.clear(); resizeObservers.delete(this.record); }
            observe(target: Element): void { resizeObservers.add(this.record); this.record.elements.add(target); }
            unobserve(target: Element): void { this.record.elements.delete(target); }
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
            get() { return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0; },
            set(value: number) { (this as HTMLElement & { __scrollTop?: number }).__scrollTop = Math.max(0, value); },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                this.scrollTop = this.scrollTop + delta;
                this.dispatchEvent(new Event('scroll'));
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
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => { clearTimeout(handle); });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('keeps an already-revealed list visible when the footer changes height', async () => {
        const container = document.createElement('div');
        container.style.height = `${VIEWPORT_HEIGHT}px`;
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        let loadCount = 0;

        function Footer(): React.ReactElement {
            return <div data-testid={FOOTER_TESTID} style={{ height: footerHeight }} />;
        }

        const tree = () => (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={DATA}
                    drawDistance={0}
                    estimatedItemSize={ESTIMATED_ROW_HEIGHT}
                    initialScrollAtEnd
                    keyExtractor={keyExtractor}
                    ListFooterComponent={<Footer />}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    onLoad={() => { loadCount += 1; }}
                    recycleItems={false}
                    renderItem={renderRow}
                />
            </div>
        );

        // Time is advanced in SHORT steps throughout. Legend arms a 2s fallback that clears the
        // preserved at-end target (`PRESERVED_INITIAL_SCROLL_FALLBACK_CLEAR_DELAY_MS = 2e3`), after
        // which the footer path returns early at `:2808 !initialScroll`. A streaming transcript
        // never grants that 2s of quiet — its footer is moving continuously — so a harness that
        // flushes all pending timers would clear the target and test nothing.
        const frame = async (flush: boolean) => {
            await act(async () => {
                if (flush) flushResizeObservers();
                await vi.advanceTimersByTimeAsync(16);
            });
        };

        // The footer moves throughout — including DURING the open window, while Legend's bootstrap
        // initial-scroll session is still live. That is the only state in which
        // `handleBootstrapInitialScrollFooterLayout` passes its `:2811` gate, so a run that only
        // moves the footer after settle cannot reach the reset at all.
        const opacityTimeline: Array<number | null> = [];
        const didFinishTimeline: Array<boolean | undefined> = [];
        const FOOTER_STEPS = new Map<number, number>([
            [6, 96], [10, 148], [22, 210], [30, 262], [38, 172], [46, 300],
        ]);

        await act(async () => { root.render(tree()); });
        const totalFrames = MOUNT_PASSES * 2 + SETTLE_FRAMES + OBSERVE_FRAMES * 2;
        for (let step = 0; step < totalFrames; step += 1) {
            const nextHeight = FOOTER_STEPS.get(step);
            if (nextHeight !== undefined) {
                footerHeight = nextHeight;
                await act(async () => { root.render(tree()); });
            }
            await frame(step % 2 === 0);
            opacityTimeline.push(readRowContainerOpacity(container));
            didFinishTimeline.push(capturedContext?.state.didFinishInitialScroll);
        }

        const loadCountAfter = loadCount;
        await act(async () => { root.unmount(); });
        container.remove();

        // Non-vacuity: the list really revealed, and Legend really received footer size changes.
        const revealFrame = opacityTimeline.findIndex((value) => value === 1);
        expect(footerDeliveries).toBeGreaterThan(1);
        expect(revealFrame).toBeGreaterThanOrEqual(0);
        expect(loadCountAfter).toBe(1);

        // The contract: once revealed, the list stays visible across every later footer change.
        // `onLoad` cannot witness a violation — `resetInitialRenderState` never clears `didLoad` —
        // so opacity and Legend's own reveal state are the only honest observers.
        const afterReveal = opacityTimeline.slice(revealFrame);
        const didFinishAfterReveal = didFinishTimeline.slice(revealFrame);
        expect({
            hiddenFramesAfterReveal: afterReveal.filter((value) => value === 0).length,
            unfinishedFramesAfterReveal: didFinishAfterReveal.filter((value) => value === false).length,
        }).toEqual({ hiddenFramesAfterReveal: 0, unfinishedFramesAfterReveal: 0 });
    });
});
