import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  decodeGithubJsonResponse,
  isGithubRateLimited,
  readGithubApiResponseFacts,
  readGithubRetryAfterMs,
  type GithubApiClientV1,
  type GithubApiResponseV1,
} from '../../observations/githubApiClient.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from '../errors.js';
import { decodeGithubSearchItem, projectGithubEntry } from '../mapping/entry.js';
import { readGithubChecksConditionBatch, type GithubChecksBatchTargetV1 } from '../checksCondition.js';
import { projectGithubChecksRowState, type GithubChecksSurfaceV1 } from '../checks.js';
import {
  GITHUB_SEARCH_RESULT_CEILING_V1,
  GITHUB_SCAN_PARTIAL_REASON_PRIORITY_V1,
  type GithubTriageFailureV1,
  type GithubTriageScanEvidenceV1,
  type GithubTriageScanObservationV1,
  type GithubTriageScanPartialReasonV1,
  type GithubTriageScanResultV1,
} from '../types.js';

import {
  decodeGithubScanContinuation,
  encodeGithubScanContinuation,
} from './continuation.js';
import {
  createGithubScanFrontier,
  finishGithubScanLane,
  githubScanFrontierHasOpenLane,
  githubScanLanePageSize,
  githubScanMaxPagesPerLane,
  readGithubScanWalkHealth,
  splitGithubScanLane,
  takeNextGithubScanLane,
  type GithubScanInvocationFrontierV1,
  type GithubScanLaneStateV1,
} from './frontier.js';
import { readValidatedGithubNextPage } from './link.js';
import {
  buildGithubLaneQuery,
  buildGithubLaneSearchUrl,
  groupGithubScanRepositories,
  mapGithubLaneToInvolvement,
  type GithubScanLaneIdV1,
} from './query.js';

/**
 * One bounded GitHub scan page.
 *
 * `limit` bounds ONE page, not a whole walk. The call fills up to that many rows across
 * the five involvement lanes in bounded round-robin order and then settles: `complete`
 * when every lane ended, `page` plus this source's own continuation when any lane is
 * still open. The continuation is invocation-local — never persisted, never promoted to
 * another cursor type — and cancellation, deadline, failure, or a restart discards it, so
 * the next attempt begins again at the initial requests.
 *
 * Fairness is why the continuation exists at all. Without it the walk restarted at the
 * first lane every time, so on a busy account `review-requested` consumed the whole
 * budget and `assigned`, `mentioned`, `reviewed` and `authored` were never read.
 *
 * It never concludes absence. A row the corpus holds that this scan did not return is a
 * candidate for an authoritative `get`, not for deletion.
 */

export type GithubScanPageRequestV1 =
  /** One GLOBAL observation projection budget shared by the five lanes, for this page. */
  | Readonly<{ kind: 'initial'; limit: number }>
  /** This source's own opaque continuation bytes, from its immediately preceding page. */
  | Readonly<{ kind: 'continuation'; token: string }>;

export type GithubScanInputV1 = Readonly<{
  page: GithubScanPageRequestV1;
  /** Selected `owner/name` scopes, or null for the explicit Account-wide scan. */
  repositoryKeys: readonly string[] | null;
  scopeKey?: string;
  completedSinceMs?: number;
  query?: string;
}>;

export type GithubScanDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  /** Injected clock. `Date.now()` in an adapter makes every freshness claim untestable. */
  now: () => number;
  signal: AbortSignal;
}>;

/**
 * The evidence arm carries exactly one reason, so precedence is fixed and
 * declaration-ordered by `sources/SCM.md` §2.8b: work never inspected outranks work whose
 * shape moved, and this call's own page-shape fact is last.
 *
 * `continuation-unavailable` is not in that list because it is not sticky, and it leads
 * here deliberately: it is the only reason that says a `complete` arm did NOT walk the
 * account, so reporting the condition underneath it would present a cut-short walk as an
 * ordinary partial one.
 */
const PARTIAL_REASON_PRIORITY = GITHUB_SCAN_PARTIAL_REASON_PRIORITY_V1;

/** The floor for any arm that did not settle the walk: this page could not hold
 *  another fitting native page, which is why it stopped. */
const PROJECTION_BUDGET_EVIDENCE: GithubTriageScanEvidenceV1 = Object.freeze({
  kind: 'partial',
  reason: 'projection-budget',
});

const CONTINUATION_UNRECOGNIZED_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_scan_continuation_unrecognized',
});

const CANCELLED_SCAN = Object.freeze({
  kind: 'failed' as const,
  failure: Object.freeze({ class: 'transient' as const, code: 'github_request_cancelled' }),
});

/** This call's own non-sticky page-shape facts, plus the rows it could not map. */
type ScanHealth = {
  reasons: Set<GithubTriageScanPartialReasonV1>;
  omittedItemCount: number;
  checksFailure: GithubTriageFailureV1 | null;
};

/**
 * The arm carries exactly one reason, so the walk's sticky set is unioned with this
 * call's own facts BEFORE the reason is chosen. That is what makes a five-page walk
 * which hit the result ceiling on page one still report it on page five instead of
 * announcing a truncated inbox as a whole one.
 */
function resolvePartialEvidence(
  frontier: GithubScanInvocationFrontierV1,
  health: ScanHealth,
): GithubTriageScanEvidenceV1 | null {
  const reasons = new Set<GithubTriageScanPartialReasonV1>([
    ...readGithubScanWalkHealth(frontier),
    ...health.reasons,
  ]);
  for (const reason of PARTIAL_REASON_PRIORITY) {
    if (!reasons.has(reason)) continue;
    return Object.freeze(
      health.omittedItemCount > 0
        ? { kind: 'partial', reason, omittedItemCount: health.omittedItemCount }
        : { kind: 'partial', reason },
    );
  }
  if (health.checksFailure !== null) {
    return Object.freeze({ kind: 'partial', reason: health.checksFailure.code });
  }
  return null;
}

/** `x-ratelimit-remaining: 0` means the next request would be rejected; settle now. */
function isGithubBudgetExhausted(response: GithubApiResponseV1): boolean {
  return readTriageResponseHeaderV1(response.headers, 'x-ratelimit-remaining') === '0';
}

/**
 * A successful response whose remaining budget is zero: the next request would be
 * rejected, so the invocation settles now with GitHub's own retry evidence as the
 * deadline. It never sleeps until reset, retries, or returns a deferred arm.
 *
 * The evidence is read by `readGithubRetryAfterMs`, the one place this plugin turns
 * GitHub's rate-limit headers into a wait. This arm used to re-read
 * `x-ratelimit-reset` and re-spell the same arithmetic, which is how one plugin ends
 * up answering "how long until we may retry" twice.
 */
function budgetExhaustedFailure(
  response: GithubApiResponseV1,
  nowMs: number,
): GithubTriageFailureV1 {
  const durationMs = readGithubRetryAfterMs(response.headers, nowMs);
  return Object.freeze({
    class: 'rateLimit',
    code: 'github_rate_limit_budget_exhausted',
    ...(durationMs === null ? {} : { retryNotBeforeMs: nowMs + durationMs }),
  });
}

type SearchPage = Readonly<{
  totalCount: number;
  incompleteResults: boolean;
  items: readonly unknown[];
}>;

function decodeSearchPage(body: unknown): SearchPage | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Readonly<Record<string, unknown>>;
  if (!Array.isArray(record.items)) return null;
  const totalCount = typeof record.total_count === 'number' && Number.isFinite(record.total_count)
    ? record.total_count
    : null;
  if (totalCount === null) return null;
  if (typeof record.incomplete_results !== 'boolean') return null;
  return Object.freeze({
    totalCount,
    incompleteResults: record.incomplete_results,
    items: Object.freeze([...record.items]),
  });
}

export async function runGithubTriageScan(
  input: GithubScanInputV1,
  dependencies: GithubScanDependenciesV1,
): Promise<GithubTriageScanResultV1> {
  const repositoryGroups = input.repositoryKeys === null
    ? [null]
    : groupGithubScanRepositories(input.repositoryKeys, input.completedSinceMs);
  const scope = input.scopeKey ?? JSON.stringify(repositoryGroups);
  const query = input.query?.trim();
  const scopeKey = query ? JSON.stringify([scope, query]) : scope;
  const buildLaneQuery = (laneId: GithubScanLaneIdV1, repositoryKeys: readonly string[] | null): string => buildGithubLaneQuery({
    laneId,
    repositoryKeys,
    ...(query ? { query } : {}),
    ...(input.completedSinceMs === undefined ? {} : { completedSinceMs: input.completedSinceMs }),
  });

  let frontier: GithubScanInvocationFrontierV1;
  if (input.page.kind === 'initial') {
    frontier = createGithubScanFrontier({ scanLimit: input.page.limit, buildLaneQuery, repositoryGroups, scopeKey });
  } else {
    const resumed = decodeGithubScanContinuation(input.page.token, {
      buildLaneQuery,
      repositoryGroups, scopeKey,
      ...(input.completedSinceMs === undefined ? {} : { completedSinceMs: input.completedSinceMs }),
    });
    if (resumed === null) {
      return Object.freeze({ kind: 'failed', failure: CONTINUATION_UNRECOGNIZED_FAILURE });
    }
    frontier = createGithubScanFrontier({
      scanLimit: resumed.scanLimit,
      groupIndex: resumed.groupIndex,
      buildLaneQuery,
      repositoryGroups, scopeKey,
      resume: {
        nextLaneIndex: resumed.nextLaneIndex,
        walkHealth: resumed.walkHealth,
        lanes: resumed.lanes,
      },
    });
  }

  const observations: GithubTriageScanObservationV1[] = [];
  // Search omits current-head checks and can omit immutable repository identity.
  // One native batch per page acquires both; repeated involvement encounters reuse them.
  const checks = new Map<string, GithubChecksSurfaceV1>();
  const repositoryIds = new Map<string, string>();
  const repositoryKey = (view: NonNullable<ReturnType<typeof decodeGithubSearchItem>>) => JSON.stringify([view.owner, view.name]);
  const checksKey = (view: NonNullable<ReturnType<typeof decodeGithubSearchItem>>) => JSON.stringify([view.owner, view.name, view.number]);
  const laneFailures: GithubTriageFailureV1[] = [];
  const health: ScanHealth = { reasons: new Set(), omittedItemCount: 0, checksFailure: null };

  const failLane = (lane: GithubScanLaneStateV1, failure: GithubTriageFailureV1): void => {
    finishGithubScanLane(lane, buildLaneQuery);
    laneFailures.push(failure);
    frontier.walkHealth.add('lane-unresolved');
  };

  const settle = (): GithubTriageScanResultV1 => {
    const base = {
      observations: Object.freeze([...observations]),
      laneFailures: Object.freeze([...laneFailures]),
    };
    if (!githubScanFrontierHasOpenLane(frontier)) {
      // `walkFinished` requires BOTH: every lane ended here, and nothing the walk
      // observed on any earlier page is still outstanding.
      const evidence = resolvePartialEvidence(frontier, health)
        ?? Object.freeze({ kind: 'walkFinished' as const });
      return Object.freeze({ kind: 'complete', ...base, evidence });
    }
    const continuation = encodeGithubScanContinuation(frontier, input.completedSinceMs);
    if (continuation === null) {
      // The walk cannot be resumed, so it ends here — and says so. A `complete` arm that
      // quietly dropped the rest of the walk would read as a finished one.
      health.reasons.add('continuation-unavailable');
      return Object.freeze({
        kind: 'complete',
        ...base,
        evidence: resolvePartialEvidence(frontier, health) ?? PROJECTION_BUDGET_EVIDENCE,
      });
    }
    // `walkFinished` on a `page` arm is a contradiction — the walk did not finish — so
    // this arm's floor is the page-shape fact that stopped it.
    return Object.freeze({
      kind: 'page',
      ...base,
      evidence: resolvePartialEvidence(frontier, health) ?? PROJECTION_BUDGET_EVIDENCE,
      continuation,
    });
  };

  const pendingViews: { view: ReturnType<typeof decodeGithubSearchItem>; involvement: ReturnType<typeof mapGithubLaneToInvolvement> }[] = [];
  const searched = new Set<GithubScanLaneStateV1>();
  while (githubScanFrontierHasOpenLane(frontier)) {
    if (dependencies.signal.aborted) {
      return CANCELLED_SCAN;
    }
    if (frontier.remainingBudget === 0) {
      health.reasons.add('projection-budget');
      break;
    }
    const lane = takeNextGithubScanLane(frontier, buildLaneQuery);
    if (lane === null) break;
    // The text-query budget is one native page per involvement/repository lane;
    // preserve the remaining frontier for explicit Load More.
    if (query && searched.has(lane)) break;
    searched.add(lane);
    const perPage = githubScanLanePageSize(frontier, lane);

    const url = lane.frontier.kind === 'initial'
      ? buildGithubLaneSearchUrl({
        laneQuery: lane.laneQuery,
        perPage,
        page: 1,
      })
      : lane.frontier.nextUrl;

    let response: GithubApiResponseV1;
    try {
      response = await dependencies.client.request({ url });
    } catch (error) {
      const failure = classifyGithubTransportFailure(error);
      if (failure.code === 'github_request_cancelled') {
        return Object.freeze({ kind: 'failed', failure });
      }
      failLane(lane, failure);
      continue;
    }

    const nowMs = dependencies.now();
    if (isGithubRateLimited(readGithubApiResponseFacts(response))) {
      return Object.freeze({
        kind: 'failed',
        failure: classifyGithubResponseFailure(response, nowMs),
      });
    }
    if (!isGithubSuccessStatus(response.status)) {
      // A grouped qualifier can be rejected for one inaccessible repository.
      // Walk its members through this same fair frontier, preserving readable work.
      if (response.status === 422 && splitGithubScanLane(lane, buildLaneQuery)) continue;
      failLane(lane, classifyGithubResponseFailure(response, nowMs));
      continue;
    }

    let page: SearchPage | null;
    try {
      page = decodeSearchPage(decodeGithubJsonResponse(response));
    } catch (error) {
      failLane(lane, classifyGithubTransportFailure(error));
      continue;
    }
    if (page === null) {
      failLane(lane, Object.freeze({
        class: 'unsupportedContract',
        code: 'github_search_envelope_invalid',
      }));
      continue;
    }

    if (page.items.length > perPage) {
      // A page wider than the geometry this walk requested cannot be admitted: the budget
      // was reserved whole pages at a time, so ingesting the overflow would push
      // `observations + omittedItemCount` past the limit the target strictly rejects.
      failLane(lane, Object.freeze({
        class: 'unsupportedContract',
        code: 'github_search_page_overdelivered',
      }));
      continue;
    }
    if (page.totalCount > GITHUB_SEARCH_RESULT_CEILING_V1) {
      // Grouping must not reduce the per-repository 1,000-result reachability.
      if (splitGithubScanLane(lane, buildLaneQuery)) continue;
      frontier.walkHealth.add('result-ceiling');
    }
    if (page.incompleteResults) frontier.walkHealth.add('incomplete-results');

    const views = page.items.map((rawItem) => {
      // Budget is spent on RAW provider cardinality, before and regardless of decoding. A
      // malformed row still consumed a row of this page, and counting only the rows that
      // mapped is how `observations + omittedItemCount` grew past the submitted limit —
      // which the strict aggregate rejects outright.
      frontier.remainingBudget -= 1;
      // The raw cursor advances by response cardinality BEFORE tolerant decoding, so an
      // undecodable item can never make a following raw item vanish.
      return decodeGithubSearchItem(rawItem);
    });
    // Rows wait for the page's one checks/identity batch below. A batch per lane put a
    // GraphQL round trip between consecutive lane searches of the same page.
    const involvement = mapGithubLaneToInvolvement(lane.laneId);
    for (const view of views) pendingViews.push({ view, involvement });

    if (isGithubBudgetExhausted(response)) {
      return Object.freeze({ kind: 'failed', failure: budgetExhaustedFailure(response, nowMs) });
    }

    lane.pagesConsumed += 1;
    if (lane.pagesConsumed >= githubScanMaxPagesPerLane(perPage)) {
      // GitHub's search cannot return anything past its 1,000-result ceiling, so a lane
      // still offering `rel="next"` here is structurally truncated, not continuable.
      finishGithubScanLane(lane, buildLaneQuery);
      frontier.walkHealth.add('result-ceiling');
      continue;
    }

    const next = readValidatedGithubNextPage(response.headers, url, {
      laneQuery: lane.laneQuery,
      perPage,
    });
    if (next.kind === 'ended') {
      finishGithubScanLane(lane, buildLaneQuery);
    } else if (next.kind === 'invalid') {
      failLane(lane, Object.freeze({
        class: 'unsupportedContract',
        code: 'github_search_link_invalid',
      }));
    } else {
      lane.frontier = Object.freeze({ kind: 'next', nextUrl: next.next.url });
    }
  }

  if (dependencies.signal.aborted) return CANCELLED_SCAN;
  // One native batch acquires current-head checks for every pull request on this page
  // and the immutable repository identity search omitted. It runs after the page's last
  // search, so a rate-limited optional Checks read can no longer park a search after it.
  const targets = new Map<string, GithubChecksBatchTargetV1>();
  const queriedRepositories = new Set<string>();
  for (const { view } of pendingViews) {
    if (view === null) continue;
    if (view.repositoryId !== null) repositoryIds.set(repositoryKey(view), view.repositoryId);
    if (view.kindId === 'pull-request' && !targets.has(checksKey(view))) {
      targets.set(checksKey(view), {
        route: { owner: view.owner, name: view.name }, pullRequestNumber: Number(view.number),
        // A list row shows only the outcome counts; GitHub states them without context pages.
        depth: 'counts',
      });
      queriedRepositories.add(repositoryKey(view));
    }
  }
  for (const { view } of pendingViews) {
    if (view === null || repositoryIds.has(repositoryKey(view))) continue;
    // A PR's query already carries its repository's databaseId; issues need only that field.
    if (!queriedRepositories.has(repositoryKey(view))) {
      targets.set(repositoryKey(view), { route: { owner: view.owner, name: view.name } });
      queriedRepositories.add(repositoryKey(view));
    }
  }
  if (targets.size > 0) {
    try {
      const reads = await readGithubChecksConditionBatch([...targets.values()], dependencies);
      let index = 0;
      for (const [key, target] of targets) {
        const read = reads[index++];
        if (read?.repositoryId !== null && read?.repositoryId !== undefined) {
          repositoryIds.set(JSON.stringify([target.route.owner, target.route.name]), read.repositoryId);
        }
        if (read?.surface !== null && read?.surface !== undefined) checks.set(key, read.surface);
      }
    } catch (error) {
      if (dependencies.signal.aborted) return CANCELLED_SCAN;
      throw error;
    }
  }
  for (const { view, involvement } of pendingViews) {
    const repositoryId = view === null ? null : view.repositoryId ?? repositoryIds.get(repositoryKey(view)) ?? null;
    if (view === null || repositoryId === null) {
      health.omittedItemCount += 1;
      frontier.walkHealth.add('undecodable-items');
      continue;
    }
    const surface = view.kindId === 'pull-request' ? checks.get(checksKey(view)) : undefined;
    const checksFailures = surface === undefined ? [] : [surface.checkRunsFailure, surface.commitStatusFailure];
    const checksRateLimit = checksFailures.find(failure => failure?.class === 'rateLimit');
    const checksFailure = checksRateLimit ?? checksFailures.find(failure => failure !== null) ?? null;
    health.checksFailure = checksRateLimit ?? health.checksFailure ?? checksFailure;
    const projection = projectGithubEntry(view, repositoryId, {
      additionsDeletions: view.kindId === 'pull-request' ? 'detailOnly' : null,
      reviewDecision: surface?.reviewDecision ?? null,
      checks: surface === undefined ? null : projectGithubChecksRowState(surface),
    });
    if (projection === null) {
      health.omittedItemCount += 1;
      frontier.walkHealth.add('undecodable-items');
      continue;
    }
    // One item can match `authored` AND `mentioned`. Every native encounter emits its
    // own observation carrying that lane's canonical fact: the aggregate applies the
    // exact canonical ref idempotently and unions involvement, so it stays one row.
    // Suppressing the later encounter here would drop a fact, and holding a private
    // delivered-item set would merely rebuild a second dedupe owner inside the source.
    observations.push(Object.freeze({
      kind: 'present',
      localRef: projection.localRef,
      locator: projection.locator,
      snapshot: projection.snapshot,
      viewer: Object.freeze({ involvement: Object.freeze([involvement]) }),
    }));
  }

  return dependencies.signal.aborted ? CANCELLED_SCAN : settle();
}
