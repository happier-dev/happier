import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';

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
  TriageGetResultV1,
  TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';

import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from '../configuration.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../contribution.js';
import { GITHUB_CHANGED_FILES_PAGE_SIZE_V1 } from '../detail/routes.js';
import { buildGithubRepositoryKey, parseGithubRoutingToken } from '../locator.js';

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
 * observation- and locator-level facts), and every bounded text member rejects an
 * empty string. Row facts already use the public vocabulary; this seam omits
 * observations that tolerant provider decoding could not make emittable.
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
/**
 * Projects GitHub row facts onto the published Triage value constraints.
 *
 * The detail Feedback surface uses this same conversion when it replaces a
 * snapshot's stale review/check facts with its live state facts. Keeping that
 * conversion here prevents the two surfaces from disagreeing on the public
 * status payload spelling.
 */
export function toTriageFacts(facts: readonly GithubTriageRowFactV1[]): ProjectedFacts {
  const projected: TriageRowFactV1[] = [];
  let dropped = false;
  for (const fact of facts) {
    const value = fact.value;
    switch (value.kind) {
      case 'text':
      case 'actor': {
        const text = value.value;
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
        if (!value.value) {
          dropped = true;
          break;
        }
        projected.push(Object.freeze({
          id: fact.id,
          importance: fact.importance,
          value: Object.freeze({ kind: 'status' as const, value: value.value, tone: value.tone }),
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
    // materializations and never ride a list result. Complete task edit values
    // are carried separately by exact get, never by this display snapshot.
    scopeLabel,
    ...(snapshot.scopeDisplayName === undefined ? {} : { scopeDisplayName: snapshot.scopeDisplayName }),
    ...(snapshot.authorLabel === undefined ? {} : { authorLabel: snapshot.authorLabel }),
    ...(snapshot.designation === undefined ? {} : { designation: snapshot.designation }),
    ...(isEmittableInstant(snapshot.createdAtMs) ? { createdAtMs: snapshot.createdAtMs } : {}),
    ...(snapshot.completedAtMs === undefined ? {} : { completedAtMs: snapshot.completedAtMs }),
    state: Object.freeze({
      presentation: snapshot.state.presentation,
      ...(snapshot.state.stage === undefined ? {} : { stage: snapshot.state.stage }),
      ...(snapshot.state.completionReason === undefined ? {} : { completionReason: snapshot.state.completionReason }),
      // GitHub's `state` is a bare provider string and an unrecognized value reaches
      // here verbatim, so the provider's own word is projected into one bounded line
      // like every other display string. Nothing surviving omits the label rather than
      // publishing a blank one, which the non-empty published string would reject.
      ...(nativeLabel.value.length === 0 ? {} : { nativeLabel: nativeLabel.value }),
    }),
    facts: facts.facts,
    ...(snapshot.relations === undefined ? {} : { relations: snapshot.relations }),
    ...(snapshot.reviewRevision === undefined
      ? {}
      : { reviewRevision: snapshot.reviewRevision }),
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
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.retryNotBeforeMs === undefined
      ? {}
      : { retryNotBeforeMs: failure.retryNotBeforeMs }),
  });
}

function toTriagePresentObservation(
  observation: Extract<GithubTriageObservationV1, Readonly<{ kind: 'present' }>>,
): Extract<TriageSourceObservationV1, Readonly<{ kind: 'present' }>> {
  const snapshot = observation.snapshot;
  const scopeRoute = parseGithubRoutingToken(observation.locator.routingToken);
  const scopeUnitId = scopeRoute === null ? null : buildGithubRepositoryKey(scopeRoute);
  const repository = snapshot.nameWithOwner === null
    ? null
    : normalizeScmHostingRepositoryIdentity({
        kind: 'github',
        deployment: GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
        repository: snapshot.nameWithOwner,
      });
  return Object.freeze({
    kind: 'present' as const,
    localRef: toTriageLocalRef(observation.localRef),
    locator: toTriageLocator(observation.locator),
    snapshot: {
      ...toTriageSnapshot(snapshot, observation.locator, observation.localRef.entryId),
      ...(scopeUnitId === null ? {} : { scopeUnitId }),
    },
    viewer: toTriageViewerFacts(observation.viewer),
    ...(isEmittableInstant(snapshot.sourceUpdatedAtMs)
      ? { sourceUpdatedAtMs: snapshot.sourceUpdatedAtMs }
      : {}),
    ...(snapshot.nativeRevision ? { nativeRevision: snapshot.nativeRevision } : {}),
    // The forge repository, in the exact vocabulary a project's resolved SCM
    // hosting provider already uses, so launch placement joins the two by
    // equality instead of by parsing a remote URL.
    ...(repository === null ? {} : { repository }),
  });
}

export function toTriageObservation(
  observation: Extract<GithubTriageObservationV1, { kind: 'present' }>,
): Extract<TriageSourceObservationV1, { kind: 'present' }>;
export function toTriageObservation(observation: GithubTriageObservationV1): TriageSourceObservationV1;
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

/**
 * Only an authoritative get returns executable comparison routing. The same
 * response owns its immutable endpoints; the configured instance belongs to
 * this invocation and never enters the persisted row projection above.
 */
export function toTriageGetResult(
  observation: GithubTriageObservationV1,
  instance: TriageConfiguredSourceInstanceV1,
): TriageGetResultV1 {
  const projected = toTriageObservation(observation);
  if (observation.kind !== 'present' || projected.kind !== 'present') return projected;
  if (observation.localRef.kindId !== 'pull-request') return { ...projected,
    ...(observation.taskFields === undefined ? {} : { taskFields: observation.taskFields }) };
  const revision = observation.snapshot.reviewRevision;
  const route = parseGithubRoutingToken(observation.locator.routingToken);
  const repository = route === null ? null : buildGithubRepositoryKey(route);
  const number = Number(observation.localRef.entryId);
  if (revision === undefined || repository === null || !Number.isSafeInteger(number) || number < 1) return projected;
  return Object.freeze({
    ...projected,
    comparisonSource: Object.freeze({
      kind: 'pullRequest' as const,
      locator: Object.freeze({
        providerId: 'github',
        repository,
        number,
        baseOid: revision.baseSha,
        headOid: revision.headSha,
        sourceAction: Object.freeze({
          action: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles }),
          input: Object.freeze({
            v: 1,
            instance,
            localRef: toTriageLocalRef(observation.localRef),
            routingToken: repository,
            limit: GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
            comparison: true,
          }),
        }),
      }),
    }),
  });
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
