import {
  buildBitbucketCollisionScope,
  buildBitbucketRepositoryKey,
  readBitbucketBracedUuid,
  readBitbucketEntryId,
} from './identity.js';
import { readBitbucketCloneUrl } from '../bitbucketCloneUrl.js';
import { truncateUtf8 } from './text.js';

/**
 * Raw-decode guard for untrusted provider prose, not the published display bound.
 *
 * The bound a list row must fit belongs to `@happier-dev/triage-protocol` and is applied once, at
 * the projection boundary in `source/observations.ts`, together with single-line normalization.
 * This one only stops an absurd provider payload from being carried around in memory before it
 * gets there, so it is deliberately much larger and is never the value a row is measured against.
 * An identity-valid provider entity is never dropped because its presentation is large: oversize
 * text is truncated on a UTF-8 boundary and the entry is flagged.
 */
export const MAX_BITBUCKET_TEXT_UTF8_BYTES = 4 * 1024;

export type BitbucketAccountRef = Readonly<{
  uuid: string | null;
  nickname: string | null;
  displayName: string | null;
}>;

export type BitbucketParticipantFact = Readonly<{
  user: BitbucketAccountRef;
  role: 'REVIEWER' | 'PARTICIPANT' | null;
  approved: boolean;
  state: 'approved' | 'changes_requested' | null;
  participatedAtMs: number | null;
}>;

export type BitbucketPullRequestNativeState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';

export type BitbucketPullRequestState = Readonly<{
  native: BitbucketPullRequestNativeState | null;
  presentation: 'open' | 'merged' | 'declined' | 'superseded' | 'unknown';
  nativeLabel: string;
}>;

export type BitbucketRepositoryRef = Readonly<{
  uuid: string;
  name: string | null;
  fullName: string | null;
  repositoryKey: string | null;
}>;

export type BitbucketPullRequestEndpoint = Readonly<{
  branchName: string | null;
  commitHash: string | null;
  repository: BitbucketRepositoryRef | null;
  /** The provider's HTTPS source repository clone link, never synthesized locally. */
  cloneUrl?: string;
}>;

export type BitbucketPullRequestEntry = Readonly<{
  kindId: 'pull-request';
  collisionScope: string;
  entryId: string;
  title: string;
  summary: string | null;
  projectionTruncated: boolean;
  state: BitbucketPullRequestState;
  webUrl: string | null;
  repository: BitbucketRepositoryRef;
  author: BitbucketAccountRef | null;
  closedBy: BitbucketAccountRef | null;
  draft: boolean;
  queued: boolean | null;
  commentCount: number | null;
  taskCount: number | null;
  closeSourceBranch: boolean | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  source: BitbucketPullRequestEndpoint | null;
  destination: BitbucketPullRequestEndpoint | null;
  mergeCommitHash: string | null;
  declineReason: string | null;
  /**
   * `null` means the endpoint did not return the list, which is different from an empty list.
   *
   * Both lists are omitted from the pull-request collection by default and returned on a pull
   * request's own `self` URL; the `fields` projection restores them on a collection page for the
   * routes that ask. So `null` now means the read did not ask, or asked and was not answered —
   * either way, unknown. Rendering that as "no reviewers" or "nobody approved" would be a lie, and
   * the review walk treats an unexpected `null` as evidence it could not see rather than as a
   * verdict.
   */
  reviewers: readonly BitbucketAccountRef[] | null;
  participants: readonly BitbucketParticipantFact[] | null;
  /** At least one nested reviewer/participant item could not be decoded as review evidence. */
  reviewEvidenceIncomplete: boolean;
}>;

export type BitbucketRowDecodeFailureReason = 'not-an-object' | 'identity-invalid';

export type BitbucketPullRequestRowResult =
  | Readonly<{ ok: true; entry: BitbucketPullRequestEntry }>
  | Readonly<{ ok: false; reason: BitbucketRowDecodeFailureReason }>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNestedString(source: unknown, ...path: readonly string[]): string | null {
  let current: unknown = source;
  for (const key of path) {
    const record = readRecord(current);
    if (record === null) return null;
    current = record[key];
  }
  return readString(current);
}

function readAccountRef(value: unknown): BitbucketAccountRef | null {
  const record = readRecord(value);
  if (record === null) return null;
  return {
    uuid: readBitbucketBracedUuid(record.uuid),
    nickname: readString(record.nickname),
    displayName: readString(record.display_name),
  };
}

const NATIVE_STATES: Readonly<Record<string, BitbucketPullRequestState>> = Object.freeze({
  OPEN: { native: 'OPEN', presentation: 'open', nativeLabel: 'Open' },
  MERGED: { native: 'MERGED', presentation: 'merged', nativeLabel: 'Merged' },
  DECLINED: { native: 'DECLINED', presentation: 'declined', nativeLabel: 'Declined' },
  SUPERSEDED: { native: 'SUPERSEDED', presentation: 'superseded', nativeLabel: 'Superseded' },
});

/**
 * A closed, declined, or superseded pull request is present with a state — never absent, and never
 * merged-with-a-successor. An unrecognised state stays present and carries its raw label.
 */
function readState(value: unknown): BitbucketPullRequestState {
  const raw = readString(value);
  if (raw === null) return { native: null, presentation: 'unknown', nativeLabel: 'Unknown' };
  return NATIVE_STATES[raw] ?? { native: null, presentation: 'unknown', nativeLabel: raw };
}

function readRepositoryRef(value: unknown): BitbucketRepositoryRef | null {
  const record = readRecord(value);
  if (record === null) return null;
  const uuid = readBitbucketBracedUuid(record.uuid);
  if (uuid === null) return null;
  const fullName = readString(record.full_name);
  return {
    uuid,
    name: readString(record.name),
    fullName,
    repositoryKey: buildBitbucketRepositoryKey(fullName),
  };
}

function readEndpoint(value: unknown): BitbucketPullRequestEndpoint | null {
  const record = readRecord(value);
  if (record === null) return null;
  const cloneUrl = readBitbucketCloneUrl(record.repository, 'https');
  return {
    branchName: readNestedString(record, 'branch', 'name'),
    commitHash: readNestedString(record, 'commit', 'hash'),
    repository: readRepositoryRef(record.repository),
    ...(cloneUrl === null ? {} : { cloneUrl }),
  };
}

function readParticipantState(value: unknown): 'approved' | 'changes_requested' | null {
  return value === 'approved' || value === 'changes_requested' ? value : null;
}

function readParticipant(value: unknown): BitbucketParticipantFact | null {
  const record = readRecord(value);
  if (record === null) return null;
  const user = readAccountRef(record.user);
  if (user === null || user.uuid === null || typeof record.approved !== 'boolean') return null;
  const state = readParticipantState(record.state);
  if (record.state !== null && state === null) return null;
  const role = record.role === 'REVIEWER' || record.role === 'PARTICIPANT' ? record.role : null;
  return {
    user,
    role,
    approved: record.approved,
    state,
    participatedAtMs: readTimestampMs(record.participated_on),
  };
}

type OptionalListDecode<T> = Readonly<{
  items: readonly T[] | null;
  incomplete: boolean;
}>;

function readOptionalList<T>(
  value: unknown,
  decode: (item: unknown) => T | null,
): OptionalListDecode<T> {
  if (!Array.isArray(value)) return { items: null, incomplete: false };
  const decoded: T[] = [];
  let incomplete = false;
  for (const item of value) {
    const mapped = decode(item);
    if (mapped === null) incomplete = true;
    else decoded.push(mapped);
  }
  return { items: decoded, incomplete };
}

/**
 * Decodes one untrusted provider row. Identity is required — the destination repository's immutable
 * UUID plus the pull request's integer id — and a row that cannot prove it is omitted rather than
 * fabricated. Every other field is optional presentation.
 */
export function decodeBitbucketPullRequestRow(raw: unknown): BitbucketPullRequestRowResult {
  const record = readRecord(raw);
  if (record === null) return { ok: false, reason: 'not-an-object' };

  const destination = readEndpoint(record.destination);
  const repository = destination?.repository ?? null;
  const collisionScope = repository === null ? null : buildBitbucketCollisionScope(repository.uuid);
  const entryId = readBitbucketEntryId(record.id);
  if (repository === null || collisionScope === null || entryId === null) {
    return { ok: false, reason: 'identity-invalid' };
  }

  const rawTitle = readString(record.title) ?? '';
  const title = truncateUtf8(rawTitle, MAX_BITBUCKET_TEXT_UTF8_BYTES);
  const rawSummary = readNestedString(record, 'summary', 'raw');
  const summary = rawSummary === null
    ? null
    : truncateUtf8(rawSummary, MAX_BITBUCKET_TEXT_UTF8_BYTES);
  const reviewers = readOptionalList(record.reviewers, (reviewer) => {
    const account = readAccountRef(reviewer);
    return account === null || account.uuid === null ? null : account;
  });
  const participants = readOptionalList(record.participants, readParticipant);

  return {
    ok: true,
    entry: {
      kindId: 'pull-request',
      collisionScope,
      entryId,
      title: title.value,
      summary: summary?.value ?? null,
      projectionTruncated: title.truncated || (summary?.truncated ?? false),
      state: readState(record.state),
      webUrl: readNestedString(record, 'links', 'html', 'href'),
      repository,
      author: readAccountRef(record.author),
      closedBy: readAccountRef(record.closed_by),
      draft: record.draft === true,
      queued: readBoolean(record.queued),
      commentCount: readCount(record.comment_count),
      taskCount: readCount(record.task_count),
      closeSourceBranch: readBoolean(record.close_source_branch),
      createdAtMs: readTimestampMs(record.created_on),
      updatedAtMs: readTimestampMs(record.updated_on),
      source: readEndpoint(record.source),
      destination,
      mergeCommitHash: readNestedString(record, 'merge_commit', 'hash'),
      declineReason: readString(record.reason),
      reviewers: reviewers.items,
      participants: participants.items,
      reviewEvidenceIncomplete: reviewers.incomplete || participants.incomplete,
    },
  };
}

export type BitbucketWorkspaceRef = Readonly<{
  uuid: string;
  slug: string | null;
  name: string | null;
  administrator: boolean | null;
}>;

export type BitbucketWorkspaceRowResult =
  | Readonly<{ ok: true; workspace: BitbucketWorkspaceRef }>
  | Readonly<{ ok: false; reason: BitbucketRowDecodeFailureReason }>;

/**
 * `GET /2.0/user/workspaces` returns `paginated_workspace_access`, whose rows are
 * `{ administrator, workspace }` permission records — not bare workspaces.
 */
export function decodeBitbucketWorkspaceAccessRow(raw: unknown): BitbucketWorkspaceRowResult {
  const record = readRecord(raw);
  if (record === null) return { ok: false, reason: 'not-an-object' };
  const workspace = readRecord(record.workspace);
  if (workspace === null) return { ok: false, reason: 'identity-invalid' };
  const uuid = readBitbucketBracedUuid(workspace.uuid);
  if (uuid === null) return { ok: false, reason: 'identity-invalid' };
  return {
    ok: true,
    workspace: {
      uuid,
      slug: readString(workspace.slug),
      name: readString(workspace.name),
      administrator: readBoolean(record.administrator),
    },
  };
}

export type BitbucketRepositoryRowResult =
  | Readonly<{ ok: true; repository: BitbucketRepositoryRef }>
  | Readonly<{ ok: false; reason: BitbucketRowDecodeFailureReason }>;

export function decodeBitbucketRepositoryRow(raw: unknown): BitbucketRepositoryRowResult {
  const record = readRecord(raw);
  if (record === null) return { ok: false, reason: 'not-an-object' };
  const repository = readRepositoryRef(record);
  if (repository === null) return { ok: false, reason: 'identity-invalid' };
  return { ok: true, repository };
}
