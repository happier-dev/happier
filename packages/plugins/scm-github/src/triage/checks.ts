import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';
import type { ForgeCiSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from './errors.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from './locator.js';
import type { GithubChecksRowStateV1, GithubReviewDecisionV1 } from './mapping/facts.js';
import type { GithubViewerSubscriptionV1 } from './detail/contracts.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import { readGithubCheckOutcomeV1, readGithubStatusContextObservationV1 } from './checkOutcome.js';
import { readGithubChecksConditionSurface, type GithubChecksConditionSnapshotV1 } from './checksCondition.js';
import {
  GITHUB_MAX_PAGE_SIZE_V1,
  type GithubChecksStateV1,
  type GithubTriageFailureV1,
} from './types.js';

/**
 * The pull-request check surface: TWO reads, both required, each following its own
 * pagination.
 *
 *   GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs?filter=all
 *   GET /repos/{owner}/{repo}/commits/{head_sha}/status
 *
 * They answer different questions — GitHub App check runs and legacy commit statuses —
 * and one failing renders the other's rows plus the failure that explains the gap.
 *
 * `none`, `unknown` and `knownIncomplete` are DIFFERENT states. No checks configured,
 * a check surface we could not read, and a suite past GitHub's ceiling must never
 * render alike: the first is "nothing to run", the second is "we cannot tell", and the
 * third is "these rows are real but the list is short".
 *
 * Follow every validated continuation under the caller's lifetime. GitHub limits this
 * endpoint to the most recent 1,000 check suites, not 1,000 runs. Saturating that
 * provider boundary or receiving fewer rows than its declared total makes coverage
 * incomplete; undecodable rows make it unknown while preserving the readable rows.
 */

// GitHub REST list-check-runs-for-a-git-reference, checked 2026-10-04.
// Coverage evidence only: never a local paging cutoff.
const GITHUB_CHECK_SUITE_CEILING_V1 = 1_000;

export type GithubCheckResourceKindV1 = 'check-run' | 'commit-status';
export type GithubCheckActionsTargetV1 = Readonly<{ selection: ForgeCiSelectionV1; checkRunId: string; headSha: string }>;

export type GithubCheckObservationV1 = Readonly<{
  /**
   * Provider-native, RESOURCE-KIND-QUALIFIED id. Matrix legs and re-runs legitimately
   * share a name and a details URL, so a name- or URL-derived key silently hides one
   * job's failure behind another's success.
   */
  key: string;
  resourceKind: GithubCheckResourceKindV1;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  /** Immutable provider time when GraphQL omits the Check Run's own timestamps. */
  checkSuiteCreatedAtMs?: number;
  /** Provider Check Run output or legacy status description, when supplied. */
  logExcerpt?: string | null;
  /** Provider evidence on the current PR head; REST historical rows omit it. */
  required?: boolean | null;
  /** Native total from already-requested Check Run output; absence means unknown. */
  annotationsCount?: number;
  /** Native CheckSuite.workflowRun plus App/repository/commit provenance, never name or ID guesses. */
  actions?: GithubCheckActionsTargetV1;
}>;

export type { GithubChecksStateV1 } from './types.js';

/** Decode omissions belong to the Checks read, not the shared provider classifier. */
type GithubChecksReadFailureV1 = GithubTriageFailureV1 & Readonly<{ omittedRowCount?: number }>;

export type GithubChecksSurfaceV1 = Readonly<{
  observation?: GithubChecksConditionSnapshotV1;
  /** Scalar from the same head-qualified GraphQL read, never inferred from review rows. */
  reviewDecision?: GithubReviewDecisionV1 | null;
  nativePullRequest?: GithubNativePullRequestFactsV1;
  state: GithubChecksStateV1;
  observations: readonly GithubCheckObservationV1[];
  /** `null`, never `0`, wherever a per-job breakdown is unavailable. */
  failingCount: number | null;
  runningCount: number | null;
  passingCount: number | null;
  checkRunsFailure: GithubChecksReadFailureV1 | null;
  commitStatusFailure: GithubChecksReadFailureV1 | null;
  /** The list row projection, or `null` when the surface cannot answer. */
  rowState: GithubChecksRowStateV1 | null;
}>;

/** Body-free native facts acquired alongside the current-head check rollup. */
export type GithubNativePullRequestFactsV1 = Readonly<{
  /** Native viewer fact from the existing summary; absence remains unknown. */
  viewerSubscription?: GithubViewerSubscriptionV1;
  repository: Readonly<{
    archived: boolean | null;
    hasIssues?: boolean | null;
    mergeSettings: Readonly<{ merge: boolean | null; squash: boolean | null; rebase: boolean | null }>;
  }>;
  nodeId: string | null;
  mergeStateStatus: string | null;
  canMergeWithoutWaiting: boolean | null;
  viewerCanUpdate: boolean | null;
  viewerCanEnableAutoMerge: boolean | null;
  viewerCanDisableAutoMerge: boolean | null;
  queue?: Readonly<{ id: string; state: string | null; position: number | null;
    estimatedTimeToMergeSeconds?: number | null }> | null;
  reviews: readonly Readonly<{ id: string; author: string | null; state: string; submittedAtMs: number | null }>[];
  requests: readonly Readonly<{ kind: 'user' | 'team'; subject: string }>[];
  reviewIncomplete: boolean;
  threads: readonly Readonly<{ id: string; isResolved: boolean }>[];
  threadsIncomplete: boolean;
}>;

export type GithubChecksDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
  signal: AbortSignal;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPositiveDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return /^[1-9][0-9]*$/u.test(candidate) ? candidate : null;
}

function readEpochMs(value: unknown): number | null {
  const text = readTrimmedString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCheckOutput(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const parts = [value.title, value.summary, value.text]
    .map(readTrimmedString)
    .filter((part): part is string => part !== null);
  const distinct = parts.filter((part, index) => parts.indexOf(part) === index);
  return distinct.length === 0 ? null : distinct.join('\n\n');
}

function decodeCheckRun(raw: unknown): GithubCheckObservationV1 | null {
  if (!isRecord(raw)) return null;
  const id = readPositiveDecimal(raw.id);
  const name = readTrimmedString(raw.name);
  const status = readTrimmedString(raw.status);
  if (id === null || name === null || status === null) return null;
  const annotationsCount = isRecord(raw.output) ? raw.output.annotations_count : undefined;
  return Object.freeze({
    key: `github-check-run:${id}`,
    resourceKind: 'check-run',
    name,
    status,
    conclusion: readTrimmedString(raw.conclusion),
    detailsUrl: readTrimmedString(raw.details_url),
    startedAtMs: readEpochMs(raw.started_at),
    completedAtMs: readEpochMs(raw.completed_at),
    logExcerpt: readCheckOutput(raw.output),
    ...(typeof annotationsCount === 'number' && Number.isSafeInteger(annotationsCount) && annotationsCount >= 0
      ? { annotationsCount } : {}),
  });
}

function decodeCommitStatus(raw: unknown): GithubCheckObservationV1 | null {
  if (!isRecord(raw)) return null;
  const id = readPositiveDecimal(raw.id);
  const context = readTrimmedString(raw.context);
  const state = readTrimmedString(raw.state);
  if (id === null || context === null || state === null) return null;
  const normalized = readGithubStatusContextObservationV1(state);
  return Object.freeze({
    key: `github-commit-status:${id}`,
    resourceKind: 'commit-status',
    name: context,
    ...normalized,
    detailsUrl: readTrimmedString(raw.target_url),
    startedAtMs: readEpochMs(raw.created_at),
    completedAtMs: normalized.status === 'in_progress' ? null : readEpochMs(raw.updated_at),
    logExcerpt: readTrimmedString(raw.description),
  });
}

type CollectionRead = Readonly<{
  observations: readonly GithubCheckObservationV1[];
  totalCount: number | null;
  /** Provider completeness evidence, independent of a local request budget. */
  truncated: boolean;
  failure: GithubChecksReadFailureV1 | null;
}>;

async function readPaginatedCollection(
  dependencies: GithubChecksDependenciesV1,
  input: Readonly<{
    initialUrl: string;
    repositoryId?: string | null;
    readPage: (body: unknown) => Readonly<{
      rows: readonly unknown[];
      totalCount: number | null;
      checkSuiteIds?: readonly string[];
    }> | null;
    decodeRow: (raw: unknown) => GithubCheckObservationV1 | null;
  }>,
): Promise<CollectionRead> {
  const observations: GithubCheckObservationV1[] = [];
  let totalCount: number | null = null;
  let url: string | null = input.initialUrl;
  let rowCount = 0;
  let omittedRows = 0;
  const checkSuiteIds = new Set<string>();

  const finish = (failure: GithubTriageFailureV1 | null): CollectionRead => {
    return Object.freeze({
      observations: Object.freeze([...observations]),
      totalCount,
      truncated: checkSuiteIds.size >= GITHUB_CHECK_SUITE_CEILING_V1
        || (totalCount !== null && rowCount < totalCount),
      failure: omittedRows === 0 ? failure : Object.freeze({
        ...(failure ?? { class: 'unsupportedContract' as const, code: 'github_checks_rows_undecodable' }),
        omittedRowCount: omittedRows,
      }),
    });
  };

  while (url !== null) {
    if (dependencies.signal.aborted) {
      return finish(Object.freeze({ class: 'transient', code: 'github_request_cancelled' }));
    }
    const requestedUrl: string = url;
    let response;
    try {
      response = await dependencies.client.request({ url: requestedUrl });
    } catch (error) {
      return finish(classifyGithubTransportFailure(error));
    }
    if (!isGithubSuccessStatus(response.status)) {
      return finish(classifyGithubResponseFailure(response, dependencies.now()));
    }
    let page: ReturnType<typeof input.readPage>;
    try {
      page = input.readPage(decodeGithubJsonResponse(response));
    } catch (error) {
      return finish(classifyGithubTransportFailure(error));
    }
    if (page === null) {
      return finish(Object.freeze({
        class: 'unsupportedContract',
        code: 'github_checks_envelope_invalid',
      }));
    }
    if (page.totalCount !== null) totalCount = page.totalCount;
    rowCount += page.rows.length;
    for (const id of page.checkSuiteIds ?? []) checkSuiteIds.add(id);
    for (const raw of page.rows) {
      const decoded = input.decodeRow(raw);
      if (decoded !== null) observations.push(decoded);
      else omittedRows += 1;
    }

    const next = readValidatedGithubFollowUpPage(response.headers, requestedUrl, input.repositoryId);
    if (next.kind === 'next') {
      url = next.url;
    } else if (next.kind === 'invalid') {
      return finish(Object.freeze({
        class: 'unsupportedContract',
        code: 'github_checks_link_invalid',
      }));
    } else {
      url = null;
    }
  }

  return finish(null);
}

export async function readGithubPullRequestChecks(
  input: Readonly<{ route: GithubRepositoryRouteV1; headSha: string; repositoryId?: string | null;
    observation?: Readonly<{ pullRequestNumber: number; selection: 'all' | 'required' }>;
    includeStatus?: boolean;
    includeOutput?: boolean;
  }>,
  dependencies: GithubChecksDependenciesV1,
): Promise<GithubChecksSurfaceV1> {
  if (input.observation) return readGithubChecksConditionSurface({ ...input, observation: input.observation }, dependencies);
  const checkRunsUrl = `${buildGithubApiUrl([
    'repos',
    input.route.owner,
    input.route.name,
    'commits',
    input.headSha,
    'check-runs',
  ])}?filter=all&per_page=${GITHUB_MAX_PAGE_SIZE_V1}`;
  const statusUrl = `${buildGithubApiUrl([
    'repos',
    input.route.owner,
    input.route.name,
    'commits',
    input.headSha,
    'status',
  ])}?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`;

  // The two collections are independent, so both walks start together; each keeps its
  // own pagination, failure and completeness evidence.
  const [checkRuns, commitStatuses] = await Promise.all([readPaginatedCollection(dependencies, {
    initialUrl: checkRunsUrl,
    repositoryId: input.repositoryId ?? null,
    decodeRow: decodeCheckRun,
    readPage: (body) => {
      if (!isRecord(body) || !Array.isArray(body.check_runs)) return null;
      return Object.freeze({
        rows: Object.freeze([...body.check_runs]),
        totalCount: typeof body.total_count === 'number' ? body.total_count : null,
        checkSuiteIds: body.check_runs.flatMap((raw) => {
          const id = isRecord(raw) && isRecord(raw.check_suite)
            ? readPositiveDecimal(raw.check_suite.id) : null;
          return id === null ? [] : [id];
        }),
      });
    },
  }), readPaginatedCollection(dependencies, {
    initialUrl: statusUrl,
    repositoryId: input.repositoryId ?? null,
    decodeRow: decodeCommitStatus,
    readPage: (body) => {
      if (!isRecord(body) || !Array.isArray(body.statuses)) return null;
      return Object.freeze({ rows: Object.freeze([...body.statuses]), totalCount: null });
    },
  })]);

  return projectGithubChecksSurface({ checkRuns, commitStatuses });
}

export function projectGithubChecksSurface(input: Readonly<{
  checkRuns: CollectionRead;
  commitStatuses: CollectionRead;
}>): GithubChecksSurfaceV1 {
  const observations = Object.freeze([
    ...input.checkRuns.observations,
    ...input.commitStatuses.observations,
  ]);
  const anyFailure = input.checkRuns.failure !== null || input.commitStatuses.failure !== null;
  // Each reader supplies its own provider completeness evidence. The GraphQL
  // condition reader uses this same projector without inheriting a REST ceiling.
  const knownIncomplete = input.checkRuns.truncated
    || input.commitStatuses.truncated;

  const state: GithubChecksStateV1 = anyFailure
    ? 'unknown'
    : knownIncomplete
      ? 'knownIncomplete'
      : observations.length === 0 ? 'none' : 'resolved';

  if (anyFailure) {
    // We hold rows but cannot claim a breakdown; a count here would be a guess.
    return Object.freeze({
      state,
      observations,
      failingCount: null,
      runningCount: null,
      passingCount: null,
      checkRunsFailure: input.checkRuns.failure,
      commitStatusFailure: input.commitStatuses.failure,
      rowState: null,
    });
  }

  const tally = { failed: 0, pending: 0, passed: 0, neutral: 0, unknown: 0 };
  for (const observation of observations) tally[readGithubCheckOutcomeV1(observation)] += 1;
  return projectGithubChecksTally({ observations, tally, knownIncomplete, state });
}

/** Per-outcome counts under the one check outcome policy, `readGithubCheckOutcomeV1`. */
export type GithubChecksOutcomeTallyV1 = Readonly<Record<ReturnType<typeof readGithubCheckOutcomeV1>, number>>;

/**
 * The list row's checks surface from GitHub's own per-state counts of the head's rollup
 * contexts (`checkRunCountsByState`, `statusContextCountsByState`). The counts cover the
 * whole connection, so no context page is read and the surface carries no rows.
 */
export function projectGithubChecksCountsSurface(tally: GithubChecksOutcomeTallyV1): GithubChecksSurfaceV1 {
  const total = tally.failed + tally.pending + tally.passed + tally.neutral + tally.unknown;
  return projectGithubChecksTally({ observations: Object.freeze([]), tally, knownIncomplete: false,
    state: total === 0 ? 'none' : 'resolved' });
}

function projectGithubChecksTally(input: Readonly<{
  observations: readonly GithubCheckObservationV1[];
  tally: GithubChecksOutcomeTallyV1;
  knownIncomplete: boolean;
  state: GithubChecksStateV1;
}>): GithubChecksSurfaceV1 {
  const { observations, knownIncomplete, state } = input;
  const failing = input.tally.failed;
  const running = input.tally.pending;
  const passing = input.tally.passed;
  const unknown = input.tally.unknown > 0;
  const total = failing + running + passing + input.tally.neutral + input.tally.unknown;

  // A whole-suite verdict is a claim about checks this walk never read. `allPassing`
  // over a known-incomplete collection is the dangerous one: it reads as "CI is
  // green" while the unread pages may be exactly where the failures are. Observed
  // failures and observed in-flight runs are positive evidence and survive; the
  // suite-wide breakdown does not, for the same reason an unreadable suite's does
  // not — a rendered `0 failing` nobody could compute is a fabricated fact.
  const rowState: GithubChecksRowStateV1 | null = total === 0
    ? null
    : failing > 0
      ? Object.freeze({ kind: 'failing', failingCount: failing })
      : running > 0
        ? Object.freeze({ kind: 'running' })
        : passing > 0 && !knownIncomplete && !unknown ? Object.freeze({ kind: 'allPassing' }) : null;

  const countsUnavailable = total === 0 || knownIncomplete || unknown;
  return Object.freeze({
    state: unknown ? 'unknown' : state,
    observations,
    failingCount: countsUnavailable ? null : failing,
    runningCount: countsUnavailable ? null : running,
    passingCount: countsUnavailable ? null : passing,
    checkRunsFailure: null,
    commitStatusFailure: null,
    rowState,
  });
}
