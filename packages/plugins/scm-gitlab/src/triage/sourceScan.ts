/**
 * `scan` — one page of the GitLab walk per call.
 *
 * The caller's `limit` bounds ONE page. A call fills it across the involvement
 * lanes in fair rotation and then either hands back its own invocation-local
 * continuation (`page`, when a lane is still open) or ends the walk (`complete`,
 * when every lane has ended). The continuation is source-private: it is never
 * persisted, and a token this source did not mint — or one that no longer matches
 * this invocation's lanes or origin — is refused rather than adopted.
 *
 * Settling the whole account inside one call is what starved this source: at any
 * admissible limit one native page fills the budget, so the first lane took all of
 * it, the frontier was discarded, and the next refresh restarted at that same first
 * lane. Only `scope=created_by_me` was ever answered.
 *
 * Scan never concludes absence. `walkFinished` is the ceiling: the lanes are
 * selected universes and GitLab stops reporting collection totals past 10,000
 * records, so a finished walk is health evidence and nothing more.
 */

import type {
  TriageScanInputV1,
  TriageScanResultV1,
  TriageSourceScanEvidenceV1,
  TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { authorizeGitlabConfiguredInstance } from './configuredInstance.js';
import { GITLAB_TRIAGE_KIND_IDS } from './contribution.js';
import type { GitlabHttpFetcher } from './http/gitlabClient.js';
import type { GitlabConnectedAccounts } from './http/gitlabClient.js';
import { readGitlabViewerIdentity } from './invocation.js';
import {
  buildGitlabScanLanes,
  type GitlabLaneRequest,
  type GitlabUnavailableLane,
} from './mapping/gitlabInvolvement.js';
import {
  decodeGitlabScanContinuation,
  encodeGitlabScanContinuation,
  readGitlabScanContinuationViewerUserId,
} from './scan/gitlabScanContinuation.js';
import {
  createGitlabScanFrontier,
  hasOpenGitlabLane,
  projectGitlabPageHealth,
  runGitlabScan,
  type GitlabScanFrontier,
} from './scan/gitlabScanFrontier.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import { projectGitlabPresentObservation } from './sourceObservation.js';
import type { GitlabScanHealth } from './mapping/gitlabInvolvement.js';

export type GitlabScanOperationInput = Readonly<{
  scan: TriageScanInputV1;
  connectedAccounts: GitlabConnectedAccounts;
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  nowMs: number;
}>;

function projectScanEvidence(
  health: GitlabScanHealth,
  undecodableCount: number,
): TriageSourceScanEvidenceV1 {
  if (health.kind === 'walkFinished') return { kind: 'walkFinished' };
  return {
    kind: 'partial',
    reason: health.reason,
    // Only rows GitLab returned on THIS page and this source could not identify.
    // Entry-level presentation truncation is a separate fact and never counted here,
    // and a walk-level total would be double-counted by every consumer.
    ...(undecodableCount > 0 ? { omittedItemCount: undecodableCount } : {}),
  };
}

export async function scanGitlabTriageSource(
  input: GitlabScanOperationInput,
): Promise<TriageScanResultV1> {
  const authorized = await authorizeGitlabConfiguredInstance({
    instance: input.scan.instance,
    connectedAccounts: input.connectedAccounts,
    signal: input.signal,
  });
  if (authorized.kind === 'failed') {
    return { kind: 'failed', failure: projectGitlabSourceFailure(authorized.failure) };
  }
  const { origin, invocation } = authorized.resolved;

  const viewer = await readGitlabViewerIdentity({
    invocation,
    fetcher: input.fetcher,
    signal: input.signal,
    nowMs: input.nowMs,
  });
  if (viewer.kind === 'failed'
    && (viewer.failure.class === 'authentication' || viewer.failure.class === 'permission')) {
    // The credential cannot answer for its own account, so every lane below it
    // would report the same thing less clearly.
    return { kind: 'failed', failure: projectGitlabSourceFailure(viewer.failure) };
  }
  const viewerUserId = viewer.kind === 'identified'
    ? viewer.viewer.userId
    : input.scan.page.kind === 'continuation'
      ? readGitlabScanContinuationViewerUserId(input.scan.page.continuation)
      : null;
  if (viewerUserId === undefined) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unknown-continuation',
        detail: 'This source did not mint the continuation it was handed.',
      },
    };
  }

  const requests: GitlabLaneRequest[] = [];
  const unavailableLanes: GitlabUnavailableLane[] = [];
  for (const kindId of GITLAB_TRIAGE_KIND_IDS) {
    const lanes = buildGitlabScanLanes({ kindId, viewerUserId });
    requests.push(...lanes.requests);
    unavailableLanes.push(...lanes.unavailable);
  }

  let frontier: GitlabScanFrontier;
  if (input.scan.page.kind === 'initial') {
    frontier = createGitlabScanFrontier({
      scanLimit: input.scan.page.limit,
      origin,
      lanes: requests,
    });
  } else {
    // Every field is revalidated against the lanes THIS invocation built and the origin
    // it was authorized against. A token this process did not mint cannot be repaired
    // into a frontier — guessing one would aim this binding's credential at whatever
    // host the token named.
    const resumed = decodeGitlabScanContinuation({
      continuation: input.scan.page.continuation,
      origin,
      lanes: requests,
    });
    if (resumed === null) {
      return {
        kind: 'failed',
        failure: {
          class: 'unsupportedContract',
          code: 'unknown-continuation',
          detail: 'This source did not mint the continuation it was handed.',
        },
      };
    }
    frontier = resumed;
  }

  const settlement = await runGitlabScan({
    invocation,
    frontier,
    unavailableLanes,
    fetcher: input.fetcher,
    signal: input.signal,
    nowMs: input.nowMs,
  });
  if (settlement.kind === 'failed') {
    // The frontier dies with the failure: nothing is retained, and the next attempt
    // starts at `page: 'initial'`.
    return { kind: 'failed', failure: projectGitlabSourceFailure(settlement.failure) };
  }

  const observations: TriageSourceScanObservationV1[] = settlement.entries
    .map(projectGitlabPresentObservation);

  if (!hasOpenGitlabLane(frontier)) {
    return {
      kind: 'complete',
      observations,
      evidence: projectScanEvidence(
        projectGitlabPageHealth({
          frontier,
          budgetExhausted: settlement.budgetExhausted,
          continuationUnavailable: false,
        }),
        settlement.undecodableCount,
      ),
    };
  }

  const continuation = encodeGitlabScanContinuation(frontier);
  if (continuation === null) {
    // The walk cannot be handed back, so it ends here — and says so. A `complete` arm
    // that quietly dropped the remaining lanes would read as a finished walk.
    return {
      kind: 'complete',
      observations,
      evidence: projectScanEvidence(
        projectGitlabPageHealth({
          frontier,
          budgetExhausted: settlement.budgetExhausted,
          continuationUnavailable: true,
        }),
        settlement.undecodableCount,
      ),
    };
  }

  return {
    kind: 'page',
    observations,
    evidence: projectScanEvidence(
      projectGitlabPageHealth({
        frontier,
        budgetExhausted: settlement.budgetExhausted,
        continuationUnavailable: false,
      }),
      settlement.undecodableCount,
    ),
    continuation,
  };
}
