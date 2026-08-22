import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  decodeGithubJsonResponse,
  isGithubRateLimited,
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
import { createGithubRepositoryReader, type GithubRepositoryReaderV1 } from '../repositories.js';
import {
  GITHUB_SEARCH_RESULT_CEILING_V1,
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
  githubScanFrontierHasOpenLane,
  readGithubScanWalkHealth,
  takeNextGithubScanLane,
  type GithubScanInvocationFrontierV1,
  type GithubScanLaneStateV1,
} from './frontier.js';
import { readValidatedGithubNextPage } from './link.js';
import {
  buildGithubLaneQuery,
  buildGithubLaneSearchUrl,
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
  | Readonly<{ kind: 'continuation'; token: string; maxLimit: number }>;

export type GithubScanInputV1 = Readonly<{
  page: GithubScanPageRequestV1;
  /** `owner/name` when the configured instance is repository-scoped, else `null`. */
  repositoryKey: string | null;
}>;

export type GithubScanDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  /** Injected clock. `Date.now()` in an adapter makes every freshness claim untestable. */
  now: () => number;
  signal: AbortSignal;
  repositories?: GithubRepositoryReaderV1;
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
const PARTIAL_REASON_PRIORITY: readonly GithubTriageScanPartialReasonV1[] = Object.freeze([
  'continuation-unavailable',
  'result-ceiling',
  'incomplete-results',
  'undecodable-items',
  'lane-unresolved',
  'projection-budget',
]);

/** The floor for any arm that did not settle the walk: this page could not hold
 *  another whole native page, which is why it stopped. */
const PROJECTION_BUDGET_EVIDENCE: GithubTriageScanEvidenceV1 = Object.freeze({
  kind: 'partial',
  reason: 'projection-budget',
});

const CONTINUATION_UNRECOGNIZED_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_scan_continuation_unrecognized',
});

/** This call's own non-sticky page-shape facts, plus the rows it could not map. */
type ScanHealth = {
  reasons: Set<GithubTriageScanPartialReasonV1>;
  omittedItemCount: number;
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
  const repositories = dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
  const buildLaneQuery = (laneId: GithubScanLaneIdV1): string => buildGithubLaneQuery({
    laneId,
    repositoryKey: input.repositoryKey,
  });

  let frontier: GithubScanInvocationFrontierV1;
  if (input.page.kind === 'initial') {
    frontier = createGithubScanFrontier({ scanLimit: input.page.limit, buildLaneQuery });
  } else {
    const resumed = decodeGithubScanContinuation(input.page.token, {
      buildLaneQuery,
      maxScanLimit: input.page.maxLimit,
    });
    if (resumed === null) {
      return Object.freeze({ kind: 'failed', failure: CONTINUATION_UNRECOGNIZED_FAILURE });
    }
    frontier = createGithubScanFrontier({
      scanLimit: resumed.scanLimit,
      buildLaneQuery,
      resume: {
        nextLaneIndex: resumed.nextLaneIndex,
        walkHealth: resumed.walkHealth,
        lanes: resumed.lanes,
      },
    });
  }

  const observations: GithubTriageScanObservationV1[] = [];
  const laneFailures: GithubTriageFailureV1[] = [];
  const health: ScanHealth = { reasons: new Set(), omittedItemCount: 0 };

  const failLane = (lane: GithubScanLaneStateV1, failure: GithubTriageFailureV1): void => {
    lane.ended = true;
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
    const continuation = encodeGithubScanContinuation(frontier);
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

  while (githubScanFrontierHasOpenLane(frontier)) {
    if (dependencies.signal.aborted) {
      return Object.freeze({
        kind: 'failed',
        failure: Object.freeze({ class: 'transient', code: 'github_request_cancelled' }),
      });
    }
    if (frontier.remainingBudget < frontier.nativePageSize) {
      health.reasons.add('projection-budget');
      break;
    }
    const lane = takeNextGithubScanLane(frontier);
    if (lane === null) break;

    const url = lane.frontier.kind === 'initial'
      ? buildGithubLaneSearchUrl({
        laneQuery: lane.laneQuery,
        perPage: frontier.nativePageSize,
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
    if (isGithubRateLimited(response)) {
      return Object.freeze({
        kind: 'failed',
        failure: classifyGithubResponseFailure(response, nowMs),
      });
    }
    if (!isGithubSuccessStatus(response.status)) {
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

    if (page.items.length > frontier.nativePageSize) {
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
      frontier.walkHealth.add('result-ceiling');
    }
    if (page.incompleteResults) frontier.walkHealth.add('incomplete-results');

    const involvement = mapGithubLaneToInvolvement(lane.laneId);
    for (const rawItem of page.items) {
      // Budget is spent on RAW provider cardinality, before and regardless of decoding. A
      // malformed row still consumed a row of this page, and counting only the rows that
      // mapped is how `observations + omittedItemCount` grew past the submitted limit —
      // which the strict aggregate rejects outright.
      frontier.remainingBudget -= 1;
      // The raw cursor advances by response cardinality BEFORE tolerant decoding, so an
      // undecodable item can never make a following raw item vanish.
      const view = decodeGithubSearchItem(rawItem);
      if (view === null) {
        health.omittedItemCount += 1;
        frontier.walkHealth.add('undecodable-items');
        continue;
      }
      let repositoryId = view.repositoryId;
      if (repositoryId === null) {
        const read = await repositories.read({ owner: view.owner, name: view.name });
        if (read.kind !== 'readable') {
          health.omittedItemCount += 1;
          frontier.walkHealth.add('undecodable-items');
          continue;
        }
        repositoryId = read.repositoryId;
      }
      const projection = projectGithubEntry(view, repositoryId, {
        additionsDeletions: view.kindId === 'pull-request' ? 'detailOnly' : null,
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

    if (isGithubBudgetExhausted(response)) {
      return Object.freeze({ kind: 'failed', failure: budgetExhaustedFailure(response, nowMs) });
    }

    lane.pagesConsumed += 1;
    if (lane.pagesConsumed >= frontier.maxPagesPerLane) {
      // GitHub's search cannot return anything past its 1,000-result ceiling, so a lane
      // still offering `rel="next"` here is structurally truncated, not continuable.
      lane.ended = true;
      frontier.walkHealth.add('result-ceiling');
      continue;
    }

    const next = readValidatedGithubNextPage(response.headers, {
      laneQuery: lane.laneQuery,
      perPage: frontier.nativePageSize,
    });
    if (next.kind === 'ended') {
      lane.ended = true;
    } else if (next.kind === 'invalid') {
      failLane(lane, Object.freeze({
        class: 'unsupportedContract',
        code: 'github_search_link_invalid',
      }));
    } else {
      lane.frontier = Object.freeze({ kind: 'next', nextUrl: next.next.url });
    }
  }

  return settle();
}
