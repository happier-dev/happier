import { describe, expect, it } from 'vitest';

import { testkitEntryRef } from '../testkit/observations.test-support.js';
import {
    CORPUS_DEFAULT_SMART_POLICY_V1,
    parseCorpusSmartPolicy,
    type CorpusSmartPolicyV1,
} from './smartPolicy.js';
import { compareCorpusWindowRows, rankCorpusWindow, type CorpusRankableRowV1 } from './rankWindow.js';

type TestRow = CorpusRankableRowV1 & Readonly<{ id: string; observationsWouldDerive?: 'required' }>;

function row(input: Readonly<{
    id: string;
    sortAtMs: number;
    attention?: 'required' | 'suggested';
    observationsWouldDerive?: 'required';
}>): TestRow {
    return Object.freeze({
        id: input.id,
        entryRef: testkitEntryRef({ entryId: input.id }),
        sortAtMs: input.sortAtMs,
        attention: input.attention === undefined ? null : { level: input.attention },
        ...(input.observationsWouldDerive === undefined
            ? {}
            : { observationsWouldDerive: input.observationsWouldDerive }),
    });
}

const attentionThenActivity: CorpusSmartPolicyV1 = { v: 1, precedence: ['attention', 'activity'] };
const activityThenAttention: CorpusSmartPolicyV1 = { v: 1, precedence: ['activity', 'attention'] };

describe('rankCorpusWindow', () => {
    it('re-ranks only the fetched window and never adds, drops or rewrites a row', () => {
        const fetched = [
            row({ id: 'a', sortAtMs: 10 }),
            row({ id: 'b', sortAtMs: 30, attention: 'required' }),
            row({ id: 'c', sortAtMs: 20, attention: 'suggested' }),
        ];
        const original = [...fetched];

        const ranked = rankCorpusWindow(fetched, 'smart', attentionThenActivity);

        expect(ranked.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
        // Same membership, same identities: a ranker that fetched another page,
        // compared section heads or rebuilt a row would break one of these.
        expect([...ranked].sort()).toHaveLength(3);
        expect(new Set(ranked)).toEqual(new Set(original));
        for (const entry of ranked) expect(original.includes(entry)).toBe(true);
        // The caller's window is not reordered underneath it.
        expect(fetched).toEqual(original);
    });

    it('evaluates only the two closed Smart precedence tuples and defaults to attention then activity', () => {
        const fetched = [
            row({ id: '1', sortAtMs: 300 }),
            row({ id: '2', sortAtMs: 100, attention: 'required' }),
            row({ id: '3', sortAtMs: 200, attention: 'suggested' }),
        ];

        expect(CORPUS_DEFAULT_SMART_POLICY_V1).toEqual({ v: 1, precedence: ['attention', 'activity'] });
        expect(rankCorpusWindow(fetched, 'smart', CORPUS_DEFAULT_SMART_POLICY_V1).map((entry) => entry.id))
            .toEqual(['2', '3', '1']);
        // The other tuple reads activity first, so the newest row wins even
        // though a required-attention row exists in the same window.
        expect(rankCorpusWindow(fetched, 'smart', activityThenAttention).map((entry) => entry.id))
            .toEqual(['1', '3', '2']);

        // No weight, decay, named source branch or dynamically admitted
        // predicate is representable.
        expect(parseCorpusSmartPolicy({ v: 1, precedence: ['attention', 'activity'] }))
            .toEqual(attentionThenActivity);
        expect(parseCorpusSmartPolicy({ v: 1, precedence: ['activity', 'attention'] }))
            .toEqual(activityThenAttention);
        expect(parseCorpusSmartPolicy({ v: 1, precedence: ['attention'] })).toBeNull();
        expect(parseCorpusSmartPolicy({ v: 1, precedence: ['attention', 'attention'] })).toBeNull();
        expect(parseCorpusSmartPolicy({ v: 1, precedence: ['activity', 'staleness'] })).toBeNull();
        expect(parseCorpusSmartPolicy({ v: 1, precedence: ['attention', 'activity'], weights: { attention: 2 } }))
            .toBeNull();
        expect(parseCorpusSmartPolicy({ v: 2, precedence: ['attention', 'activity'] })).toBeNull();
        expect(parseCorpusSmartPolicy(null)).toBeNull();
    });

    it('uses the supplied displayed-attention result rather than re-deriving attention', () => {
        // This row's observations would derive `required`, but the one canonical
        // derivation already answered `null` for it — because the observation
        // that carried the signal belongs to a retired instance. A ranker that
        // re-derived attention would promote it.
        const fetched = [
            row({ id: 'derives', sortAtMs: 100, observationsWouldDerive: 'required' }),
            row({ id: 'declared', sortAtMs: 50, attention: 'suggested' }),
        ];

        expect(rankCorpusWindow(fetched, 'smart', attentionThenActivity).map((entry) => entry.id))
            .toEqual(['declared', 'derives']);
    });

    it('does not manufacture an attention value or explanation for an unobserved entry', () => {
        const unobserved = row({ id: 'unobserved', sortAtMs: 900 });
        const suggested = row({ id: 'suggested', sortAtMs: 1, attention: 'suggested' });

        const ranked = rankCorpusWindow([unobserved, suggested], 'smart', attentionThenActivity);

        // It lands in the no-match group, behind a real `suggested` claim, and
        // it is never scored, relabelled or described.
        expect(ranked.map((entry) => entry.id)).toEqual(['suggested', 'unobserved']);
        expect(ranked[1]).toBe(unobserved);
        expect(ranked[1]?.attention).toBeNull();
    });

    it('resolves ties by activity then the canonical entry reference, independent of input order', () => {
        const tied = [
            row({ id: 'c', sortAtMs: 500, attention: 'required' }),
            row({ id: 'a', sortAtMs: 500, attention: 'required' }),
            row({ id: 'b', sortAtMs: 900, attention: 'required' }),
        ];

        const forward = rankCorpusWindow(tied, 'smart', attentionThenActivity).map((entry) => entry.id);
        const reversed = rankCorpusWindow([...tied].reverse(), 'smart', attentionThenActivity)
            .map((entry) => entry.id);

        expect(forward).toEqual(['b', 'a', 'c']);
        // Arrival order is never an authority: two lanes legitimately answer in
        // a different order on every pass.
        expect(reversed).toEqual(forward);
    });

    it('orders newest and oldest by activity alone, with the same canonical tie-break', () => {
        const fetched = [
            row({ id: 'a', sortAtMs: 500, attention: 'required' }),
            row({ id: 'b', sortAtMs: 500 }),
            row({ id: 'c', sortAtMs: 900 }),
        ];

        // Attention is not a predicate of either direct order, so the
        // required-attention row does not jump the newest one.
        expect(rankCorpusWindow(fetched, 'newest', attentionThenActivity).map((entry) => entry.id))
            .toEqual(['c', 'a', 'b']);
        expect(rankCorpusWindow(fetched, 'oldest', attentionThenActivity).map((entry) => entry.id))
            .toEqual(['a', 'b', 'c']);
    });

    it('compares two entries of different sources by the canonical reference components', () => {
        const compare = compareCorpusWindowRows('newest', CORPUS_DEFAULT_SMART_POLICY_V1);
        const left: CorpusRankableRowV1 = {
            entryRef: testkitEntryRef({ source: { pluginId: 'happier.a', localId: 'x' } }),
            sortAtMs: 5,
            attention: null,
        };
        const right: CorpusRankableRowV1 = {
            entryRef: testkitEntryRef({ source: { pluginId: 'happier.a', localId: 'y' } }),
            sortAtMs: 5,
            attention: null,
        };

        expect(compare(left, right)).toBeLessThan(0);
        expect(compare(right, left)).toBeGreaterThan(0);
        expect(compare(left, left)).toBe(0);
    });

    it('keeps two contract-valid references distinct when a component carries the separator byte', () => {
        // A delimiter join would merge these two into one comparison key and
        // make the order non-deterministic between them.
        const compare = compareCorpusWindowRows('newest', CORPUS_DEFAULT_SMART_POLICY_V1);
        const left: CorpusRankableRowV1 = {
            entryRef: testkitEntryRef({ collisionScope: 'ab', entryId: 'c' }),
            sortAtMs: 5,
            attention: null,
        };
        const right: CorpusRankableRowV1 = {
            entryRef: testkitEntryRef({ collisionScope: 'a', entryId: 'bc' }),
            sortAtMs: 5,
            attention: null,
        };

        expect(compare(left, right)).not.toBe(0);
    });
});
