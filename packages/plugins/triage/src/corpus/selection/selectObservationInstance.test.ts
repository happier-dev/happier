import { describe, expect, it } from 'vitest';

import { deriveDisplayedAttention } from '../attention/deriveAttention.js';
import type { ProjectedObservationV1 } from '../fold/projectedObservation.js';
import {
    testkitObservation,
    testkitPresentOutcome,
    testkitViewer,
} from '../testkit/observations.test-support.js';
import { selectObservationInstance } from './selectObservationInstance.js';

const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

const present = (
    sourceInstanceId: string,
    involvement: readonly ('assignee' | 'reviewRequested' | 'subscribed')[] = [],
): ProjectedObservationV1 => testkitObservation({
    sourceInstanceId,
    outcome: testkitPresentOutcome({ viewer: testkitViewer({ involvement: [...involvement] }) }),
});

const unresolvedOnly = (sourceInstanceId: string): ProjectedObservationV1 => testkitObservation({
    sourceInstanceId,
    observedAtMs: 1_760_000_300_000,
    outcome: { kind: 'unresolved', failure: { class: 'permission', code: 'example/forbidden' } },
});

describe('selectObservationInstance', () => {
    it('selects the attention-carrying connection rather than the pass-order first one', () => {
        const forward = [present(INSTANCE_A), present(INSTANCE_B, ['reviewRequested'])];
        const reversed = [present(INSTANCE_B, ['reviewRequested']), present(INSTANCE_A)];

        for (const observations of [forward, reversed]) {
            const attention = deriveDisplayedAttention(observations);
            expect(selectObservationInstance(observations, [INSTANCE_A, INSTANCE_B], attention, null)).toEqual({
                kind: 'selected',
                sourceInstanceId: INSTANCE_B,
                reason: 'attention',
            });
        }
    });

    it('uses the lexicographic active-present fallback when displayed attention is null', () => {
        const observations = [present(INSTANCE_B), present(INSTANCE_A)];

        expect(selectObservationInstance(observations, [INSTANCE_A, INSTANCE_B], null, null)).toEqual({
            kind: 'selected',
            sourceInstanceId: INSTANCE_A,
            reason: 'deterministicTieBreak',
        });
    });

    it('honours an explicit user switch over the attention winner', () => {
        const observations = [present(INSTANCE_A), present(INSTANCE_B, ['assignee'])];
        const attention = deriveDisplayedAttention(observations);

        expect(selectObservationInstance(observations, [INSTANCE_A, INSTANCE_B], attention, INSTANCE_A)).toEqual({
            kind: 'selected',
            sourceInstanceId: INSTANCE_A,
            reason: 'override',
        });
    });

    it('returns none when no observation of this pass is present', () => {
        expect(selectObservationInstance([unresolvedOnly(INSTANCE_A)], [INSTANCE_A], null, null)).toEqual({
            kind: 'none',
            reason: 'noPresentObservation',
        });
    });

    it('excludes a retired instance from selection even while its observation is in the pass', () => {
        // Retirement removes read and Action authority. Selecting on the
        // observation alone would mount a detail against a credential that no
        // longer exists.
        const observations = [present(INSTANCE_A, ['assignee'])];
        const attention = deriveDisplayedAttention(observations);

        expect(selectObservationInstance(observations, [], attention, null)).toEqual({
            kind: 'none',
            reason: 'allInstancesRetired',
        });
        expect(selectObservationInstance(observations, [], attention, INSTANCE_A)).toEqual({
            kind: 'none',
            reason: 'allInstancesRetired',
        });
    });
});
