import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  TriageEntryLocatorV1,
  TriageRowFactV1,
  TriageSourceEntrySnapshotV1,
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
  TriageSourceObservationV1,
  TriageSourceScanEvidenceV1,
  TriageSourceScanObservationV1,
  TriageSourceViewerFactsV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  GithubTriageEntryLocalRefV1,
  GithubTriageEntryLocatorV1,
  GithubTriageEntrySnapshotV1,
  GithubTriageFailureV1,
  GithubTriageObservationV1,
  GithubTriageRowFactV1,
  GithubTriageScanEvidenceV1,
  GithubTriageScanObservationV1,
  GithubTriageViewerFactsV1,
} from '../types.js';

/**
 * The one projection from this plugin's own GitHub Triage shapes onto the published
 * source ABI.
 *
 * It exists because the two vocabularies are deliberately near-identical but not
 * equal: the public snapshot has no `kindId`, `webUrl` or provider clock (those are
 * observation- and locator-level facts), its row-fact arms name their payload `value`,
 * and every bounded text member rejects an empty string. Doing that rename inside the
 * provider modules would have coupled tolerant row decoding to the ABI; doing it in
 * more than one place would be two projections of one concept.
 *
 * Nothing here reaches a provider, a credential or a clock. It is a pure total
 * function over already-decoded provider evidence.
 */

function isEmittableInstant(value: number): boolean {
  return Number.isSafeInteger(value);
}

export function toTriageLocalRef(
  localRef: GithubTriageEntryLocalRefV1,
): TriageSourceEntryLocalRefV1 {
  return Object.freeze({
    kindId: localRef.kindId,
    collisionScope: localRef.collisionScope,
    entryId: localRef.entryId,
  });
}

export function toTriageLocator(locator: GithubTriageEntryLocatorV1): TriageEntryLocatorV1 {
  return Object.freeze({
    v: 1 as const,
    routingToken: locator.routingToken,
    displayPath: locator.displayPath,
    ...(locator.webUrl === null ? {} : { webUrl: locator.webUrl }),
  });
}

type ProjectedFacts = Readonly<{ facts: readonly TriageRowFactV1[]; dropped: boolean }>;

/**
 * A bounded text member of the public ABI rejects an empty string, so a provider row
 * whose fact text projected to nothing is dropped rather than emitted invalid: one
 * empty string would make the target reject the whole page atomically.
 */
function toTriageFacts(facts: readonly GithubTriageRowFactV1[]): ProjectedFacts {
  const projected: TriageRowFactV1[] = [];
  let dropped = false;
  for (const fact of facts) {
    const value = fact.value;
    switch (value.kind) {
      case 'text':
      case 'actor': {
        const text = value.kind === 'text' ? value.text : value.label;
        if (!text) {
          dropped = true;
          break;
        }
        projected.push(Object.freeze({
          id: fact.id,
          importance: fact.importance,
          value: Object.freeze({ kind: value.kind, value: text }),
        }));
        break;
      }
      case 'status': {
        if (!value.label) {
          dropped = true;
          break;
        }
        projected.push(Object.freeze({
          id: fact.id,
          importance: fact.importance,
          value: Object.freeze({ kind: 'status' as const, value: value.label, tone: value.tone }),
        }));
        break;
      }
      case 'number': {
        projected.push(Object.freeze({
          id: fact.id,
          importance: fact.importance,
          value: Object.freeze({ kind: 'number' as const, value: value.value, format: value.format }),
        }));
        break;
      }
      case 'timestamp': {
        if (!isEmittableInstant(value.atMs)) {
          dropped = true;
          break;
        }
        projected.push(Object.freeze({
          id: fact.id,
          importance: fact.importance,
          value: Object.freeze({ kind: 'timestamp' as const, atMs: value.atMs, format: value.format }),
        }));
        break;
      }
      case 'detailOnly': {
        projected.push(Object.freeze({
          id: fact.id,
          importance: fact.importance,
          value: Object.freeze({ kind: 'detailOnly' as const }),
        }));
        break;
      }
    }
  }
  return Object.freeze({ facts: Object.freeze(projected), dropped });
}

export function toTriageSnapshot(
  snapshot: GithubTriageEntrySnapshotV1,
  locator: GithubTriageEntryLocatorV1,
  entryId: string,
): TriageSourceEntrySnapshotV1 {
  const facts = toTriageFacts(snapshot.rowFacts);
  // A provider row can carry an empty title or repository label; the public members
  // are non-empty. The entry's own native designation and its repository key are the
  // only substitutes that are still this entry's real presentation, never a guess.
  const title = snapshot.title || `#${entryId}`;
  const scopeLabel = snapshot.scopeLabel || locator.routingToken;
  const nativeLabel = projectTriageDisplayTextV1(
    snapshot.state.nativeLabel,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  const truncated = snapshot.projectionTruncated || facts.dropped;
  return Object.freeze({
    v: 1 as const,
    title,
    // No `summary`. It is one line of row subtitle, never a body excerpt, and GitHub
    // publishes no such line: the body, its comments and its activity are live detail
    // materializations and never ride a list result.
    scopeLabel,
    ...(isEmittableInstant(snapshot.createdAtMs) ? { createdAtMs: snapshot.createdAtMs } : {}),
    state: Object.freeze({
      presentation: snapshot.state.presentation,
      // GitHub's `state` is a bare provider string and an unrecognized value reaches
      // here verbatim, so the provider's own word is projected into one bounded line
      // like every other display string. Nothing surviving omits the label rather than
      // publishing a blank one, which the non-empty published string would reject.
      ...(nativeLabel.value.length === 0 ? {} : { nativeLabel: nativeLabel.value }),
    }),
    facts: facts.facts,
    ...(truncated ? { projectionTruncated: true as const } : {}),
  });
}

export function toTriageViewerFacts(
  viewer: GithubTriageViewerFactsV1,
): TriageSourceViewerFactsV1 {
  return Object.freeze({ involvement: Object.freeze([...viewer.involvement]) });
}

export function toTriageFailure(failure: GithubTriageFailureV1): TriageSourceFailureV1 {
  return Object.freeze({
    class: failure.class,
    code: failure.code,
    ...(failure.retryNotBeforeMs === undefined
      ? {}
      : { retryNotBeforeMs: failure.retryNotBeforeMs }),
  });
}

function toTriagePresentObservation(
  observation: Extract<GithubTriageObservationV1, Readonly<{ kind: 'present' }>>,
): Extract<TriageSourceObservationV1, Readonly<{ kind: 'present' }>> {
  const snapshot = observation.snapshot;
  return Object.freeze({
    kind: 'present' as const,
    localRef: toTriageLocalRef(observation.localRef),
    locator: toTriageLocator(observation.locator),
    snapshot: toTriageSnapshot(snapshot, observation.locator, observation.localRef.entryId),
    viewer: toTriageViewerFacts(observation.viewer),
    ...(isEmittableInstant(snapshot.sourceUpdatedAtMs)
      ? { sourceUpdatedAtMs: snapshot.sourceUpdatedAtMs }
      : {}),
    ...(snapshot.nativeRevision ? { nativeRevision: snapshot.nativeRevision } : {}),
  });
}

export function toTriageObservation(
  observation: GithubTriageObservationV1,
): TriageSourceObservationV1 {
  switch (observation.kind) {
    case 'present':
      return toTriagePresentObservation(observation);
    case 'absent':
      return Object.freeze({
        kind: 'absent' as const,
        localRef: toTriageLocalRef(observation.localRef),
      });
    case 'merged':
      return Object.freeze({
        kind: 'merged' as const,
        localRef: toTriageLocalRef(observation.localRef),
        successor: toTriageLocalRef(observation.successor),
      });
    case 'unresolved':
      return Object.freeze({
        kind: 'unresolved' as const,
        localRef: toTriageLocalRef(observation.localRef),
        failure: toTriageFailure(observation.failure),
      });
  }
}

export function toTriageScanObservation(
  observation: GithubTriageScanObservationV1,
): TriageSourceScanObservationV1 {
  // A scan can never conclude absence, and the provider type already excludes it.
  return toTriageObservation(observation) as TriageSourceScanObservationV1;
}

export function toTriageScanEvidence(
  evidence: GithubTriageScanEvidenceV1,
): TriageSourceScanEvidenceV1 {
  if (evidence.kind === 'walkFinished') return Object.freeze({ kind: 'walkFinished' as const });
  return Object.freeze({
    kind: 'partial' as const,
    reason: evidence.reason,
    ...(evidence.omittedItemCount === undefined
      ? {}
      : { omittedItemCount: evidence.omittedItemCount }),
  });
}
