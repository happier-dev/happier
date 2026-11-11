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

import {
  advanceCursorCycleWalkV1,
  type CursorCycleProbeV1,
} from '@happier-dev/triage-sources/runtime';
import {
  buildGitlabApiUrl,
  GITLAB_REST_MAX_PAGE_SIZE,
  requestGitlabJson,
} from '../http/gitlabClient.js';
import type {
  GitlabAuthorizedInvocation,
  GitlabHttpFetcher,
} from '../http/gitlabClient.js';
import { selectGitlabNextPageUrl, isGitlabPageWithinResource } from '../http/gitlabLink.js';
import { decodeGitlabPage } from '../mapping/gitlabEntry.js';
import type {
  GitlabLaneId,
  GitlabLaneRequest,
  GitlabScanHealth,
  GitlabStickyWalkReason,
  GitlabUnavailableLane,
  GitlabWalkReason,
} from '../mapping/gitlabInvolvement.js';
import { mapGitlabNativeSortField, projectGitlabScanHealth } from '../mapping/gitlabInvolvement.js';
import type { GitlabConfiguredOrigin } from '../origin.js';
import type { GitlabFailure, GitlabMappedEntry } from '../types.js';

/** The provider maximum used to derive one scan walk's fixed native geometry. */
export const GITLAB_MAX_NATIVE_PAGE_SIZE = GITLAB_REST_MAX_PAGE_SIZE;

/**
 * The one derivation of this walk's fixed provider page size.
 *
 * It partitions the caller's limit across sorted streams and is exported because
 * the continuation decoder has to answer the SAME question about a token it is handed.
 * A decoder that accepted whatever geometry a token named would let a resumed walk run
 * at a page size and a budget this source would never have chosen — which is a second
 * owner of the walk's geometry, reached through untrusted bytes.
 */
export function deriveGitlabNativePageSize(scanLimit: number, streamCount = 1): number {
  return Math.max(1, Math.min(Math.floor(scanLimit / streamCount), GITLAB_MAX_NATIVE_PAGE_SIZE));
}

export type GitlabLaneFrontier = {
  readonly request: GitlabLaneRequest;
  nextUrl: string;
  ended: boolean;
  /** Unshown rows from at most one native provider page. */
  pending: unknown[];
  /** Constant-space evidence that this provider walk has not revisited a URL. */
  cycleProbe: CursorCycleProbeV1;
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

/** The initial native request also owns the frozen filters of every next URL. */
export function buildGitlabScanLaneUrl(origin: GitlabConfiguredOrigin, request: GitlabLaneRequest, nativePageSize: number): string {
  const field = mapGitlabNativeSortField(request.sort?.field ?? 'updated');
  const sortQuery = field === undefined ? [] as const
    : [['order_by', field], ['sort', request.sort?.direction ?? 'desc']] as const;
  return buildGitlabApiUrl(origin, request.path, [
    ...request.query,
    ['per_page', String(nativePageSize)],
    ...sortQuery,
  ]);
}

export function createGitlabScanFrontier(input: Readonly<{
  scanLimit: number;
  origin: GitlabConfiguredOrigin;
  lanes: readonly GitlabLaneRequest[];
  walkHealth?: ReadonlySet<GitlabStickyWalkReason>;
}>): GitlabScanFrontier {
  const nativePageSize = deriveGitlabNativePageSize(input.scanLimit, input.lanes[0]?.sort === undefined ? 1 : input.lanes.length);
  return {
    scanLimit: input.scanLimit,
    nativePageSize,
    nextLaneIndex: 0,
    walkHealth: new Set(input.walkHealth ?? []),
    lanes: input.lanes.map((request) => {
      const nextUrl = buildGitlabScanLaneUrl(input.origin, request, nativePageSize);
      const initialized = advanceCursorCycleWalkV1(null, nextUrl);
      if (initialized.kind !== 'advanced') throw new Error('an initial cursor cannot be revisited');
      return {
        request,
        nextUrl,
        ended: false,
        pending: [],
        cycleProbe: initialized.walk.probe,
      };
    }),
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
  return frontier.lanes.some((lane) => !lane.ended || lane.pending.length > 0);
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
  const requestedSort = frontier.lanes[0]?.request.sort;
  const sort = requestedSort?.field === 'updated' || requestedSort?.field === 'created' ? requestedSort : undefined;
  // A lane GitLab offers no query for is observed once, when the lanes are built, and
  // is a property of the whole walk rather than of the page that noticed it.
  if (input.unavailableLanes.length > 0) frontier.walkHealth.add('lane-unavailable');
  const entries: GitlabMappedEntry[] = [];
  let consumedItemCount = 0;
  let undecodableCount = 0;
  let budgetExhausted = false;
  const fetched = new Set<GitlabLaneFrontier>();

  for (;;) {
    if (input.signal.aborted) {
      return { kind: 'failed', failure: { class: 'transient', code: 'cancelled' } };
    }

    if (!hasOpenGitlabLane(frontier)) break;

    // The budget is checked BEFORE a lane is selected, because selecting one advances
    // the rotation: stopping after the selection would silently skip that lane on the
    // next call. A whole native page either fits the remaining budget or this page
    // ends; nothing is fetched and thrown away to find out.
    if (sort === undefined ? consumedItemCount + frontier.nativePageSize > frontier.scanLimit : consumedItemCount >= frontier.scanLimit) {
      budgetExhausted = true;
      break;
    }

    const decodeHead = (lane: GitlabLaneFrontier) => decodeGitlabPage({
      kindId: lane.request.kindId, origin: input.invocation.origin, body: [lane.pending[0]],
      laneInvolvement: lane.request.involvement,
      ...(lane.request.nativeRowFact ? { laneRowFact: lane.request.nativeRowFact } : {}),
    });
    const lane = sort === undefined ? selectNextLane(frontier)
      : frontier.lanes.find(candidate => !candidate.ended && candidate.pending.length === 0) ?? null;
    if (sort !== undefined && lane === null) {
      const candidates = frontier.lanes.filter(candidate => candidate.pending.length > 0);
      const compare = (a: GitlabLaneFrontier, b: GitlabLaneFrontier): number => {
        const left = decodeHead(a)?.entries[0]; const right = decodeHead(b)?.entries[0];
        if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
        const leftValue = sort.field === 'created' ? left.snapshot.sourceCreatedAtMs : left.snapshot.sourceUpdatedAtMs;
        const rightValue = sort.field === 'created' ? right.snapshot.sourceCreatedAtMs : right.snapshot.sourceUpdatedAtMs;
        const difference = (leftValue ?? 0) - (rightValue ?? 0);
        return difference === 0 ? `${left.identity.collisionScope}:${left.identity.kindId}:${left.identity.entryId}`.localeCompare(`${right.identity.collisionScope}:${right.identity.kindId}:${right.identity.entryId}`)
          : sort.direction === 'asc' ? difference : -difference;
      };
      let head = candidates[0];
      for (const candidate of candidates.slice(1)) if (head !== undefined && compare(candidate, head) < 0) head = candidate;
      if (head === undefined) break;
      const decoded = decodeHead(head);
      head.pending.shift();
      consumedItemCount += 1;
      if (decoded === null || decoded.undecodableCount > 0) {
        undecodableCount += 1;
        frontier.walkHealth.add('undecodable-items');
      } else entries.push(...decoded.entries);
      continue;
    }
    if (!lane) break;
    if (sort !== undefined && fetched.has(lane)) { budgetExhausted = true; break; }
    fetched.add(lane);

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

    // GitLab accepted the fixed `per_page` geometry. More raw rows than that —
    // or more than this call's remaining public budget — is provider
    // overdelivery, not data this source may push into the aggregate envelope.
    // Reject before decoding/mapping or advancing the frontier, so the failure
    // is atomic at this source boundary rather than at the host envelope.
    const rawItemCount = result.response.rawItemCount;
    if (rawItemCount !== null && (rawItemCount > frontier.nativePageSize
      || (sort === undefined && consumedItemCount + rawItemCount > frontier.scanLimit))) {
      return {
        kind: 'failed',
        failure: { class: 'unsupportedContract', code: 'provider-overdelivery' },
      };
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

    if (sort === undefined) {
      entries.push(...decoded.entries);
      undecodableCount += decoded.undecodableCount;
      if (decoded.undecodableCount > 0) frontier.walkHealth.add('undecodable-items');
      consumedItemCount += decoded.rawItemCount;
    } else if (Array.isArray(result.response.body)) {
      lane.pending.push(...result.response.body);
    }

    const selection = selectGitlabNextPageUrl(
      result.response.headers,
      input.invocation.origin.normalized,
    );
    const advanced = selection.kind === 'next' && isGitlabPageWithinResource(selection.url, sort === undefined ? lane.nextUrl
      : buildGitlabScanLaneUrl(input.invocation.origin, lane.request, frontier.nativePageSize), sort !== undefined)
      ? advanceCursorCycleWalkV1(
        { cursor: lane.nextUrl, probe: lane.cycleProbe },
        selection.url,
      )
      : null;
    if (selection.kind === 'next' && advanced?.kind === 'advanced') {
      lane.nextUrl = advanced.walk.cursor;
      lane.cycleProbe = advanced.walk.probe;
    } else {
      lane.ended = true;
      // GitLab named a next page this invocation may not follow — a cross-origin or
      // otherwise inadmissible `Link`. The lane stops either way, but it stopped
      // UNFINISHED, and a lane that stopped unfinished is not a lane that ran out.
      // Without this the walk settles `complete`/`walkFinished` and tells the reader
      // their inbox is whole over a lane that was cut off.
      if (selection.kind === 'refused' || selection.kind === 'malformed' || selection.kind === 'next') {
        frontier.walkHealth.add('lane-unresolved');
      }
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
