import { describe, expect, it } from 'vitest';

import { CORPUS_SMART_PRECEDENCE_TUPLES_V1 } from '../../corpus/query/smartPolicy.js';
import {
    TRIAGE_SURFACE_INITIAL_STATE_V1,
    reduceTriageSurfaceV1,
    type TriageSurfaceStateV1,
} from '../state/surface.js';
import { readTriageBulkSelectionScopeKeyV1 } from './bulkSelectionScope.js';

function withQuery(query: string): TriageSurfaceStateV1 {
    return reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, { kind: 'searchChanged', query });
}

describe('what counts as the same list for a bulk selection', () => {
    it('survives the reader typing, because a query narrows the list rather than replacing it', () => {
        // The defect this exists to prevent: with the query in the scope, every
        // keystroke was a new scope, the selection owner cleared the set, and a
        // reader who chose six entries and then typed to find a seventh was
        // left with none — while the comment beside it claimed the opposite.
        const base = readTriageBulkSelectionScopeKeyV1(TRIAGE_SURFACE_INITIAL_STATE_V1);

        expect(readTriageBulkSelectionScopeKeyV1(withQuery('normalizer'))).toBe(base);
        expect(readTriageBulkSelectionScopeKeyV1(withQuery('normalizer!'))).toBe(base);
        expect(readTriageBulkSelectionScopeKeyV1(reduceTriageSurfaceV1(
            withQuery('normalizer'),
            { kind: 'searchComposing', text: 'norm' },
        ))).toBe(base);
    });

    it('changes when the reader is genuinely looking at a different list', () => {
        const base = readTriageBulkSelectionScopeKeyV1(TRIAGE_SURFACE_INITIAL_STATE_V1);

        const reordered = reduceTriageSurfaceV1(
            TRIAGE_SURFACE_INITIAL_STATE_V1,
            { kind: 'orderChanged', order: 'oldest' },
        );
        const regrouped = reduceTriageSurfaceV1(
            TRIAGE_SURFACE_INITIAL_STATE_V1,
            { kind: 'groupingChanged', grouping: 'scope' },
        );
        const filtered = reduceTriageSurfaceV1(
            TRIAGE_SURFACE_INITIAL_STATE_V1,
            { kind: 'filterValueToggled', facet: 'states', value: 'open' },
        );
        const reranked = reduceTriageSurfaceV1(
            TRIAGE_SURFACE_INITIAL_STATE_V1,
            {
                kind: 'smartPolicyChanged',
                smartPolicy: { v: 1, precedence: CORPUS_SMART_PRECEDENCE_TUPLES_V1[1] },
            },
        );

        for (const [label, state] of [
            ['order', reordered],
            ['grouping', regrouped],
            ['facet', filtered],
            ['smart policy', reranked],
        ] as const) {
            expect(readTriageBulkSelectionScopeKeyV1(state), label).not.toBe(base);
        }
    });
});
