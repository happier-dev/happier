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
 * - **display reads carry metadata only.** Explicit comparison reads also
 *   project exact patches and their availability for the shared code reader;
 * - **an absent provider field is never projected as `false`.** GitLab added the
 *   per-file `collapsed` and `too_large` fields in 18.4. A response that omits
 *   them said nothing about truncation, and saying "not truncated" on its behalf
 *   is how a reviewer approves a diff they believe is whole;
 * - **an actor is a username, never an email address or an account id.**
 *
 * Every single-line value goes through the published normalizer. A note body is
 * the one exception and it is narrow: its line structure IS its content, so it
 * is stripped of the control characters that are not line structure. Result
 * fitting belongs to the canonical external-Action envelope owner after the
 * complete result shape exists; this projector invents no per-field byte quota.
 */

import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  normalizeTriageSingleLineV1,
  projectTriageDisplayTextV1,
  type TriagePullRequestStatusV1,
  type TriageRowFactV1,
} from '@happier-dev/triage-protocol/v1';

import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { readGitlabDiscussionResolution } from '../mapping/discussionResolution.js';
import type { GitlabComparisonFileV1, GitlabPatchEvidenceV1 } from './contracts.js';
import type { GitlabDetailPageV1 } from './reads.js';
import {
  GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
  type GitlabActivityEventSourceV1,
} from './routes.js';

/** The published bounds one GitLab detail projection is measured against. */
export type GitlabDetailBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  textUtf8Bytes: number;
  locationUtf8Bytes: number;
}>;

export const GITLAB_DETAIL_BOUNDS_V1: GitlabDetailBoundsV1 = Object.freeze({
  identifierUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  locationUtf8Bytes: MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
});

/**
 * Notes published for one discussion.
 *
 * The reader's reply window is four, but the whole returned `notes[]` is
 * published so `Show 4 earlier replies` stays a client-local window over data
 * the panel already holds rather than an invented nested HTTP cursor.
 */

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

function normalizedOrNull(value: unknown): Readonly<{ value: string; truncated: false }> | null {
  const raw = readString(value);
  if (raw === null) return null;
  const normalized = normalizeTriageSingleLineV1(raw);
  return normalized === '' ? null : { value: normalized, truncated: false };
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
): Readonly<{ value: string; truncated: boolean }> | null {
  if (!isRecord(value)) return null;
  return normalizedOrNull(value.username);
}

/* ----------------------------------------------------------------- note body */

/** C0 controls that are not line structure, plus `U+007F`. */
const NON_STRUCTURAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;
const CARRIAGE_RETURNS = /\r\n?/gu;
const EXCESSIVE_BLANK_LINES = /\n{3,}/gu;

function projectNoteBody(
  value: unknown,
): Readonly<{ value: string; truncated: boolean }> {
  if (typeof value !== 'string') return { value: '', truncated: false };
  const normalized = value
    .replace(CARRIAGE_RETURNS, '\n')
    .replace(NON_STRUCTURAL_CONTROLS, '')
    .replace(EXCESSIVE_BLANK_LINES, '\n\n')
    .trim();
  return { value: normalized, truncated: false };
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
  maxRows: number | null,
  projectOne: (row: JsonRecord) => Readonly<{ row: TRow; truncated: boolean }> | null,
): GitlabPageProjectionV1<TRow> {
  if (!Array.isArray(body)) {
    return Object.freeze({ rows: Object.freeze([]), omittedRowCount: 0, projectionTruncated: false });
  }
  const rows: TRow[] = [];
  let omitted = 0;
  let truncated = false;
  for (const candidate of body) {
    if (maxRows !== null && rows.length >= maxRows) {
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
  maxRows: number | null = GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
): GitlabPageProjectionV1<GitlabProjectedNoteRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    const author = readActor(raw.author);
    const noteBody = projectNoteBody(raw.body);
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
  maxRows: number = GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
): GitlabPageProjectionV1<GitlabProjectedActivityEventRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    // `state` events name the transition in `state`; label and milestone events
    // name it in `action`. Neither is invented for the other.
    const action = normalizedOrNull(raw.state ?? raw.action);
    if (action === null) return null;
    const actor = readActor(raw.user);
    const subject = source === 'label'
      ? normalizedOrNull(isRecord(raw.label) ? raw.label.name : null)
      : source === 'milestone'
        ? normalizedOrNull(isRecord(raw.milestone) ? raw.milestone.title : null)
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
  /**
   * The thread's own resolution, decided by the one provider reader the
   * resolution mutation also uses. A reader that inferred it from whichever note
   * happens to be first would disagree with the write it offers.
   */
  resolved: boolean;
  notes: readonly GitlabProjectedNoteRowV1[];
  /** Notes this discussion returned that did not fit the published bound. */
  omittedNoteCount: number;
  truncated?: true;
}>;

export function projectGitlabDiscussionRows(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
): GitlabPageProjectionV1<GitlabProjectedDiscussionRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    const notes = projectGitlabNoteRows(raw.notes, bounds, null);
    const truncated = notes.projectionTruncated;
    return {
      row: Object.freeze({
        id,
        individualNote: raw.individual_note === true,
        resolved: readGitlabDiscussionResolution(raw.notes).resolved,
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
  /** Provider approver rows that were unreadable at projection. */
  omittedApproverCount: number;
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
  _bounds: GitlabDetailBoundsV1,
): GitlabProjectedApprovalStateV1 | null {
  if (!isRecord(body)) return null;
  const approvedBy: string[] = [];
  let omittedApproverCount = 0;
  if (Array.isArray(body.approved_by)) {
    for (const candidate of body.approved_by) {
      // GitLab nests the user under `user`; a flat actor is accepted too rather
      // than dropping an approver over an envelope difference.
      const actor = isRecord(candidate)
        ? readActor(candidate.user) ?? readActor(candidate)
        : null;
      if (actor !== null) approvedBy.push(actor.value);
      else omittedApproverCount += 1;
    }
  }
  const approvalsRequired = readCount(body.approvals_required);
  const approvalsLeft = readCount(body.approvals_left);
  return Object.freeze({
    ...(approvalsRequired === null ? {} : { approvalsRequired }),
    ...(approvalsLeft === null ? {} : { approvalsLeft }),
    approvedBy: Object.freeze(approvedBy),
    omittedApproverCount,
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
  return projectRows(body, null, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    const name = normalizedOrNull(raw.name);
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
  maxRows: number = GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
): GitlabPageProjectionV1<GitlabProjectedPipelineRowV1> {
  return projectRows(body, maxRows, (raw) => {
    const id = readNativeId(raw.id, bounds.identifierUtf8Bytes);
    const status = normalizedOrNull(raw.status);
    if (id === null || status === null) return null;
    const ref = normalizedOrNull(raw.ref);
    const sha = boundedOrNull(raw.sha, bounds.identifierUtf8Bytes);
    const source = normalizedOrNull(raw.source);
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

const RUNNING_JOB_STATUSES = new Set([
  'created', 'pending', 'running', 'waiting_for_resource', 'preparing',
  'scheduled', 'waiting_for_callback', 'canceling',
]);
const FAILING_JOB_STATUSES = new Set(['failed']);
const PASSING_JOB_STATUSES = new Set(['success']);

type GitlabJobRowV1 = NonNullable<TriagePullRequestStatusV1['checks']>['rows'][number];

function projectGitlabCheckState(status: string | undefined): GitlabJobRowV1['state'] {
  const normalized = status?.trim() ?? '';
  return PASSING_JOB_STATUSES.has(normalized) ? 'passed'
    : FAILING_JOB_STATUSES.has(normalized) ? 'failed'
      : RUNNING_JOB_STATUSES.has(normalized) ? 'pending'
        : normalized === 'canceled' || normalized === 'skipped' || normalized === 'manual' ? 'neutral' : 'unknown';
}

/** A native pipeline status proves its summary, never a count of its jobs. */
export function projectGitlabOpeningChecksFact(
  page: GitlabDetailPageV1<GitlabProjectedPipelineRowV1> | null,
  headSha: string | null,
): TriageRowFactV1 {
  let value: TriageRowFactV1['value'] = { kind: 'status', value: 'Checks unavailable', tone: 'warning' };
  if (page !== null && headSha !== null && page.omittedRowCount === 0) {
    const newest = page.rows[0];
    if (newest === undefined && page.nextUrl === null && page.incomplete === null) {
      value = { kind: 'status', value: 'No pipelines', tone: 'neutral' };
    } else if (newest?.sha === headSha) {
      const state = projectGitlabCheckState(newest.status);
      if (state === 'passed') value = { kind: 'status', value: 'All passing', tone: 'success' };
      else if (state === 'failed') value = { kind: 'status', value: 'Failing', tone: 'danger' };
      else if (state === 'pending') value = { kind: 'status', value: 'Running', tone: 'info' };
    }
  }
  return { id: 'gitlab/checks', importance: 'primary', value };
}

export function projectGitlabPipelineJobs(body: unknown): Readonly<{
  rows: readonly GitlabJobRowV1[];
  incomplete: boolean;
  projectionTruncated: boolean;
}> {
  if (!Array.isArray(body)) return { rows: [], incomplete: true, projectionTruncated: false };
  const rows: GitlabJobRowV1[] = [];
  let incomplete = false;
  let projectionTruncated = false;
  for (const candidate of body) {
    const id = isRecord(candidate) ? readNativeId(candidate.id, MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1) : null;
    const name = isRecord(candidate) ? boundedOrNull(candidate.name, MAX_TRIAGE_TEXT_UTF8_BYTES_V1) : null;
    if (!isRecord(candidate) || id === null || name === null) {
      incomplete = true;
      continue;
    }
    const state = projectGitlabCheckState(readString(candidate.status) ?? undefined);
    const startedAtMs = readTimestampMs(candidate.started_at);
    const completedAtMs = readTimestampMs(candidate.finished_at);
    const detailsUrl = boundedWebUrl(candidate.web_url, GITLAB_DETAIL_BOUNDS_V1);
    projectionTruncated ||= name.truncated;
    rows.push({ id, name: name.value, state,
      ...(detailsUrl === null ? {} : { detailsUrl }),
      ...(startedAtMs === null ? {} : { startedAtMs }),
      ...(completedAtMs === null ? {} : { completedAtMs }),
    });
  }
  return { rows, incomplete, projectionTruncated };
}

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
    const state = projectGitlabCheckState(status);
    if (state === 'failed') failingCount += 1;
    else if (state === 'pending') runningCount += 1;
    else if (state === 'passed') passingCount += 1;
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
  /** Added and removed lines, counted only from a patch GitLab says is whole (never a collapsed or silent one). */
  lines?: Readonly<{ additions: number; deletions: number }>;
}>;

/**
 * Whether this response carried GitLab's per-file truncation evidence at all.
 *
 * `reported` means every projected file carried both 18.4 fields. `unknown`
 * means at least one did not, and the reader labels the tab accordingly rather
 * than claiming a complete diff.
 */
export type GitlabDiffLimitStatusV1 = 'reported' | 'unknown';

export type GitlabChangedFilesProjectionV1<TRow = GitlabProjectedChangedFileRowV1> =
  GitlabPageProjectionV1<TRow> & Readonly<{
    diffLimitStatus: GitlabDiffLimitStatusV1;
  }>;

export function projectGitlabChangedFileRows(
  body: unknown, bounds: GitlabDetailBoundsV1, maxRows: number, comparison: true,
): GitlabChangedFilesProjectionV1<GitlabComparisonFileV1>;
export function projectGitlabChangedFileRows(
  body: unknown, bounds: GitlabDetailBoundsV1, maxRows?: number,
): GitlabChangedFilesProjectionV1;
export function projectGitlabChangedFileRows(
  body: unknown,
  bounds: GitlabDetailBoundsV1,
  maxRows: number = GITLAB_MAX_DETAIL_PAGE_SIZE_V1,
  comparison = false,
): GitlabChangedFilesProjectionV1 {
  let everyRowReported = true;
  const projected = projectRows<GitlabProjectedChangedFileRowV1>(body, maxRows, (raw) => {
    // Repository paths are code identities, not single-line display prose.
    const pathValue = raw.new_path ?? raw.old_path;
    const path = typeof pathValue === 'string' && pathValue.length > 0 ? { value: pathValue, truncated: false } : null;
    if (path === null) return null;
    const previousPath = raw.old_path === raw.new_path
      ? null
      : typeof raw.old_path === 'string' && raw.old_path.length > 0 ? { value: raw.old_path, truncated: false } : null;
    // Read as booleans ONLY when GitLab supplied booleans. `?? false` here is
    // exactly the defect this projector exists to prevent.
    const collapsed = typeof raw.collapsed === 'boolean' ? raw.collapsed : null;
    const tooLarge = typeof raw.too_large === 'boolean' ? raw.too_large : null;
    if (collapsed === null || tooLarge === null) everyRowReported = false;
    const truncated = path.truncated || (previousPath?.truncated ?? false);
    const evidence = projectGitlabPatchEvidence(raw);
    // The default page carries the patch's counts, never its text; a comparison carries the patch itself.
    const lines = comparison || evidence.state !== 'available' ? null : countGitlabPatchLines(evidence.patch);
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
        ...(lines === null ? {} : { lines }),
        ...(comparison ? {
          status: raw.new_file === true ? 'added' : raw.deleted_file === true ? 'removed'
            : raw.renamed_file === true ? 'renamed' : 'modified',
          diffAvailable: typeof raw.diff === 'string' && raw.diff.length > 0,
          evidence,
        } : {}),
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

function countGitlabPatchLines(patch: string): Readonly<{ additions: number; deletions: number }> {
  let additions = 0;
  let deletions = 0;
  for (const hunk of parseUnifiedDiffHunks(patch)) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions += 1;
      else if (line.kind === 'remove') deletions += 1;
    }
  }
  return Object.freeze({ additions, deletions });
}

function projectGitlabPatchEvidence(raw: JsonRecord): GitlabPatchEvidenceV1 {
  if (typeof raw.diff !== 'string' || raw.diff.length === 0) return { state: 'unavailable', reason: 'provider_patch_missing' };
  const reason = raw.too_large === true ? 'provider_patch_truncated'
    : raw.collapsed === true ? 'provider_patch_collapsed'
      : typeof raw.collapsed !== 'boolean' || typeof raw.too_large !== 'boolean' ? 'provider_patch_completeness_unknown' : null;
  return reason === null ? { state: 'available', patch: raw.diff } : { state: 'truncated', patch: raw.diff, reason };
}
