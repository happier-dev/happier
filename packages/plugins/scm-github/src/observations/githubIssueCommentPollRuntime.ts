import {
  MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES,
  MAX_CONVERSATION_RETRY_AFTER_MS,
  type ConversationNormalizedIngressV1,
  type ConversationObservationV1,
  type ConversationPollResultV1,
} from '@happier-dev/channels-protocol/v1';
import { parseForgeLinkHeader } from '@happier-dev/triage-sources/runtime';
import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  classifyGithubIssueCommentPage,
  MAX_GITHUB_ISSUE_COMMENT_CONTINUATION_URL_LENGTH,
  maximumGithubIssueCommentCursorPosition,
  parseGithubIssueCommentCursor,
  type GithubIssueCommentCursorCandidateV1,
  type GithubIssueCommentContinuationV1,
  type GithubIssueCommentCursorV1,
  type GithubIssueCommentCursorPositionV1,
} from './githubIssueCommentCursor.js';
import { createGithubRepositoryIssueCommentsUrl } from './githubIssueCommentPolling.js';
import type { GithubApiClientV1, GithubApiResponseV1 } from './githubApiClient.js';
import type {
  GithubChannelProviderConfigV1,
  GithubRepositorySourceConfigV1,
} from './githubProviderContracts.js';
import { GITHUB_API_ORIGIN, readGithubPositiveDecimal } from './githubProviderContracts.js';

const MAX_GITHUB_ISSUE_COMMENT_PAGES_PER_POLL = 10;
const MAX_GITHUB_ISSUE_COMMENT_SCOPE_LENGTH = 512;
const githubIssueCommentTextEncoder = new TextEncoder();

type JsonRecord = Readonly<Record<string, unknown>>;

type GithubIssueCommentRecordV1 = Readonly<{
  id: string;
  body: string | null;
  createdAtIso: string;
  updatedAtIso: string;
  issueNumber: number;
  actor: Readonly<{
    id: string | null;
    label?: string;
    kind: 'human' | 'bot' | 'unknown';
  }>;
}>;

type GithubIssueCommentPollScopeV1 = Readonly<{
  connectionId: string;
  providerConnectionKey: string;
}>;

export type GithubIssueRecordV1 = Readonly<{
  id: string;
  number: number;
  title?: string;
  kind: 'githubIssue' | 'githubPullRequest';
}>;

export class GithubIssueCommentPollResponseError extends Error {
  constructor(readonly response: GithubApiResponseV1) {
    super(`GitHub issue-comment API returned ${response.status}`);
  }
}

class GithubIssueCommentHistoryGapError extends Error {
  constructor() {
    super('GitHub issue-comment baseline or poll exceeded the bounded pagination window');
  }
}

export class GithubIssueCommentCheckpointError extends Error {
  constructor() {
    super('GitHub issue-comment checkpoint is malformed or has an unsafe continuation');
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RangeError(`GitHub ${label} must be a string`);
  }
  return value;
}

function readTimestamp(value: unknown, label: string): string {
  const iso = readString(value, label);
  const time = Date.parse(iso);
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new RangeError(`GitHub ${label} must be an ISO timestamp`);
  }
  return new Date(time).toISOString();
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`GitHub ${label} must be a positive safe integer`);
  }
  return value;
}

function decodeJson(response: GithubApiResponseV1): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  } catch {
    throw new RangeError('GitHub issue-comment API returned invalid JSON');
  }
}

/**
 * The RFC 8288 grammar is a provider-published standard rather than a GitHub rule, so
 * it is parsed by the shared forge owner. What the relation MEANS, and whether its URL
 * may be followed, stays with this source's continuation validation below.
 */
function parseGithubPaginationLink(
  headers: Readonly<Record<string, string>>,
  relation: 'next' | 'last',
): string | null {
  return parseForgeLinkHeader(readTriageResponseHeaderV1(headers, 'link'))[relation] ?? null;
}

function parseNextLink(headers: Readonly<Record<string, string>>): string | null {
  return parseGithubPaginationLink(headers, 'next');
}

function parseLastLink(headers: Readonly<Record<string, string>>): string | null {
  return parseGithubPaginationLink(headers, 'last');
}

function expectedConnectionKey(repository: GithubRepositorySourceConfigV1): string {
  return `github:repository:${repository.repositoryId}`;
}

function readPollScope(input: Readonly<{
  connectionId: string;
  providerConnectionKey: string;
  repository: GithubRepositorySourceConfigV1;
}>): GithubIssueCommentPollScopeV1 {
  if (!input.connectionId.trim() || input.connectionId.length > MAX_GITHUB_ISSUE_COMMENT_SCOPE_LENGTH) {
    throw new RangeError('GitHub issue-comment polling requires a bounded Channel connection ID');
  }
  if (
    !input.providerConnectionKey.trim()
    || input.providerConnectionKey.length > MAX_GITHUB_ISSUE_COMMENT_SCOPE_LENGTH
    || input.providerConnectionKey !== expectedConnectionKey(input.repository)
  ) {
    throw new RangeError('GitHub issue-comment polling requires its immutable repository connection key');
  }
  return Object.freeze({
    connectionId: input.connectionId,
    providerConnectionKey: input.providerConnectionKey,
  });
}

/**
 * A persisted checkpoint is an Account-owned recovery boundary. Its malformed
 * contents must request an authenticated baseline reset instead of becoming a
 * retryable transport failure or silently lending an invalid continuation to
 * this poll.
 */
function parsePersistedGithubIssueCommentCheckpoint(value: unknown): GithubIssueCommentCursorV1 {
  try {
    return parseGithubIssueCommentCursor(value);
  } catch (error) {
    if (error instanceof RangeError) throw new GithubIssueCommentCheckpointError();
    throw error;
  }
}

function continuationMatchesScope(
  continuation: GithubIssueCommentContinuationV1,
  scope: GithubIssueCommentPollScopeV1,
): boolean {
  return continuation.transport === 'poll'
    && continuation.connectionId === scope.connectionId
    && continuation.providerConnectionKey === scope.providerConnectionKey;
}

function readSingleQueryValue(url: URL, key: string, label: string): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new RangeError(`GitHub issue-comment continuation has repeated ${label}`);
  }
  return values[0] ?? null;
}

function withIssueCommentSinceFilter(headUrl: string, since: string): string {
  const filterUrl = new URL(headUrl);
  filterUrl.searchParams.set('since', since);
  filterUrl.searchParams.delete('page');
  return filterUrl.toString();
}

function readIssueCommentFilterSince(filterUrl: string): string {
  const since = readSingleQueryValue(new URL(filterUrl), 'since', 'since boundary');
  if (since === null) {
    throw new RangeError('GitHub issue-comment continuation requires its since boundary');
  }
  return since;
}

function cursorPosition(cursor: Pick<
  GithubIssueCommentCursorV1 | GithubIssueCommentCursorPositionV1,
  'updatedAtIso' | 'commentIdAtUpdatedAt'
>): GithubIssueCommentCursorPositionV1 {
  return Object.freeze({
    updatedAtIso: cursor.updatedAtIso,
    commentIdAtUpdatedAt: cursor.commentIdAtUpdatedAt,
  });
}

function cursorAtPosition(position: GithubIssueCommentCursorPositionV1): GithubIssueCommentCursorV1 {
  return Object.freeze({
    v: 1,
    updatedAtIso: position.updatedAtIso,
    commentIdAtUpdatedAt: position.commentIdAtUpdatedAt,
    etag: null,
    continuation: null,
  });
}

/**
 * GitHub Link headers are provider-controlled URLs. They remain an opaque
 * Account checkpoint only after proving that they cannot redirect the selected
 * Connected Account, cross the immutable repository stream, or change the
 * ordered comments filter that the cursor owns.
 */
function validateGithubIssueCommentContinuationUrl(input: Readonly<{
  value: string;
  repository: GithubRepositorySourceConfigV1;
  expectedFilterUrl: string;
}>): string {
  try {
    return validateGithubIssueCommentContinuationUrlUnchecked(input);
  } catch (error) {
    if (error instanceof RangeError) throw new GithubIssueCommentHistoryGapError();
    throw error;
  }
}

function validatePersistedGithubIssueCommentContinuationUrl(input: Readonly<{
  value: string;
  repository: GithubRepositorySourceConfigV1;
  expectedFilterUrl: string;
}>): string {
  try {
    return validateGithubIssueCommentContinuationUrlUnchecked(input);
  } catch (error) {
    if (error instanceof RangeError) throw new GithubIssueCommentCheckpointError();
    throw error;
  }
}

function validateGithubIssueCommentContinuationUrlUnchecked(input: Readonly<{
  value: string;
  repository: GithubRepositorySourceConfigV1;
  expectedFilterUrl: string;
}>): string {
  if (!input.value || input.value.length > MAX_GITHUB_ISSUE_COMMENT_CONTINUATION_URL_LENGTH) {
    throw new RangeError('GitHub issue-comment continuation URL is invalid');
  }
  let url: URL;
  try {
    url = new URL(input.value);
  } catch {
    throw new RangeError('GitHub issue-comment continuation URL is invalid');
  }
  if (
    url.protocol !== 'https:'
    || url.origin !== GITHUB_API_ORIGIN
    || url.username
    || url.password
    || url.hash
  ) {
    throw new RangeError('GitHub issue-comment continuation URL must stay on the declared GitHub API origin');
  }
  const expectedPath = `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/issues/comments`;
  if (url.pathname !== expectedPath) {
    throw new RangeError('GitHub issue-comment continuation URL must stay in the configured repository stream');
  }
  const expectedFilter = new URL(input.expectedFilterUrl);
  const allowedQueryNames = new Set(['sort', 'direction', 'since', 'per_page', 'page']);
  for (const key of url.searchParams.keys()) {
    if (!allowedQueryNames.has(key)) {
      throw new RangeError('GitHub issue-comment continuation URL contains an unsupported query parameter');
    }
  }
  for (const [key, label] of [
    ['sort', 'sort'],
    ['direction', 'direction'],
    ['per_page', 'per-page limit'],
  ] as const) {
    const expected = readSingleQueryValue(expectedFilter, key, label);
    const actual = readSingleQueryValue(url, key, label);
    if (expected === null || actual !== expected) {
      throw new RangeError(`GitHub issue-comment continuation URL changed its ${label}`);
    }
  }
  const expectedSince = readSingleQueryValue(expectedFilter, 'since', 'since boundary');
  const actualSince = readSingleQueryValue(url, 'since', 'since boundary');
  if (actualSince !== expectedSince) {
    throw new RangeError('GitHub issue-comment continuation URL changed its since boundary');
  }
  const page = readSingleQueryValue(url, 'page', 'page');
  if (page !== null && !/^[1-9][0-9]*$/u.test(page)) {
    throw new RangeError('GitHub issue-comment continuation URL has an invalid page');
  }
  return url.toString();
}

function parseIssueNumberFromUrl(value: unknown, repository: GithubRepositorySourceConfigV1): number {
  const raw = readString(value, 'comment issue URL');
  const url = new URL(raw);
  if (url.origin !== 'https://api.github.com') {
    throw new RangeError('GitHub comment issue URL must target the GitHub API');
  }
  const expected = `/repos/${repository.owner}/${repository.name}/issues/`;
  if (!url.pathname.startsWith(expected)) {
    throw new RangeError('GitHub comment issue URL must stay inside the configured repository');
  }
  return readPositiveInteger(Number(url.pathname.slice(expected.length)), 'issue number');
}

function parseActor(value: unknown): GithubIssueCommentRecordV1['actor'] {
  if (!isRecord(value)) {
    return Object.freeze({ id: null, label: undefined, kind: 'unknown' });
  }
  const id = (() => {
    try {
      return readGithubPositiveDecimal(value.id, 'comment author ID');
    } catch {
      return null;
    }
  })();
  const label = typeof value.login === 'string' && value.login.trim() ? value.login.trim() : undefined;
  const type = value.type;
  return Object.freeze({
    id,
    ...(label === undefined ? {} : { label }),
    kind: type === 'User' && label?.toLowerCase() !== 'ghost'
      ? 'human'
      : type === 'Bot'
        ? 'bot'
        : 'unknown',
  });
}

function parseIssueComment(
  value: unknown,
  repository: GithubRepositorySourceConfigV1,
): GithubIssueCommentRecordV1 {
  if (!isRecord(value)) throw new RangeError('GitHub issue-comment entry must be an object');
  return Object.freeze({
    id: readGithubPositiveDecimal(value.id, 'comment ID'),
    body: typeof value.body === 'string' ? value.body : null,
    createdAtIso: readTimestamp(value.created_at, 'comment creation time'),
    updatedAtIso: readTimestamp(value.updated_at, 'comment update time'),
    issueNumber: parseIssueNumberFromUrl(value.issue_url, repository),
    actor: parseActor(value.user),
  });
}

export function parseGithubIssue(value: unknown): GithubIssueRecordV1 {
  if (!isRecord(value)) throw new RangeError('GitHub issue response must be an object');
  return Object.freeze({
    id: readGithubPositiveDecimal(value.id, 'issue ID'),
    number: readPositiveInteger(value.number, 'issue number'),
    ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
    kind: isRecord(value.pull_request) ? 'githubPullRequest' : 'githubIssue',
  });
}

function issueUrl(repository: GithubRepositorySourceConfigV1, issueNumber: number): string {
  return new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${issueNumber}`,
    'https://api.github.com',
  ).toString();
}

export function githubIssueEndpointId(repositoryId: string, issue: GithubIssueRecordV1): string {
  return `github:repository:${repositoryId}:issue:${issue.id}:number:${issue.number}`;
}

function githubIssueCommentOccurrenceId(repositoryId: string, commentId: string): string {
  return `github:repository:${repositoryId}:issue-comment:${commentId}`;
}

function initialCursor(nowMs: number): GithubIssueCommentCursorV1 {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('GitHub issue-comment baseline requires a nonnegative safe clock');
  }
  return Object.freeze({
    v: 1,
    // GitHub's comment ordering is second-granular. A local millisecond
    // baseline would classify a comment that arrives later in that same
    // second as already seen. The cursor-only `0` lower-bound sentinel keeps
    // the whole observed second replay-safe; API comment IDs remain positive.
    updatedAtIso: new Date(Math.floor(nowMs / 1_000) * 1_000).toISOString(),
    commentIdAtUpdatedAt: '0',
    etag: null,
    continuation: null,
  });
}

function sortComments(
  comments: readonly GithubIssueCommentRecordV1[],
): readonly GithubIssueCommentRecordV1[] {
  return Object.freeze([...comments].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAtIso);
    const rightTime = Date.parse(right.updatedAtIso);
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
    if (left.id.length !== right.id.length) return left.id.length < right.id.length ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }));
}

function pollIntervalHint(headers: Readonly<Record<string, string>>): number | null {
  const raw = readTriageResponseHeaderV1(headers, 'x-poll-interval');
  if (!raw || !/^\d+$/u.test(raw.trim())) return null;
  const seconds = Number(raw.trim());
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const retryAfterMs = seconds * 1_000;
  // GitHub's poll cadence is projected through the same strict Channels retry
  // result as rate-limit hints, so normalize an oversized provider interval at
  // this provider boundary before the core parses it.
  return !Number.isSafeInteger(retryAfterMs)
    ? MAX_CONVERSATION_RETRY_AFTER_MS
    : Math.min(retryAfterMs, MAX_CONVERSATION_RETRY_AFTER_MS);
}

function providerHistoryGapResult(): ConversationPollResultV1 {
  return Object.freeze({
    kind: 'historyGap' as const,
    reason: 'providerHistoryUnavailable' as const,
  });
}

async function readIssueCommentPages(input: Readonly<{
  client: GithubApiClientV1;
  initialUrl: string;
  etag: string | null;
  repository: GithubRepositorySourceConfigV1;
  expectedFilterUrl: string;
  maxPages: number;
}>): Promise<Readonly<{
  kind: 'notModified' | 'pages';
  comments: readonly GithubIssueCommentRecordV1[];
  etag: string | null;
  nextPageUrl: string | null;
  lastPageUrl: string | null;
  pollIntervalHeaders: Readonly<Record<string, string>>;
}>> {
  let nextUrl: string | null = input.initialUrl;
  let first = true;
  let etag: string | null = null;
  const comments: GithubIssueCommentRecordV1[] = [];
  const visitedUrls = new Set<string>();
  let lastHeaders: Readonly<Record<string, string>> = {};
  let lastPageUrl: string | null = null;

  for (let pageCount = 0; nextUrl !== null && pageCount < input.maxPages; pageCount += 1) {
    if (visitedUrls.has(nextUrl)) {
      throw new GithubIssueCommentHistoryGapError();
    }
    visitedUrls.add(nextUrl);
    const response = await input.client.request({
      url: nextUrl,
      headers: first && input.etag ? { 'If-None-Match': input.etag } : {},
    });
    lastHeaders = response.headers;
    if (response.status === 304) {
      if (!first || input.etag === null) {
        throw new RangeError('Only an ETag-validated initial GitHub issue-comment page may be not modified');
      }
      return Object.freeze({
        kind: 'notModified',
        comments: Object.freeze([]),
        etag: input.etag,
        nextPageUrl: null,
        lastPageUrl: null,
        pollIntervalHeaders: lastHeaders,
      });
    }
    if (response.status !== 200) throw new GithubIssueCommentPollResponseError(response);
    const parsed = decodeJson(response);
    if (!Array.isArray(parsed)) throw new RangeError('GitHub issue-comment API response must be an array');
    comments.push(...parsed.map((entry) => parseIssueComment(entry, input.repository)));
    if (first) {
      etag = readTriageResponseHeaderV1(response.headers, 'etag');
      const last = parseLastLink(response.headers);
      lastPageUrl = last === null
        ? null
        : validateGithubIssueCommentContinuationUrl({
          value: last,
          repository: input.repository,
          expectedFilterUrl: input.expectedFilterUrl,
        });
    }
    const next = parseNextLink(response.headers);
    nextUrl = next === null
      ? null
      : validateGithubIssueCommentContinuationUrl({
        value: next,
        repository: input.repository,
        expectedFilterUrl: input.expectedFilterUrl,
      });
    first = false;
  }

  return Object.freeze({
    kind: 'pages',
    comments: sortComments(comments),
    etag,
    nextPageUrl: nextUrl,
    lastPageUrl,
    pollIntervalHeaders: lastHeaders,
  });
}

/**
 * Polls the documented repository issue-comments endpoint. This intentionally
 * remains separate from the GitHub Events cursor because update-time/comment-ID
 * ordering and ETag semantics are not interchangeable with the 300-event
 * retention window.
 */
export async function pollGithubIssueCommentsForChannels(input: Readonly<{
  client: GithubApiClientV1;
  config: GithubChannelProviderConfigV1;
  checkpoint: unknown;
  limit: number;
  connectionId: string;
  providerConnectionKey: string;
  nowMs?: number;
}>): Promise<ConversationPollResultV1> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new RangeError('GitHub issue-comment polling requires the Channels batch limit');
  }
  const nowMs = input.nowMs ?? Date.now();
  const checkpoint = input.checkpoint === null ? null : parsePersistedGithubIssueCommentCheckpoint(input.checkpoint);
  const scope = readPollScope({
    connectionId: input.connectionId,
    providerConnectionKey: input.providerConnectionKey,
    repository: input.config.repository,
  });
  const headUrl = checkpoint === null
    ? new URL(
      `/repos/${encodeURIComponent(input.config.repository.owner)}/${encodeURIComponent(input.config.repository.name)}/issues/comments?sort=updated&direction=asc&per_page=100`,
      'https://api.github.com',
    ).toString()
    : createGithubRepositoryIssueCommentsUrl({
      apiBaseUrl: 'https://api.github.com',
      owner: input.config.repository.owner,
      repository: input.config.repository.name,
      cursor: checkpoint,
    });
  const persistedContinuation = checkpoint?.continuation ?? null;
  const activeContinuation = persistedContinuation !== null && continuationMatchesScope(persistedContinuation, scope)
    ? persistedContinuation
    : null;
  const expectedFilterUrl = activeContinuation === null
    ? headUrl
    : withIssueCommentSinceFilter(headUrl, activeContinuation.filterSince);
  const initialUrl = activeContinuation === null
    ? headUrl
    : validatePersistedGithubIssueCommentContinuationUrl({
      value: activeContinuation.url,
      repository: input.config.repository,
      expectedFilterUrl,
    });
  let pageResult: Awaited<ReturnType<typeof readIssueCommentPages>>;
  let baselineTailPageResult: Awaited<ReturnType<typeof readIssueCommentPages>> | null = null;
  try {
    pageResult = await readIssueCommentPages({
      client: input.client,
      initialUrl,
      // An ETag is only meaningful for an ordinary complete first page. Never
      // send it while resuming an opaque continuation or discarding one whose
      // connection scope has changed.
      etag: activeContinuation === null && persistedContinuation === null ? checkpoint?.etag ?? null : null,
      repository: input.config.repository,
      expectedFilterUrl,
      // A null checkpoint has no history to admit. Read its authenticated
      // head once, then use GitHub's validated `rel="last"` link to establish
      // the current tail without walking historical pages. A replay cursor
      // orders only the Link page that created it. Re-reading a later page
      // under that cursor could discard an older ID at the same timestamp
      // before the window-start cursor has classified it.
      maxPages: checkpoint === null
        ? 1
        : activeContinuation?.replayCursor === undefined
          ? MAX_GITHUB_ISSUE_COMMENT_PAGES_PER_POLL
          : 1,
    });
    if (checkpoint === null && pageResult.kind === 'pages' && pageResult.nextPageUrl !== null) {
      if (pageResult.lastPageUrl === null) return providerHistoryGapResult();
      baselineTailPageResult = await readIssueCommentPages({
        client: input.client,
        initialUrl: pageResult.lastPageUrl,
        etag: null,
        repository: input.config.repository,
        expectedFilterUrl,
        maxPages: 1,
      });
      if (baselineTailPageResult.kind !== 'pages' || baselineTailPageResult.nextPageUrl !== null) {
        return providerHistoryGapResult();
      }
    }
  } catch (error) {
    if (error instanceof GithubIssueCommentHistoryGapError) return providerHistoryGapResult();
    throw error;
  }
  const retryAfterMs = pollIntervalHint(pageResult.pollIntervalHeaders);

  if (pageResult.kind === 'notModified') {
    if (checkpoint === null) throw new RangeError('GitHub issue-comment baseline cannot be conditionally not modified');
    return Object.freeze({
      kind: 'batch' as const,
      observations: [],
      checkpointAfterBatch: checkpoint,
      ...(retryAfterMs === null ? {} : { retryHint: { retryAfterMs } }),
    });
  }
  if (checkpoint === null) {
    const latest = (baselineTailPageResult ?? pageResult).comments.at(-1);
    const baseline = latest === undefined
      ? initialCursor(nowMs)
      : Object.freeze({
        v: 1 as const,
        updatedAtIso: latest.updatedAtIso,
        commentIdAtUpdatedAt: latest.id,
        etag: pageResult.etag,
        continuation: null,
    });
    return Object.freeze({
      kind: 'checkpointOnly' as const,
      checkpointAfterBatch: baseline,
    });
  }

  const candidates: GithubIssueCommentCursorCandidateV1[] = pageResult.comments.map((comment) => ({
    commentId: comment.id,
    createdAtIso: comment.createdAtIso,
    updatedAtIso: comment.updatedAtIso,
  }));
  const classification = classifyGithubIssueCommentPage({
    // A bounded re-read of the same Link page needs only its page-local replay
    // boundary. A later Link page must classify from the window start because
    // GitHub can place a lower ID at the same timestamp after an earlier page.
    cursor: activeContinuation?.replayCursor === undefined
      ? checkpoint
      : cursorAtPosition(activeContinuation.replayCursor),
    comments: candidates,
    maxTerminalItems: input.limit,
  });
  const commentsById = new Map(pageResult.comments.map((comment) => [comment.id, comment]));
  const issuesByNumber = new Map<number, GithubIssueRecordV1>();
  const observations: ConversationNormalizedIngressV1[] = [];

  for (const entry of classification.classifications) {
    if (entry.kind === 'alreadyClassified') continue;
    const comment = commentsById.get(entry.commentId);
    if (!comment) throw new RangeError('GitHub issue-comment cursor lost its classified comment');
    let issue = issuesByNumber.get(comment.issueNumber);
    if (!issue) {
      const response = await input.client.request({ url: issueUrl(input.config.repository, comment.issueNumber) });
      if (response.status !== 200) throw new GithubIssueCommentPollResponseError(response);
      issue = parseGithubIssue(decodeJson(response));
      if (issue.number !== comment.issueNumber) throw new RangeError('GitHub issue identity did not match its comment');
      issuesByNumber.set(comment.issueNumber, issue);
    }
    const createdAtMs = Date.parse(comment.createdAtIso);
    const updatedAtMs = Date.parse(comment.updatedAtIso);
    const shell = Object.freeze({
      v: 1 as const,
      occurrenceId: githubIssueCommentOccurrenceId(input.config.repository.repositoryId, comment.id),
      occurredAt: createdAtMs,
      transport: { kind: 'poll' as const },
      endpoint: {
        kind: issue.kind,
        audience: 'shared' as const,
        id: githubIssueEndpointId(input.config.repository.repositoryId, issue),
        label: issue.title === undefined ? `#${issue.number}` : `#${issue.number} ${issue.title}`,
        parentId: input.config.repository.repositoryId,
        parentLabel: input.config.repository.nameWithOwner,
      },
      actor: {
        principalId: comment.actor.id,
        ...(comment.actor.label === undefined ? {} : { label: comment.actor.label }),
        kind: comment.actor.kind,
        isIntegrationSelf: comment.actor.id === input.config.integrationPrincipal.id,
      },
      message: {
        id: comment.id,
        revision: comment.updatedAtIso,
        // GitHub issue-comment payloads have no authenticated structured
        // mention or reply target. Rendered Markdown cannot grant admission.
        addressingEvidence: 'none' as const,
        contentProvenance: 'original' as const,
        providerTimestamp: updatedAtMs,
      },
    });
    if (entry.kind === 'unsupportedEdit') {
      observations.push(Object.freeze({
        kind: 'routableNonAdmission' as const,
        shell,
        reason: 'unsupportedEdit' as const,
      }));
      continue;
    }
    if (comment.body === null) {
      observations.push(Object.freeze({
        kind: 'routableNonAdmission' as const,
        shell,
        reason: 'unsupportedContent' as const,
      }));
      continue;
    }
    if (githubIssueCommentTextEncoder.encode(comment.body).byteLength > MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES) {
      observations.push(Object.freeze({
        kind: 'routableNonAdmission' as const,
        shell,
        reason: 'messageTooLarge' as const,
      }));
      continue;
    }
    const observation: ConversationObservationV1 = Object.freeze({
      ...shell,
      message: {
        ...shell.message,
        text: comment.body,
      },
    });
    observations.push(Object.freeze({ kind: 'fullText' as const, observation }));
  }

  const allCandidatesClassified = classification.classifications.length === candidates.length;
  // If admission stopped inside this fetched window, restart at its actual
  // first page. The stable `(updated_at, id)` boundary discards replayed work
  // and preserves every unseen comment; jumping to Link's next page would
  // silently skip the unclassified suffix.
  const nextContinuationUrl = allCandidatesClassified
    ? pageResult.nextPageUrl
    : initialUrl;
  const windowHighWatermark = maximumGithubIssueCommentCursorPosition(
    activeContinuation?.windowHighWatermark ?? cursorPosition(checkpoint),
    cursorPosition(classification.cursor),
  );
  const committedCursorPosition = nextContinuationUrl === null
    ? windowHighWatermark
    : cursorPosition(checkpoint);
  const checkpointAfterBatch: GithubIssueCommentCursorV1 = Object.freeze({
    v: 1,
    updatedAtIso: committedCursorPosition.updatedAtIso,
    commentIdAtUpdatedAt: committedCursorPosition.commentIdAtUpdatedAt,
    // A validator represents the complete initial response only. Keeping it
    // after a bounded Link window or an admission cap would turn partial work
    // into a false no-change result and strand unseen equal-time comments.
    etag: allCandidatesClassified && nextContinuationUrl === null && activeContinuation === null
      ? pageResult.etag
      : null,
    continuation: nextContinuationUrl === null
      ? null
      : Object.freeze({
        transport: 'poll' as const,
        connectionId: scope.connectionId,
        providerConnectionKey: scope.providerConnectionKey,
        filterSince: readIssueCommentFilterSince(expectedFilterUrl),
        windowHighWatermark,
        ...(!allCandidatesClassified ? { replayCursor: cursorPosition(classification.cursor) } : {}),
        url: nextContinuationUrl,
      }),
  });
  return Object.freeze({
    kind: 'batch' as const,
    observations,
    checkpointAfterBatch,
    ...(retryAfterMs === null ? {} : { retryHint: { retryAfterMs } }),
  });
}
