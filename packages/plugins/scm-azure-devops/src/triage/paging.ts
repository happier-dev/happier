import {
  decodeAzureProjectRow,
  decodeAzurePullRequestRow,
  decodeAzureRepositoryRow,
  decodeAzureRowPage,
} from './decode.js';
import { createAzureDevOpsFailure } from './failures.js';
import { readHeader } from './rateLimit.js';
import {
  AZURE_SCAN_STICKY_REASONS,
  type AzureDevOpsApiClient,
  type AzureInvolvementLaneId,
  type AzureLaneFrontier,
  type AzureProjectPage,
  type AzurePullRequestLanePage,
  type AzureRepositoryFrontierResult,
  type AzureScanFrontier,
  type AzureScanStickyReason,
} from './types.js';

/**
 * One project per page, deliberately.
 *
 * The provider-issued token then names the exact stable boundary after the current project,
 * so the walk never accumulates a project array or leans on a mutable array index.
 */
export const AZURE_PROJECT_PAGE_SIZE = 1;
export const AZURE_CONTINUATION_TOKEN_HEADER = 'x-ms-continuationtoken';

const LANE_ORDER: readonly AzureInvolvementLaneId[] = ['authored', 'reviewer'];

/**
 * Create the paging state for one bounded scan invocation.
 *
 * It is a plain function-local structure: it is never serialized, persisted, published in a
 * result, or resumed after interruption, and it holds no credential and no delivered ids.
 */
export function createAzureScanFrontier(input: Readonly<{
  scanLimit: number;
  nativePageSize: number;
}>): AzureScanFrontier {
  const scanLimit = Math.max(1, Math.floor(input.scanLimit));
  // One fixed native page geometry for the whole invocation. Shrinking `$top` mid-walk
  // corrupts the provider offset the walk already committed to.
  const nativePageSize = Math.min(Math.max(1, Math.floor(input.nativePageSize)), scanLimit);
  return {
    scanLimit,
    nativePageSize,
    projectId: null,
    projectNextToken: null,
    lastCompletedRepositoryId: null,
    currentRepositoryId: null,
    nextLaneIndex: 0,
    lanes: createAzureLaneFrontiers(),
    walkHealth: [],
    observed: 0,
  };
}

/** The two distinct provider queries every enabled repository is walked through. */
export function createAzureLaneFrontiers(): readonly AzureLaneFrontier[] {
  return LANE_ORDER.map((laneId) => ({ laneId, skip: 0, ended: false }));
}

/**
 * Record one §2.8b sticky caveat exactly once, in the closed declaration order.
 *
 * Order is preserved rather than sorted at read time because the declaration order *is* the
 * precedence the evidence arm reports with.
 */
export function recordAzureWalkHealth(
  frontier: AzureScanFrontier,
  reason: AzureScanStickyReason,
): void {
  if (frontier.walkHealth.includes(reason)) return;
  frontier.walkHealth = AZURE_SCAN_STICKY_REASONS.filter((candidate) => (
    candidate === reason || frontier.walkHealth.includes(candidate)
  ));
}

/** True when a whole further native page still fits the remaining projection budget. */
export function azurePageFitsBudget(frontier: AzureScanFrontier): boolean {
  return frontier.observed + frontier.nativePageSize <= frontier.scanLimit;
}

/**
 * Round-robin lane selection over the lanes still open (`sources/SCM.md` §2.8b).
 *
 * The rotation position is what makes fairness real: selecting the first open lane instead lets
 * a deep authored lane consume every page of the walk while the reviewer lane — the one a triage
 * reader opened the view for — is never queried at all.
 */
export function selectAzureLane(frontier: AzureScanFrontier): number {
  const count = frontier.lanes.length;
  for (let step = 0; step < count; step += 1) {
    const index = (frontier.nextLaneIndex + step) % count;
    if (frontier.lanes[index]?.ended === false) return index;
  }
  return -1;
}

/** Advance the rotation past the lane that just consumed a page. */
export function advanceAzureLaneRotation(frontier: AzureScanFrontier, laneIndex: number): void {
  frontier.nextLaneIndex = frontier.lanes.length === 0
    ? 0
    : (laneIndex + 1) % frontier.lanes.length;
}

export async function readAzureProjectPage(input: Readonly<{
  client: AzureDevOpsApiClient;
  continuationToken: string | null;
  signal: AbortSignal;
}>): Promise<AzureProjectPage> {
  const result = await input.client.request({
    route: { resource: 'projects' },
    query: {
      stateFilter: 'wellFormed',
      $top: AZURE_PROJECT_PAGE_SIZE,
      ...(input.continuationToken === null ? {} : { continuationToken: input.continuationToken }),
    },
    signal: input.signal,
  });
  if (!result.ok) return { ok: false, failure: result.failure };

  const page = decodeAzureRowPage(result.body, decodeAzureProjectRow);
  if (page === null) {
    return {
      ok: false,
      failure: createAzureDevOpsFailure({
        failureClass: 'malformedResponse',
        status: result.status,
        detail: 'The Azure DevOps project list did not return a value array.',
      }),
    };
  }

  return {
    ok: true,
    projects: page.rows,
    rawCardinality: page.rawCardinality,
    undecodable: page.undecodable,
    // Only the response-issued token continues the walk. A locally incremented or guessed
    // project token is not a continuation.
    continuationToken: readHeader(result.headers, AZURE_CONTINUATION_TOKEN_HEADER),
  };
}

/**
 * Read a project's repositories and return the frontier slice strictly after the supplied
 * repository GUID.
 *
 * The 7.1 repository list publishes an array, not a continuation protocol, so no page token is
 * invented for it. Ordering by immutable GUID makes the walk converge even while repositories
 * are created and reordered underneath it; provider presentation order is unaffected because
 * this ordering is scan-local.
 */
export async function readAzureRepositoriesAfter(input: Readonly<{
  client: AzureDevOpsApiClient;
  projectId: string;
  lastCompletedRepositoryId: string | null;
  signal: AbortSignal;
}>): Promise<AzureRepositoryFrontierResult> {
  const result = await input.client.request({
    route: { resource: 'repositories', project: input.projectId },
    signal: input.signal,
  });
  if (!result.ok) return { ok: false, failure: result.failure };

  const page = decodeAzureRowPage(result.body, decodeAzureRepositoryRow);
  if (page === null) {
    return {
      ok: false,
      failure: createAzureDevOpsFailure({
        failureClass: 'malformedResponse',
        status: result.status,
        detail: 'The Azure DevOps repository list did not return a value array.',
      }),
    };
  }

  const frontier = input.lastCompletedRepositoryId?.toLowerCase() ?? null;
  const repositories = [...page.rows]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .filter((repository) => frontier === null || repository.id > frontier);

  return {
    ok: true,
    repositories,
    rawCardinality: page.rawCardinality,
    undecodable: page.undecodable,
  };
}

/**
 * Read one native page of one pull-request involvement lane.
 *
 * The two lanes are distinct provider queries — `searchCriteria.creatorId` for authored and
 * `searchCriteria.reviewerId` for review-requested. No third "reviewed" query is guessed: the
 * viewer's returned vote already proves participation.
 */
export async function readAzurePullRequestLanePage(input: Readonly<{
  client: AzureDevOpsApiClient;
  projectId: string;
  repositoryId: string;
  lane: AzureInvolvementLaneId;
  viewerId: string;
  top: number;
  skip: number;
  signal: AbortSignal;
}>): Promise<AzurePullRequestLanePage> {
  const laneCriterion = input.lane === 'authored'
    ? { 'searchCriteria.creatorId': input.viewerId }
    : { 'searchCriteria.reviewerId': input.viewerId };

  const result = await input.client.request({
    route: {
      resource: 'pullRequests',
      project: input.projectId,
      repositoryId: input.repositoryId,
    },
    query: {
      ...laneCriterion,
      'searchCriteria.status': 'active',
      $top: input.top,
      $skip: input.skip,
    },
    signal: input.signal,
  });
  if (!result.ok) return { ok: false, failure: result.failure };

  const page = decodeAzureRowPage(result.body, decodeAzurePullRequestRow);
  if (page === null) {
    return {
      ok: false,
      failure: createAzureDevOpsFailure({
        failureClass: 'malformedResponse',
        status: result.status,
        detail: 'The Azure DevOps pull request list did not return a value array.',
      }),
    };
  }

  return {
    ok: true,
    rows: page.rows,
    rawCardinality: page.rawCardinality,
    undecodable: page.undecodable,
    // A short page ends the lane. A full page advances `$skip` by the raw cardinality and may
    // require one later empty terminal read; no `limit + 1` sentinel is fetched and discarded.
    ended: page.rawCardinality < input.top,
  };
}

/** Advance a lane by the provider's own raw cardinality — never by the decoded row count. */
export function advanceAzureLane(
  frontier: AzureScanFrontier,
  laneId: AzureInvolvementLaneId,
  rawCardinality: number,
  ended: boolean,
): void {
  frontier.lanes = frontier.lanes.map((lane) => (
    lane.laneId === laneId
      ? { laneId: lane.laneId, skip: lane.skip + rawCardinality, ended: lane.ended || ended }
      : lane
  ));
}
