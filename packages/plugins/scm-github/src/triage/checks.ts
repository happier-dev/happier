import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from './errors.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from './locator.js';
import type { GithubChecksRowStateV1 } from './mapping/facts.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import {
  GITHUB_MAX_PAGE_SIZE_V1,
  GITHUB_SEARCH_RESULT_CEILING_V1,
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
 * A list is short for two unrelated reasons, and both must reach `knownIncomplete`.
 * The declared one is a `total_count` past the ceiling. The observed one is a walk that
 * exhausted its page budget while a validated `Link rel="next"` was still on offer —
 * the only evidence available for commit statuses, whose envelope carries no total this
 * source can use, and for any check-runs response that omits one. A rollup computed
 * over the pages that fit and reported as `resolved` tells a reader every check passed
 * while unread pages hold the failures.
 */

export type GithubCheckResourceKindV1 = 'check-run' | 'commit-status';

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
}>;

export type GithubChecksStateV1 = 'none' | 'unknown' | 'knownIncomplete' | 'resolved';

export type GithubChecksSurfaceV1 = Readonly<{
  state: GithubChecksStateV1;
  observations: readonly GithubCheckObservationV1[];
  /** `null`, never `0`, wherever a per-job breakdown is unavailable. */
  failingCount: number | null;
  runningCount: number | null;
  passingCount: number | null;
  checkRunsFailure: GithubTriageFailureV1 | null;
  commitStatusFailure: GithubTriageFailureV1 | null;
  /** The list row projection, or `null` when the surface cannot answer. */
  rowState: GithubChecksRowStateV1 | null;
}>;

export type GithubChecksDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
  signal: AbortSignal;
}>;

const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
]);
const NEUTRAL_CONCLUSIONS = new Set(['neutral', 'skipped', 'cancelled', 'stale']);

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

function decodeCheckRun(raw: unknown): GithubCheckObservationV1 | null {
  if (!isRecord(raw)) return null;
  const id = readPositiveDecimal(raw.id);
  const name = readTrimmedString(raw.name);
  const status = readTrimmedString(raw.status);
  if (id === null || name === null || status === null) return null;
  return Object.freeze({
    key: `github-check-run:${id}`,
    resourceKind: 'check-run',
    name,
    status,
    conclusion: readTrimmedString(raw.conclusion),
    detailsUrl: readTrimmedString(raw.details_url),
    startedAtMs: readEpochMs(raw.started_at),
    completedAtMs: readEpochMs(raw.completed_at),
  });
}

function decodeCommitStatus(raw: unknown): GithubCheckObservationV1 | null {
  if (!isRecord(raw)) return null;
  const id = readPositiveDecimal(raw.id);
  const context = readTrimmedString(raw.context);
  const state = readTrimmedString(raw.state);
  if (id === null || context === null || state === null) return null;
  return Object.freeze({
    key: `github-commit-status:${id}`,
    resourceKind: 'commit-status',
    name: context,
    status: state === 'pending' ? 'in_progress' : 'completed',
    conclusion: state === 'pending'
      ? null
      : state === 'success' ? 'success' : 'failure',
    detailsUrl: readTrimmedString(raw.target_url),
    startedAtMs: readEpochMs(raw.created_at),
    completedAtMs: state === 'pending' ? null : readEpochMs(raw.updated_at),
  });
}

type CollectionRead = Readonly<{
  observations: readonly GithubCheckObservationV1[];
  totalCount: number | null;
  /**
   * The walk stopped at its own page budget while GitHub was still advertising a
   * validated next page. `total_count` cannot stand in for this: the commit-status
   * envelope carries no usable total here, and a check-runs response that omits or
   * understates it would leave a short list looking settled.
   */
  truncated: boolean;
  failure: GithubTriageFailureV1 | null;
}>;

async function readPaginatedCollection(
  dependencies: GithubChecksDependenciesV1,
  input: Readonly<{
    initialUrl: string;
    readPage: (body: unknown) => Readonly<{
      rows: readonly unknown[];
      totalCount: number | null;
    }> | null;
    decodeRow: (raw: unknown) => GithubCheckObservationV1 | null;
    maxPages: number;
  }>,
): Promise<CollectionRead> {
  const observations: GithubCheckObservationV1[] = [];
  let totalCount: number | null = null;
  let url: string | null = input.initialUrl;
  let pages = 0;

  while (url !== null && pages < input.maxPages) {
    if (dependencies.signal.aborted) {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        totalCount,
        truncated: false,
        failure: Object.freeze({ class: 'transient', code: 'github_request_cancelled' }),
      });
    }
    const requestedUrl: string = url;
    let response;
    try {
      response = await dependencies.client.request({ url: requestedUrl });
    } catch (error) {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        totalCount,
        truncated: false,
        failure: classifyGithubTransportFailure(error),
      });
    }
    if (!isGithubSuccessStatus(response.status)) {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        totalCount,
        truncated: false,
        failure: classifyGithubResponseFailure(response, dependencies.now()),
      });
    }
    let page: ReturnType<typeof input.readPage>;
    try {
      page = input.readPage(decodeGithubJsonResponse(response));
    } catch (error) {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        totalCount,
        truncated: false,
        failure: classifyGithubTransportFailure(error),
      });
    }
    if (page === null) {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        totalCount,
        truncated: false,
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_checks_envelope_invalid',
        }),
      });
    }
    if (page.totalCount !== null) totalCount = page.totalCount;
    for (const raw of page.rows) {
      const decoded = input.decodeRow(raw);
      if (decoded !== null) observations.push(decoded);
    }

    pages += 1;
    const next = readValidatedGithubFollowUpPage(response.headers, requestedUrl);
    if (next.kind === 'next') {
      url = next.url;
    } else if (next.kind === 'invalid') {
      return Object.freeze({
        observations: Object.freeze([...observations]),
        totalCount,
        truncated: false,
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_checks_link_invalid',
        }),
      });
    } else {
      url = null;
    }
  }

  return Object.freeze({
    observations: Object.freeze([...observations]),
    totalCount,
    truncated: url !== null,
    failure: null,
  });
}

export async function readGithubPullRequestChecks(
  input: Readonly<{ route: GithubRepositoryRouteV1; headSha: string }>,
  dependencies: GithubChecksDependenciesV1,
): Promise<GithubChecksSurfaceV1> {
  const maxPages = Math.ceil(GITHUB_SEARCH_RESULT_CEILING_V1 / GITHUB_MAX_PAGE_SIZE_V1);
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

  const checkRuns = await readPaginatedCollection(dependencies, {
    initialUrl: checkRunsUrl,
    maxPages,
    decodeRow: decodeCheckRun,
    readPage: (body) => {
      if (!isRecord(body) || !Array.isArray(body.check_runs)) return null;
      return Object.freeze({
        rows: Object.freeze([...body.check_runs]),
        totalCount: typeof body.total_count === 'number' ? body.total_count : null,
      });
    },
  });
  const commitStatuses = await readPaginatedCollection(dependencies, {
    initialUrl: statusUrl,
    maxPages,
    decodeRow: decodeCommitStatus,
    readPage: (body) => {
      if (!isRecord(body) || !Array.isArray(body.statuses)) return null;
      return Object.freeze({ rows: Object.freeze([...body.statuses]), totalCount: null });
    },
  });

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
  // Two independent ways a check list is short, and either one alone is enough: the
  // suite declares more runs than this walk will ever read, or the walk hit its own
  // page budget while GitHub was still offering pages. Deriving incompleteness from
  // `total_count` alone leaves the second case rendering as a settled rollup.
  const knownIncomplete = input.checkRuns.truncated
    || input.commitStatuses.truncated
    || (input.checkRuns.totalCount !== null
      && input.checkRuns.totalCount > GITHUB_SEARCH_RESULT_CEILING_V1);

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

  let failing = 0;
  let running = 0;
  let passing = 0;
  for (const observation of observations) {
    if (observation.status !== 'completed') {
      running += 1;
      continue;
    }
    if (observation.conclusion !== null && FAILING_CONCLUSIONS.has(observation.conclusion)) {
      failing += 1;
      continue;
    }
    if (observation.conclusion !== null && NEUTRAL_CONCLUSIONS.has(observation.conclusion)) continue;
    passing += 1;
  }

  const rowState: GithubChecksRowStateV1 | null = observations.length === 0
    ? null
    : failing > 0
      ? Object.freeze({ kind: 'failing', failingCount: failing })
      : running > 0
        ? Object.freeze({ kind: 'running' })
        : passing > 0 ? Object.freeze({ kind: 'allPassing' }) : null;

  return Object.freeze({
    state,
    observations,
    failingCount: observations.length === 0 ? null : failing,
    runningCount: observations.length === 0 ? null : running,
    passingCount: observations.length === 0 ? null : passing,
    checkRunsFailure: null,
    commitStatusFailure: null,
    rowState,
  });
}
