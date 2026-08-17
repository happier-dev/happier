import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  truncateTriageUtf8V1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The Azure DevOps detail boundary projector.
 *
 * Everything a detail read may hand to an Action result or a mounted panel is
 * built here and nowhere else. It runs immediately after the body is decoded and
 * before any state exists, so a provider field that is not copied here cannot be
 * reached later by a panel that decides it wants it.
 *
 * Four refusals are deliberate:
 *
 * - **a status is informational until a policy evaluation proves otherwise.**
 *   Blocking comes only from a returned evaluation's `configuration.isBlocking`,
 *   never from a status's display text or state;
 * - **a build validation is recognized only by its documented configuration type
 *   id.** Matching on a display name would silently reclassify a customer policy
 *   somebody happened to call "Build";
 * - **a missing start or completion time renders as unknown, never as a zero
 *   duration.** "It took no time" and "we do not know when it ran" are different
 *   claims, and only one of them is true;
 * - **iteration `0` is never a path id.** It is the documented `compareTo`
 *   baseline, and asking for it as a resource asks for something that does not
 *   exist.
 */

export type AzureDetailBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  labelUtf8Bytes: number;
  textUtf8Bytes: number;
  locationUtf8Bytes: number;
  pathUtf8Bytes: number;
  /** One comment body, which is document content rather than a row label. */
  commentBodyUtf8Bytes: number;
}>;

export const AZURE_DETAIL_BOUNDS_V1: AzureDetailBoundsV1 = Object.freeze({
  identifierUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  labelUtf8Bytes: 128,
  textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  locationUtf8Bytes: MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  pathUtf8Bytes: 512,
  commentBodyUtf8Bytes: 8_192,
});

/** The largest number of rows any one Azure detail page publishes. */
export const AZURE_MAX_DETAIL_ROWS_V1 = 100;
/** Threads one read publishes; the documented endpoint returns all of them at once. */
export const AZURE_MAX_THREAD_ROWS_V1 = 200;
/** Comments published inside one thread. */
export const AZURE_MAX_THREAD_COMMENTS_V1 = 60;
/** Iterations published by the one shared iteration read. */
export const AZURE_MAX_ITERATION_ROWS_V1 = 100;

/**
 * The documented configuration type of Azure's own build-validation policy.
 *
 * It is the ONLY evidence that classifies an evaluation as a build validation.
 * Display text is customer-authored and would reclassify any policy named
 * "Build" as one.
 */
export const AZURE_BUILD_VALIDATION_POLICY_TYPE_ID_V1 =
  '0609b952-1397-4640-95ec-e00a01b2c241';

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bounded(
  value: unknown,
  maxUtf8Bytes: number,
): Readonly<{ value: string; truncated: boolean }> | null {
  const raw = readString(value);
  if (raw === null) return null;
  const projected = projectTriageDisplayTextV1(raw, maxUtf8Bytes);
  return projected.value === '' ? null : projected;
}

function boundedWebUrl(value: unknown, bounds: AzureDetailBoundsV1): string | null {
  const raw = readString(value);
  if (raw === null || !/^https?:\/\//iu.test(raw.trim())) return null;
  const absolute = raw.trim();
  return new TextEncoder().encode(absolute).length <= bounds.locationUtf8Bytes ? absolute : null;
}

/** Azure nests an identity as `{ id, displayName, uniqueName }`. */
function readIdentityName(
  value: unknown,
  bounds: AzureDetailBoundsV1,
): Readonly<{ value: string; truncated: boolean }> | null {
  if (!isRecord(value)) return null;
  return bounded(value.displayName, bounds.labelUtf8Bytes);
}

/** C0 controls that are not line structure, plus `U+007F`. */
const NON_STRUCTURAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;
const CARRIAGE_RETURNS = /\r\n?/gu;
const EXCESSIVE_BLANK_LINES = /\n{3,}/gu;

function projectCommentBody(
  value: unknown,
  bounds: AzureDetailBoundsV1,
): Readonly<{ value: string; truncated: boolean }> {
  if (typeof value !== 'string') return { value: '', truncated: false };
  const normalized = value
    .replace(CARRIAGE_RETURNS, '\n')
    .replace(NON_STRUCTURAL_CONTROLS, '')
    .replace(EXCESSIVE_BLANK_LINES, '\n\n')
    .trim();
  return truncateTriageUtf8V1(normalized, bounds.commentBodyUtf8Bytes);
}

export type AzurePageProjectionV1<TRow> = Readonly<{
  rows: readonly TRow[];
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

function projectRows<TRow>(
  body: unknown,
  maxRows: number,
  projectOne: (row: JsonRecord) => Readonly<{ row: TRow; truncated: boolean }> | null,
): AzurePageProjectionV1<TRow> {
  // Azure wraps every collection as `{ count, value: [...] }`.
  const values = isRecord(body) && Array.isArray(body.value)
    ? body.value
    : Array.isArray(body) ? body : [];
  const rows: TRow[] = [];
  let omitted = 0;
  let truncated = false;
  for (const candidate of values) {
    if (rows.length >= maxRows || !isRecord(candidate)) {
      omitted += 1;
      continue;
    }
    const projected = projectOne(candidate);
    if (projected === null) {
      omitted += 1;
      continue;
    }
    rows.push(projected.row);
    truncated = truncated || projected.truncated;
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    omittedRowCount: omitted,
    projectionTruncated: truncated,
  });
}

/* ---------------------------------------------------------------- iterations */

export type AzureProjectedIterationRowV1 = Readonly<{
  /** The real 1-based iteration id. */
  id: number;
  description?: string;
  createdAtMs?: number;
  author?: string;
  /** Azure's own reason for this iteration, when it supplied one. */
  reason?: string;
  truncated?: true;
}>;

export function projectAzureIterationRows(
  body: unknown,
  bounds: AzureDetailBoundsV1,
): AzurePageProjectionV1<AzureProjectedIterationRowV1> {
  return projectRows(body, AZURE_MAX_ITERATION_ROWS_V1, (raw) => {
    // A 1-based real iteration only. `0` is the comparison baseline, and a row
    // claiming it would let a caller path-address a resource that does not exist.
    const id = readPositiveInteger(raw.id);
    if (id === null) return null;
    const description = bounded(raw.description, bounds.textUtf8Bytes);
    const author = readIdentityName(raw.author, bounds);
    const reason = bounded(raw.reason, bounds.labelUtf8Bytes);
    const createdAtMs = readTimestampMs(raw.createdDate);
    const truncated = (description?.truncated ?? false)
      || (author?.truncated ?? false)
      || (reason?.truncated ?? false);
    return {
      row: Object.freeze({
        id,
        ...(description === null ? {} : { description: description.value }),
        ...(createdAtMs === null ? {} : { createdAtMs }),
        ...(author === null ? {} : { author: author.value }),
        ...(reason === null ? {} : { reason: reason.value }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* ------------------------------------------------------------------- commits */

export type AzureProjectedCommitRowV1 = Readonly<{
  commitId: string;
  comment: string;
  author?: string;
  authoredAtMs?: number;
  url?: string;
  truncated?: true;
}>;

export function projectAzureCommitRows(
  body: unknown,
  bounds: AzureDetailBoundsV1,
  maxRows: number = AZURE_MAX_DETAIL_ROWS_V1,
): AzurePageProjectionV1<AzureProjectedCommitRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const commitId = bounded(raw.commitId, bounds.identifierUtf8Bytes);
    if (commitId === null) return null;
    const comment = bounded(raw.comment, bounds.textUtf8Bytes);
    const author = isRecord(raw.author) ? bounded(raw.author.name, bounds.labelUtf8Bytes) : null;
    const authoredAtMs = isRecord(raw.author) ? readTimestampMs(raw.author.date) : null;
    const url = boundedWebUrl(raw.remoteUrl ?? raw.url, bounds);
    const truncated = commitId.truncated
      || (comment?.truncated ?? false)
      || (author?.truncated ?? false);
    return {
      row: Object.freeze({
        commitId: commitId.value,
        comment: comment?.value ?? '',
        ...(author === null ? {} : { author: author.value }),
        ...(authoredAtMs === null ? {} : { authoredAtMs }),
        ...(url === null ? {} : { url }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* --------------------------------------------------------- iteration changes */

export type AzureProjectedChangedFileRowV1 = Readonly<{
  path: string;
  /** Azure's own change type: `add`, `edit`, `delete`, `rename`, … */
  changeType: string;
  /** Azure's own object id for the item, when it supplied one. */
  objectId?: string;
  isFolder: boolean;
  truncated?: true;
}>;

/**
 * The provider-issued position of the next changes page.
 *
 * Azure returns `nextSkip` and `nextTop` in the response, and the walk continues
 * **only** while one of them is non-zero. A self-incremented `$skip` is how a
 * caller silently re-reads or skips files, so this source never computes one.
 */
export type AzureChangesPositionV1 = Readonly<{
  nextSkip: number;
  nextTop: number;
}>;

export type AzureChangesProjectionV1 =
  AzurePageProjectionV1<AzureProjectedChangedFileRowV1> & Readonly<{
    next: AzureChangesPositionV1 | null;
  }>;

export function projectAzureIterationChanges(
  body: unknown,
  bounds: AzureDetailBoundsV1,
  maxRows: number = AZURE_MAX_DETAIL_ROWS_V1,
): AzureChangesProjectionV1 {
  const changes = isRecord(body) && Array.isArray(body.changeEntries)
    ? { value: body.changeEntries }
    : body;
  const projected = projectRows<AzureProjectedChangedFileRowV1>(changes, maxRows, (raw) => {
    const item = isRecord(raw.item) ? raw.item : {};
    const path = bounded(item.path, bounds.pathUtf8Bytes);
    const changeType = bounded(raw.changeType, bounds.labelUtf8Bytes);
    if (path === null || changeType === null) return null;
    const objectId = bounded(item.objectId, bounds.identifierUtf8Bytes);
    const truncated = path.truncated || changeType.truncated;
    return {
      row: Object.freeze({
        path: path.value,
        changeType: changeType.value,
        ...(objectId === null ? {} : { objectId: objectId.value }),
        isFolder: item.isFolder === true,
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });

  const nextSkip = isRecord(body) ? readNonNegativeInteger(body.nextSkip) : null;
  const nextTop = isRecord(body) ? readNonNegativeInteger(body.nextTop) : null;
  // The walk continues only while the provider says there is more. Two zeroes,
  // or an absent pair, end it — this source never invents the next offset.
  const hasMore = (nextSkip ?? 0) > 0 || (nextTop ?? 0) > 0;
  return Object.freeze({
    ...projected,
    next: hasMore
      ? Object.freeze({ nextSkip: nextSkip ?? 0, nextTop: nextTop ?? 0 })
      : null,
  });
}

/* ------------------------------------------------------------------ policies */

export type AzureProjectedStatusRowV1 = Readonly<{
  id: string;
  state: string;
  description?: string;
  contextName?: string;
  targetUrl?: string;
  createdAtMs?: number;
  truncated?: true;
}>;

export function projectAzureStatusRows(
  body: unknown,
  bounds: AzureDetailBoundsV1,
): AzurePageProjectionV1<AzureProjectedStatusRowV1> {
  return projectRows(body, AZURE_MAX_DETAIL_ROWS_V1, (raw) => {
    const id = readPositiveInteger(raw.id);
    const state = bounded(raw.state, bounds.labelUtf8Bytes);
    if (id === null || state === null) return null;
    const description = bounded(raw.description, bounds.textUtf8Bytes);
    const context = isRecord(raw.context)
      ? bounded(
        [readString(raw.context.genre), readString(raw.context.name)]
          .filter((part): part is string => part !== null)
          .join('/'),
        bounds.labelUtf8Bytes,
      )
      : null;
    const targetUrl = boundedWebUrl(raw.targetUrl, bounds);
    const createdAtMs = readTimestampMs(raw.creationDate);
    const truncated = state.truncated
      || (description?.truncated ?? false)
      || (context?.truncated ?? false);
    return {
      row: Object.freeze({
        id: String(id),
        state: state.value,
        ...(description === null ? {} : { description: description.value }),
        ...(context === null ? {} : { contextName: context.value }),
        ...(targetUrl === null ? {} : { targetUrl }),
        ...(createdAtMs === null ? {} : { createdAtMs }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

export type AzureProjectedPolicyEvaluationRowV1 = Readonly<{
  evaluationId: string;
  status: string;
  displayName?: string;
  /**
   * Enforcement comes from `configuration.isBlocking` and nowhere else. A status
   * is informational until a returned evaluation says otherwise.
   */
  isBlocking: boolean;
  /** True only when the documented build-validation configuration type matched. */
  isBuildValidation: boolean;
  startedAtMs?: number;
  completedAtMs?: number;
  truncated?: true;
}>;

export function projectAzurePolicyEvaluationRows(
  body: unknown,
  bounds: AzureDetailBoundsV1,
): AzurePageProjectionV1<AzureProjectedPolicyEvaluationRowV1> {
  return projectRows(body, AZURE_MAX_DETAIL_ROWS_V1, (raw) => {
    const evaluationId = bounded(raw.evaluationId, bounds.identifierUtf8Bytes);
    const status = bounded(raw.status, bounds.labelUtf8Bytes);
    if (evaluationId === null || status === null) return null;
    const configuration = isRecord(raw.configuration) ? raw.configuration : {};
    const type = isRecord(configuration.type) ? configuration.type : {};
    const displayName = bounded(type.displayName, bounds.labelUtf8Bytes);
    const startedAtMs = readTimestampMs(raw.startedDate);
    const completedAtMs = readTimestampMs(raw.completedDate);
    const truncated = evaluationId.truncated
      || status.truncated
      || (displayName?.truncated ?? false);
    return {
      row: Object.freeze({
        evaluationId: evaluationId.value,
        status: status.value,
        ...(displayName === null ? {} : { displayName: displayName.value }),
        isBlocking: configuration.isBlocking === true,
        // The documented type id, compared case-insensitively because Azure
        // returns GUIDs in either case. Display text is never consulted.
        isBuildValidation:
          (readString(type.id) ?? '').trim().toLowerCase()
            === AZURE_BUILD_VALIDATION_POLICY_TYPE_ID_V1,
        // Absent stays absent: a missing time is unknown, never a zero duration.
        ...(startedAtMs === null ? {} : { startedAtMs }),
        ...(completedAtMs === null ? {} : { completedAtMs }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* ------------------------------------------------------------------- threads */

export type AzureProjectedThreadCommentV1 = Readonly<{
  id: string;
  author?: string;
  content: string;
  publishedAtMs?: number;
  /** Azure's own comment type: `text`, `codeChange`, `system`. */
  commentType?: string;
  truncated?: true;
}>;

export type AzureProjectedThreadRowV1 = Readonly<{
  id: string;
  status?: string;
  /**
   * The file and line this thread is anchored to.
   *
   * A thread WITHOUT a `threadContext` is an unanchored remark, and it stays in
   * the result: dropping it hides review conversation that has nothing wrong
   * with it beyond not naming a file.
   */
  path?: string;
  rightFileStartLine?: number;
  comments: readonly AzureProjectedThreadCommentV1[];
  omittedCommentCount: number;
  truncated?: true;
}>;

export function projectAzureThreadRows(
  body: unknown,
  bounds: AzureDetailBoundsV1,
): AzurePageProjectionV1<AzureProjectedThreadRowV1> {
  return projectRows(body, AZURE_MAX_THREAD_ROWS_V1, (raw) => {
    const id = readPositiveInteger(raw.id);
    if (id === null) return null;
    const status = bounded(raw.status, bounds.labelUtf8Bytes);
    const context = isRecord(raw.threadContext) ? raw.threadContext : null;
    const path = context === null ? null : bounded(context.filePath, bounds.pathUtf8Bytes);
    const rightStart = context !== null && isRecord(context.rightFileStart)
      ? readPositiveInteger(context.rightFileStart.line)
      : null;

    const comments = projectRows<AzureProjectedThreadCommentV1>(
      { value: raw.comments },
      AZURE_MAX_THREAD_COMMENTS_V1,
      (comment) => {
        const commentId = readPositiveInteger(comment.id);
        if (commentId === null) return null;
        const author = readIdentityName(comment.author, bounds);
        const content = projectCommentBody(comment.content, bounds);
        const commentType = bounded(comment.commentType, bounds.labelUtf8Bytes);
        const commentTruncated = content.truncated || (author?.truncated ?? false);
        return {
          row: Object.freeze({
            id: String(commentId),
            ...(author === null ? {} : { author: author.value }),
            content: content.value,
            ...(readTimestampMs(comment.publishedDate) === null
              ? {}
              : { publishedAtMs: readTimestampMs(comment.publishedDate) as number }),
            ...(commentType === null ? {} : { commentType: commentType.value }),
            ...(commentTruncated ? { truncated: true as const } : {}),
          }),
          truncated: commentTruncated,
        };
      },
    );

    const truncated = (status?.truncated ?? false)
      || (path?.truncated ?? false)
      || comments.projectionTruncated;
    return {
      row: Object.freeze({
        id: String(id),
        ...(status === null ? {} : { status: status.value }),
        ...(path === null ? {} : { path: path.value }),
        ...(rightStart === null ? {} : { rightFileStartLine: rightStart }),
        comments: comments.rows,
        omittedCommentCount: comments.omittedRowCount,
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}
