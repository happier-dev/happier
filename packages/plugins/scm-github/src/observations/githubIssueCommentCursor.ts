export type GithubIssueCommentCursorPositionV1 = Readonly<{
  updatedAtIso: string;
  commentIdAtUpdatedAt: string;
}>;

export type GithubIssueCommentCursorV1 = Readonly<{
  v: 1;
  updatedAtIso: string;
  commentIdAtUpdatedAt: string;
  etag: string | null;
}>;

export type GithubIssueCommentCursorCandidateV1 = Readonly<{
  commentId: string;
  createdAtIso: string;
  updatedAtIso: string;
  action?: 'created' | 'edited';
}>;

export type GithubIssueCommentCursorClassificationV1 =
  | Readonly<{ kind: 'admit'; commentId: string }>
  | Readonly<{ kind: 'unsupportedEdit'; commentId: string }>
  | Readonly<{ kind: 'alreadyClassified'; commentId: string }>;

export type GithubIssueCommentPageClassificationV1 = Readonly<{
  classifications: readonly GithubIssueCommentCursorClassificationV1[];
  cursor: GithubIssueCommentCursorV1;
}>;

type GithubIssueCommentPosition = Readonly<{
  updatedAtMs: number;
  commentId: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CURSOR_DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/u;
const GITHUB_COMMENT_DECIMAL_ID = /^[1-9][0-9]*$/u;

function normalizeCursorDecimalId(value: string): string {
  if (!CURSOR_DECIMAL_ID.test(value)) {
    throw new RangeError('GitHub comment cursor IDs must be nonnegative decimal strings');
  }
  return value;
}

function normalizeGithubCommentId(value: string): string {
  if (!GITHUB_COMMENT_DECIMAL_ID.test(value)) {
    throw new RangeError('GitHub comment IDs must be positive decimal strings');
  }
  return value;
}

function parseGithubTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError('GitHub comment timestamps must be valid nonnegative ISO timestamps');
  }
  return timestamp;
}

function canonicalIsoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function compareDecimalIds(left: string, right: string): number {
  const normalizedLeft = normalizeCursorDecimalId(left);
  const normalizedRight = normalizeCursorDecimalId(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function comparePositions(left: GithubIssueCommentPosition, right: GithubIssueCommentPosition): number {
  if (left.updatedAtMs !== right.updatedAtMs) {
    return left.updatedAtMs < right.updatedAtMs ? -1 : 1;
  }
  return compareDecimalIds(left.commentId, right.commentId);
}

function positionFromCursor(cursor: GithubIssueCommentCursorV1): GithubIssueCommentPosition {
  return {
    updatedAtMs: parseGithubTimestamp(cursor.updatedAtIso),
    commentId: normalizeCursorDecimalId(cursor.commentIdAtUpdatedAt),
  };
}

function positionFromCursorPosition(position: GithubIssueCommentCursorPositionV1): GithubIssueCommentPosition {
  return {
    updatedAtMs: parseGithubTimestamp(position.updatedAtIso),
    commentId: normalizeCursorDecimalId(position.commentIdAtUpdatedAt),
  };
}

/** Keeps every comparison of GitHub's `(updated_at, id)` cursor order in its canonical owner. */
export function compareGithubIssueCommentCursorPositions(
  left: GithubIssueCommentCursorPositionV1,
  right: GithubIssueCommentCursorPositionV1,
): number {
  return comparePositions(positionFromCursorPosition(left), positionFromCursorPosition(right));
}

/** Parses the persisted provider-owned cursor without lending it a third feature cursor shape. */
export function parseGithubIssueCommentCursor(value: unknown): GithubIssueCommentCursorV1 {
  if (!isRecord(value) || value.v !== 1) {
    throw new RangeError('GitHub issue-comment checkpoint must use V1');
  }
  if (typeof value.updatedAtIso !== 'string' || typeof value.commentIdAtUpdatedAt !== 'string') {
    throw new RangeError('GitHub issue-comment checkpoint is missing its ordering boundary');
  }
  if (value.etag !== null && typeof value.etag !== 'string') {
    throw new RangeError('GitHub issue-comment checkpoint has an invalid ETag');
  }
  return Object.freeze({
    v: 1,
    updatedAtIso: canonicalIsoTimestamp(parseGithubTimestamp(value.updatedAtIso)),
    commentIdAtUpdatedAt: normalizeCursorDecimalId(value.commentIdAtUpdatedAt),
    etag: value.etag,
  });
}

function positionFromCandidate(candidate: GithubIssueCommentCursorCandidateV1): GithubIssueCommentPosition {
  return {
    updatedAtMs: parseGithubTimestamp(candidate.updatedAtIso),
    commentId: normalizeGithubCommentId(candidate.commentId),
  };
}

/**
 * GitHub's `since` filter is second-granular while the checkpoint's immutable
 * comment ID resolves ordering inside that second. Re-reading one preceding
 * second makes a page boundary replay-safe without treating ETag as identity.
 */
export function createGithubIssueCommentSince(cursor: GithubIssueCommentCursorV1): string {
  const timestamp = positionFromCursor(cursor).updatedAtMs - 1_000;
  if (timestamp < 0) throw new RangeError('GitHub comment cursor cannot precede the Unix epoch');
  return canonicalIsoTimestamp(timestamp).replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * Classifies one provider page in the checkpoint's total `(updated_at, id)`
 * order. Both ordinary comments and terminal edit dispositions advance the
 * same cursor, so a replay cannot turn an edit into a second input.
 */
export function classifyGithubIssueCommentPage(input: Readonly<{
  cursor: GithubIssueCommentCursorV1;
  comments: readonly GithubIssueCommentCursorCandidateV1[];
  /** A bounded provider batch must leave the next terminal item unseen. */
  maxTerminalItems?: number;
}>): GithubIssueCommentPageClassificationV1 {
  if (input.maxTerminalItems !== undefined
    && (!Number.isSafeInteger(input.maxTerminalItems) || input.maxTerminalItems < 1)) {
    throw new RangeError('GitHub issue-comment batches require a positive safe terminal-item limit');
  }
  let cursor = input.cursor;
  let cursorPosition = positionFromCursor(cursor);
  const candidates = input.comments
    .map((candidate) => ({ candidate, position: positionFromCandidate(candidate) }))
    .sort((left, right) => comparePositions(left.position, right.position));
  const classifications: GithubIssueCommentCursorClassificationV1[] = [];
  let terminalItems = 0;

  for (const { candidate, position } of candidates) {
    if (comparePositions(position, cursorPosition) <= 0) {
      classifications.push({ kind: 'alreadyClassified', commentId: candidate.commentId });
      continue;
    }

    const isEdit = candidate.action === 'edited' || candidate.createdAtIso !== candidate.updatedAtIso;
    if (input.maxTerminalItems !== undefined && terminalItems >= input.maxTerminalItems) {
      break;
    }
    classifications.push({
      kind: isEdit ? 'unsupportedEdit' : 'admit',
      commentId: candidate.commentId,
    });
    terminalItems += 1;
    cursor = {
      v: 1,
      updatedAtIso: canonicalIsoTimestamp(position.updatedAtMs),
      commentIdAtUpdatedAt: position.commentId,
      etag: cursor.etag,
    };
    cursorPosition = position;
  }

  return Object.freeze({
    classifications: Object.freeze(classifications),
    cursor: Object.freeze(cursor),
  });
}
