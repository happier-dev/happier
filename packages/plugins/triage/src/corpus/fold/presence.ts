import type { CorpusEntryObservationsV1 } from './projectedObservation.js';

/**
 * Row-level presence, folded from the observations of one entry in the current
 * pass.
 */
export type CorpusPresenceV1 =
    | Readonly<{ kind: 'present'; observedAtMs: number }>
    | Readonly<{ kind: 'absent'; observedAtMs: number }>
    | Readonly<{ kind: 'unresolved'; observedAtMs: number | null }>;

/**
 * Absence requires unanimity.
 *
 * Unanimity is what makes "connection B's narrower visibility is not evidence
 * about A" a structural property rather than a rule to remember: an entry one
 * credential can still see is never reported gone because another credential
 * could not see it.
 *
 * `merged` never contributes to absence. It is a third answer, and folding it
 * either way is the bug the published observation contract exists to prevent.
 */
export function rollUpPresence(observations: CorpusEntryObservationsV1): CorpusPresenceV1 {
    let presentAtMs: number | null = null;
    let absentAtMs: number | null = null;
    let latestAtMs: number | null = null;
    let observationCount = 0;
    let nonAbsentCount = 0;

    for (const observation of observations) {
        observationCount += 1;
        latestAtMs = latestAtMs === null
            ? observation.observedAtMs
            : Math.max(latestAtMs, observation.observedAtMs);
        if (observation.outcome.kind === 'present') {
            presentAtMs = presentAtMs === null
                ? observation.observedAtMs
                : Math.max(presentAtMs, observation.observedAtMs);
            nonAbsentCount += 1;
            continue;
        }
        if (observation.outcome.kind === 'absent') {
            absentAtMs = absentAtMs === null
                ? observation.observedAtMs
                : Math.max(absentAtMs, observation.observedAtMs);
            continue;
        }
        nonAbsentCount += 1;
    }

    if (presentAtMs !== null) return { kind: 'present', observedAtMs: presentAtMs };
    if (observationCount > 0 && nonAbsentCount === 0 && absentAtMs !== null) {
        return { kind: 'absent', observedAtMs: absentAtMs };
    }
    return { kind: 'unresolved', observedAtMs: latestAtMs };
}
