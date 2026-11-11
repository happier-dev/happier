import { decodeGithubSearchItem } from '../mapping/entry.js';
import type { TriageListSortV1 } from '@happier-dev/triage-protocol/v1';
import {
  GITHUB_MAX_PAGE_SIZE_V1,
  GITHUB_SCAN_STICKY_REASONS_V1,
  GITHUB_SEARCH_RESULT_CEILING_V1,
  type GithubScanStickyReasonV1,
} from '../types.js';

import { GITHUB_SCAN_LANE_ORDER_V1, type GithubScanLaneIdV1 } from './query.js';

/**
 * Invocation-local five-lane paging state.
 *
 * It lives inside ONE scan walk. It is never persisted, promoted to another cursor
 * type, or written to storage; cancellation, deadline, failure, or process death drops
 * the whole value. When the walk stops with lanes still open, `scan/continuation.ts`
 * projects exactly this shape into the source-private continuation the target copies
 * back on the next page — the walk resumes there and nowhere else, and a later refresh
 * rebuilds it from the exact configured instance and starts again.
 *
 * It holds no delivered-item history. Ordered walks retain at most one unshown native
 * page per independent query in this same frontier; they never sort a partial window.
 * A second encounter of the same item in another lane is emitted again on purpose, and the aggregate unions
 * the involvement facts idempotently.
 *
 * NOTHING here may hold a credential, an authorization header, or an account ref.
 */

export type GithubScanLaneFrontierV1 =
  | Readonly<{ kind: 'initial' }>
  | Readonly<{ kind: 'next'; nextUrl: string }>;

export type GithubScanLaneStateV1 = {
  readonly laneId: GithubScanLaneIdV1;
  readonly repositoryKeys: readonly string[] | null;
  /** null queries the group; an index walks its repositories after a provider refusal/ceiling. */
  repositoryIndex: number | null;
  laneQuery: string;
  frontier: GithubScanLaneFrontierV1;
  pagesConsumed: number;
  ended: boolean;
  /** Unshown rows from at most one native provider page. */
  pending: unknown[];
  /** Present for the sorted all-group frontier; absent for legacy rotation. */
  scopeIndex?: number;
};

export type GithubScanInvocationFrontierV1 = {
  readonly scanLimit: number;
  readonly sort?: TriageListSortV1;
  /**
   * The walk-level health this walk has already established, carried forward across
   * every page of the same refresh.
   *
   * Splitting one walk across calls split its health with it: lane one hits GitHub's
   * 1,000-result ceiling on page one, lanes two to five walk clean, and the settling
   * call would otherwise report a truncated inbox as a finished one. Names only — the
   * per-call `omittedItemCount` stays per call, so the target's
   * `observations + omittedItemCount <= limit` check stays exact.
   */
  readonly walkHealth: Set<GithubScanStickyReasonV1>;
  readonly nativePageSize: number;
  readonly scopeKey: string;
  readonly repositoryGroups: readonly (readonly string[] | null)[];
  groupIndex: number;
  remainingBudget: number;
  nextLaneIndex: number;
  lanes: readonly GithubScanLaneStateV1[];
};

/** Ordered scans retain independent native repository groups in one frontier. */
export function githubScanLaneScopes(groups: readonly (readonly string[] | null)[], groupIndex: number, sort?: TriageListSortV1): readonly (readonly string[] | null)[] {
  return sort === undefined ? [groups[groupIndex] ?? null] : groups;
}

/** Partition the source page across ordered streams; native minimum one supplies
 * the head required to compare even when there are more streams than output rows. */
export function githubScanNativePageSize(scanLimit: number, streamCount = 1): number {
  return Math.min(Math.max(1, Math.floor(scanLimit / streamCount)), GITHUB_MAX_PAGE_SIZE_V1);
}

/** Reserve the heads needed if GitHub decomposes any rejected repository group. */
export function githubScanSortedStreamCount(groups: readonly (readonly string[] | null)[] = [null]): number {
  return groups.reduce((count, group) => count + (group?.length ?? 1), 0) * GITHUB_SCAN_LANE_ORDER_V1.length;
}

/**
 * Derived from GitHub's own contract: search returns at most 1,000 results per query,
 * so a lane cannot reach anything beyond `ceil(1000 / per_page)` pages.
 */
export function githubScanMaxPagesPerLane(nativePageSize: number): number {
  return Math.ceil(GITHUB_SEARCH_RESULT_CEILING_V1 / nativePageSize);
}

export function createGithubScanFrontier(input: Readonly<{
  scanLimit: number;
  sort?: TriageListSortV1;
  buildLaneQuery: (laneId: GithubScanLaneIdV1, repositoryKeys: readonly string[] | null) => string;
  repositoryGroups?: readonly (readonly string[] | null)[];
  groupIndex?: number;
  scopeKey?: string;
  /** Resumed lane positions, in `GITHUB_SCAN_LANE_ORDER_V1` order. Absent starts fresh. */
  resume?: Readonly<{
    nextLaneIndex: number;
    walkHealth: readonly GithubScanStickyReasonV1[];
    lanes: readonly Readonly<{
      frontier: GithubScanLaneFrontierV1;
      pagesConsumed: number;
      ended: boolean;
      repositoryIndex: number | null;
      pending?: readonly unknown[];
      laneId?: GithubScanLaneIdV1;
      scopeIndex?: number;
    }>[];
  }>;
}>): GithubScanInvocationFrontierV1 {
  if (!Number.isSafeInteger(input.scanLimit) || input.scanLimit < 1) {
    throw new RangeError('GitHub scan limit must be a positive integer');
  }
  const nativePageSize = githubScanNativePageSize(input.scanLimit, input.sort === undefined ? 1
    : githubScanSortedStreamCount(input.repositoryGroups));
  const resume = input.resume;
  const repositoryGroups = input.repositoryGroups ?? [null];
  const groupIndex = input.groupIndex ?? 0;
  const makeLane = (laneId: GithubScanLaneIdV1, scopeIndex: number,
    resumed?: NonNullable<typeof resume>['lanes'][number]): GithubScanLaneStateV1 => {
    const scope = repositoryGroups[scopeIndex] ?? null;
    const repositoryIndex = resumed?.repositoryIndex ?? null;
    return {
      laneId, repositoryKeys: scope, repositoryIndex,
      laneQuery: input.buildLaneQuery(laneId, repositoryIndex === null ? scope : [scope![repositoryIndex]!]),
      frontier: resumed?.frontier ?? { kind: 'initial' },
      pagesConsumed: resumed?.pagesConsumed ?? 0, ended: resumed?.ended ?? false,
      pending: [...(resumed?.pending ?? [])],
      ...(input.sort === undefined ? {} : { scopeIndex }),
    };
  };
  return {
    scanLimit: input.scanLimit,
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    walkHealth: new Set(resume?.walkHealth ?? []),
    nativePageSize,
    scopeKey: input.scopeKey ?? '',
    repositoryGroups,
    groupIndex,
    // The projection budget belongs to the page being built, never to a resumed
    // position: each page is bounded by the limit the continuation already binds.
    remainingBudget: input.scanLimit,
    nextLaneIndex: resume?.nextLaneIndex ?? 0,
    lanes: input.sort !== undefined && resume !== undefined
      ? resume.lanes.map(lane => makeLane(lane.laneId!, lane.scopeIndex!, lane))
      : githubScanLaneScopes(repositoryGroups, groupIndex, input.sort).flatMap((_scope, scopeIndex) =>
        GITHUB_SCAN_LANE_ORDER_V1.map((laneId, laneIndex) => makeLane(laneId,
          input.sort === undefined ? groupIndex : scopeIndex, resume?.lanes[laneIndex]))),
  };
}

function selectRepository(lane: GithubScanLaneStateV1, index: number,
  buildLaneQuery: (laneId: GithubScanLaneIdV1, repositoryKeys: readonly string[] | null) => string): void {
  lane.repositoryIndex = index;
  lane.laneQuery = buildLaneQuery(lane.laneId, [lane.repositoryKeys![index]!]);
  lane.pagesConsumed = 0;
  lane.frontier = { kind: 'initial' };
}

/** Settle one query, advancing a decomposed group without abandoning its other repositories. */
export function finishGithubScanLane(lane: GithubScanLaneStateV1,
  buildLaneQuery: (laneId: GithubScanLaneIdV1, repositoryKeys: readonly string[] | null) => string): void {
  if (lane.scopeIndex === undefined && lane.repositoryIndex !== null && lane.repositoryKeys !== null && lane.repositoryIndex + 1 < lane.repositoryKeys.length) {
    selectRepository(lane, lane.repositoryIndex + 1, buildLaneQuery);
  } else {
    lane.ended = true;
    lane.frontier = { kind: 'initial' };
  }
}

/** A provider refusal or ceiling decomposes a group once, in the same round-robin slot. */
export function splitGithubScanLane(lane: GithubScanLaneStateV1,
  buildLaneQuery: (laneId: GithubScanLaneIdV1, repositoryKeys: readonly string[] | null) => string,
  frontier?: GithubScanInvocationFrontierV1): boolean {
  if (lane.repositoryIndex !== null || lane.repositoryKeys === null || lane.repositoryKeys.length < 2) return false;
  if (frontier?.sort !== undefined) {
    const index = frontier.lanes.indexOf(lane);
    const members = lane.repositoryKeys.map((_key, repositoryIndex) => {
      const member = { ...lane, pending: [] };
      selectRepository(member, repositoryIndex, buildLaneQuery);
      return member;
    });
    frontier.lanes = [...frontier.lanes.slice(0, index), ...members, ...frontier.lanes.slice(index + 1)];
  } else selectRepository(lane, 0, buildLaneQuery);
  return true;
}

/**
 * One fitting provider page is consumed from each non-ended lane before any lane
 * deep-pages again. An unstarted lane can use remaining capacity; an issued next
 * Link keeps its original geometry and waits for the next invocation if it cannot fit.
 */
export function takeNextGithubScanLane(
  frontier: GithubScanInvocationFrontierV1,
  buildLaneQuery: (laneId: GithubScanLaneIdV1, repositoryKeys: readonly string[] | null) => string,
): GithubScanLaneStateV1 | null {
  if (frontier.lanes.every(lane => lane.ended) && frontier.groupIndex + 1 < frontier.repositoryGroups.length) {
    const next = createGithubScanFrontier({ scanLimit: frontier.scanLimit, buildLaneQuery,
      repositoryGroups: frontier.repositoryGroups, groupIndex: frontier.groupIndex + 1, scopeKey: frontier.scopeKey });
    frontier.groupIndex = next.groupIndex;
    frontier.lanes = next.lanes;
    frontier.nextLaneIndex = 0;
  }
  const laneCount = frontier.lanes.length;
  for (let offset = 0; offset < laneCount; offset += 1) {
    const index = (frontier.nextLaneIndex + offset) % laneCount;
    const lane = frontier.lanes[index];
    if (lane !== undefined && !lane.ended
      && githubScanLanePageSize(frontier, lane) <= frontier.remainingBudget) {
      frontier.nextLaneIndex = (index + 1) % laneCount;
      return lane;
    }
  }
  return null;
}

/** Next URLs have already been validated by the Link/continuation owner. */
export function githubScanLanePageSize(
  frontier: GithubScanInvocationFrontierV1,
  lane: GithubScanLaneStateV1,
): number {
  return lane.frontier.kind === 'initial'
    ? Math.min(frontier.nativePageSize, frontier.remainingBudget)
    : Number(new URL(lane.frontier.nextUrl).searchParams.get('per_page'));
}

/** The sticky set in its one declared order, so a token's bytes never depend on
 *  the order the conditions happened to be observed in. */
export function readGithubScanWalkHealth(
  frontier: GithubScanInvocationFrontierV1,
): readonly GithubScanStickyReasonV1[] {
  return Object.freeze(
    GITHUB_SCAN_STICKY_REASONS_V1.filter((reason) => frontier.walkHealth.has(reason)),
  );
}

export function githubScanFrontierHasOpenLane(
  frontier: GithubScanInvocationFrontierV1,
): boolean {
  return (frontier.sort === undefined && frontier.groupIndex + 1 < frontier.repositoryGroups.length)
    || frontier.lanes.some((lane) => !lane.ended || lane.pending.length > 0);
}

/** Merge only known native heads. The caller fills missing heads before selecting;
 * it ends this source page when a head needs a second fetch in the same call. */
export function takeGithubSortedScanHead(frontier: GithubScanInvocationFrontierV1, sort: TriageListSortV1): Readonly<{
  laneId: GithubScanLaneIdV1;
  view: ReturnType<typeof decodeGithubSearchItem>;
}> | null {
  const candidates = frontier.lanes.filter(candidate => candidate.pending.length > 0);
  const value = (candidate: GithubScanLaneStateV1) => decodeGithubSearchItem(candidate.pending[0]);
  const compare = (a: GithubScanLaneStateV1, b: GithubScanLaneStateV1): number => {
    const left = value(a); const right = value(b);
    if (left === null || right === null) return left === null ? -1 : 1;
    const difference = sort.field === 'created' ? left.createdAtMs - right.createdAtMs : left.updatedAtMs - right.updatedAtMs;
    return difference === 0 ? `${left.repositoryId ?? left.repositoryLabel}:${left.kindId}:${left.number}`.localeCompare(`${right.repositoryId ?? right.repositoryLabel}:${right.kindId}:${right.number}`)
      : sort.direction === 'asc' ? difference : -difference;
  };
  let head = candidates[0];
  for (const candidate of candidates.slice(1)) if (head !== undefined && compare(candidate, head) < 0) head = candidate;
  if (head === undefined) return null;
  const view = decodeGithubSearchItem(head.pending.shift());
  frontier.remainingBudget -= 1;
  return { laneId: head.laneId, view };
}
