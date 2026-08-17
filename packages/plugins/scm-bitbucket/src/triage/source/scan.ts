import {
  type TriageScanInputV1,
  type TriageScanResultV1,
  type TriageSourceScanEvidenceV1,
  type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';

import { createBitbucketFailure, type BitbucketTriageFailure } from '../failures.js';
import { decodeBitbucketConfiguration } from '../instance.js';
import { resolveBitbucketPageGeometry, type BitbucketPageGeometry } from '../pagination.js';
import {
  BITBUCKET_TRIAGE_LANE_IDS,
  buildBitbucketAuthoredLaneUrl,
  buildBitbucketRepositoryReviewLaneUrl,
  readBitbucketLaneAvailability,
  scanBitbucketPullRequests,
} from '../pullRequests.js';
import { createBitbucketRepositoryEnumerator } from '../repositoryFrontier.js';
import {
  BITBUCKET_REPOSITORY_ROUTE_ID,
  decodeBitbucketScanContinuation,
  encodeBitbucketScanContinuation,
  type BitbucketScanFrontierRecord,
  type BitbucketWalkHealthReason,
} from '../scanContinuation.js';
import { getBitbucketViewer } from '../viewer.js';
import {
  createAuthorizedBitbucketClient,
  type BitbucketSourceRuntime,
} from './authorization.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import { toTriageSourceFailure } from './failures.js';
import { toBitbucketPresentObservation } from './observations.js';

function failed(failure: BitbucketTriageFailure): TriageScanResultV1 {
  return { kind: 'failed', failure: toTriageSourceFailure(failure) };
}

type ScanStart = Readonly<{
  geometry: BitbucketPageGeometry;
  nextLaneIndex: number;
  walkHealth: readonly BitbucketWalkHealthReason[];
  authored: BitbucketScanFrontierRecord['authored'];
  repositoryListNextUrl: string | null;
  currentRepository: BitbucketScanFrontierRecord['currentRepository'];
}>;

function readScanStart(
  input: TriageScanInputV1,
): Readonly<{ ok: true; start: ScanStart }> | Readonly<{ ok: false; failure: BitbucketTriageFailure }> {
  if (input.page.kind === 'initial') {
    const geometry = resolveBitbucketPageGeometry(input.page.limit);
    if (!geometry.ok) return { ok: false, failure: geometry.failure };
    return {
      ok: true,
      start: {
        geometry: geometry.geometry,
        nextLaneIndex: 0,
        walkHealth: [],
        authored: { nextUrl: null, ended: false },
        repositoryListNextUrl: null,
        currentRepository: null,
      },
    };
  }

  // A continuation this source did not mint in this process — another version, an unrecognized
  // health reason, a URL that is not a Bitbucket API URL — is refused rather than guessed at, so
  // the next attempt restarts at `page: 'initial'`.
  const decoded = decodeBitbucketScanContinuation(input.page.continuation);
  if (decoded === null) {
    return { ok: false, failure: createBitbucketFailure('unsupportedContract', 'continuation-not-issued') };
  }
  return {
    ok: true,
    start: {
      // Page geometry is chosen once on the initial call and reused unchanged on every following
      // page. It is never shrunk to fit a remainder.
      geometry: { scanLimit: decoded.scanLimit, nativePageSize: decoded.nativePageSize },
      nextLaneIndex: decoded.nextLaneIndex,
      walkHealth: decoded.walkHealth,
      authored: decoded.authored,
      repositoryListNextUrl: decoded.repositoryListNextUrl,
      currentRepository: decoded.currentRepository,
    },
  };
}

/**
 * One bounded Bitbucket scan page, confined to exactly one configured account × workspace.
 *
 * `input.limit` is this call's raw-row budget. The call fills up to it and then settles: while any
 * lane or the repository enumeration is still open the result is `page` plus this invocation's
 * frontier, and only an all-lanes-ended walk over a finished enumeration returns `complete`. The
 * frontier exists solely in memory for this refresh — it is never persisted, never resumed after an
 * interruption, and never promoted into a checkpoint, lease, epoch or scheduled resume point.
 */
export async function scanBitbucketSource(
  runtime: BitbucketSourceRuntime,
  input: TriageScanInputV1,
): Promise<TriageScanResultV1> {
  if (input.instance.binding.purpose !== BITBUCKET_CONNECTED_ACCOUNT_PURPOSE) {
    return failed(createBitbucketFailure('unsupportedContract', 'binding-purpose-mismatch'));
  }

  const configuration = decodeBitbucketConfiguration(input.instance.configuration);
  if (configuration === null) {
    return failed(createBitbucketFailure('unsupportedContract', 'configuration-undecodable'));
  }
  // The configured instance's own key must agree with the routing it carries; a disagreement is a
  // mismatched tuple rather than a hint about which workspace to walk.
  if (input.instance.localInstanceKey !== configuration.workspaceUuid) {
    return failed(createBitbucketFailure('unsupportedContract', 'configuration-instance-mismatch'));
  }

  const started = readScanStart(input);
  if (!started.ok) return failed(started.failure);
  const start = started.start;

  const authorized = await createAuthorizedBitbucketClient(runtime, {
    purpose: input.instance.binding.purpose,
    account: input.instance.binding.account,
  });
  if (!authorized.ok) return failed(authorized.failure);

  // The viewer belongs to the credential rather than to the workspace, so it is read per
  // invocation and never carried in the continuation: a reconnect between pages stays correct
  // without a token migration, and no account identity ever rides a routing token.
  const viewer = await getBitbucketViewer({
    client: authorized.client,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (!viewer.ok) return failed(viewer.failure);

  const workspaceUuid = configuration.workspaceUuid;
  const accountUuid = viewer.viewer.accountUuid;

  const unavailableLanes = BITBUCKET_TRIAGE_LANE_IDS.flatMap((laneId) => {
    const availability = readBitbucketLaneAvailability(laneId);
    return availability.kind === 'unavailable'
      ? [{ laneId, reason: availability.reason }]
      : [];
  });

  // Review involvement is repository-scoped on this forge: the workspace-wide selected-user route
  // is authored-only and is never misrepresented as account-wide review discovery. The enumeration
  // is entered one repository at a time so the continuation stays bounded by this contract rather
  // than by the workspace inventory.
  const repositories = createBitbucketRepositoryEnumerator({
    client: authorized.client,
    workspaceUuid,
    resumeUrl: start.repositoryListNextUrl,
    enteredRepositoryUuid: start.currentRepository?.repositoryUuid ?? null,
    initial: input.page.kind === 'initial',
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  const carriedRepositoryLane = start.currentRepository === null
    ? null
    : {
      repositoryUuid: start.currentRepository.repositoryUuid,
      lane: start.currentRepository.lanes[0] ?? { nextUrl: null, ended: true },
    };

  const outcome = await scanBitbucketPullRequests({
    client: authorized.client,
    geometry: start.geometry,
    authoredSeedUrl: buildBitbucketAuthoredLaneUrl({ workspaceUuid, accountUuid }),
    authored: start.authored,
    currentRepository: carriedRepositoryLane,
    nextLaneIndex: start.nextLaneIndex,
    buildRepositoryLaneUrl: (repositoryUuid) => buildBitbucketRepositoryReviewLaneUrl({
      workspaceUuid,
      repositoryUuid,
    }),
    repositories,
    unavailableLanes,
    carriedWalkHealth: start.walkHealth,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (!outcome.ok) return failed(outcome.failure);

  // The repository route is unfiltered, because Bitbucket refuses every `participants.*` predicate
  // and the one reviewer predicate it does accept cannot express `reviewed`. The involvement
  // predicate is therefore evaluated here, against the reviewer and participant evidence each row
  // carries — exactly, since a participant's identity and their approval are properties of one
  // object. A pull request this credential is proven to have no relationship to is not this
  // account's triage row, so it is not published as one.
  const observations: TriageSourceScanObservationV1[] = outcome.observations.flatMap(
    (observation) => {
      const projected = toBitbucketPresentObservation(observation.entry, {
        ...(observation.routeInvolvement === null
          ? {}
          : { laneInvolvement: observation.routeInvolvement }),
        viewerAccountUuid: accountUuid,
      });
      return projected.viewer.involvement.length === 0 ? [] : [projected];
    },
  );

  const continuation = outcome.walkOpen
    ? encodeBitbucketScanContinuation({
      scanLimit: start.geometry.scanLimit,
      nativePageSize: start.geometry.nativePageSize,
      nextLaneIndex: outcome.frontier.nextLaneIndex,
      walkHealth: outcome.walkHealth,
      authored: outcome.frontier.authored,
      repositoryListNextUrl: repositories.cursorUrl(),
      currentRepository: outcome.frontier.currentRepository === null
        ? null
        : {
          repositoryUuid: outcome.frontier.currentRepository.repositoryUuid,
          lanes: [{
            laneId: BITBUCKET_REPOSITORY_ROUTE_ID,
            ...outcome.frontier.currentRepository.lane,
          }],
        },
    } satisfies BitbucketScanFrontierRecord)
    : null;

  const evidence = resolveScanEvidence({
    walkHealth: outcome.walkHealth,
    omittedItemCount: outcome.omittedItemCount,
    projectionBudget: outcome.projectionBudget,
    // A frontier the token cannot hold ends the walk here rather than being truncated into one
    // that addresses the wrong repository, and the result says so.
    continuationUnavailable: outcome.walkOpen && continuation === null,
  });

  return continuation === null
    ? { kind: 'complete', observations, evidence }
    : { kind: 'page', observations, evidence, continuation };
}

/**
 * The one evidence arm this call reports.
 *
 * Precedence is fixed and declaration-ordered: the sticky walk-level reasons first, then this
 * call's own page-shape fact. `walkFinished` belongs only to a settled walk whose sticky set is
 * empty — a clean-looking finish produced by a call that never witnessed the truncation is the arm
 * that lies. `omittedItemCount` stays a per-call number describing the rows *this* page returned.
 */
function resolveScanEvidence(
  input: Readonly<{
    walkHealth: readonly BitbucketWalkHealthReason[];
    omittedItemCount: number;
    projectionBudget: boolean;
    continuationUnavailable: boolean;
  }>,
): TriageSourceScanEvidenceV1 {
  const carry = input.omittedItemCount > 0 ? { omittedItemCount: input.omittedItemCount } : {};

  if (input.continuationUnavailable) {
    return { kind: 'partial', reason: 'continuation-unavailable', ...carry };
  }
  const sticky = input.walkHealth[0];
  if (sticky !== undefined) return { kind: 'partial', reason: sticky, ...carry };
  if (input.projectionBudget) return { kind: 'partial', reason: 'projection-budget', ...carry };
  return { kind: 'walkFinished' };
}
