// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList } from '@legendapp/list/react-native';
import * as legendReactNative from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Legend's web build keeps its entire row container at `opacity: 0` until `readyToRender`
 * flips (`react-native.web.mjs`: `ContainersInner` styles `opacity: readyToRender ? 1 : 0`,
 * and `setInitialRenderState` sets `readyToRender` in the same block that emits `onLoad`).
 * `readyToRender` needs `didContainersLayout`, whose only producer is the `checkAllSizesKnown`
 * gate inside `calculateItemsInView`.
 *
 * `checkAllSizesKnown` is a MUTATING predicate: it validates every mounted row's
 * `getItemSizeVersion` and DELETES the cached size of any row whose version moved. The check
 * that asks "is every mounted row measured?" can therefore make a mounted row unmeasured -
 * including from inside the gate's own evaluation.
 *
 * That is only safe if invalidating a MOUNTED row also schedules its re-measurement, because
 * nothing else will. A row whose signature moved without its height moving produces no
 * ResizeObserver delivery, and `measureContainersInLayoutEffect` only runs for containers
 * scheduled through `scheduleContainerLayout`. An invalidation observed at or after the final
 * measurement flush therefore strands `didContainersLayout === false` for the life of the
 * mount: `applyItemSize` also discards `needsRecalculate` while that guard is false, so no
 * further `calculateItemsInView` runs either. Rows stay in the DOM, permanently invisible, and
 * `onLoad` never arrives - a blank transcript, not a slow one.
 *
 * The transcript arms exactly this path in production: `ChatListInternal` wires
 * `getItemSizeVersion` to the full row-shell signature, and a signature moves whenever a row
 * re-shapes (streaming revision, tool-call state) - frequently with no height change.
 *
 * The contract is asserted on container opacity and `onLoad`, never on row presence: a stalled
 * list has all of its rows mounted the whole time. That is the trap.
 *
 * Opacity alone is not the contract either, because opacity is exactly what the plausible wrong
 * fix forges. A build that hardcodes `isReadyToRender = true` (`:883`) and `opacity: 1`
 * (`:5899`/`:5902`) reveals a list Legend never laid out - rows painted at estimate-derived
 * offsets, `didContainersLayout` never set - and a pixel-only assertion cannot tell that apart
 * from the owner-level repair. So this test reads Legend's own reveal state at the instant of the
 * reveal, through the `internal.useStateContext` runtime export, and requires all three facts
 * that a genuine reveal implies:
 *
 *   - at the reveal, `didContainersLayout === true` - the container-layout gate really passed;
 *   - at the reveal, `didFinishInitialScroll === true` - the initial scroll really landed;
 *   - once settled, every MOUNTED row's `sizesKnown` entry equals that row's real rendered
 *     height - Legend measured them, rather than positioning from `estimatedItemSize`.
 *
 * The third is the one no reveal shortcut can forge: forcing `readyToRender` never produces the
 * missing measurement, so an invalidated row that nothing re-measures is still visible here. It
 * is checked once the mount has settled rather than at the reveal, because an invalidation
 * observed at the reveal itself is legitimately still in flight at that instant - the fix's whole
 * claim is that its re-measurement is already scheduled by then.
 */

type LivenessRow = Readonly<{ id: string }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

/**
 * The slice of Legend's signal context this harness reads. `internal.useStateContext` is a real
 * runtime export of the installed build but is absent from its `.d.ts`, so the shape is declared
 * here and cast once, at the boundary, below.
 */
type LegendRevealContext = Readonly<{
    state: Readonly<{
        /** itemKey -> mounted container id. */
        containerItemKeys: Map<string, number>;
        didContainersLayout?: boolean;
        didFinishInitialScroll?: boolean;
        /** itemKey -> measured size. Absent for a row Legend has not measured. */
        sizesKnown: Map<string, number>;
    }>;
}>;

/** Legend's own state at the instant it revealed the list (read from inside `onLoad`). */
type RevealState = Readonly<{
    didContainersLayout: boolean | undefined;
    didFinishInitialScroll: boolean | undefined;
    mountedRowCount: number;
}>;

type MountOutcome = Readonly<{
    contextCaptured: boolean;
    finalLoadCount: number;
    finalOpacity: number | null;
    finalRows: number;
    invalidatedRowId: string | null;
    invalidatedRowStillMounted: boolean;
    invalidationWasPreLoad: boolean;
    observations: number;
    observationsAtLoad: number | null;
    revealState: RevealState | null;
    /** Mounted rows still carrying no real measurement once the mount has settled. */
    settledUnmeasuredRows: readonly string[];
}>;

const HOST_ID = 'legend-liveness-host';
const ROW_TESTID_PREFIX = 'legend-liveness-row-';
const ROW_COUNT = 40;
const VIEWPORT_HEIGHT = 500;
const ESTIMATED_ROW_HEIGHT = 100;
/** Measurement passes to step through while the list mounts. */
const MOUNT_PASSES = 8;
/** Frames after the mount passes with no new measurement delivery - a settled list. */
const SETTLE_FRAMES = 12;

const resizeObservers = new Set<ResizeObserverRecord>();
const rowVersions = new Map<string, string>();
/** Last size delivered per element, so the observer only fires on a real size change. */
const lastDeliveredSize = new WeakMap<Element, Readonly<{ height: number; width: number }>>();

const DATA: readonly LivenessRow[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    id: `row-${index}`,
}));

/**
 * The run currently mounting. `getItemSizeVersion` must keep a stable identity across renders
 * (`useWrapIfItem` memoizes on the function reference), so the per-run controls live here
 * rather than in a closure.
 */
type ActiveRun = {
    context: LegendRevealContext | null;
    invalidateAtObservation: number | null;
    invalidatedRowId: string | null;
    invalidationWasPreLoad: boolean;
    observations: number;
    observationsAtLoad: number | null;
    revealState: RevealState | null;
};

let activeRun: ActiveRun = {
    context: null,
    invalidateAtObservation: null,
    invalidatedRowId: null,
    invalidationWasPreLoad: false,
    observations: 0,
    observationsAtLoad: null,
    revealState: null,
};

/** Heights deliberately differ from `estimatedItemSize`, so measurement is load-bearing. */
function heightOfRowId(id: string): number {
    const index = Number.parseInt(id.slice('row-'.length), 10);
    return 70 + (index % 4) * 45;
}

function keyExtractor(item: LivenessRow): string {
    return item.id;
}

/**
 * The app-facing size-version contract. Moving the answer at observation N models a row whose
 * shape changed at that exact instant - with no re-render and no height change, which is the
 * common transcript case (a revised message that reflows to the same height).
 */
function getItemSizeVersion(item: LivenessRow): React.Key {
    const observation = activeRun.observations;
    activeRun.observations += 1;
    if (observation === activeRun.invalidateAtObservation && activeRun.invalidatedRowId === null) {
        activeRun.invalidatedRowId = item.id;
        activeRun.invalidationWasPreLoad = activeRun.observationsAtLoad === null;
        rowVersions.set(item.id, 'v1');
    }
    return `${item.id}@${rowVersions.get(item.id) ?? 'v0'}`;
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

function rowIdOfElement(element: HTMLElement): string | null {
    const row = element.matches(`[data-testid^="${ROW_TESTID_PREFIX}"]`)
        ? element
        : element.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    const testId = row?.dataset.testid;
    return testId ? testId.slice(ROW_TESTID_PREFIX.length) : null;
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === HOST_ID) return rect(800, VIEWPORT_HEIGHT);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const rowId = rowIdOfElement(htmlElement);
    if (rowId !== null) return rect(800, heightOfRowId(rowId));
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 0);
}

/**
 * A faithful ResizeObserver: an entry is delivered only when an element's measured size
 * actually changed. A version move that leaves the height alone produces no delivery - which
 * is precisely why the invalidated row cannot repair itself.
 */
function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries: ResizeObserverEntry[] = [];
        for (const element of observer.elements) {
            const next = measuredRect(element);
            const previous = lastDeliveredSize.get(element);
            if (previous && previous.height === next.height && previous.width === next.width) {
                continue;
            }
            lastDeliveredSize.set(element, { height: next.height, width: next.width });
            entries.push({
                borderBoxSize: [],
                contentBoxSize: [],
                contentRect: next,
                devicePixelContentBoxSize: [],
                target: element,
            } as unknown as ResizeObserverEntry);
        }
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

/**
 * Reads Legend's signal context from inside a mounted row. `useStateContext` is a plain
 * `useContext` read, so this is behaviour-neutral - it observes the reveal, it does not shape it.
 */
function useCapturedLegendContext(): void {
    const legendInternal = (legendReactNative as unknown as {
        internal: { useStateContext: () => LegendRevealContext };
    }).internal;
    activeRun.context = legendInternal.useStateContext();
}

function ProbeRow({ item }: Readonly<{ item: LivenessRow }>): React.ReactElement {
    useCapturedLegendContext();
    return (
        <div data-testid={`${ROW_TESTID_PREFIX}${item.id}`} style={{ height: heightOfRowId(item.id) }}>
            {item.id}
        </div>
    );
}

function renderRow({ item }: Readonly<{ item: LivenessRow }>): React.ReactElement {
    return <ProbeRow item={item} />;
}

/**
 * Snapshots what Legend actually knew at the instant it revealed the list. `onLoad` is emitted
 * from the same block that flips `readyToRender` (`setInitialRenderState`), after
 * `didContainersLayout` / `didFinishInitialScroll` are assigned - so this is the reveal-time
 * state, not the settled-later state.
 */
function captureRevealState(run: ActiveRun): RevealState {
    const state = run.context?.state;
    return {
        didContainersLayout: state?.didContainersLayout,
        didFinishInitialScroll: state?.didFinishInitialScroll,
        mountedRowCount: state?.containerItemKeys.size ?? 0,
    };
}

/**
 * Mounted rows Legend has no real measurement for. A row whose size was invalidated and never
 * re-measured stays here forever, and the list is then positioned from `estimatedItemSize`
 * instead of from what it rendered. Read once the mount has settled, because an invalidation
 * observed at the reveal itself is legitimately still in flight at that instant - the whole point
 * of the fix is that its re-measurement is already scheduled.
 */
function unmeasuredMountedRows(run: ActiveRun): readonly string[] {
    const state = run.context?.state;
    if (!state) return [];
    const unmeasured: string[] = [];
    for (const key of state.containerItemKeys.keys()) {
        if (state.sizesKnown.get(key) !== heightOfRowId(key)) unmeasured.push(key);
    }
    return unmeasured;
}

/**
 * The row container is the nearest ancestor of a mounted row carrying an explicit opacity -
 * the element `ContainersInner` styles from `readyToRender`.
 */
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

function mountedRowIds(scope: HTMLElement): readonly string[] {
    return [...scope.querySelectorAll<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`)]
        .map((element) => element.dataset.testid?.slice(ROW_TESTID_PREFIX.length))
        .filter((id): id is string => id !== undefined);
}

describe('Legend web readyToRender liveness across a size-version invalidation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

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
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
            clearTimeout(handle);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    /**
     * Mounts a fresh list, optionally moving one row's size version at a chosen version
     * observation, then settles with no further measurement deliveries - which is what a real
     * browser delivers when nothing changed size.
     */
    async function mountWithInvalidation(
        invalidateAtObservation: number | null,
    ): Promise<MountOutcome> {
        rowVersions.clear();
        activeRun = {
            context: null,
            invalidateAtObservation,
            invalidatedRowId: null,
            invalidationWasPreLoad: false,
            observations: 0,
            observationsAtLoad: null,
            revealState: null,
        };
        const run = activeRun;
        const container = document.createElement('div');
        container.style.height = `${VIEWPORT_HEIGHT}px`;
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        let loadCount = 0;

        const tree = (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={DATA}
                    drawDistance={0}
                    estimatedItemSize={ESTIMATED_ROW_HEIGHT}
                    getItemSizeVersion={getItemSizeVersion}
                    initialScrollAtEnd
                    keyExtractor={keyExtractor}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    onLoad={() => {
                        loadCount += 1;
                        run.observationsAtLoad ??= run.observations;
                        run.revealState ??= captureRevealState(run);
                    }}
                    recycleItems={false}
                    renderItem={renderRow}
                />
            </div>
        );

        await act(async () => {
            root.render(tree);
        });

        // Each mount pass is two atomic steps: deliver whatever measurements changed, then let
        // the frames those measurements queued run.
        for (let step = 0; step < MOUNT_PASSES * 2; step += 1) {
            await act(async () => {
                if (step % 2 === 0) flushResizeObservers();
                else await vi.runOnlyPendingTimersAsync();
            });
        }
        for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
            await act(async () => {
                await vi.runOnlyPendingTimersAsync();
            });
        }

        const stillMounted = mountedRowIds(container);
        const outcome: MountOutcome = {
            contextCaptured: run.context !== null,
            finalLoadCount: loadCount,
            finalOpacity: readRowContainerOpacity(container),
            finalRows: stillMounted.length,
            invalidatedRowId: run.invalidatedRowId,
            invalidatedRowStillMounted:
                run.invalidatedRowId !== null && stillMounted.includes(run.invalidatedRowId),
            invalidationWasPreLoad: run.invalidationWasPreLoad,
            observations: run.observations,
            observationsAtLoad: run.observationsAtLoad,
            revealState: run.revealState,
            settledUnmeasuredRows: unmeasuredMountedRows(run),
        };

        await act(async () => {
            root.unmount();
        });
        container.remove();
        return outcome;
    }

    it('reveals the list however late the size-version invalidation is observed', async () => {
        // Calibrate against this Legend build rather than a hard-coded number: how many
        // version observations does an undisturbed mount make before it reveals itself?
        const baseline = await mountWithInvalidation(null);
        expect(baseline.finalOpacity).toBe(1);
        expect(baseline.finalLoadCount).toBe(1);
        expect(baseline.contextCaptured).toBe(true);
        expect(baseline.observationsAtLoad).not.toBeNull();
        const preLoadObservations = baseline.observationsAtLoad ?? 0;
        expect(preLoadObservations).toBeGreaterThan(0);

        // Move one row's version at every observation up to and including the one the reveal
        // depends on. The last of these lands inside the gate's own `checkAllSizesKnown` call -
        // the moment after which nothing re-measures the row it just invalidated.
        const outcomes: MountOutcome[] = [];
        for (let observation = 0; observation <= preLoadObservations; observation += 1) {
            outcomes.push(await mountWithInvalidation(observation));
        }

        // Non-vacuity: the invalidations really happened, before the reveal, on rows that stay
        // mounted - so `checkAllSizesKnown` genuinely has to answer for them.
        const preLoadInvalidations = outcomes.filter(
            (outcome) => outcome.invalidationWasPreLoad && outcome.invalidatedRowStillMounted,
        );
        expect(preLoadInvalidations.length).toBeGreaterThan(0);
        expect(outcomes.every((outcome) => outcome.invalidatedRowId !== null)).toBe(true);
        expect(outcomes.every((outcome) => outcome.contextCaptured)).toBe(true);

        // The contract. Row presence proves nothing here: a stalled list has every row in the
        // DOM at opacity 0, which is a blank transcript, not a slow one.
        const stalled = outcomes.filter(
            (outcome) => outcome.finalOpacity !== 1 || outcome.finalLoadCount !== 1,
        );
        expect(
            stalled.map((outcome) => ({
                loadCount: outcome.finalLoadCount,
                opacity: outcome.finalOpacity,
                row: outcome.invalidatedRowId,
                rows: outcome.finalRows,
            })),
        ).toEqual([]);
        expect(outcomes.every((outcome) => outcome.finalRows > 0)).toBe(true);

        // Opacity is what the plausible wrong fix forges, so the reveal must also be EARNED.
        // Legend's own gate state at the instant of the reveal has to say the layout completed
        // and the initial scroll landed - a build that hardcodes `isReadyToRender`/`opacity`
        // paints identical pixels while `didContainersLayout` was never set, and fails here.
        const allOutcomes = [baseline, ...outcomes];
        const unearnedReveals = allOutcomes
            .map((outcome) => ({ outcome, reveal: outcome.revealState }))
            .filter(({ reveal }) => (
                reveal === null
                || reveal.didContainersLayout !== true
                || reveal.didFinishInitialScroll !== true
                || reveal.mountedRowCount === 0
            ));
        expect(
            unearnedReveals.map(({ outcome, reveal }) => ({
                didContainersLayout: reveal?.didContainersLayout ?? null,
                didFinishInitialScroll: reveal?.didFinishInitialScroll ?? null,
                mountedRows: reveal?.mountedRowCount ?? null,
                row: outcome.invalidatedRowId,
            })),
        ).toEqual([]);

        // And the layout it claims must be a real one: once settled, no mounted row may still be
        // waiting for a measurement. This is the fix's own contract - invalidating a mounted row
        // schedules its re-measurement - and it is the part no reveal shortcut can forge, because
        // forcing `readyToRender` never produces the missing measurement.
        expect(
            allOutcomes
                .filter((outcome) => outcome.settledUnmeasuredRows.length > 0)
                .map((outcome) => ({
                    row: outcome.invalidatedRowId,
                    unmeasured: outcome.settledUnmeasuredRows,
                })),
        ).toEqual([]);
    });
});
