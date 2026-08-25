import { buildGithubEntryLocalRef } from '../identity.js';
import { buildGithubEntryLocator } from '../locator.js';
import { GITHUB_API_ORIGIN } from '../../observations/githubProviderContracts.js';
import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  GithubTriageEntryLocalRefV1,
  GithubTriageEntryLocatorV1,
  GithubTriageEntrySnapshotV1,
  GithubTriageKindIdV1,
} from '../types.js';

import {
  buildGithubRowFacts,
  type GithubChecksRowStateV1,
  type GithubReviewDecisionV1,
} from './facts.js';
import { mapGithubIssueState, mapGithubPullRequestState } from './state.js';

/**
 * Tolerant provider-row decoding lives here, one raw entity at a time. A malformed row
 * is omitted and counted; it never invalidates its siblings, never fabricates an id, and
 * never coerces a cross-kind row.
 *
 * Everything above this module works with the decoded view, so the strict source result
 * never sees a raw provider bag.
 */

export type GithubRawEntityViewV1 = Readonly<{
  kindId: GithubTriageKindIdV1;
  /** Native item number, validated positive decimal. */
  number: string;
  owner: string;
  name: string;
  /** Provider-cased `owner/name`, presentation only. */
  repositoryLabel: string;
  /** Numeric repository id when this response carried one; otherwise resolved by the caller. */
  repositoryId: string | null;
  title: string;
  state: Readonly<Record<string, unknown>>;
  authorLogin: string | null;
  labelNames: readonly string[];
  commentCount: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  htmlUrl: string | null;
  /** Head revision, present on a pull-request response. */
  nativeRevision: string | null;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
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

function readLabelNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (name) names.push(name);
      continue;
    }
    if (isRecord(entry)) {
      const name = readTrimmedString(entry.name);
      if (name !== null) names.push(name);
    }
  }
  return Object.freeze(names);
}

function readCommentCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `https://api.github.com/repos/{owner}/{repo}` → `{ owner, repo }`, or `null`. */
export function readGithubRepositoryRouteFromApiUrl(value: unknown): Readonly<{
  owner: string;
  name: string;
}> | null {
  const text = readTrimmedString(value);
  if (text === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (
    parsed.origin !== GITHUB_API_ORIGIN
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 3 || segments[0] !== 'repos') return null;
  const owner = segments[1];
  const name = segments[2];
  if (owner === undefined || name === undefined) return null;
  return Object.freeze({ owner, name });
}

function readRepositoryFacts(raw: JsonRecord): Readonly<{
  owner: string;
  name: string;
  label: string;
  repositoryId: string | null;
}> | null {
  const repository = isRecord(raw.repository) ? raw.repository : null;
  if (repository !== null) {
    const owner = isRecord(repository.owner) ? readTrimmedString(repository.owner.login) : null;
    const name = readTrimmedString(repository.name);
    if (owner !== null && name !== null) {
      return Object.freeze({
        owner,
        name,
        label: readTrimmedString(repository.full_name) ?? `${owner}/${name}`,
        repositoryId: readPositiveDecimal(repository.id),
      });
    }
  }
  const route = readGithubRepositoryRouteFromApiUrl(raw.repository_url);
  if (route === null) return null;
  return Object.freeze({
    owner: route.owner,
    name: route.name,
    label: `${route.owner}/${route.name}`,
    repositoryId: null,
  });
}

/**
 * Decodes one `/search/issues` item. An item carrying `pull_request` IS a pull request
 * and is mapped as one — never as an issue.
 */
export function decodeGithubSearchItem(raw: unknown): GithubRawEntityViewV1 | null {
  if (!isRecord(raw)) return null;
  const number = readPositiveDecimal(raw.number);
  const title = readTrimmedString(raw.title);
  const createdAtMs = readEpochMs(raw.created_at);
  const updatedAtMs = readEpochMs(raw.updated_at);
  const repository = readRepositoryFacts(raw);
  if (number === null || title === null || repository === null) return null;
  if (createdAtMs === null || updatedAtMs === null) return null;
  const kindId: GithubTriageKindIdV1 = isRecord(raw.pull_request) ? 'pull-request' : 'issue';
  return Object.freeze({
    kindId,
    number,
    owner: repository.owner,
    name: repository.name,
    repositoryLabel: repository.label,
    repositoryId: repository.repositoryId,
    title,
    state: raw,
    authorLogin: isRecord(raw.user) ? readTrimmedString(raw.user.login) : null,
    labelNames: readLabelNames(raw.labels),
    commentCount: readCommentCount(raw.comments),
    createdAtMs,
    updatedAtMs,
    htmlUrl: readTrimmedString(raw.html_url),
    nativeRevision: null,
  });
}

/** Decodes `GET /repos/{owner}/{repo}/pulls/{number}`. */
export function decodeGithubPullRequestBody(raw: unknown): GithubRawEntityViewV1 | null {
  if (!isRecord(raw)) return null;
  const number = readPositiveDecimal(raw.number);
  const title = readTrimmedString(raw.title);
  const createdAtMs = readEpochMs(raw.created_at);
  const updatedAtMs = readEpochMs(raw.updated_at);
  const base = isRecord(raw.base) ? raw.base : null;
  const repository = base !== null && isRecord(base.repo)
    ? readRepositoryFacts({ repository: base.repo })
    : readRepositoryFacts(raw);
  if (number === null || title === null || repository === null) return null;
  if (createdAtMs === null || updatedAtMs === null) return null;
  const head = isRecord(raw.head) ? raw.head : null;
  return Object.freeze({
    kindId: 'pull-request',
    number,
    owner: repository.owner,
    name: repository.name,
    repositoryLabel: repository.label,
    repositoryId: repository.repositoryId,
    title,
    state: raw,
    authorLogin: isRecord(raw.user) ? readTrimmedString(raw.user.login) : null,
    labelNames: readLabelNames(raw.labels),
    commentCount: readCommentCount(raw.comments),
    createdAtMs,
    updatedAtMs,
    htmlUrl: readTrimmedString(raw.html_url),
    nativeRevision: head === null ? null : readTrimmedString(head.sha),
  });
}

/** Decodes `GET /repos/{owner}/{repo}/issues/{number}`. */
export function decodeGithubIssueBody(
  raw: unknown,
  route: Readonly<{ owner: string; name: string }>,
): GithubRawEntityViewV1 | null {
  if (!isRecord(raw)) return null;
  const number = readPositiveDecimal(raw.number);
  const title = readTrimmedString(raw.title);
  const createdAtMs = readEpochMs(raw.created_at);
  const updatedAtMs = readEpochMs(raw.updated_at);
  if (number === null || title === null) return null;
  if (createdAtMs === null || updatedAtMs === null) return null;
  const repository = readRepositoryFacts(raw);
  return Object.freeze({
    kindId: isRecord(raw.pull_request) ? 'pull-request' : 'issue',
    number,
    owner: repository?.owner ?? route.owner,
    name: repository?.name ?? route.name,
    repositoryLabel: repository?.label ?? `${route.owner}/${route.name}`,
    repositoryId: repository?.repositoryId ?? null,
    title,
    state: raw,
    authorLogin: isRecord(raw.user) ? readTrimmedString(raw.user.login) : null,
    labelNames: readLabelNames(raw.labels),
    commentCount: readCommentCount(raw.comments),
    createdAtMs,
    updatedAtMs,
    htmlUrl: readTrimmedString(raw.html_url),
    nativeRevision: null,
  });
}

/**
 * The repository identity launch placement joins on, or `null`.
 *
 * It is emitted only when it fits the published repository-path bound. A truncated
 * `owner/name` is not a weaker identity — it is a different one, and it would
 * match a checkout the reader never asked for. Omitting it resolves no launch
 * candidate, which is the honest answer.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function buildGithubNameWithOwner(owner: string, name: string): string | null {
  const nameWithOwner = `${owner}/${name}`;
  return utf8ByteLength(nameWithOwner) <= MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1
    ? nameWithOwner
    : null;
}

export type GithubEntryProjectionExtrasV1 = Readonly<{
  reviewDecision?: GithubReviewDecisionV1 | null;
  checks?: GithubChecksRowStateV1 | null;
  mergeability?: 'conflicts' | 'blocked' | 'computing' | null;
  additionsDeletions?: 'detailOnly' | Readonly<{ additions: number; deletions: number }> | null;
}>;

export type GithubEntryProjectionV1 = Readonly<{
  localRef: GithubTriageEntryLocalRefV1;
  locator: GithubTriageEntryLocatorV1;
  snapshot: GithubTriageEntrySnapshotV1;
}>;

/**
 * Projects a decoded view plus its proven repository id into identity, locator and the
 * bounded snapshot. Returns `null` only when identity cannot be proven — never because
 * presentation was oversized, which truncates and sets `projectionTruncated`.
 */
export function projectGithubEntry(
  view: GithubRawEntityViewV1,
  repositoryId: string,
  extras: GithubEntryProjectionExtrasV1 = {},
): GithubEntryProjectionV1 | null {
  const localRef = buildGithubEntryLocalRef({
    kindId: view.kindId,
    repositoryId,
    // The native ITEM NUMBER, not `raw.id`: `number` is the only uniqueness claim
    // GitHub publishes, and it is scoped to the repository the collision scope names.
    nativeItemId: view.number,
  });
  if (localRef === null) return null;
  const locator = buildGithubEntryLocator({
    owner: view.owner,
    name: view.name,
    entryNumber: view.number,
    webUrl: view.htmlUrl,
  });
  if (locator === null) return null;

  // Provider text is normalized into one bounded line at the shared owner before it is
  // measured: a GitHub issue title may contain a newline, and the strict target rejects a
  // control-bearing result ATOMICALLY, discarding every other row on the same scan page.
  const title = projectTriageDisplayTextV1(view.title, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  const scopeLabel = projectTriageDisplayTextV1(
    view.repositoryLabel,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  );
  const state = view.kindId === 'pull-request'
    ? mapGithubPullRequestState(view.state)
    : mapGithubIssueState(view.state);
  const facts = buildGithubRowFacts({
    kindId: view.kindId,
    number: view.number,
    repositoryLabel: scopeLabel.value,
    authorLogin: view.authorLogin,
    updatedAtMs: view.updatedAtMs,
    // GitHub returns `comments` on every issue response, so "always for issues" holds
    // without coercion. A missing count stays omitted rather than becoming a fabricated 0.
    commentCount: view.commentCount,
    labelNames: view.labelNames,
    reviewDecision: extras.reviewDecision ?? null,
    checks: extras.checks ?? null,
    mergeability: extras.mergeability ?? null,
    additionsDeletions: extras.additionsDeletions ?? null,
  });

  return Object.freeze({
    localRef,
    locator,
    snapshot: Object.freeze({
      kindId: view.kindId,
      title: title.value,
      scopeLabel: scopeLabel.value,
      webUrl: locator.webUrl,
      nameWithOwner: buildGithubNameWithOwner(view.owner, view.name),
      createdAtMs: view.createdAtMs,
      sourceUpdatedAtMs: view.updatedAtMs,
      nativeRevision: view.nativeRevision,
      state,
      rowFacts: facts.rowFacts,
      projectionTruncated: title.truncated || scopeLabel.truncated || facts.truncated,
    }),
  });
}
