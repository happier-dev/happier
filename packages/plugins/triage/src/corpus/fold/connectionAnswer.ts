import {
    MAX_TRIAGE_ROW_FACTS_V1,
    TRIAGE_VIEWER_INVOLVEMENTS_V1,
    type TriageRowFactV1,
    type TriageSourceViewerFactsV1,
} from '@happier-dev/triage-protocol/v1';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

import type { CorpusEntryObservationsV1, ProjectedObservationV1 } from './projectedObservation.js';

/**
 * One connection's several answers for one entry, folded into that
 * connection's one answer.
 *
 * A source is allowed — and a first-party one is designed — to report the same
 * entry more than once inside a single walk. GitHub asks five involvement
 * queries and emits every native encounter separately, each carrying only the
 * fact that lane established, "so the aggregate applies the exact canonical ref
 * idempotently and unions involvement" (`scan/frontier.ts`). That union has to
 * happen somewhere, and this is the only place it can: the source deliberately
 * holds no delivered-item set, and every reader downstream — the row's content,
 * the wire, the mounted store's rehydration — sees at most one answer per
 * connection by construction.
 *
 * Without it the facts were silently dropped at the narrowest point. The wire
 * carries one observation per connection, so whichever encounter happened to be
 * newest became the row's whole viewer record: a pull request that arrived
 * through `review-requested` on an early page and `participating` on a later
 * one reached the mounted store as `participating` alone, and the store's
 * rebuild then derived `suggested` for an entry the user's review is blocking.
 * Re-inferring the lost facts from the rendered attention level is not a repair
 * — it would mint involvement the source never reported — so the union is made
 * before anything serializes.
 *
 * Only `present` answers fold. An `absent`, `merged` or `unresolved` answer
 * carries no viewer facts to union and is passed through untouched, which keeps
 * `rollUpPresence` and `selectObservationInstance` reading exactly the outcomes
 * they read before.
 *
 * The folded answer is the connection's NEWEST present one. Within one
 * connection its own clock is comparable — that is the same rule
 * `listWindow.ts#contentObservation` already applies — so the snapshot,
 * locator, source attention and `sourceUpdatedAtMs` come from the newest
 * encounter and only `involvement` accumulates.
 */
export function foldConnectionAnswers(
    observations: CorpusEntryObservationsV1,
): CorpusEntryObservationsV1 {
    let foldable = false;
    const presentByInstance = new Map<string, ProjectedObservationV1[]>();
    for (const observation of observations) {
        if (observation.outcome.kind !== 'present') continue;
        const answers = presentByInstance.get(observation.sourceInstanceId);
        if (answers === undefined) {
            presentByInstance.set(observation.sourceInstanceId, [observation]);
            continue;
        }
        answers.push(observation);
        foldable = true;
    }
    // The overwhelmingly common shape — one answer per connection — is returned
    // untouched rather than rebuilt.
    if (!foldable) return observations;

    const emitted = new Set<string>();
    const folded: ProjectedObservationV1[] = [];
    for (const observation of observations) {
        if (observation.outcome.kind !== 'present') {
            folded.push(observation);
            continue;
        }
        // The connection keeps the position of its first answer; the content
        // comes from its newest. Position and content are separate questions,
        // and no reader downstream orders observations within a row.
        if (emitted.has(observation.sourceInstanceId)) continue;
        emitted.add(observation.sourceInstanceId);
        const answers = presentByInstance.get(observation.sourceInstanceId) ?? [observation];
        folded.push(answers.length === 1 ? observation : mergeAnswers(answers));
    }
    return Object.freeze(folded);
}

function mergeAnswers(answers: readonly ProjectedObservationV1[]): ProjectedObservationV1 {
    let newest = answers[0] as ProjectedObservationV1;
    for (const answer of answers) {
        if (answer.observedAtMs > newest.observedAtMs) newest = answer;
    }
    const outcome = newest.outcome;
    // Every answer in this bucket is `present` by construction; the narrowing
    // is here so the merged outcome keeps its exact type rather than a cast.
    if (outcome.kind !== 'present') return newest;

    const involvement = new Set<TriageSourceViewerFactsV1['involvement'][number]>();
    for (const answer of answers) {
        if (answer.outcome.kind !== 'present') continue;
        for (const value of answer.outcome.viewer.involvement) involvement.add(value);
    }
    const mergedSnapshot = mergeTiedSnapshotFacts(newest, answers);
    const involvementChanged = involvement.size !== outcome.viewer.involvement.length;
    if (!involvementChanged && mergedSnapshot === outcome.snapshot) return newest;

    return Object.freeze({
        ...newest,
        outcome: Object.freeze({
            ...outcome,
            snapshot: mergedSnapshot,
            ...(involvementChanged
                ? {
                    viewer: Object.freeze({
                        ...outcome.viewer,
                        // The protocol's own declared order, not encounter order: two
                        // walks of the same inbox legitimately meet the lanes in a
                        // different sequence, and a viewer record that reordered with
                        // them would make one entry's facts look like two.
                        involvement: Object.freeze(
                            TRIAGE_VIEWER_INVOLVEMENTS_V1.filter((value) => involvement.has(value)),
                        ),
                    }),
                }
                : {}),
        }),
    });
}

/**
 * Supplement the winner's row facts only when tied source answers prove they
 * describe the same native revision. Missing revision on both sides is not
 * evidence: treating `undefined === undefined` as agreement manufactures a
 * snapshot from unrelated reads.
 *
 * A same-id disagreement vetoes the whole supplement. The winner remains the
 * sole authority rather than combining half of one answer with half of a
 * conflicting answer. Equal duplicates keep the winner's exact object, while
 * new ids fill only the protocol-owned fact capacity.
 */
function mergeTiedSnapshotFacts(
    winner: ProjectedObservationV1,
    answers: readonly ProjectedObservationV1[],
): Extract<ProjectedObservationV1['outcome'], Readonly<{ kind: 'present' }>>['snapshot'] {
    if (winner.outcome.kind !== 'present') {
        throw new Error('The connection-answer winner must be present.');
    }
    // Keep the discriminated member itself, rather than rereading the union
    // through `winner` inside callbacks where TypeScript cannot preserve the
    // outer narrowing.
    const winnerOutcome = winner.outcome;
    const winnerSnapshot = winnerOutcome.snapshot;
    const winnerRevision = winnerOutcome.nativeRevision;
    if (winnerRevision === undefined || winnerRevision.length === 0) return winnerSnapshot;

    const tied = answers.filter((answer) => answer.observedAtMs === winner.observedAtMs);
    const tiedPresent = tied.filter((answer): answer is ProjectedObservationV1 & Readonly<{
        outcome: Extract<ProjectedObservationV1['outcome'], Readonly<{ kind: 'present' }>>;
    }> => answer.outcome.kind === 'present');
    if (tiedPresent.length !== tied.length || tiedPresent.some((answer) =>
        answer.outcome.nativeRevision === undefined
        || answer.outcome.nativeRevision.length === 0
        || answer.outcome.nativeRevision !== winnerRevision)) {
        return winnerSnapshot;
    }

    const byId = new Map<string, TriageRowFactV1>();
    for (const fact of winnerSnapshot.facts) byId.set(fact.id, fact);
    for (const answer of tiedPresent) {
        for (const fact of answer.outcome.snapshot.facts) {
            const existing = byId.get(fact.id);
            if (existing !== undefined && !pluginJsonValuesEqual(existing, fact)) {
                return winnerSnapshot;
            }
            if (existing === undefined) byId.set(fact.id, fact);
        }
    }

    const facts = [...byId.values()];
    const projectionTruncated = tiedPresent.some((answer) =>
        answer.outcome.snapshot.projectionTruncated === true)
        || facts.length > MAX_TRIAGE_ROW_FACTS_V1;
    const boundedFacts = facts.slice(0, MAX_TRIAGE_ROW_FACTS_V1);
    if (boundedFacts.length === winnerSnapshot.facts.length
        && boundedFacts.every((fact, index) => fact === winnerSnapshot.facts[index])
        && projectionTruncated === (winnerSnapshot.projectionTruncated === true)) {
        return winnerSnapshot;
    }
    return Object.freeze({
        ...winnerSnapshot,
        facts: Object.freeze(boundedFacts),
        ...(projectionTruncated ? { projectionTruncated: true as const } : {}),
    });
}
