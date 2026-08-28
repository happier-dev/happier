import type {
  TriageGetResultV1,
  TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';

import type { BitbucketTriageApiClient } from '../apiClient.js';
import type { BitbucketPullRequestNativeState } from '../entries.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from '../failures.js';
import { getBitbucketPullRequest } from '../pullRequests.js';
import { getBitbucketViewer } from '../viewer.js';
import { toTriageSourceFailure } from './failures.js';
import type { BitbucketEntryRouteV1 } from './invocationAdmission.js';
import { readViewerReviewVerdict, toBitbucketPresentObservation } from './observations.js';

/**
 * The one authoritative observation of a single Bitbucket entry, given an authorized client.
 *
 * `get` publishes it as a Triage role; a mutation reaches it twice — once as the fresh pre-write
 * currentness proof and once as the confirming read that says what actually happened. All three
 * must agree about what "this pull request, as this viewer sees it" means, so there is one
 * projector rather than one per caller.
 *
 * The viewer is read first for the same reason `get` reads it first: without the credential's
 * provider identity the present arm could only claim an empty involvement set, and *not involved*
 * is a different statement from *unknown*.
 *
 * Bitbucket Cloud V1 never concludes absence, so the only two arms this produces are `present` and
 * `unresolved`.
 */
export type BitbucketEntryObservationV1 = Readonly<{
  observation: TriageGetResultV1;
  /**
   * The two provider facts a currentness gate compares, carried out of the SAME read that produced
   * the observation.
   *
   * The published observation deliberately does not expose the native state and source-branch
   * commit as separate fields, and reading them again would be a second race — so the one read
   * hands back both. They are `null` exactly when the observation is `unresolved`.
   */
  state: BitbucketPullRequestNativeState | null;
  headCommit: string | null;
  viewerReviewVerdict: 'approved' | 'changes_requested' | null;
}>;

export async function observeBitbucketEntryWithFacts(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    localRef: TriageSourceEntryLocalRefV1;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketEntryObservationV1> {
  const unresolved = (failure: BitbucketTriageFailure): BitbucketEntryObservationV1 => ({
    observation: {
      kind: 'unresolved',
      localRef: input.localRef,
      failure: toTriageSourceFailure(failure),
    },
    state: null,
    headCommit: null,
    viewerReviewVerdict: null,
  });

  const viewer = await getBitbucketViewer({
    client: input.client,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!viewer.ok) return unresolved(viewer.failure);

  const outcome = await getBitbucketPullRequest({
    client: input.client,
    workspaceUuid: input.route.workspaceUuid,
    repositoryUuid: input.route.repositoryUuid,
    entryId: input.route.entryId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (outcome.kind === 'unresolved') return unresolved(outcome.failure);

  const observation = toBitbucketPresentObservation(outcome.entry, {
    viewerAccountUuid: viewer.viewer.accountUuid,
  });
  // The authoritative result addresses exactly the requested ref; a different ref is invalid rather
  // than a redirect the caller should follow.
  if (
    observation.localRef.kindId !== input.localRef.kindId
    || observation.localRef.collisionScope !== input.localRef.collisionScope
    || observation.localRef.entryId !== input.localRef.entryId
  ) {
    return unresolved(createBitbucketFailure('unknown', 'route-body-mismatch'));
  }

  return {
    observation,
    state: outcome.entry.state.native,
    headCommit: outcome.entry.source?.commitHash ?? null,
    viewerReviewVerdict: readViewerReviewVerdict(outcome.entry, viewer.viewer.accountUuid),
  };
}

/** The same read, for the caller that needs only the published observation. */
export async function observeBitbucketEntry(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    localRef: TriageSourceEntryLocalRefV1;
    signal?: AbortSignal;
  }>,
): Promise<TriageGetResultV1> {
  return (await observeBitbucketEntryWithFacts(input)).observation;
}
