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
import type { GithubReviewDecisionV1 } from './mapping/facts.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import {
  GITHUB_MAX_PAGE_SIZE_V1,
  GITHUB_SEARCH_RESULT_CEILING_V1,
  type GithubTriageFailureV1,
} from './types.js';

/**
 * Review people, read as the two DIFFERENT facts they are.
 *
 *  - HISTORICAL reviewers are the distinct authors returned by the paginated reviews
 *    collection, with the state and time of their newest review.
 *  - OUTSTANDING requested reviewers are the separately read users AND teams whose
 *    review is still awaited.
 *
 * They are never unioned. A list built from requests loses everyone who already
 * reviewed; a list built from reviews hides a still-outstanding team request. GitHub
 * itself removes a requested reviewer the moment they submit a review, so "was
 * requested" is not recoverable from the request collection alone.
 *
 * A team reviewer is a first-class reviewer, never rendered as a user and never dropped.
 */

export type GithubReviewStateV1 =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

export type GithubHistoricalReviewerV1 = Readonly<{
  login: string;
  state: GithubReviewStateV1;
  submittedAtMs: number | null;
}>;

/**
 * The provider-native facts that identify one submitted review.
 *
 * This is deliberately richer than the collapsed reviewer row above. Mutation
 * reconciliation must distinguish a review that existed before one invocation
 * from a review first observed afterwards; author/state alone cannot do that.
 */
export type GithubPullRequestReviewRecordV1 = Readonly<{
  providerId: string;
  authorLogin: string;
  commitRevision: string;
  state: GithubReviewStateV1;
  body: string;
  submittedAtMs: number | null;
}>;

export type GithubRequestedReviewerV1 =
  | Readonly<{ kind: 'user'; login: string }>
  | Readonly<{ kind: 'team'; slug: string; name: string }>;

export type GithubReviewersSurfaceV1 = Readonly<{
  historical: readonly GithubHistoricalReviewerV1[];
  outstanding: readonly GithubRequestedReviewerV1[];
  /**
   * `null` means UNRESOLVED, not "no decision". See the note on `reviewDecision`
   * derivation below: REST cannot prove GitHub's own `REVIEW_REQUIRED` arm.
   */
  reviewDecision: GithubReviewDecisionV1 | null;
  reviewsFailure: GithubTriageFailureV1 | null;
  requestsFailure: GithubTriageFailureV1 | null;
  reviewsIncomplete: boolean;
  requestsIncomplete: boolean;
}>;

export type GithubReviewsDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
  signal: AbortSignal;
}>;

const REVIEW_STATES = new Set<GithubReviewStateV1>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readEpochMs(value: unknown): number | null {
  const text = readTrimmedString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function decodeGithubReview(raw: unknown): GithubHistoricalReviewerV1 | null {
  if (!isRecord(raw)) return null;
  const login = isRecord(raw.user) ? readTrimmedString(raw.user.login) : null;
  const state = readTrimmedString(raw.state);
  if (login === null || state === null) return null;
  if (!REVIEW_STATES.has(state as GithubReviewStateV1)) return null;
  return Object.freeze({
    login,
    state: state as GithubReviewStateV1,
    submittedAtMs: readEpochMs(raw.submitted_at),
  });
}

function readProviderId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return readTrimmedString(value);
}

export function decodeGithubPullRequestReviewRecord(
  raw: unknown,
): GithubPullRequestReviewRecordV1 | null {
  if (!isRecord(raw)) return null;
  const providerId = readProviderId(raw.id);
  const authorLogin = isRecord(raw.user) ? readTrimmedString(raw.user.login) : null;
  const commitRevision = readTrimmedString(raw.commit_id);
  const state = readTrimmedString(raw.state);
  if (
    providerId === null
    || authorLogin === null
    || commitRevision === null
    || state === null
    || !REVIEW_STATES.has(state as GithubReviewStateV1)
    || typeof raw.body !== 'string'
  ) {
    return null;
  }
  return Object.freeze({
    providerId,
    authorLogin,
    commitRevision,
    state: state as GithubReviewStateV1,
    body: raw.body,
    submittedAtMs: readEpochMs(raw.submitted_at),
  });
}

/** Newest review per author wins; earlier reviews by the same person are history. */
export function collapseGithubHistoricalReviewers(
  reviews: readonly GithubHistoricalReviewerV1[],
): readonly GithubHistoricalReviewerV1[] {
  const byLogin = new Map<string, GithubHistoricalReviewerV1>();
  for (const review of reviews) {
    if (review.state === 'PENDING') continue;
    const existing = byLogin.get(review.login);
    if (
      existing === undefined
      || (review.submittedAtMs ?? 0) >= (existing.submittedAtMs ?? 0)
    ) {
      byLogin.set(review.login, review);
    }
  }
  return Object.freeze([...byLogin.values()]);
}

/**
 * Derives ONLY what the REST reviews collection can prove.
 *
 * GitHub's authoritative `reviewDecision` — including its `REVIEW_REQUIRED` arm, which
 * depends on branch-protection rules — is exposed on GraphQL, not on these REST
 * resources. Synthesizing "Review required" from the presence of an outstanding request
 * would be a fabricated fact about a rule this read never saw, so the decision stays
 * unresolved and the row fact is OMITTED instead.
 */
export function deriveGithubReviewDecision(
  historical: readonly GithubHistoricalReviewerV1[],
): GithubReviewDecisionV1 | null {
  if (historical.some((reviewer) => reviewer.state === 'CHANGES_REQUESTED')) {
    return 'changes-requested';
  }
  if (historical.some((reviewer) => reviewer.state === 'APPROVED')) return 'approved';
  return null;
}

export function decodeGithubRequestedReviewers(
  body: unknown,
): readonly GithubRequestedReviewerV1[] | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body.users) || !Array.isArray(body.teams)) return null;
  const reviewers: GithubRequestedReviewerV1[] = [];
  for (const raw of body.users) {
    const login = isRecord(raw) ? readTrimmedString(raw.login) : null;
    if (login !== null) reviewers.push(Object.freeze({ kind: 'user', login }));
  }
  for (const raw of body.teams) {
    if (!isRecord(raw)) continue;
    const slug = readTrimmedString(raw.slug);
    if (slug === null) continue;
    reviewers.push(Object.freeze({ kind: 'team', slug, name: readTrimmedString(raw.name) ?? slug }));
  }
  return Object.freeze(reviewers);
}

async function readPaginated<T, TPageRow = unknown>(
  dependencies: GithubReviewsDependenciesV1,
  input: Readonly<{
    initialUrl: string;
    readPage: (body: unknown) => readonly TPageRow[] | null;
    decodeRow: (raw: TPageRow) => T | null;
    maxPages: number;
  }>,
): Promise<Readonly<{
  rows: readonly T[];
  failure: GithubTriageFailureV1 | null;
  incomplete: boolean;
}>> {
  const rows: T[] = [];
  let url: string | null = input.initialUrl;
  let pages = 0;

  while (url !== null && pages < input.maxPages) {
    if (dependencies.signal.aborted) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({ class: 'transient', code: 'github_request_cancelled' }),
        incomplete: false,
      });
    }
    const requestedUrl: string = url;
    let response;
    try {
      response = await dependencies.client.request({ url: requestedUrl });
    } catch (error) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: classifyGithubTransportFailure(error),
        incomplete: false,
      });
    }
    if (!isGithubSuccessStatus(response.status)) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: classifyGithubResponseFailure(response, dependencies.now()),
        incomplete: false,
      });
    }
    let page: readonly TPageRow[] | null;
    try {
      page = input.readPage(decodeGithubJsonResponse(response));
    } catch (error) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: classifyGithubTransportFailure(error),
        incomplete: false,
      });
    }
    if (page === null) {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_reviews_envelope_invalid',
        }),
        incomplete: false,
      });
    }
    for (const raw of page) {
      const decoded = input.decodeRow(raw);
      if (decoded !== null) rows.push(decoded);
    }

    pages += 1;
    const next = readValidatedGithubFollowUpPage(response.headers, requestedUrl);
    if (next.kind === 'next') {
      url = next.url;
    } else if (next.kind === 'invalid') {
      return Object.freeze({
        rows: Object.freeze([...rows]),
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_reviews_link_invalid',
        }),
        incomplete: false,
      });
    } else {
      url = null;
    }
  }

  return Object.freeze({
    rows: Object.freeze([...rows]),
    failure: null,
    // A validated next page after the provider-derived 1,000-row budget is
    // evidence that this connection did not finish. Rows already read remain
    // useful, but they may not be presented as the whole review history.
    incomplete: url !== null,
  });
}

export type GithubPullRequestReviewRecordsReadV1 = Readonly<{
  reviews: readonly GithubPullRequestReviewRecordV1[];
  failure: GithubTriageFailureV1 | null;
  incomplete: boolean;
}>;

/** The one canonical walk of GitHub's submitted-review collection. */
export async function readGithubPullRequestReviewRecords(
  input: Readonly<{ route: GithubRepositoryRouteV1; number: string }>,
  dependencies: GithubReviewsDependenciesV1,
): Promise<GithubPullRequestReviewRecordsReadV1> {
  const maxPages = Math.ceil(GITHUB_SEARCH_RESULT_CEILING_V1 / GITHUB_MAX_PAGE_SIZE_V1);
  const base = buildGithubApiUrl([
    'repos',
    input.route.owner,
    input.route.name,
    'pulls',
    input.number,
  ]);
  const read = await readPaginated<GithubPullRequestReviewRecordV1>(dependencies, {
    initialUrl: `${base}/reviews?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`,
    maxPages,
    decodeRow: decodeGithubPullRequestReviewRecord,
    readPage: (body) => (Array.isArray(body) ? Object.freeze([...body]) : null),
  });
  return Object.freeze({
    reviews: read.rows,
    failure: read.failure,
    incomplete: read.incomplete,
  });
}

export async function readGithubPullRequestReviewers(
  input: Readonly<{ route: GithubRepositoryRouteV1; number: string }>,
  dependencies: GithubReviewsDependenciesV1,
): Promise<GithubReviewersSurfaceV1> {
  const maxPages = Math.ceil(GITHUB_SEARCH_RESULT_CEILING_V1 / GITHUB_MAX_PAGE_SIZE_V1);
  const base = buildGithubApiUrl([
    'repos',
    input.route.owner,
    input.route.name,
    'pulls',
    input.number,
  ]);

  const reviews = await readGithubPullRequestReviewRecords(input, dependencies);

  // `GET /requested_reviewers` returns TOP-LEVEL `users` and `teams`, unlike the pull
  // request object's nested `requested_reviewers`/`requested_teams`. One shape, read once.
  const requests = await readPaginated<GithubRequestedReviewerV1, GithubRequestedReviewerV1>(dependencies, {
    initialUrl: `${base}/requested_reviewers?per_page=${GITHUB_MAX_PAGE_SIZE_V1}`,
    maxPages,
    decodeRow: (raw) => raw,
    readPage: (body) => decodeGithubRequestedReviewers(body),
  });

  const historical = collapseGithubHistoricalReviewers(reviews.reviews.map((review) => ({
    login: review.authorLogin,
    state: review.state,
    submittedAtMs: review.submittedAtMs,
  })));
  return Object.freeze({
    historical,
    outstanding: requests.rows,
    reviewDecision: reviews.failure === null ? deriveGithubReviewDecision(historical) : null,
    reviewsFailure: reviews.failure,
    requestsFailure: requests.failure,
    reviewsIncomplete: reviews.incomplete,
    requestsIncomplete: requests.incomplete,
  });
}
