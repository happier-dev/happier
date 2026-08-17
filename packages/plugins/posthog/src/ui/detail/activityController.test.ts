import { describe, expect, it } from 'vitest';

import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { PosthogProjectedActivityRecord } from './activityProjection.js';
import {
    posthogActivityInitialState,
    posthogActivityReducer,
    type PosthogActivityStateV1,
} from './activityController.js';

function record(id: string): PosthogProjectedActivityRecord {
    return { id, activity: 'updated', isSystem: false, changedFields: [] };
}

const FORBIDDEN: TriageSourceFailureV1 = {
    class: 'permission',
    code: 'posthog/permission-denied',
};
const UNAUTHORIZED: TriageSourceFailureV1 = {
    class: 'authentication',
    code: 'posthog/account-unauthorized',
};

function started(state: PosthogActivityStateV1, token: number): PosthogActivityStateV1 {
    return posthogActivityReducer(state, { kind: 'requestStarted', token });
}

function settled(
    state: PosthogActivityStateV1,
    token: number,
    records: readonly PosthogProjectedActivityRecord[],
    continuation: string | null,
): PosthogActivityStateV1 {
    return posthogActivityReducer(state, {
        kind: 'pageSettled',
        token,
        records,
        omittedRowCount: 0,
        totalCount: null,
        continuation,
    });
}

describe('posthogActivityReducer', () => {
    it('appends validated pages and stops when the provider states no next', () => {
        let state = settled(started(posthogActivityInitialState(), 1), 1, [record('a')], 'p2');
        expect(state.kind).toBe('ready');
        expect(state.canLoadMore).toBe(true);

        state = settled(started(state, 2), 2, [record('b')], null);

        expect(state.records.map((row) => row.id)).toEqual(['a', 'b']);
        expect(state.canLoadMore).toBe(false);
        expect(state.pending).toBe(false);
    });

    it('renders a provider-stated empty page as a settled empty result, not a failure', () => {
        const state = settled(started(posthogActivityInitialState(), 1), 1, [], null);

        // An issue with no recorded activity is a real answer. It must be visibly
        // different from a read that failed and from a tab that was never built.
        expect(state.kind).toBe('ready');
        expect(state.records).toEqual([]);
        expect(state.failure).toBeNull();
    });

    it('makes a first-page failure visibly unavailable rather than empty', () => {
        const state = posthogActivityReducer(
            started(posthogActivityInitialState(), 1),
            { kind: 'pageFailed', token: 1, failure: FORBIDDEN },
        );

        expect(state.kind).toBe('unavailable');
        expect(state.records).toEqual([]);
        // A 403 stays a permission failure the reader can see: no stable
        // missing-scope discriminator is characterized, so status alone never hides
        // this plane.
        expect(state.failure).toEqual(FORBIDDEN);
    });

    it('keeps rows a reader already had when a later page fails', () => {
        let state = settled(started(posthogActivityInitialState(), 1), 1, [record('a')], 'p2');
        state = posthogActivityReducer(started(state, 2), {
            kind: 'pageFailed',
            token: 2,
            failure: UNAUTHORIZED,
        });

        expect(state.kind).toBe('ready');
        expect(state.records.map((row) => row.id)).toEqual(['a']);
        // The authentication failure renders beside the rows that are still on screen;
        // it does not blank them.
        expect(state.failure).toEqual(UNAUTHORIZED);
        expect(state.canLoadMore).toBe(true);
    });

    it('ignores a result belonging to a superseded request', () => {
        const state = started(posthogActivityInitialState(), 2);

        expect(settled(state, 1, [record('stale')], null)).toBe(state);
        expect(posthogActivityReducer(state, {
            kind: 'pageFailed',
            token: 1,
            failure: FORBIDDEN,
        })).toBe(state);
    });

    it('discards every byte of the plane when its panel is left', () => {
        let state = settled(started(posthogActivityInitialState(), 1), 1, [record('a')], 'p2');
        state = posthogActivityReducer(state, {
            kind: 'pageFailed',
            token: 1,
            failure: FORBIDDEN,
        });

        // The Activity panel declares `discard`: leaving keeps no rows, no paging
        // position, no error and no total.
        expect(posthogActivityReducer(state, { kind: 'panelLeft' }))
            .toEqual(posthogActivityInitialState());
    });
});
