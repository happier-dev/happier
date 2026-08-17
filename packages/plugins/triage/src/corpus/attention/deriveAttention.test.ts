import { describe, expect, it } from 'vitest';

import type { ProjectedObservationV1 } from '../fold/projectedObservation.js';
import {
    testkitObservation,
    testkitPresentOutcome,
    testkitViewer,
} from '../testkit/observations.test-support.js';
import { deriveDisplayedAttention } from './deriveAttention.js';

const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

function presentWith(
    sourceInstanceId: string,
    viewer: ReturnType<typeof testkitViewer>,
): ProjectedObservationV1 {
    return testkitObservation({ sourceInstanceId, outcome: testkitPresentOutcome({ viewer }) });
}

const unresolved = (sourceInstanceId: string): ProjectedObservationV1 => testkitObservation({
    sourceInstanceId,
    observedAtMs: 1_760_000_200_000,
    outcome: { kind: 'unresolved', failure: { class: 'transient', code: 'example/timeout' } },
});

describe('deriveDisplayedAttention', () => {
    it('excludes an unresolved observation from the derivation instead of scoring it none', () => {
        const assignedButFailingElsewhere = [
            presentWith(INSTANCE_A, testkitViewer({ involvement: ['assignee'] })),
            unresolved(INSTANCE_B),
        ];

        expect(deriveDisplayedAttention(assignedButFailingElsewhere)).toEqual({
            level: 'required',
            fromSourceInstanceId: INSTANCE_A,
            reasonId: 'involvement/assignee',
            reasonLabel: 'Assigned to you',
        });
    });

    it('selects equal meaningful attention by level then sourceInstanceId regardless of pass order', () => {
        const required = testkitViewer({
            sourceAttention: { level: 'required', reasonId: 'example/review', reasonLabel: 'Review requested' },
        });
        const forward = [presentWith(INSTANCE_A, required), presentWith(INSTANCE_B, required)];
        const reversed = [presentWith(INSTANCE_B, required), presentWith(INSTANCE_A, required)];

        expect(deriveDisplayedAttention(forward)?.fromSourceInstanceId).toBe(INSTANCE_A);
        expect(deriveDisplayedAttention(reversed)?.fromSourceInstanceId).toBe(INSTANCE_A);
    });

    it('prefers a required claim over a suggested one from a lexicographically smaller instance', () => {
        const observations = [
            presentWith(INSTANCE_A, testkitViewer({ involvement: ['subscribed'] })),
            presentWith(INSTANCE_B, testkitViewer({ involvement: ['reviewRequested'] })),
        ];

        expect(deriveDisplayedAttention(observations)).toEqual({
            level: 'required',
            fromSourceInstanceId: INSTANCE_B,
            reasonId: 'involvement/review-requested',
            reasonLabel: 'Your review was requested',
        });
    });

    it('returns null for no present observation and for present observations with only none attention', () => {
        expect(deriveDisplayedAttention([])).toBeNull();
        expect(deriveDisplayedAttention([
            presentWith(INSTANCE_A, testkitViewer({ involvement: [] })),
            presentWith(INSTANCE_B, testkitViewer({ sourceAttention: { level: 'none' } })),
        ])).toBeNull();
    });

    it('never falls back to involvement when the source declared no meaningful attention', () => {
        // A reason-free declaration must not become a display winner, and it
        // must not be silently upgraded by the aggregate's own table either.
        const observations = [presentWith(INSTANCE_A, testkitViewer({
            involvement: ['assignee'],
            sourceAttention: { level: 'none' },
        }))];

        expect(deriveDisplayedAttention(observations)).toBeNull();
    });

    it('prefers the source-declared reason over the aggregate involvement table', () => {
        const observations = [presentWith(INSTANCE_A, testkitViewer({
            involvement: ['assignee'],
            sourceAttention: { level: 'suggested', reasonId: 'example/stale', reasonLabel: 'Waiting on you' },
        }))];

        expect(deriveDisplayedAttention(observations)).toEqual({
            level: 'suggested',
            fromSourceInstanceId: INSTANCE_A,
            reasonId: 'example/stale',
            reasonLabel: 'Waiting on you',
        });
    });
});
