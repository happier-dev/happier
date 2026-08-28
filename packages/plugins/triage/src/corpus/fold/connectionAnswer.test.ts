import {
    MAX_TRIAGE_ROW_FACTS_V1,
    type TriageRowFactV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { testkitObservation, testkitPresentOutcome, testkitSnapshot } from '../testkit/observations.test-support.js';
import { foldConnectionAnswers } from './connectionAnswer.js';
import type { ProjectedObservationV1 } from './projectedObservation.js';

function fact(id: string, text = id): TriageRowFactV1 {
    return {
        id,
        importance: 'secondary',
        value: { kind: 'text', value: text },
    };
}

function answer(input: Readonly<{
    observedAtMs?: number;
    nativeRevision?: string;
    facts: readonly TriageRowFactV1[];
    projectionTruncated?: true;
}>): ProjectedObservationV1 {
    return testkitObservation({
        observedAtMs: input.observedAtMs ?? 2_000,
        outcome: testkitPresentOutcome({
            ...(input.nativeRevision === undefined ? {} : { nativeRevision: input.nativeRevision }),
            snapshot: testkitSnapshot({
                facts: input.facts,
                ...(input.projectionTruncated === undefined ? {} : { projectionTruncated: true }),
            }),
        }),
    });
}

function foldedFacts(...answers: readonly ProjectedObservationV1[]): readonly TriageRowFactV1[] {
    const folded = foldConnectionAnswers(answers)[0];
    return folded?.outcome.kind === 'present' ? folded.outcome.snapshot.facts : [];
}

describe('one connection\'s tied observation facts', () => {
    it('unions facts only when tied answers carry the same explicit native revision', () => {
        expect(foldedFacts(
            answer({ nativeRevision: 'head-a', facts: [fact('winner')] }),
            answer({ nativeRevision: 'head-a', facts: [fact('supplement')] }),
        ).map((entry) => entry.id)).toEqual(['winner', 'supplement']);
    });

    it('does not treat two missing revisions as equal evidence', () => {
        expect(foldedFacts(
            answer({ facts: [fact('winner')] }),
            answer({ facts: [fact('unsupported')] }),
        ).map((entry) => entry.id)).toEqual(['winner']);
    });

    it('does not combine facts from different revisions or different observation times', () => {
        expect(foldedFacts(
            answer({ nativeRevision: 'head-a', facts: [fact('winner')] }),
            answer({ nativeRevision: 'head-b', facts: [fact('wrong-revision')] }),
        ).map((entry) => entry.id)).toEqual(['winner']);
        expect(foldedFacts(
            answer({ observedAtMs: 2_000, nativeRevision: 'head-a', facts: [fact('winner')] }),
            answer({ observedAtMs: 1_000, nativeRevision: 'head-a', facts: [fact('older')] }),
        ).map((entry) => entry.id)).toEqual(['winner']);
    });

    it('vetoes the supplemental merge when one tied answer conflicts with the winner fact id', () => {
        expect(foldedFacts(
            answer({ nativeRevision: 'head-a', facts: [fact('state', 'open')] }),
            answer({ nativeRevision: 'head-a', facts: [fact('state', 'closed'), fact('supplement')] }),
        )).toEqual([fact('state', 'open')]);
    });

    it('keeps the winner copy of an equal duplicate fact', () => {
        const winnerAnswer = answer({ nativeRevision: 'head-a', facts: [fact('state', 'open')] });
        if (winnerAnswer.outcome.kind !== 'present') throw new Error('expected a present answer');
        const winner = winnerAnswer.outcome.snapshot.facts[0];
        const folded = foldedFacts(
            winnerAnswer,
            answer({ nativeRevision: 'head-a', facts: [fact('state', 'open'), fact('supplement')] }),
        );

        expect(folded).toEqual([winner, fact('supplement')]);
        expect(folded[0]).toBe(winner);
    });

    it('keeps the protocol fact cap and marks a merged overflow or truncated supplement', () => {
        const merged = foldConnectionAnswers([
            answer({ nativeRevision: 'head-a', facts: [fact('a'), fact('b'), fact('c')] }),
            answer({ nativeRevision: 'head-a', facts: [fact('d'), fact('e')] }),
        ])[0];
        expect(merged?.outcome.kind === 'present' && merged.outcome.snapshot.facts)
            .toHaveLength(MAX_TRIAGE_ROW_FACTS_V1);
        expect(merged?.outcome.kind === 'present' && merged.outcome.snapshot.projectionTruncated)
            .toBe(true);

        const inherited = foldConnectionAnswers([
            answer({ nativeRevision: 'head-a', facts: [fact('a')] }),
            answer({ nativeRevision: 'head-a', facts: [], projectionTruncated: true }),
        ])[0];
        expect(inherited?.outcome.kind === 'present' && inherited.outcome.snapshot.projectionTruncated)
            .toBe(true);
    });
});
