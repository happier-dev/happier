/**
 * The GitLab detail boundary projector.
 *
 * Everything a detail read may hand to an Action result or a mounted panel is
 * built here and nowhere else. It runs immediately after the raw body is decoded
 * and before any state exists, which is what makes it a boundary rather than a
 * filter: a provider field that is not copied here cannot be reached later by a
 * panel that decides it wants it.
 *
 * Three refusals are deliberate:
 *
 * - **a diff body never crosses this boundary.** A changed-file row publishes
 *   the file's identity, its change counts, and GitLab's own truncation
 *   evidence. The rich diff body is held at the 03b catalog under `B6`, and
 *   shipping diff bytes to a surface with no renderer for them would pay the
 *   cost of a feature that does not exist yet;
 * - **an absent provider field is never projected as `false`.** GitLab added the
 *   per-file `collapsed` and `too_large` fields in 18.4. A response that omits
 *   them said nothing about truncation, and saying "not truncated" on its behalf
 *   is how a reviewer approves a diff they believe is whole;
 * - **an actor is a username, never an email address or an account id.**
 *
 * Every single-line value goes through the published normalizer, so the
 * collapse-then-bound rule keeps one owner across the product. A note body is
 * the one exception and it is narrow: its line structure IS its content, so it
 * is stripped of the control characters that are not line structure and then cut
 * on a whole code point by the same published truncator.
 */

import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  truncateTriageUtf8V1,
} from '@happier-dev/triage-protocol/v1';

import type { GitlabActivityEventSourceV1 } from './routes.js';

/** The published bounds one GitLab detail projection is measured against. */
export type GitlabDetailBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  labelUtf8Bytes: number;
  textUtf8Bytes: number;
  locationUtf8Bytes: number;
  /** A changed-file path; longer than display text because a path is identity. */
  pathUtf8Bytes: number;
  /** One note body, which is document content rather than a row label. */
  noteBodyUtf8Bytes: number;
}>;

export const GITLAB_DETAIL_BOUNDS_V1: GitlabDetailBoundsV1 = Object.freeze({
  identifierUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  labelUtf8Bytes: 128,
  textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  locationUtf8Bytes: MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  pathUtf8Bytes: 512,
  noteBodyUtf8Bytes: 8_192,
});

/** The largest number of rows any one GitLab detail page publishes. */
export const GITLAB_MAX_DETAIL_ROWS_V1 = 100;
/**
 * Notes published for one discussion.
 *
 * The reader's reply window is four, but the whole returned `notes[]` is
 * published so `Show 4 earlier replies` stays a client-local window over data
 * the panel already holds rather than an invented nested HTTP cursor.
 */
export const GITLAB_MAX_DISCUSSION_NOTES_V1 = 40;
/** Approvers published for one merge request. */
export const GITLAB_MAX_APPROVERS_V1 = 40;
/** Approval rules published for one merge request. */
export const GITLAB_MAX_APPROVAL_RULES_V1 = 30;

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

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A GitLab native id. Numeric on most collections; a discussion id is a hex
 * string, so both spellings are accepted and neither is invented.
 */
function readNativeId(value: unknown, maxUtf8Bytes: number): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate === '' || /[^\x21-\x7E]/u.test(candidate)) return null;
  return new TextEncoder().encode(candidate).length <= maxUtf8Bytes ? candidate : null;
}

function bounded(value: string, maxUtf8Bytes: number): Readonly<{
  value: string;
  truncated: boolean;
}> {
  return projectTriageDisplayTextV1(value, maxUtf8Bytes);
}

function boundedOrNull(
  value: unknown,
  maxUtf8Bytes: number,
): Readonly<{ value: string; truncated: boolean }> | null {
  const raw = readString(value);
  if (raw === null) return null;
  const projected = bounded(raw, maxUtf8Bytes);
  return projected.value === '' ? null : projected;
}

/**
 * A location is never truncated into a shorter destination: an over-bound URL is
 * omitted so the row keeps its identity instead of pointing somewhere else.
 */
function boundedWebUrl(value: unknown, bounds: GitlabDetailBoundsV1): string | null {
  const raw = readString(value);
  if (raw === null || !/^https?:\/\//iu.test(raw.trim())) return null;
  const absolute = raw.trim();
  return new TextEncoder().encode(absolute).length <= bounds.locationUtf8Bytes ? absolute : null;
}

/** The username half of a GitLab actor object. */
function readActor(
  value: unknown,
  bounds: GitlabDetailBoundsV1,
): Readonly<{ value: string; truncated: boolean }> | null {
  if (!isRecord(value)) return null;
  return boundedOrNull(value.username, bounds.labelUtf8Bytes);
}

/* ----------------------------------------------------------------- note body */

/** C0 controls that are not line structure, plus `U+007F`. */
const NON_STRUCTURAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;
const CARRIAGE_RETURNS = /\r\n?/gu;
const EXCESSIVE_BLANK_LINES = /\n{3,}/gu;

function projectNoteBody(
  value: unknown,
  bounds: GitlabDetailBoundsV1,
): Readonly<{ value: string; truncated: boolean }> {
  if (typeof value !== 'string') return { value: '', truncated: false };
  const normalized = value
    .replace(CARRIAGE_RETURNS, '\n')
    .replace(NON_STRUCTURAL_CONTROLS, '')
    .replace(EXCESSIVE_BLANK_LINES, '\n\n')
    .trim();
  return truncateTriageUtf8V1(normalized, bounds.noteBodyUtf8Bytes);
}

/* --------------------------------------------------------------- page result */

export type GitlabPageProjectionV1<TRow> = Readonly<{
  rows: readonly TRow[];
  /** Provider items in this page this projection could not identify. */
  omittedRowCount: number;
  /** True when at least one published value was shortened to fit its bound. */
  projectionTruncated: boolean;
}>;

function projectRows<TRow>(
  body: unknown,
  maxRows: number,
  projectOne: (row: JsonRecord) => Readonly<{ row: TRow; truncated: boolean }> | null,
): GitlabPageProjectionV1<TRow> {
  if (!Array.isArray(body)) {
    return Object.freeze({ rows: Object.freeze([]), omittedRowCount: 0, projectionTruncated: false });
  }
  const rows: TRow[] = [];
  let omitted = 0;
  let truncated = false;
  for (const candidate of body) {
    if (rows.length >= maxRows) {
      omitted += 1;
      continue;
    }
    if (!isRecord(candidate)) {
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

/* --------------------------------------------------------------------- notes */

export type GitlabProjectedNoteRowV1 = Readonly<{
  id: string;
  author?: string;
  body: string;
  atMs?: number;
  editedAtMs?: number;
  /**
   * GitLab's own `system` flag. A system note is an activity record GitLab
   * happens to serve through the notes collection; keeping the flag lets the
   * reader separate a person's comment from a state change instead of rendering
   * "added label bug" as somebody's remark.
   */
  system: boolean;
  resolved?: boolean;
  truncated?: true;
}>;

export function projectGitlabNoteRows(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_ROWS_V1,
): GitlabPageProjectionV1<GitlabProjectedNoteRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    const author = readActor(raw.author, bounds);
    const noteBody = projectNoteBody(raw.body, bounds);
    const atMs = readTimestampMs(raw.created_at);
    const updatedAtMs = readTimestampMs(raw.updated_at);
    const truncated = noteBody.truncated || (author?.truncated ?? false);
    return {
      row: Object.freeze({
        id,
        ...(author === null ? {} : { author: author.value }),
        body: noteBody.value,
        ...(atMs === null ? {} : { atMs }),
        // An edit is only an edit when GitLab reports a different instant.
        ...(updatedAtMs === null || updatedAtMs === atMs ? {} : { editedAtMs: updatedAtMs }),
        system: raw.system === true,
        ...(typeof raw.resolved === 'boolean' ? { resolved: raw.resolved } : {}),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* ------------------------------------------------------------ resource events */

export type GitlabProjectedActivityEventRowV1 = Readonly<{
  id: string;
  source: GitlabActivityEventSourceV1;
  /** GitLab's own word for what happened: `opened`, `add`, `remove`, … */
  action: string;
  atMs?: number;
  actor?: string;
  /** The label name or milestone title the action applied to. */
  subject?: string;
  truncated?: true;
}>;

/**
 * One page of one event source.
 *
 * The three sources are projected by one function because their row shape is the
 * same three facts; they are never merged into one cursor, which is the
 * divergence that actually matters.
 */
export function projectGitlabActivityEventRows(
  body: unknown,
  source: GitlabActivityEventSourceV1,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_ROWS_V1,
): GitlabPageProjectionV1<GitlabProjectedActivityEventRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    // `state` events name the transition in `state`; label and milestone events
    // name it in `action`. Neither is invented for the other.
    const action = boundedOrNull(raw.state ?? raw.action, bounds.labelUtf8Bytes);
    if (action === null) return null;
    const actor = readActor(raw.user, bounds);
    const subject = source === 'label'
      ? boundedOrNull(isRecord(raw.label) ? raw.label.name : null, bounds.labelUtf8Bytes)
      : source === 'milestone'
        ? boundedOrNull(isRecord(raw.milestone) ? raw.milestone.title : null, bounds.labelUtf8Bytes)
        : null;
    const atMs = readTimestampMs(raw.created_at);
    const truncated = action.truncated
      || (actor?.truncated ?? false)
      || (subject?.truncated ?? false);
    return {
      row: Object.freeze({
        id,
        source,
        action: action.value,
        ...(atMs === null ? {} : { atMs }),
        ...(actor === null ? {} : { actor: actor.value }),
        ...(subject === null ? {} : { subject: subject.value }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* --------------------------------------------------------------- discussions */

export type GitlabProjectedDiscussionRowV1 = Readonly<{
  id: string;
  /** GitLab's own flag: an individual note is not a resolvable thread. */
  individualNote: boolean;
  notes: readonly GitlabProjectedNoteRowV1[];
  /** Notes this discussion returned that did not fit the published bound. */
  omittedNoteCount: number;
  truncated?: true;
}>;

export function projectGitlabDiscussionRows(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_ROWS_V1,
): GitlabPageProjectionV1<GitlabProjectedDiscussionRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    const notes = projectGitlabNoteRows(raw.notes, bounds, GITLAB_MAX_DISCUSSION_NOTES_V1);
    const truncated = notes.projectionTruncated;
    return {
      row: Object.freeze({
        id,
        individualNote: raw.individual_note === true,
        notes: notes.rows,
        omittedNoteCount: notes.omittedRowCount,
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* ----------------------------------------------------------------- approvals */

export type GitlabProjectedApprovalStateV1 = Readonly<{
  approvalsRequired?: number;
  approvalsLeft?: number;
  approvedBy: readonly string[];
  userHasApproved?: boolean;
  /**
   * GitLab's own answer to whether THIS account may approve. It is a provider
   * fact, not an edition guess: approve is available on every tier, so the verb
   * is never hidden behind a licence check.
   */
  userCanApprove?: boolean;
}>;

export function projectGitlabApprovalState(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
): GitlabProjectedApprovalStateV1 | null {
  if (!isRecord(body)) return null;
  const approvedBy: string[] = [];
  if (Array.isArray(body.approved_by)) {
    for (const candidate of body.approved_by) {
      if (approvedBy.length >= GITLAB_MAX_APPROVERS_V1) break;
      // GitLab nests the user under `user`; a flat actor is accepted too rather
      // than dropping an approver over an envelope difference.
      const actor = isRecord(candidate)
        ? readActor(candidate.user, bounds) ?? readActor(candidate, bounds)
        : null;
      if (actor !== null) approvedBy.push(actor.value);
    }
  }
  const approvalsRequired = readCount(body.approvals_required);
  const approvalsLeft = readCount(body.approvals_left);
  return Object.freeze({
    ...(approvalsRequired === null ? {} : { approvalsRequired }),
    ...(approvalsLeft === null ? {} : { approvalsLeft }),
    approvedBy: Object.freeze(approvedBy),
    ...(typeof body.user_has_approved === 'boolean'
      ? { userHasApproved: body.user_has_approved }
      : {}),
    ...(typeof body.user_can_approve === 'boolean'
      ? { userCanApprove: body.user_can_approve }
      : {}),
  });
}

export type GitlabProjectedApprovalRuleV1 = Readonly<{
  id: string;
  name: string;
  approvalsRequired?: number;
  approved?: boolean;
  truncated?: true;
}>;

export function projectGitlabApprovalRules(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
): GitlabPageProjectionV1<GitlabProjectedApprovalRuleV1> {
  return projectRows(body, GITLAB_MAX_APPROVAL_RULES_V1, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    const name = boundedOrNull(raw.name, bounds.labelUtf8Bytes);
    if (id === null || name === null) return null;
    const approvalsRequired = readCount(raw.approvals_required);
    return {
      row: Object.freeze({
        id,
        name: name.value,
        ...(approvalsRequired === null ? {} : { approvalsRequired }),
        ...(typeof raw.approved === 'boolean' ? { approved: raw.approved } : {}),
        ...(name.truncated ? { truncated: true as const } : {}),
      }),
      truncated: name.truncated,
    };
  });
}

/* ----------------------------------------------------------------- pipelines */

export type GitlabProjectedPipelineRowV1 = Readonly<{
  id: string;
  status: string;
  ref?: string;
  sha?: string;
  source?: string;
  webUrl?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  truncated?: true;
}>;

export function projectGitlabPipelineRows(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_ROWS_V1,
): GitlabPageProjectionV1<GitlabProjectedPipelineRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    const status = boundedOrNull(raw.status, bounds.labelUtf8Bytes);
    if (id === null || status === null) return null;
    const ref = boundedOrNull(raw.ref, bounds.labelUtf8Bytes);
    const sha = boundedOrNull(raw.sha, bounds.identifierUtf8Bytes);
    const source = boundedOrNull(raw.source, bounds.labelUtf8Bytes);
    const webUrl = boundedWebUrl(raw.web_url, bounds);
    const createdAtMs = readTimestampMs(raw.created_at);
    const updatedAtMs = readTimestampMs(raw.updated_at);
    const truncated = status.truncated
      || (ref?.truncated ?? false)
      || (sha?.truncated ?? false)
      || (source?.truncated ?? false);
    return {
      row: Object.freeze({
        id,
        status: status.value,
        ...(ref === null ? {} : { ref: ref.value }),
        ...(sha === null ? {} : { sha: sha.value }),
        ...(source === null ? {} : { source: source.value }),
        ...(webUrl === null ? {} : { webUrl }),
        ...(createdAtMs === null ? {} : { createdAtMs }),
        ...(updatedAtMs === null ? {} : { updatedAtMs }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/** The per-job rollup of one pipeline, or the honest absence of one. */
export type GitlabPipelineRollupV1 = Readonly<{
  failingCount: number;
  runningCount: number;
  passingCount: number;
}>;

const RUNNING_JOB_STATUSES = new Set(['created', 'pending', 'running', 'waiting_for_resource']);
const FAILING_JOB_STATUSES = new Set(['failed']);
const PASSING_JOB_STATUSES = new Set(['success']);

/**
 * Rolls one pipeline's jobs up into three counts, or returns `null`.
 *
 * `null` and `{0, 0, 0}` are different answers and are never conflated. A
 * rendered `0 failing` over a job list nobody could read is a fabricated fact,
 * and it is the fabrication that makes a reviewer trust a red pipeline.
 */
export function projectGitlabPipelineRollup(body: unknown): GitlabPipelineRollupV1 | null {
  if (!Array.isArray(body)) return null;
  let failingCount = 0;
  let runningCount = 0;
  let passingCount = 0;
  for (const candidate of body) {
    if (!isRecord(candidate)) return null;
    const status = readString(candidate.status);
    if (status === null) return null;
    const normalized = status.trim();
    if (FAILING_JOB_STATUSES.has(normalized)) failingCount += 1;
    else if (RUNNING_JOB_STATUSES.has(normalized)) runningCount += 1;
    else if (PASSING_JOB_STATUSES.has(normalized)) passingCount += 1;
    // `canceled`, `skipped`, `manual` are neither failing, running nor passing,
    // and are deliberately counted in none of the three.
  }
  return Object.freeze({ failingCount, runningCount, passingCount });
}

/* ------------------------------------------------------------- changed files */

export type GitlabProjectedChangedFileRowV1 = Readonly<{
  path: string;
  previousPath?: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  /**
   * GitLab excluded this file's diff but says it can be fetched on request.
   * Present ONLY when GitLab supplied the field: absent means the deployment
   * said nothing, which is not the same as `false`.
   */
  collapsed?: boolean;
  /** GitLab excluded this file's diff and says it cannot be retrieved. */
  tooLarge?: boolean;
  truncated?: true;
}>;

/**
 * Whether this response carried GitLab's per-file truncation evidence at all.
 *
 * `reported` means every projected file carried both 18.4 fields. `unknown`
 * means at least one did not, and the reader labels the tab accordingly rather
 * than claiming a complete diff.
 */
export type GitlabDiffLimitStatusV1 = 'reported' | 'unknown';

export type GitlabChangedFilesProjectionV1 =
  GitlabPageProjectionV1<GitlabProjectedChangedFileRowV1> & Readonly<{
    diffLimitStatus: GitlabDiffLimitStatusV1;
  }>;

export function projectGitlabChangedFileRows(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_ROWS_V1,
): GitlabChangedFilesProjectionV1 {
  let everyRowReported = true;
  const projected = projectRows<GitlabProjectedChangedFileRowV1>(body, maxRows, (raw) => {
    const path = boundedOrNull(raw.new_path ?? raw.old_path, bounds.pathUtf8Bytes);
    if (path === null) return null;
    const previousPath = raw.old_path === raw.new_path
      ? null
      : boundedOrNull(raw.old_path, bounds.pathUtf8Bytes);
    // Read as booleans ONLY when GitLab supplied booleans. `?? false` here is
    // exactly the defect this projector exists to prevent.
    const collapsed = typeof raw.collapsed === 'boolean' ? raw.collapsed : null;
    const tooLarge = typeof raw.too_large === 'boolean' ? raw.too_large : null;
    if (collapsed === null || tooLarge === null) everyRowReported = false;
    const truncated = path.truncated || (previousPath?.truncated ?? false);
    return {
      row: Object.freeze({
        path: path.value,
        ...(previousPath === null ? {} : { previousPath: previousPath.value }),
        newFile: raw.new_file === true,
        renamedFile: raw.renamed_file === true,
        deletedFile: raw.deleted_file === true,
        ...(collapsed === null ? {} : { collapsed }),
        ...(tooLarge === null ? {} : { tooLarge }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
  return Object.freeze({
    ...projected,
    // An empty page carried no evidence either way, and `unknown` is the honest
    // value for "nothing said".
    diffLimitStatus: projected.rows.length > 0 && everyRowReported
      ? ('reported' as const)
      : ('unknown' as const),
  });
}
