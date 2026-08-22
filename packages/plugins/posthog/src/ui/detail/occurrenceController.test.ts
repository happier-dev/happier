import { describe, expect, it } from 'vitest';

import type { PosthogProjectedIssueEvent } from './issueEventProjection.js';
import {
    posthogSampleInitialState,
    posthogSampleReducer,
    type PosthogSampleStateV1,
} from './occurrenceController.js';

function event(uuid: string): PosthogProjectedIssueEvent {
    return { uuid, exceptions: [] };
}

const FAILURE = { class: 'permission', code: 'posthog/permission-denied' } as const;

function started(state: PosthogSampleStateV1, token: number): PosthogSampleStateV1 {
    return posthogSampleReducer(state, { kind: 'requestStarted', token });
}

function settled(
    state: PosthogSampleStateV1,
    token: number,
    events: readonly PosthogProjectedIssueEvent[],
    continuation: string | null,
): PosthogSampleStateV1 {
    return posthogSampleReducer(state, {
        kind: 'pageSettled',
        token,
        events,
        omittedRowCount: 0,
        continuation,
    });
}

describe('posthogSampleReducer', () => {
    it('keeps Load more mounted and busy while the next page is in flight', () => {
        // The shared owner's rule (`triage-protocol` pagedPanel.ts): "the affordance
        // stays mounted in its busy state rather than vanishing". Dropping it for the
        // whole in-flight page unmounts the control the reader just pressed and makes
        // the Button's own `busy` prop unreachable.
        const held = settled(started(posthogSampleInitialState(), 1), 1, [event('a')], 'c1');
        const inFlight = started(held, 2);

        expect(inFlight.canLoadMore).toBe(true);
        expect(inFlight.pending).toBe(true);
        expect(inFlight.kind).toBe('ready');
    });

    it('selects the first sampled row of the first page and keeps it across an append', () => {
        let state = settled(started(posthogSampleInitialState(), 1), 1, [event('a'), event('b')], 'c1');
        expect(state.kind).toBe('ready');
        expect(state.selectedUuid).toBe('a');

        state = settled(started(state, 2), 2, [event('c')], null);
        expect(state.rows.map((row) => row.uuid)).toEqual(['a', 'b', 'c']);
        // Appending a page must not move the reader's selection; the Stack Trace panel
        // derives its frames from it.
        expect(state.selectedUuid).toBe('a');
        expect(state.canLoadMore).toBe(false);
    });

    it('refuses a page settled against a superseded request', () => {
        const first = settled(started(posthogSampleInitialState(), 1), 1, [event('a')], 'c1');
        const superseded = settled(started(first, 2), 1, [event('stale')], 'c-stale');

        // The late result belongs to a request this controller already replaced. Applying
        // it would show rows the reader's current selection was never measured against.
        expect(superseded.rows.map((row) => row.uuid)).toEqual(['a']);
        expect(superseded.pending).toBe(true);
    });

    it('keeps rows a reader already has when a later page fails', () => {
        const ready = settled(started(posthogSampleInitialState(), 1), 1, [event('a')], 'c1');
        const failed = posthogSampleReducer(started(ready, 2), {
            kind: 'pageFailed',
            token: 2,
            failure: FAILURE,
        });

        expect(failed.rows.map((row) => row.uuid)).toEqual(['a']);
        expect(failed.failure).toEqual(FAILURE);
        expect(failed.pending).toBe(false);
        // The failed page's continuation is not consumed, so an explicit retry is still
        // possible without inventing a new position.
        expect(failed.canLoadMore).toBe(true);
    });

    it('reports a first-page failure as unavailable rather than as an empty sample', () => {
        const failed = posthogSampleReducer(
            started(posthogSampleInitialState(), 1),
            { kind: 'pageFailed', token: 1, failure: FAILURE },
        );

        expect(failed.kind).toBe('unavailable');
        expect(failed.rows).toEqual([]);
    });

    it('discards everything when the exact detail instance or entry changes', () => {
        const ready = settled(started(posthogSampleInitialState(), 1), 1, [event('a')], 'c1');
        const reset = posthogSampleReducer(ready, { kind: 'identityChanged' });

        expect(reset).toEqual(posthogSampleInitialState());
    });

    it('offers another page only when the source minted a continuation and nothing is in flight', () => {
        const ended = settled(started(posthogSampleInitialState(), 1), 1, [event('a')], null);
        expect(ended.canLoadMore).toBe(false);

        const more = settled(started(posthogSampleInitialState(), 1), 1, [event('a')], 'c1');
        expect(more.canLoadMore).toBe(true);
        // CORRECTED: this asserted `false`, which was this controller's own drift from
        // the canonical rule and is what unmounted the reader's Load more mid-flight.
        // The affordance stays mounted and busy; `pending` is what says a page is in
        // flight.
        expect(started(more, 2).canLoadMore).toBe(true);
        expect(started(more, 2).pending).toBe(true);
    });

    it('moves the selection only to a row this sample actually carries', () => {
        const ready = settled(started(posthogSampleInitialState(), 1), 1, [event('a'), event('b')], null);

        expect(posthogSampleReducer(ready, { kind: 'selected', uuid: 'b' }).selectedUuid).toBe('b');
        expect(posthogSampleReducer(ready, { kind: 'selected', uuid: 'ghost' }).selectedUuid)
            .toBe('a');
    });

    it('carries the omitted-row count so a reader can see the page was not whole', () => {
        const state = posthogSampleReducer(started(posthogSampleInitialState(), 1), {
            kind: 'pageSettled',
            token: 1,
            events: [event('a')],
            omittedRowCount: 2,
            continuation: null,
        });

        expect(state.omittedRowCount).toBe(2);
    });
});
