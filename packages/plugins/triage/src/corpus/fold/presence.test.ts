import { describe, expect, it } from 'vitest';

import {
    testkitEntryRef,
    testkitObservation,
    testkitSnapshot,
} from '../testkit/observations.test-support.js';
import { laneForSnapshot } from './lane.js';
import { rollUpPresence } from './presence.js';
import type { ProjectedObservationV1 } from './projectedObservation.js';

const presentAt = (observedAtMs: number): ProjectedObservationV1 =>
    testkitObservation({ sourceInstanceId: `instance-present-${observedAtMs}`, observedAtMs });

const absentAt = (observedAtMs: number): ProjectedObservationV1 => testkitObservation({
    sourceInstanceId: `instance-absent-${observedAtMs}`,
    observedAtMs,
    outcome: { kind: 'absent' },
});

const unresolvedAt = (observedAtMs: number): ProjectedObservationV1 => testkitObservation({
    sourceInstanceId: `instance-unresolved-${observedAtMs}`,
    observedAtMs,
    outcome: { kind: 'unresolved', failure: { class: 'permission', code: 'example/forbidden' } },
});

const mergedAt = (observedAtMs: number): ProjectedObservationV1 => testkitObservation({
    sourceInstanceId: `instance-merged-${observedAtMs}`,
    observedAtMs,
    outcome: { kind: 'merged', successor: testkitEntryRef({ entryId: '99' }) },
});

describe('presence roll-up', () => {
    it('keeps an entry present when one connection reports absent and another still observes it', () => {
        // A permission difference must never make an entry another credential
        // can still see read as gone.
        expect(rollUpPresence([absentAt(1_000), presentAt(900)]))
            .toEqual({ kind: 'present', observedAtMs: 900 });
    });

    it('concludes absence only when every observation is absent', () => {
        expect(rollUpPresence([absentAt(1_000), absentAt(1_400)])).toEqual({ kind: 'absent', observedAtMs: 1_400 });
        expect(rollUpPresence([absentAt(1_000), unresolvedAt(1_400)])).toEqual({ kind: 'unresolved', observedAtMs: 1_400 });
    });

    it('never folds a merged observation into absence', () => {
        // `merged` is a third answer; folding it either way is the bug the
        // published observation contract exists to prevent.
        expect(rollUpPresence([absentAt(1_000), mergedAt(1_200)]))
            .toEqual({ kind: 'unresolved', observedAtMs: 1_200 });
    });

    it('reports unresolved for no observation at all', () => {
        expect(rollUpPresence([])).toEqual({ kind: 'unresolved', observedAtMs: null });
    });
});

describe('lane', () => {
    it('maps a present unknown presentation state to the open lane', () => {
        const snapshot = testkitSnapshot({ state: { presentation: 'unknown', nativeLabel: 'Needs triage' } });

        expect(laneForSnapshot(snapshot)).toBe('1-open');
    });

    it('maps every terminal presentation state to the done lane', () => {
        for (const presentation of ['resolved', 'closed', 'suppressed'] as const) {
            expect(laneForSnapshot(testkitSnapshot({ state: { presentation } }))).toBe('2-done');
        }
    });
});
