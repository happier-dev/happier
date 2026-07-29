import { describe, expect, it } from 'vitest';

import {
    createInitialOlderPaginationState,
    isOlderPaginationBusyNearEdge,
    reduceOlderPagination,
    resolveItemsToOlderEdge,
    shouldLoadNow,
    type OlderPaginationEvent,
    type OlderPaginationState,
} from './olderPaginationMachine';

function run(state: OlderPaginationState, events: readonly OlderPaginationEvent[]): OlderPaginationState {
    return events.reduce(reduceOlderPagination, state);
}

function scrollObserved(params: Partial<{
    offsetY: number;
    thresholdPx: number;
    scrollable: boolean;
    trigger: 'scroll' | 'edge-reached' | 'layout-committed';
}>): OlderPaginationEvent {
    return {
        type: 'scrollObserved',
        offsetY: params.offsetY ?? 100,
        thresholdPx: params.thresholdPx ?? 400,
        scrollable: params.scrollable ?? true,
        trigger: params.trigger ?? 'scroll',
    };
}

const enterInsideThreshold = scrollObserved({ offsetY: 100 });
const exitOutsideThreshold = scrollObserved({ offsetY: 5000 });

describe('olderPaginationMachine', () => {
    it('starts idle, outside threshold, with more pages assumed and no suspensions', () => {
        const state = createInitialOlderPaginationState();
        expect(state.phase).toBe('idle');
        expect(state.insideThreshold).toBe(false);
        expect(state.hasMore).toBe(true);
        expect(state.suspendedReasons.size).toBe(0);
        expect(shouldLoadNow(state)).toBe(false);
    });

    it('arms on threshold ENTER from outside and reports shouldLoadNow', () => {
        const state = run(createInitialOlderPaginationState(), [enterInsideThreshold]);
        expect(state.phase).toBe('armed');
        expect(state.insideThreshold).toBe(true);
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('allows exactly one load in flight: a second loadStarted is a no-op', () => {
        const loading = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
        ]);
        expect(loading.phase).toBe('loading');
        expect(shouldLoadNow(loading)).toBe(false);

        const again = reduceOlderPagination(loading, { type: 'loadStarted' });
        expect(again).toEqual(loading);
    });

    it('ignores loadStarted unless armed', () => {
        const idle = createInitialOlderPaginationState();
        expect(reduceOlderPagination(idle, { type: 'loadStarted' }).phase).toBe('idle');

        const cooldown = run(idle, [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
        ]);
        expect(cooldown.phase).toBe('cooldown');
        expect(reduceOlderPagination(cooldown, { type: 'loadStarted' }).phase).toBe('cooldown');
    });

    it('does not arm again while staying inside the threshold after a load (re-arm requires EXIT then ENTER)', () => {
        const afterLoad = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
            { type: 'cooldownElapsed' },
        ]);
        expect(afterLoad.phase).toBe('idle');

        const stillInside = run(afterLoad, [enterInsideThreshold, enterInsideThreshold]);
        expect(stillInside.phase).toBe('idle');
        expect(shouldLoadNow(stillInside)).toBe(false);

        const rearmed = run(stillInside, [exitOutsideThreshold, enterInsideThreshold]);
        expect(rearmed.phase).toBe('armed');
        expect(shouldLoadNow(rearmed)).toBe(true);
    });

    it('de-arms when the threshold is exited while armed', () => {
        const state = run(createInitialOlderPaginationState(), [enterInsideThreshold, exitOutsideThreshold]);
        expect(state.phase).toBe('idle');
        expect(state.insideThreshold).toBe(false);
    });

    it('treats missing or invalid layout metrics as outside the threshold (optimistic-metrics fix)', () => {
        const armed = run(createInitialOlderPaginationState(), [enterInsideThreshold]);

        const nonScrollable = reduceOlderPagination(armed, scrollObserved({ scrollable: false }));
        expect(nonScrollable.phase).toBe('idle');
        expect(nonScrollable.insideThreshold).toBe(false);

        const nanOffset = reduceOlderPagination(armed, scrollObserved({ offsetY: Number.NaN }));
        expect(nanOffset.phase).toBe('idle');
        expect(nanOffset.insideThreshold).toBe(false);

        const nanThreshold = reduceOlderPagination(armed, scrollObserved({ thresholdPx: Number.NaN }));
        expect(nanThreshold.phase).toBe('idle');
        expect(nanThreshold.insideThreshold).toBe(false);

        const zeroThreshold = reduceOlderPagination(armed, scrollObserved({ thresholdPx: 0 }));
        expect(zeroThreshold.phase).toBe('idle');
        expect(zeroThreshold.insideThreshold).toBe(false);
    });

    it('allows an explicit edge-reached trigger at exact zero to load once when eligible', () => {
        const atExactEdge = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
        ]);
        expect(atExactEdge.suspendedReasons.has('negative-offset')).toBe(false);
        expect(atExactEdge.phase).toBe('armed');
        expect(shouldLoadNow(atExactEdge)).toBe(true);
    });

    it('allows an explicit edge-reached trigger at a near-top fractional offset to load once when eligible', () => {
        // The web scroll element reports `scrollTop` as an integer-rounded / sub-pixel-residue
        // value, so a viewport resting at the genuine top is rarely EXACTLY 0 (e.g. 1 at dpr=1,
        // 0.5/0.33 on Retina). The exact-edge re-arm must accept the same near-top band the
        // genuine-top classifier emits, otherwise the machine starves on those frames.
        const atNearTop = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 1, trigger: 'edge-reached' }),
        ]);
        expect(atNearTop.suspendedReasons.has('negative-offset')).toBe(false);
        expect(atNearTop.phase).toBe('armed');
        expect(shouldLoadNow(atNearTop)).toBe(true);
    });

    it('re-arms after cooldown from a near-top edge-reached frame without requiring a threshold exit', () => {
        const afterLoad = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 1, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
            scrollObserved({ offsetY: 0.5, trigger: 'edge-reached' }),
            { type: 'cooldownElapsed' },
        ]);
        expect(afterLoad.phase).toBe('armed');
        expect(shouldLoadNow(afterLoad)).toBe(true);
    });

    it('does not initiate a load from a non-edge committed layout inside the prefetch threshold', () => {
        const afterLayout = reduceOlderPagination(
            createInitialOlderPaginationState(),
            scrollObserved({ offsetY: 100, trigger: 'layout-committed' }),
        );

        expect(afterLayout.insideThreshold).toBe(true);
        expect(afterLayout.phase).toBe('idle');
        expect(shouldLoadNow(afterLayout)).toBe(false);
    });

    it('allows an exact committed layout to initiate a load when no earlier edge callback arrived', () => {
        const afterLayout = reduceOlderPagination(
            createInitialOlderPaginationState(),
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
        );

        expect(afterLayout.phase).toBe('armed');
        expect(shouldLoadNow(afterLayout)).toBe(true);
    });

    it('keeps passive scroll observations within the near-top band suspended so parked-at-top scrolls cannot burst', () => {
        const atTop = run(createInitialOlderPaginationState(), [scrollObserved({ offsetY: 0 })]);
        expect(atTop.suspendedReasons.has('negative-offset')).toBe(true);
        expect(shouldLoadNow(atTop)).toBe(false);

        // A passive (non-edge-reached) near-top fractional frame stays suspended too — only an
        // explicit edge-reached trigger gets the near-top treatment (anti-burst preserved).
        const nearTopPassive = run(createInitialOlderPaginationState(), [scrollObserved({ offsetY: 1 })]);
        expect(nearTopPassive.suspendedReasons.has('negative-offset')).toBe(true);
        expect(shouldLoadNow(nearTopPassive)).toBe(false);
    });

    it('keeps an edge-reached trigger beyond the near-top epsilon suspended at exact-band only (no widening)', () => {
        // 2px is past the 1.5px epsilon: it must NOT get the exact-edge treatment, so a viewport
        // truly off the top cannot masquerade as the genuine top.
        const beyondEpsilon = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 2, thresholdPx: 1, trigger: 'edge-reached' }),
        ]);
        // offsetY 2 > thresholdPx 1 -> outside the threshold entirely, never arms.
        expect(beyondEpsilon.phase).toBe('idle');
        expect(shouldLoadNow(beyondEpsilon)).toBe(false);
    });

    it('suspends loads while the observed offset is negative and resumes once positive', () => {
        const negative = run(createInitialOlderPaginationState(), [scrollObserved({ offsetY: -12 })]);
        expect(negative.suspendedReasons.has('negative-offset')).toBe(true);
        expect(shouldLoadNow(negative)).toBe(false);

        const recovered = reduceOlderPagination(negative, scrollObserved({ offsetY: 50 }));
        expect(recovered.suspendedReasons.has('negative-offset')).toBe(false);
        expect(shouldLoadNow(recovered)).toBe(true);
    });

    it('continues a successful exact-edge load when its committed layout remains at the edge', () => {
        const afterLoad = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 10, hasMore: true },
            { type: 'cooldownElapsed' },
        ]);

        expect(afterLoad.phase).toBe('armed');
        expect(shouldLoadNow(afterLoad)).toBe(true);
    });

    it('continues a successful exact-edge load when its committed layout arrives after the load result', () => {
        const afterLoad = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'cooldownElapsed' },
        ]);

        expect(afterLoad.phase).toBe('armed');
        expect(shouldLoadNow(afterLoad)).toBe(true);
    });

    it.each([
        ['only the initiating edge callback was observed', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            { type: 'loadFinished', loaded: 10, hasMore: true } as const,
            { type: 'cooldownElapsed' } as const,
        ]],
        ['the viewport leaves the exact edge', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            scrollObserved({ offsetY: 300, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 10, hasMore: true } as const,
            { type: 'cooldownElapsed' } as const,
        ]],
        ['a spinner commit is followed by a settled off-edge layout', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 10, hasMore: true } as const,
            scrollObserved({ offsetY: 300, trigger: 'layout-committed' }),
            { type: 'cooldownElapsed' } as const,
        ]],
        ['a late spinner commit is followed by a settled off-edge layout', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            { type: 'loadFinished', loaded: 10, hasMore: true } as const,
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            scrollObserved({ offsetY: 300, trigger: 'layout-committed' }),
            { type: 'cooldownElapsed' } as const,
        ]],
        ['the load fails', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 0, hasMore: true, error: true } as const,
            { type: 'cooldownElapsed' } as const,
        ]],
        ['the load makes no progress', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 0, hasMore: true } as const,
            { type: 'cooldownElapsed' } as const,
        ]],
        ['a late exact layout follows a failed load', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            { type: 'loadFinished', loaded: 0, hasMore: true, error: true } as const,
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'cooldownElapsed' } as const,
        ]],
        ['a late exact layout follows a zero-progress load', [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' } as const,
            { type: 'loadFinished', loaded: 0, hasMore: true } as const,
            scrollObserved({ offsetY: 0, trigger: 'layout-committed' }),
            { type: 'cooldownElapsed' } as const,
        ]],
    ])('does not continue an exact-edge load when %s', (_reason, events) => {
        const afterCooldown = run(createInitialOlderPaginationState(), events);

        expect(afterCooldown.phase).toBe('idle');
        expect(shouldLoadNow(afterCooldown)).toBe(false);
    });

    it('suspends while a viewport transaction is open and resumes on resume()', () => {
        const armed = run(createInitialOlderPaginationState(), [
            { type: 'suspend', reason: 'transaction-open' },
            enterInsideThreshold,
        ]);
        expect(armed.phase).toBe('armed');
        expect(shouldLoadNow(armed)).toBe(false);

        const resumed = reduceOlderPagination(armed, { type: 'resume', reason: 'transaction-open' });
        expect(shouldLoadNow(resumed)).toBe(true);
    });

    it('suspends while the initial fill is not done', () => {
        const state = run(createInitialOlderPaginationState(), [
            { type: 'suspend', reason: 'fill-not-done' },
            enterInsideThreshold,
        ]);
        expect(shouldLoadNow(state)).toBe(false);
        expect(shouldLoadNow(reduceOlderPagination(state, { type: 'resume', reason: 'fill-not-done' }))).toBe(true);
    });

    it('requires every suspension reason to clear before loading', () => {
        const state = run(createInitialOlderPaginationState(), [
            { type: 'suspend', reason: 'transaction-open' },
            { type: 'suspend', reason: 'fill-not-done' },
            enterInsideThreshold,
        ]);
        const oneCleared = reduceOlderPagination(state, { type: 'resume', reason: 'transaction-open' });
        expect(shouldLoadNow(oneCleared)).toBe(false);
        const allCleared = reduceOlderPagination(oneCleared, { type: 'resume', reason: 'fill-not-done' });
        expect(shouldLoadNow(allCleared)).toBe(true);
    });

    it('honors the cooldown after each load before any re-arm', () => {
        const cooldown = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
        ]);
        expect(cooldown.phase).toBe('cooldown');
        expect(shouldLoadNow(cooldown)).toBe(false);

        const duringCooldown = run(cooldown, [exitOutsideThreshold, enterInsideThreshold]);
        expect(duringCooldown.phase).toBe('cooldown');
        expect(shouldLoadNow(duringCooldown)).toBe(false);
    });

    it('re-arms at cooldownElapsed when an EXIT then ENTER happened during the cooldown', () => {
        const state = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
            exitOutsideThreshold,
            enterInsideThreshold,
            { type: 'cooldownElapsed' },
        ]);
        expect(state.phase).toBe('armed');
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('does NOT re-arm at cooldownElapsed when the user stayed inside the threshold the whole time (anti-burst E6)', () => {
        const state = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 10, hasMore: true },
            enterInsideThreshold,
            { type: 'cooldownElapsed' },
        ]);
        expect(state.phase).toBe('idle');
        expect(shouldLoadNow(state)).toBe(false);
    });

    it('ignores cooldownElapsed outside the cooldown phase', () => {
        const armed = run(createInitialOlderPaginationState(), [enterInsideThreshold]);
        expect(reduceOlderPagination(armed, { type: 'cooldownElapsed' })).toEqual(armed);
    });

    it('treats hasMore=false as terminal until reset', () => {
        const exhausted = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 0, hasMore: false },
        ]);
        expect(exhausted.hasMore).toBe(false);
        expect(exhausted.phase).toBe('idle');

        const afterScroll = run(exhausted, [exitOutsideThreshold, enterInsideThreshold]);
        expect(afterScroll.phase).toBe('idle');
        expect(shouldLoadNow(afterScroll)).toBe(false);

        const fresh = reduceOlderPagination(afterScroll, { type: 'reset' });
        expect(fresh).toEqual(createInitialOlderPaginationState());
        const rearmed = run(fresh, [enterInsideThreshold]);
        expect(shouldLoadNow(rearmed)).toBe(true);
    });

    it('moves to cooldown on load error without flipping hasMore (no tight retry loop)', () => {
        const errored = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 0, hasMore: false, error: true },
        ]);
        expect(errored.phase).toBe('cooldown');
        expect(errored.hasMore).toBe(true);
        expect(shouldLoadNow(errored)).toBe(false);

        const stillInside = run(errored, [enterInsideThreshold, { type: 'cooldownElapsed' }]);
        expect(stillInside.phase).toBe('idle');
        expect(shouldLoadNow(stillInside)).toBe(false);
    });

    it('keeps suspension reasons across phases and ignores duplicate suspend/resume events', () => {
        const suspended = run(createInitialOlderPaginationState(), [
            { type: 'suspend', reason: 'transaction-open' },
            { type: 'suspend', reason: 'transaction-open' },
        ]);
        expect(suspended.suspendedReasons.size).toBe(1);

        const resumedTwice = run(suspended, [
            { type: 'resume', reason: 'transaction-open' },
            { type: 'resume', reason: 'transaction-open' },
        ]);
        expect(resumedTwice.suspendedReasons.size).toBe(0);
    });
});

// Item-space proximity (native virtualized lists): the canonical px offset on native is
// derived from ESTIMATED content height, so its error routinely swallows the px threshold
// (live defect 2026-07-12: older pages only loaded at the literal top; under-estimated
// content produced a NEGATIVE canonical offset that silently suspended loads entirely).
// When the observation carries a valid item-space proximity, it is the authoritative
// edge-proximity truth and the px-derived guards do not apply.
function itemScrollObserved(params: Partial<{
    offsetY: number;
    thresholdPx: number;
    scrollable: boolean;
    trigger: 'scroll' | 'edge-reached' | 'layout-committed';
    itemsToOlderEdge: number | null;
    thresholdItems: number | null;
}>): OlderPaginationEvent {
    return {
        type: 'scrollObserved',
        offsetY: params.offsetY ?? 5000,
        thresholdPx: params.thresholdPx ?? 400,
        scrollable: params.scrollable ?? true,
        trigger: params.trigger ?? 'scroll',
        itemsToOlderEdge: params.itemsToOlderEdge === undefined ? 4 : params.itemsToOlderEdge,
        thresholdItems: params.thresholdItems === undefined ? 12 : params.thresholdItems,
    };
}

describe('olderPaginationMachine item-space proximity', () => {
    it('arms via item proximity even when the estimated px offset is far outside the px threshold', () => {
        const state = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ offsetY: 20_000, itemsToOlderEdge: 40 }),
            itemScrollObserved({ offsetY: 20_000, itemsToOlderEdge: 6 }),
        ]);
        expect(state.phase).toBe('armed');
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('does not suspend on a negative estimated px offset while the item signal is valid', () => {
        const state = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ offsetY: -900, itemsToOlderEdge: 30 }),
            itemScrollObserved({ offsetY: -900, itemsToOlderEdge: 3 }),
        ]);
        expect(state.suspendedReasons.size).toBe(0);
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('does not apply the parked-at-top passive suspension while the item signal is valid', () => {
        const state = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ offsetY: 40, itemsToOlderEdge: 25 }),
            itemScrollObserved({ offsetY: 0.5, itemsToOlderEdge: 2 }),
        ]);
        expect(state.suspendedReasons.size).toBe(0);
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('re-arms through item-space EXIT then ENTER across a prepend (anti-burst preserved)', () => {
        let state = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ itemsToOlderEdge: 40 }),
            itemScrollObserved({ itemsToOlderEdge: 5 }),
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 50, hasMore: true },
        ]);
        // Parked inside the threshold: cooldown elapses, no re-arm (anti-burst).
        state = run(state, [
            itemScrollObserved({ itemsToOlderEdge: 5 }),
            { type: 'cooldownElapsed' },
        ]);
        expect(state.phase).toBe('idle');
        expect(shouldLoadNow(state)).toBe(false);
        // The prepend pushed the older edge 50 items away (EXIT), scrolling up re-enters.
        state = run(state, [
            itemScrollObserved({ itemsToOlderEdge: 55 }),
            itemScrollObserved({ itemsToOlderEdge: 8 }),
        ]);
        expect(state.phase).toBe('armed');
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('accepts an explicit edge-reached retry at item distance zero after cooldown without an exit', () => {
        let state = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ itemsToOlderEdge: 40 }),
            itemScrollObserved({ itemsToOlderEdge: 0 }),
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 3, hasMore: true },
            { type: 'cooldownElapsed' },
        ]);
        expect(state.phase).toBe('idle');
        state = reduceOlderPagination(
            state,
            itemScrollObserved({ itemsToOlderEdge: 0, trigger: 'edge-reached' }),
        );
        expect(state.phase).toBe('armed');
        expect(shouldLoadNow(state)).toBe(true);
    });

    it('continues only when the committed native item fact remains at the edge despite poisoned px offsets', () => {
        const initialOffEdgeCommit = reduceOlderPagination(
            createInitialOlderPaginationState(),
            itemScrollObserved({
                itemsToOlderEdge: 64,
                offsetY: 0,
                trigger: 'layout-committed',
            }),
        );
        expect(initialOffEdgeCommit.phase).toBe('idle');
        expect(shouldLoadNow(initialOffEdgeCommit)).toBe(false);

        const exactCommit = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ itemsToOlderEdge: 0, offsetY: -5000, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            itemScrollObserved({ itemsToOlderEdge: 0, offsetY: -5000, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 64, hasMore: true },
            { type: 'cooldownElapsed' },
        ]);
        expect(exactCommit.phase).toBe('armed');
        expect(shouldLoadNow(exactCommit)).toBe(true);

        const offEdgeCommit = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ itemsToOlderEdge: 0, offsetY: -5000, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            itemScrollObserved({ itemsToOlderEdge: 64, offsetY: 0, trigger: 'layout-committed' }),
            { type: 'loadFinished', loaded: 64, hasMore: true },
            { type: 'cooldownElapsed' },
        ]);
        expect(offEdgeCommit.phase).toBe('idle');
        expect(shouldLoadNow(offEdgeCommit)).toBe(false);
    });

    it('falls back to px semantics when the item signal is missing or invalid', () => {
        const nullItems = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ offsetY: -5, itemsToOlderEdge: null }),
        ]);
        expect(nullItems.suspendedReasons.has('negative-offset')).toBe(true);
        const invalidThreshold = run(createInitialOlderPaginationState(), [
            itemScrollObserved({ offsetY: 5000, itemsToOlderEdge: 3, thresholdItems: null }),
        ]);
        expect(invalidThreshold.insideThreshold).toBe(false);
    });
});

describe('isOlderPaginationBusyNearEdge', () => {
    it('is busy while loading and across the between-pages gap when a follow-up load is coming', () => {
        let state = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
        ]);
        expect(isOlderPaginationBusyNearEdge(state)).toBe(true);
        // The prepend pushed the threshold out (EXIT) and the user scrolled back in
        // (ENTER) while the page was landing: a follow-up load fires at cooldown end —
        // the indicator must span the gap instead of flickering off between pages.
        state = run(state, [
            exitOutsideThreshold,
            enterInsideThreshold,
            { type: 'loadFinished', loaded: 50, hasMore: true },
        ]);
        expect(state.phase).toBe('cooldown');
        expect(isOlderPaginationBusyNearEdge(state)).toBe(true);
        // The imminent armed hop at cooldown end stays busy (no off/on blink).
        state = reduceOlderPagination(state, { type: 'cooldownElapsed' });
        expect(state.phase).toBe('armed');
        expect(isOlderPaginationBusyNearEdge(state)).toBe(true);

        const awaitingLateCommit = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 50, hasMore: true },
        ]);
        expect(awaitingLateCommit.phase).toBe('cooldown');
        expect(isOlderPaginationBusyNearEdge(awaitingLateCommit)).toBe(true);
    });

    it('is not busy when parked after a single page, exhausted, exited, or idle', () => {
        expect(isOlderPaginationBusyNearEdge(createInitialOlderPaginationState())).toBe(false);
        // The committed page placed the viewport away from the exact edge without an
        // EXIT/ENTER cycle: no follow-up load is coming, so the indicator settles.
        const parked = run(createInitialOlderPaginationState(), [
            scrollObserved({ offsetY: 0, trigger: 'edge-reached' }),
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 50, hasMore: true },
            scrollObserved({ offsetY: 300, trigger: 'layout-committed' }),
        ]);
        expect(parked.phase).toBe('cooldown');
        expect(isOlderPaginationBusyNearEdge(parked)).toBe(false);
        const exhausted = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 2, hasMore: false },
        ]);
        expect(isOlderPaginationBusyNearEdge(exhausted)).toBe(false);
        const exited = run(createInitialOlderPaginationState(), [
            enterInsideThreshold,
            { type: 'loadStarted' },
            { type: 'loadFinished', loaded: 50, hasMore: true },
            exitOutsideThreshold,
        ]);
        expect(isOlderPaginationBusyNearEdge(exited)).toBe(false);
    });
});

describe('resolveItemsToOlderEdge', () => {
    it('returns the first source index for a genuine visible subset', () => {
        expect(resolveItemsToOlderEdge({ firstSourceIndex: 40, lastSourceIndex: 48 }, 200)).toBe(40);
        expect(resolveItemsToOlderEdge({ firstSourceIndex: 0, lastSourceIndex: 8 }, 200)).toBe(0);
    });

    it('returns null for a whole-range read (degenerate/unsettled virtualization report)', () => {
        expect(resolveItemsToOlderEdge({ firstSourceIndex: 0, lastSourceIndex: 199 }, 200)).toBeNull();
        expect(resolveItemsToOlderEdge({ firstSourceIndex: 0, lastSourceIndex: 0 }, 1)).toBeNull();
    });

    it('returns null for missing or invalid inputs', () => {
        expect(resolveItemsToOlderEdge(null, 200)).toBeNull();
        expect(resolveItemsToOlderEdge(undefined, 200)).toBeNull();
        expect(resolveItemsToOlderEdge({ firstSourceIndex: -1, lastSourceIndex: 5 }, 200)).toBeNull();
        expect(resolveItemsToOlderEdge({ firstSourceIndex: 6, lastSourceIndex: 5 }, 200)).toBeNull();
        expect(resolveItemsToOlderEdge({ firstSourceIndex: 2, lastSourceIndex: 5 }, 0)).toBeNull();
    });
});
