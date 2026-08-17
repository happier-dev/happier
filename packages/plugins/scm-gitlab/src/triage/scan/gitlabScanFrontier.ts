/**
 * The bounded scan walk — one page of it per call.
 *
 * The caller's `limit` is ONE page, not a whole-walk ceiling. A call fills up to that
 * many provider rows across the lanes in fair rotation, then stops. If any lane is
 * still open the frontier is handed back as an invocation-local continuation the
 * target copies and returns; when every lane has ended the walk is complete. The
 * continuation is never persisted, never checkpointed, and is simply dropped on
 * cancellation, deadline, failure or restart — a dropped walk starts again at its
 * initial provider request, which costs a page and loses nothing.
 *
 * Lane selection is round-robin so no lane can starve. Answering only
 * `scope=created_by_me` is the failure this exists to prevent.
 *
 * Page geometry is fixed for the whole walk. Shrinking `per_page` mid-walk corrupts
 * GitLab's own position, and fetching one extra item to discover whether a next page
 * exists spends the user's quota to learn something the `Link` header already says.
 */

import type { GitlabConfiguredOrigin } from '../origin.js';
import { buildGitlabApiUrl, requestGitlabJson } from '../http/gitlabClient.js';
import type {
  GitlabAuthorizedInvocation,
  GitlabHttpFetcher,
} from '../http/gitlabClient.js';
import { selectGitlabNextPageUrl } from '../http/gitlabLink.js';
import { decodeGitlabPage } from '../mapping/gitlabEntry.js';
import type {
  GitlabLaneId,
  GitlabLaneRequest,
  GitlabScanHealth,
  GitlabStickyWalkReason,
  GitlabUnavailableLane,
  GitlabWalkReason,
} from '../mapping/gitlabInvolvement.js';
import { projectGitlabScanHealth } from '../mapping/gitlabInvolvement.js';
import type { GitlabFailure, GitlabMappedEntry } from '../types.js';

/** GitLab caps REST `per_page` at 100. */
export const GITLAB_MAX_NATIVE_PAGE_SIZE = 100;

export type GitlabLaneFrontier = {
  readonly request: GitlabLaneRequest;
  nextUrl: string;
  ended: boolean;
};

export type GitlabScanFrontier = Readonly<{
  scanLimit: number;
  nativePageSize: number;
  lanes: readonly GitlabLaneFrontier[];
  /**
   * The one walk-level fact the frontier carries: the sticky reasons any page of this
   * walk has already observed. Names only — never counts, because `omittedItemCount`
   * describes the rows one page returned and a walk-level total would be double-counted
   * by every consumer.
   */
  walkHealth: Set<GitlabStickyWalkReason>;
}> & { nextLaneIndex: number };

export function createGitlabScanFrontier(input: Readonly<{
  scanLimit: number;
  origin: GitlabConfiguredOrigin;
  lanes: readonly GitlabLaneRequest[];
  walkHealth?: ReadonlySet<GitlabStickyWalkReason>;
}>): GitlabScanFrontier {
  const nativePageSize = Math.max(1, Math.min(input.scanLimit, GITLAB_MAX_NATIVE_PAGE_SIZE));
  return {
    scanLimit: input.scanLimit,
    nativePageSize,
    nextLaneIndex: 0,
    walkHealth: new Set(input.walkHealth ?? []),
    lanes: input.lanes.map((request) => ({
      request,
      nextUrl: buildGitlabApiUrl(input.origin, request.path, [
        ...request.query,
        ['per_page', String(nativePageSize)],
        // Newest-first is the ordering the surface reads; it is fixed for the whole
        // invocation so a later page cannot silently re-sort the walk.
        ['order_by', 'updated_at'],
        ['sort', 'desc'],
      ]),
      ended: false,
    })),
  };
}

export type GitlabScanSettlement = Readonly<{
  kind: 'settled';
  /** One observation per encounter, in walk order. Lanes are never pre-deduplicated. */
  entries: readonly GitlabMappedEntry[];
  health: GitlabScanHealth;
  /** Rows GitLab returned that could not be identified. */
  undecodableCount: number;
  /** Raw provider rows consumed, which is what the projection budget spends. */
  consumedItemCount: number;
  /** True when the page ended on the caller's limit rather than on the lanes ending. */
  budgetExhausted: boolean;
}>;

/** Whether any lane still has a provider page this walk has not read. */
export function hasOpenGitlabLane(frontier: GitlabScanFrontier): boolean {
  return frontier.lanes.some((lane) => !lane.ended);
}

export type GitlabScanResult =
  | GitlabScanSettlement
  | Readonly<{ kind: 'failed'; failure: GitlabFailure }>;

export type GitlabScanInput = Readonly<{
  invocation: GitlabAuthorizedInvocation;
  frontier: GitlabScanFrontier;
  unavailableLanes: readonly GitlabUnavailableLane[];
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  nowMs: number;
}>;

function selectNextLane(frontier: GitlabScanFrontier): GitlabLaneFrontier | null {
  const total = frontier.lanes.length;
  for (let step = 0; step < total; step += 1) {
    const index = (frontier.nextLaneIndex + step) % total;
    const lane = frontier.lanes[index];
    if (lane && !lane.ended) {
      frontier.nextLaneIndex = (index + 1) % total;
      return lane;
    }
  }
  return null;
}

/**
 * The reasons this page reports: the walk's sticky set plus this call's own page-shape
 * fact. The sticky set is read from the frontier, so a row skipped on page one is still
 * reported by the page that settles the walk.
 */
function pageReasons(
  frontier: GitlabScanFrontier,
  budgetExhausted: boolean,
): Set<GitlabWalkReason> {
  const reasons = new Set<GitlabWalkReason>(frontier.walkHealth);
  if (budgetExhausted) reasons.add('projection-budget');
  return reasons;
}

export async function runGitlabScan(input: GitlabScanInput): Promise<GitlabScanResult> {
  const { frontier } = input;
  // A lane GitLab offers no query for is observed once, when the lanes are built, and
  // is a property of the whole walk rather than of the page that noticed it.
  if (input.unavailableLanes.length > 0) frontier.walkHealth.add('lane-unavailable');
  const entries: GitlabMappedEntry[] = [];
  let consumedItemCount = 0;
  let undecodableCount = 0;
  let budgetExhausted = false;

  for (;;) {
    if (input.signal.aborted) {
      return { kind: 'failed', failure: { class: 'transient', code: 'cancelled' } };
    }

    if (!hasOpenGitlabLane(frontier)) break;

    // The budget is checked BEFORE a lane is selected, because selecting one advances
    // the rotation: stopping after the selection would silently skip that lane on the
    // next call. A whole native page either fits the remaining budget or this page
    // ends; nothing is fetched and thrown away to find out.
    if (consumedItemCount + frontier.nativePageSize > frontier.scanLimit) {
      budgetExhausted = true;
      break;
    }

    const lane = selectNextLane(frontier);
    if (!lane) break;

    const result = await requestGitlabJson({
      invocation: input.invocation,
      url: lane.nextUrl,
      fetcher: input.fetcher,
      signal: input.signal,
      nowMs: input.nowMs,
    });
    if (result.kind === 'failed') {
      // A rate limit or deadline settles as the ordinary failed result. It never
      // retains continuation custody and never waits through a provider reset.
      return { kind: 'failed', failure: result.failure };
    }

    const decoded = decodeGitlabPage({
      kindId: lane.request.kindId,
      origin: input.invocation.origin,
      body: result.response.body,
      laneInvolvement: lane.request.involvement,
      ...(lane.request.nativeRowFact ? { laneRowFact: lane.request.nativeRowFact } : {}),
    });
    if (!decoded) {
      return {
        kind: 'failed',
        failure: { class: 'unsupportedContract', code: 'unexpected-page-shape' },
      };
    }

    entries.push(...decoded.entries);
    undecodableCount += decoded.undecodableCount;
    if (decoded.undecodableCount > 0) frontier.walkHealth.add('undecodable-items');
    // Position advances by what GitLab returned, not by what decoded cleanly.
    consumedItemCount += decoded.rawItemCount;

    const nextUrl = selectGitlabNextPageUrl(
      result.response.headers,
      input.invocation.origin.normalized,
    );
    if (nextUrl === null) {
      lane.ended = true;
    } else {
      lane.nextUrl = nextUrl;
    }
  }

  return {
    kind: 'settled',
    entries,
    health: projectGitlabScanHealth(pageReasons(frontier, budgetExhausted)),
    undecodableCount,
    consumedItemCount,
    budgetExhausted,
  };
}

/**
 * The health a settled page reports once its caller knows whether the walk could be
 * handed back. `continuation-unavailable` is not sticky and is not held on the
 * frontier — it exists only on the call that could not encode one.
 */
export function projectGitlabPageHealth(input: Readonly<{
  frontier: GitlabScanFrontier;
  budgetExhausted: boolean;
  continuationUnavailable: boolean;
}>): GitlabScanHealth {
  const reasons = pageReasons(input.frontier, input.budgetExhausted);
  if (input.continuationUnavailable) reasons.add('continuation-unavailable');
  return projectGitlabScanHealth(reasons);
}

export type { GitlabLaneId };
