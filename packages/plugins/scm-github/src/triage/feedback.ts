import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GithubApiClientV1 } from '../observations/githubApiClient.js';

import type { GithubRepositoryRouteV1 } from './locator.js';
import { sendGithubGraphqlRequest } from './mutations/graphql.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubCommentBody,
  projectGithubDetailIdentifierV1,
  projectGithubDetailLabelV1,
  projectGithubDetailPathV1,
  projectGithubDetailWebUrlV1,
} from './detail/projection.js';

/**
 * The one GitHub Feedback fetcher.
 *
 * GitHub publishes pull-request issue comments, review threads, reviews, and
 * outstanding review requests as independent GraphQL connections. Each call
 * below advances exactly one of those connections (or one thread's nested
 * replies) and returns only that connection's cursor. It deliberately owns no
 * merged cursor or retained feed: the mounted panel owns its independent
 * windows, and reopening starts from GitHub's newest rows again.
 */

export const GITHUB_FEEDBACK_COMMENT_PAGE_SIZE_V1 = 40;
export const GITHUB_FEEDBACK_THREAD_PAGE_SIZE_V1 = 12;
export const GITHUB_FEEDBACK_REVIEW_PAGE_SIZE_V1 = 8;
export const GITHUB_FEEDBACK_REQUEST_PAGE_SIZE_V1 = 16;
export const GITHUB_FEEDBACK_REPLY_PAGE_SIZE_V1 = 3;

export type GithubFeedbackConnectionV1 =
  | 'comments'
  | 'threads'
  | 'reviews'
  | 'requests'
  | 'threadReplies';

type GithubFeedbackBaseInputV1 = Readonly<{
  route: GithubRepositoryRouteV1;
  repositoryId: string;
  number: string;
  kindId: 'pull-request';
  cursor: string | null;
}>;

export type GithubFeedbackConnectionInputV1 = GithubFeedbackBaseInputV1 & (
  | Readonly<{ connection: Exclude<GithubFeedbackConnectionV1, 'threadReplies'> }>
  | Readonly<{ connection: 'threadReplies'; threadId: string }>
);

export type GithubFeedbackCommentV1 = Readonly<{
  id: string;
  author: string | null;
  body: string;
  createdAtMs: number | null;
  url: string | null;
  truncated?: true;
}>;

export type GithubFeedbackThreadV1 = Readonly<{
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  replies: readonly GithubFeedbackCommentV1[];
  previousRepliesCursor: string | null;
  truncated?: true;
}>;

export type GithubFeedbackReviewV1 = Readonly<{
  id: string;
  author: string | null;
  body: string;
  state: string;
  submittedAtMs: number | null;
  url: string | null;
  truncated?: true;
}>;

export type GithubFeedbackRequestV1 =
  | Readonly<{ kind: 'user'; subject: string; truncated?: true }>
  | Readonly<{ kind: 'team'; subject: string; truncated?: true }>;

export type GithubFeedbackConnectionResultV1 =
  | Readonly<{
    kind: 'comments';
    rows: readonly GithubFeedbackCommentV1[];
    previousCursor: string | null;
  }>
  | Readonly<{
    kind: 'threads';
    rows: readonly GithubFeedbackThreadV1[];
    previousCursor: string | null;
  }>
  | Readonly<{
    kind: 'reviews';
    rows: readonly GithubFeedbackReviewV1[];
    previousCursor: string | null;
    reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
  }>
  | Readonly<{
    kind: 'requests';
    rows: readonly GithubFeedbackRequestV1[];
    nextCursor: string | null;
  }>
  | Readonly<{
    kind: 'threadReplies';
    threadId: string;
    rows: readonly GithubFeedbackCommentV1[];
    previousCursor: string | null;
  }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

export type GithubFeedbackDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
  signal: AbortSignal;
}>;

const INVALID_REQUEST: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_feedback_request_invalid',
});

const INVALID_RESPONSE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_feedback_response_invalid',
});

const COMMENTS_QUERY = `query GithubFeedbackComments(
  $owner: String!, $name: String!, $number: Int!, $commentCount: Int!, $commentCursor: String
) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      comments(last: $commentCount, before: $commentCursor) {
        nodes { id author { login } body createdAt url }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

const THREADS_QUERY = `query GithubFeedbackThreads(
  $owner: String!, $name: String!, $number: Int!, $threadCount: Int!,
  $threadCursor: String, $replyCount: Int!
) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      reviewThreads(last: $threadCount, before: $threadCursor) {
        nodes {
          id isResolved path line
          comments(last: $replyCount) {
            nodes { id author { login } body createdAt url }
            pageInfo { hasPreviousPage startCursor }
          }
        }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

const REVIEWS_QUERY = `query GithubFeedbackReviews(
  $owner: String!, $name: String!, $number: Int!, $reviewCount: Int!, $reviewCursor: String
) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      reviewDecision
      reviews(last: $reviewCount, before: $reviewCursor) {
        nodes { id author { login } body state submittedAt url }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

const REQUESTS_QUERY = `query GithubFeedbackRequests(
  $owner: String!, $name: String!, $number: Int!, $requestCount: Int!, $requestCursor: String
) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      reviewRequests(first: $requestCount, after: $requestCursor) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { name slug }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const THREAD_REPLIES_QUERY = `query GithubFeedbackThreadReplies(
  $threadId: ID!, $replyCount: Int!, $replyCursor: String
) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      pullRequest { number repository { databaseId } }
      comments(last: $replyCount, before: $replyCursor) {
        nodes { id author { login } body createdAt url }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function epochMs(value: unknown): number | null {
  const text = trimmed(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableCursor(pageInfo: unknown, direction: 'previous' | 'next'): string | null | undefined {
  if (!isRecord(pageInfo)) return undefined;
  const hasMore = direction === 'previous' ? pageInfo.hasPreviousPage : pageInfo.hasNextPage;
  if (typeof hasMore !== 'boolean') return undefined;
  if (!hasMore) return null;
  const cursor = trimmed(direction === 'previous' ? pageInfo.startCursor : pageInfo.endCursor);
  return cursor ?? undefined;
}

function decodeComment(raw: unknown): GithubFeedbackCommentV1 | null {
  if (!isRecord(raw)) return null;
  const id = projectGithubDetailIdentifierV1(raw.id);
  if (id === null || typeof raw.body !== 'string') return null;
  const author = isRecord(raw.author) ? projectGithubDetailLabelV1(raw.author.login) : null;
  const body = projectGithubCommentBody(raw.body, GITHUB_DETAIL_BOUNDS_V1.commentBodyUtf8Bytes);
  const truncated = id.truncated || (author?.truncated ?? false) || body.truncated;
  return Object.freeze({
    id: id.value,
    author: author?.value ?? null,
    body: body.value,
    createdAtMs: epochMs(raw.createdAt),
    url: projectGithubDetailWebUrlV1(raw.url),
    ...(truncated ? { truncated: true as const } : {}),
  });
}

function chronological<T extends Readonly<{ createdAtMs: number | null; id: string }>>(
  rows: readonly T[],
): readonly T[] {
  return Object.freeze([...rows].sort((left, right) => {
    if (left.createdAtMs === null || right.createdAtMs === null) {
      if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs === null ? 1 : -1;
    } else if (left.createdAtMs !== right.createdAtMs) {
      return left.createdAtMs - right.createdAtMs;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }));
}

function commentsFrom(connection: unknown): readonly GithubFeedbackCommentV1[] | null {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return null;
  const rows: GithubFeedbackCommentV1[] = [];
  for (const raw of connection.nodes) {
    const decoded = decodeComment(raw);
    if (decoded !== null) rows.push(decoded);
  }
  return chronological(rows);
}

function readPullRequest(
  data: Readonly<Record<string, unknown>>,
  repositoryId: string,
): Readonly<Record<string, unknown>> | null {
  const repository = data.repository;
  if (!isRecord(repository) || String(repository.databaseId) !== repositoryId) return null;
  return isRecord(repository.pullRequest) ? repository.pullRequest : null;
}

function unavailable(failure: TriageSourceFailureV1): GithubFeedbackConnectionResultV1 {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

function decodeThreads(connection: unknown): readonly GithubFeedbackThreadV1[] | null {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return null;
  const rows: GithubFeedbackThreadV1[] = [];
  for (const raw of connection.nodes) {
    if (!isRecord(raw)) continue;
    const id = projectGithubDetailIdentifierV1(raw.id);
    if (id === null || typeof raw.isResolved !== 'boolean') continue;
    const replies = commentsFrom(raw.comments);
    const repliesCursor = isRecord(raw.comments)
      ? nullableCursor(raw.comments.pageInfo, 'previous')
      : undefined;
    if (replies === null || repliesCursor === undefined) continue;
    const line = typeof raw.line === 'number' && Number.isSafeInteger(raw.line) ? raw.line : null;
    const path = projectGithubDetailPathV1(raw.path);
    const truncated = id.truncated || (path?.truncated ?? false)
      || replies.some((reply) => reply.truncated === true);
    rows.push(Object.freeze({
      id: id.value,
      isResolved: raw.isResolved,
      path: path?.value ?? null,
      line,
      replies,
      previousRepliesCursor: repliesCursor,
      ...(truncated ? { truncated: true as const } : {}),
    }));
  }
  return Object.freeze(rows);
}

function decodeReviews(connection: unknown): readonly GithubFeedbackReviewV1[] | null {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return null;
  const rows: GithubFeedbackReviewV1[] = [];
  for (const raw of connection.nodes) {
    if (!isRecord(raw)) continue;
    const id = projectGithubDetailIdentifierV1(raw.id);
    const state = projectGithubDetailLabelV1(raw.state);
    if (id === null || state === null || typeof raw.body !== 'string') continue;
    const author = isRecord(raw.author) ? projectGithubDetailLabelV1(raw.author.login) : null;
    const body = projectGithubCommentBody(raw.body, GITHUB_DETAIL_BOUNDS_V1.commentBodyUtf8Bytes);
    const truncated = id.truncated || state.truncated || (author?.truncated ?? false) || body.truncated;
    rows.push(Object.freeze({
      id: id.value,
      author: author?.value ?? null,
      body: body.value,
      state: state.value,
      submittedAtMs: epochMs(raw.submittedAt),
      url: projectGithubDetailWebUrlV1(raw.url),
      ...(truncated ? { truncated: true as const } : {}),
    }));
  }
  return Object.freeze([...rows].sort((left, right) => {
    const leftAt = left.submittedAtMs;
    const rightAt = right.submittedAtMs;
    if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return leftAt - rightAt;
    if (leftAt === null && rightAt !== null) return 1;
    if (leftAt !== null && rightAt === null) return -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }));
}

function decodeReviewDecision(
  value: unknown,
): 'approved' | 'changes-requested' | 'review-required' | null | undefined {
  if (value === null) return null;
  switch (value) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes-requested';
    case 'REVIEW_REQUIRED': return 'review-required';
    default: return undefined;
  }
}

function decodeRequests(connection: unknown): readonly GithubFeedbackRequestV1[] | null {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return null;
  const rows: GithubFeedbackRequestV1[] = [];
  for (const raw of connection.nodes) {
    if (!isRecord(raw) || !isRecord(raw.requestedReviewer)) continue;
    const reviewer = raw.requestedReviewer;
    if (reviewer.__typename === 'User') {
      const login = projectGithubDetailLabelV1(reviewer.login);
      if (login !== null) rows.push(Object.freeze({
        kind: 'user', subject: login.value, ...(login.truncated ? { truncated: true as const } : {}),
      }));
      continue;
    }
    if (reviewer.__typename === 'Team') {
      const subject = projectGithubDetailLabelV1(reviewer.name)
        ?? projectGithubDetailLabelV1(reviewer.slug);
      if (subject !== null) rows.push(Object.freeze({
        kind: 'team', subject: subject.value, ...(subject.truncated ? { truncated: true as const } : {}),
      }));
    }
  }
  return Object.freeze(rows);
}

export async function readGithubFeedbackConnection(
  input: GithubFeedbackConnectionInputV1,
  dependencies: GithubFeedbackDependenciesV1,
): Promise<GithubFeedbackConnectionResultV1> {
  const number = Number(input.number);
  if (
    dependencies.signal.aborted
    || !Number.isSafeInteger(number)
    || number < 1
    || !/^[1-9][0-9]*$/u.test(input.repositoryId)
    || (input.connection === 'threadReplies' && !input.threadId.trim())
  ) {
    return unavailable(INVALID_REQUEST);
  }

  const sharedVariables = {
    owner: input.route.owner,
    name: input.route.name,
    number,
  };
  const threadId = input.connection === 'threadReplies' ? input.threadId : null;
  const request = input.connection === 'comments'
    ? {
      query: COMMENTS_QUERY,
      variables: { ...sharedVariables, commentCount: GITHUB_FEEDBACK_COMMENT_PAGE_SIZE_V1, commentCursor: input.cursor },
    }
    : input.connection === 'threads'
      ? {
        query: THREADS_QUERY,
        variables: {
          ...sharedVariables,
          threadCount: GITHUB_FEEDBACK_THREAD_PAGE_SIZE_V1,
          threadCursor: input.cursor,
          replyCount: GITHUB_FEEDBACK_REPLY_PAGE_SIZE_V1,
        },
      }
      : input.connection === 'reviews'
        ? {
          query: REVIEWS_QUERY,
          variables: { ...sharedVariables, reviewCount: GITHUB_FEEDBACK_REVIEW_PAGE_SIZE_V1, reviewCursor: input.cursor },
        }
        : input.connection === 'requests'
          ? {
            query: REQUESTS_QUERY,
            variables: { ...sharedVariables, requestCount: GITHUB_FEEDBACK_REQUEST_PAGE_SIZE_V1, requestCursor: input.cursor },
          }
          : {
            query: THREAD_REPLIES_QUERY,
            variables: {
              threadId,
              replyCount: GITHUB_FEEDBACK_REPLY_PAGE_SIZE_V1,
              replyCursor: input.cursor,
            },
          };

  const answered = await sendGithubGraphqlRequest(request, dependencies);
  if (!answered.ok) return unavailable(answered.failure);

  if (input.connection === 'threadReplies' && threadId !== null) {
    const thread = answered.data.node;
    const owningPullRequest = isRecord(thread) ? thread.pullRequest : null;
    const owningRepository = isRecord(owningPullRequest) ? owningPullRequest.repository : null;
    if (
      !isRecord(thread)
      || thread.id !== threadId
      || !isRecord(owningPullRequest)
      || owningPullRequest.number !== number
      || !isRecord(owningRepository)
      || String(owningRepository.databaseId) !== input.repositoryId
    ) {
      return unavailable(INVALID_RESPONSE);
    }
    const rows = commentsFrom(thread.comments);
    const previousCursor = isRecord(thread.comments)
      ? nullableCursor(thread.comments.pageInfo, 'previous')
      : undefined;
    return rows === null || previousCursor === undefined
      ? unavailable(INVALID_RESPONSE)
      : Object.freeze({
        kind: 'threadReplies' as const,
        threadId,
        rows,
        previousCursor,
      });
  }

  const pullRequest = readPullRequest(answered.data, input.repositoryId);
  if (pullRequest === null) return unavailable(INVALID_RESPONSE);

  if (input.connection === 'comments') {
    const connection = pullRequest.comments;
    const rows = commentsFrom(connection);
    const previousCursor = isRecord(connection)
      ? nullableCursor(connection.pageInfo, 'previous')
      : undefined;
    return rows === null || previousCursor === undefined
      ? unavailable(INVALID_RESPONSE)
      : Object.freeze({ kind: 'comments' as const, rows, previousCursor });
  }
  if (input.connection === 'threads') {
    const connection = pullRequest.reviewThreads;
    const rows = decodeThreads(connection);
    const previousCursor = isRecord(connection)
      ? nullableCursor(connection.pageInfo, 'previous')
      : undefined;
    return rows === null || previousCursor === undefined
      ? unavailable(INVALID_RESPONSE)
      : Object.freeze({ kind: 'threads' as const, rows, previousCursor });
  }
  if (input.connection === 'reviews') {
    const connection = pullRequest.reviews;
    const rows = decodeReviews(connection);
    const previousCursor = isRecord(connection)
      ? nullableCursor(connection.pageInfo, 'previous')
      : undefined;
    const reviewDecision = decodeReviewDecision(pullRequest.reviewDecision);
    return rows === null || previousCursor === undefined || reviewDecision === undefined
      ? unavailable(INVALID_RESPONSE)
      : Object.freeze({ kind: 'reviews' as const, rows, previousCursor, reviewDecision });
  }
  if (input.connection === 'requests') {
    const connection = pullRequest.reviewRequests;
    const rows = decodeRequests(connection);
    const nextCursor = isRecord(connection)
      ? nullableCursor(connection.pageInfo, 'next')
      : undefined;
    return rows === null || nextCursor === undefined
      ? unavailable(INVALID_RESPONSE)
      : Object.freeze({ kind: 'requests' as const, rows, nextCursor });
  }

  return unavailable(INVALID_RESPONSE);
}
