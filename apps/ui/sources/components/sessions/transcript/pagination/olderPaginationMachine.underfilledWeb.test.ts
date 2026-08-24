import { describe, expect, it } from 'vitest';

import {
    createInitialOlderPaginationState,
    reduceOlderPagination,
    shouldLoadNow,
    type OlderPaginationScrollTrigger,
    type OlderPaginationState,
} from './olderPaginationMachine';

/**
 * Does the older pager recover a transcript that opened UNDERFILLED?
 *
 * PR #305 removes the web session-open fill loop and relies on "the existing threshold
 * pager can continue historical backfill after readiness". That premise is only true if
 * the pager can arm without the user scrolling — and an underfilled transcript cannot be
 * scrolled, because its content is shorter than its viewport.
 *
 * These tests drive the canonical machine directly, so the answer does not depend on any
 * particular list renderer.
 */

function openWebSessionUnderfilled(): OlderPaginationState {
    // Post-open state on the PR's web path: fill reported done, more history on the server.
    let state = createInitialOlderPaginationState();
    state = reduceOlderPagination(state, { type: 'resume', reason: 'fill-not-done' });
    return state;
}

// What a list whose content is shorter than its viewport reports: parked at the top,
// nothing to scroll. `scrollable: false` is the whole point — it is not incidental.
function underfilledObservation(trigger: OlderPaginationScrollTrigger) {
    return {
        type: 'scrollObserved' as const,
        offsetY: 0,
        thresholdPx: 400,
        scrollable: false,
        trigger,
        itemsToOlderEdge: 0,
        thresholdItems: 4,
    };
}

describe('older pagination on an underfilled web transcript', () => {
    it.each<OlderPaginationScrollTrigger>(['scroll', 'edge-reached', 'layout-committed'])(
        'never arms from a non-scrollable viewport (trigger: %s)',
        (trigger) => {
            let state = openWebSessionUnderfilled();
            // Repeat: a real app emits these continuously as layout settles.
            for (let i = 0; i < 20; i += 1) {
                state = reduceOlderPagination(state, underfilledObservation(trigger));
                expect(shouldLoadNow(state)).toBe(false);
            }
            expect(state.phase).toBe('idle');
            expect(state.insideThreshold).toBe(false);
        },
    );

    it('never arms even when every trigger is interleaved', () => {
        let state = openWebSessionUnderfilled();
        const triggers: OlderPaginationScrollTrigger[] = ['layout-committed', 'scroll', 'edge-reached'];
        for (let i = 0; i < 30; i += 1) {
            state = reduceOlderPagination(state, underfilledObservation(triggers[i % 3]!));
            expect(shouldLoadNow(state)).toBe(false);
        }
    });

    it('arms as soon as the SAME viewport becomes scrollable — the fill loop is what produced that', () => {
        // The contrast case: identical position and trigger, only `scrollable` differs.
        // This is exactly what the removed fill loop guaranteed before settling the latch.
        let state = openWebSessionUnderfilled();
        state = reduceOlderPagination(state, underfilledObservation('scroll'));
        expect(shouldLoadNow(state)).toBe(false);

        // Content now exceeds the viewport, and the reader is away from the top.
        state = reduceOlderPagination(state, {
            type: 'scrollObserved',
            offsetY: 5000,
            thresholdPx: 400,
            scrollable: true,
            trigger: 'scroll',
        });
        // Then they scroll up into the threshold: the EXIT -> ENTER transition the machine requires.
        state = reduceOlderPagination(state, {
            type: 'scrollObserved',
            offsetY: 100,
            thresholdPx: 400,
            scrollable: true,
            trigger: 'scroll',
        });

        expect(shouldLoadNow(state)).toBe(true);
    });
});
