import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  normalizeTriageSingleLineV1,
  projectTriageDisplayTextV1,
  type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

import type { GithubCheckObservationV1 } from '../checks.js';
import type { GithubPatchEvidenceV1 } from './contracts.js';
import { readGithubAbsoluteWebUrl } from '../locator.js';
import { readGithubChangedFileImportSpecifiers } from './files/orderChangedFiles.js';

import {
  GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
  GITHUB_TIMELINE_PAGE_SIZE_V1,
} from './routes.js';

/**
 * The GitHub detail boundary projector.
 *
 * Everything a detail read may hand to an Action result, a controller or a panel
 * is built here and nowhere else. It runs immediately after the raw body is
 * decoded and before any state exists, which is what makes it a boundary rather
 * than a filter: a provider field that is not copied here cannot be reached
 * later by a panel that decides it wants it.
 *
 * It is an allow-list, and three of its refusals are deliberate:
 *
 * - A display-only changed-file read publishes patch availability. An explicit
 *   comparison read also preserves exact patch text and its coverage; availability
 *   by itself cannot prove that GitHub supplied all the changed lines.
 * - **a timeline event's payload bag is not copied.** A timeline row is what
 *   happened, who did it, and when. The comment body an event carries belongs to
 *   the comments plane, which is separately paginated and separately bounded;
 * - **a comment author is a login, never an email address or an account id.**
 *
 * Every single-line value goes through the published normalizer, so the
 * collapse-then-bound rule keeps one owner across the product. A comment body is
 * the one exception and it is narrow: its line structure IS its content, so it
 * is stripped of the control characters that are not line structure and then cut
 * on a whole code point by the same published truncator.
 */

/** The published bounds one GitHub detail projection is measured against. */
export type GithubDetailBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  textUtf8Bytes: number;
  locationUtf8Bytes: number;
}>;

/**
 * The bounds a published GitHub detail projection uses.
 *
 * Only fields entering shared bounded Triage primitives remain here. Provider
 * labels, paths and document bodies have no real provider or host byte boundary,
 * so this source normalizes but does not truncate them.
 */
export const GITHUB_DETAIL_BOUNDS_V1: GithubDetailBoundsV1 = Object.freeze({
  identifierUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  locationUtf8Bytes: MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
});

/** One provider page of timeline events. */
export const GITHUB_MAX_TIMELINE_ROWS_V1 = GITHUB_TIMELINE_PAGE_SIZE_V1;
/** One provider page of changed files. */
export const GITHUB_MAX_CHANGED_FILE_ROWS_V1 = GITHUB_CHANGED_FILES_PAGE_SIZE_V1;
/**
 * The check rows one checks read publishes.
 *
 * The read itself walks GitHub's whole check surface so the rollup counts are
 * computed over every observation, and this bounds only what is listed. A suite
 * larger than this keeps its true counts and reports the rows it omitted.
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

function readNativeId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return /^[1-9][0-9]*$/u.test(candidate) ? candidate : null;
}

/** Provider text becomes one bounded, single-line display value. */
function bounded(value: string, maxUtf8Bytes: number): TriageBoundedTextV1 {
  return projectTriageDisplayTextV1(value, maxUtf8Bytes);
}

function boundedOrNull(value: unknown, maxUtf8Bytes: number): TriageBoundedTextV1 | null {
  const raw = readString(value);
  if (raw === null) return null;
  const projected = bounded(raw, maxUtf8Bytes);
  return projected.value === '' ? null : projected;
}

function normalizedOrNull(value: unknown): TriageBoundedTextV1 | null {
  const raw = readString(value);
  if (raw === null) return null;
  const normalized = normalizeTriageSingleLineV1(raw);
  return normalized === '' ? null : Object.freeze({ value: normalized, truncated: false });
}

function boundedWebUrl(value: unknown, bounds: GithubDetailBoundsV1): string | null {
  const absolute = readGithubAbsoluteWebUrl(value);
  if (absolute === null) return null;
  // A location is never truncated into a shorter destination: an over-bound URL
  // is omitted so the row keeps its identity instead of pointing somewhere else.
  return new TextEncoder().encode(absolute).length <= bounds.locationUtf8Bytes ? absolute : null;
}

/** Boundary helpers reused by the GraphQL Feedback connections. */
export function projectGithubDetailIdentifierV1(value: unknown): TriageBoundedTextV1 | null {
  return boundedOrNull(value, GITHUB_DETAIL_BOUNDS_V1.identifierUtf8Bytes);
}

export function projectGithubDetailLabelV1(value: unknown): TriageBoundedTextV1 | null {
  return normalizedOrNull(value);
}

export function projectGithubDetailPathV1(value: unknown): TriageBoundedTextV1 | null {
  return normalizedOrNull(value);
}

export function projectGithubDetailWebUrlV1(value: unknown): string | null {
  return boundedWebUrl(value, GITHUB_DETAIL_BOUNDS_V1);
}

/* --------------------------------------------------------------- comment body */

/** C0 controls that are not line structure, plus `U+007F`. */
const NON_STRUCTURAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;
const CARRIAGE_RETURNS = /\r\n?/gu;
const EXCESSIVE_BLANK_LINES = /\n{3,}/gu;

/**
 * Normalizes one comment body while keeping the line structure that IS its
 * content.
 *
 * The single-line rule the rest of this source uses would collapse a Markdown
 * document into one run-on paragraph, so the narrow rule here strips exactly the
 * control characters that carry no meaning, normalizes line endings, and then
 * defers to the published UTF-8-safe truncator: cutting mid-sequence would put a
 * replacement character into text a reader is reading.
 */
export function projectGithubCommentBody(
  value: string,
): TriageBoundedTextV1 {
  const normalized = value
    .replace(CARRIAGE_RETURNS, '\n')
    .replace(NON_STRUCTURAL_CONTROLS, ' ')
    .replace(EXCESSIVE_BLANK_LINES, '\n\n')
    .trim();
  return { value: normalized, truncated: false };
}

/* ------------------------------------------------------------------- timeline */

/**
 * The closed timeline vocabulary this build understands.
 *
 * `forcePushed` and `baseChanged` are separate arms and folding either into
 * `committed` is forbidden. A force push means the old head commit may no longer
 * exist on the forge, and a base change typically does not move the head SHA at
 * all — so a head-only staleness guard passes vacuously while every diff-relative
 * anchor has moved. Both failures are silent, which is why the arms exist.
 *
 * `unsupported` is the arm for everything else. An unrecognized event is never
 * dropped, because that makes the timeline quietly incomplete, and never guessed
 * into a neighbouring arm, because that makes it quietly wrong.
 */
export const GITHUB_TIMELINE_KINDS_V1 = Object.freeze([
  'commented',
  'committed',
  'forcePushed',
  'baseChanged',
  'reviewed',
  'reviewRequested',
  'reviewRequestRemoved',
  'merged',
  'closed',
  'reopened',
  'labeled',
  'unlabeled',
  'assigned',
  'unassigned',
  'milestoned',
  'demilestoned',
  'renamed',
  'referenced',
  'crossReferenced',
  'unsupported',
] as const);

export type GithubTimelineKindV1 = (typeof GITHUB_TIMELINE_KINDS_V1)[number];

const TIMELINE_KIND_BY_EVENT: Readonly<Record<string, GithubTimelineKindV1 | undefined>> =
  Object.freeze({
    commented: 'commented',
    committed: 'committed',
    head_ref_force_pushed: 'forcePushed',
    base_ref_changed: 'baseChanged',
    reviewed: 'reviewed',
    review_requested: 'reviewRequested',
    review_request_removed: 'reviewRequestRemoved',
    merged: 'merged',
    closed: 'closed',
    reopened: 'reopened',
    labeled: 'labeled',
    unlabeled: 'unlabeled',
    assigned: 'assigned',
    unassigned: 'unassigned',
    milestoned: 'milestoned',
    demilestoned: 'demilestoned',
    renamed: 'renamed',
    referenced: 'referenced',
    'cross-referenced': 'crossReferenced',
  });

export type GithubProjectedTimelineRowV1 = Readonly<{
  /** Resource-kind-qualified provider identity; never a page position. */
  id: string;
  kind: GithubTimelineKindV1;
  /** GitHub's own word for this event, kept on every row including known ones. */
  rawKind: string;
  atMs?: number;
  actor?: string;
  /** What this event changed, when the event names one thing: a label, a title, a subject. */
  summary?: string;
  webUrl?: string;
  truncated?: true;
}>;

export type GithubPageProjectionV1<TRow> = Readonly<{
  rows: readonly TRow[];
  /** Rows this page returned that could not be read; they consumed page budget. */
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

function emptyPage<TRow>(): GithubPageProjectionV1<TRow> {
  return Object.freeze({
    rows: Object.freeze([]),
    omittedRowCount: 0,
    projectionTruncated: false,
  });
}

/** A commit event carries its author on the commit, not on an `actor`. */
function readCommitActor(raw: JsonRecord): unknown {
  const author = raw['author'];
  return isRecord(author) ? author['name'] : null;
}

/**
 * A `reviewed` event IS a pull-request review resource, so it names its author on
 * `user` rather than on `actor`. Reading only `actor` renders every review as
 * anonymous — and a review's author is the fact the Feedback plane answers "has
 * anybody signed off" with.
 */
function readReviewAuthor(raw: JsonRecord): unknown {
  const user = raw['user'];
  return isRecord(user) ? user['login'] : null;
}

function readTimelineActor(raw: JsonRecord, kind: GithubTimelineKindV1): unknown {
  const actor = raw['actor'];
  if (isRecord(actor)) {
    const login = actor['login'];
    if (readString(login) !== null) return login;
  }
  if (kind === 'committed') return readCommitActor(raw);
  return readReviewAuthor(raw);
}

function readTimelineTimestamp(raw: JsonRecord): number | null {
  const created = readTimestampMs(raw['created_at']);
  if (created !== null) return created;
  // A `reviewed` event has no `created_at` either; its instant is `submitted_at`.
  const submitted = readTimestampMs(raw['submitted_at']);
  if (submitted !== null) return submitted;
  // A `committed` event has no `created_at`; its instant is the commit's own.
  const committer = raw['committer'];
  if (isRecord(committer)) {
    const committed = readTimestampMs(committer['date']);
    if (committed !== null) return committed;
  }
  const author = raw['author'];
  return isRecord(author) ? readTimestampMs(author['date']) : null;
}

/** The one thing an event changed, where the event names exactly one. */
function readTimelineSubject(raw: JsonRecord, kind: GithubTimelineKindV1): unknown {
  switch (kind) {
    case 'labeled':
    case 'unlabeled': {
      const label = raw['label'];
      return isRecord(label) ? label['name'] : null;
    }
    case 'milestoned':
    case 'demilestoned': {
      const milestone = raw['milestone'];
      return isRecord(milestone) ? milestone['title'] : null;
    }
    case 'renamed': {
      const rename = raw['rename'];
      return isRecord(rename) ? rename['to'] : null;
    }
    case 'assigned':
    case 'unassigned':
    case 'reviewRequested':
    case 'reviewRequestRemoved': {
      const assignee = raw['assignee'] ?? raw['requested_reviewer'];
      if (isRecord(assignee)) return assignee['login'];
      const team = raw['requested_team'];
      return isRecord(team) ? team['name'] : null;
    }
    case 'committed':
      return raw['message'];
    case 'reviewed':
      return raw['state'];
    default:
      return null;
  }
}

function readTimelineIdentity(raw: JsonRecord, kind: GithubTimelineKindV1): string | null {
  if (kind === 'committed') {
    const sha = readString(raw['sha']);
    if (sha !== null && /^[0-9a-f]{7,64}$/iu.test(sha.trim())) {
      return `github-timeline-commit:${sha.trim()}`;
    }
  }
  const id = readNativeId(raw['id']);
  if (id !== null) return `github-timeline-event:${id}`;
  const nodeId = readString(raw['node_id']);
  return nodeId === null ? null : `github-timeline-node:${nodeId.trim()}`;
}

/**
 * Projects one page of `/issues/{number}/timeline`.
 *
 * The page is ordered by event time and then by native event id ascending, so
 * two events sharing a timestamp keep a stable relative position across a
 * re-read. GitHub already returns the collection in that order; sorting here
 * makes the guarantee this source's own rather than a provider habit.
 */
export function projectGithubTimelineRows(
  raw: unknown,
  bounds: GithubDetailBoundsV1,
): GithubPageProjectionV1<GithubProjectedTimelineRowV1> {
  if (!Array.isArray(raw)) return emptyPage();

  type Ordered = Readonly<{
    row: GithubProjectedTimelineRowV1;
    atMs: number;
    ordinal: number;
  }>;
  const ordered: Ordered[] = [];
  let omittedRowCount = 0;
  let projectionTruncated = false;

  for (const entry of raw) {
    if (!isRecord(entry)) {
      omittedRowCount += 1;
      continue;
    }
    const rawKind = readString(entry['event']);
    if (rawKind === null) {
      omittedRowCount += 1;
      continue;
    }
    const kind = TIMELINE_KIND_BY_EVENT[rawKind.trim()] ?? 'unsupported';
    const id = readTimelineIdentity(entry, kind);
    if (id === null) {
      omittedRowCount += 1;
      continue;
    }
    if (ordered.length >= GITHUB_MAX_TIMELINE_ROWS_V1) {
      omittedRowCount += 1;
      projectionTruncated = true;
      continue;
    }

    const boundedId = bounded(id, bounds.identifierUtf8Bytes);
    const boundedKind = normalizedOrNull(rawKind);
    if (boundedKind === null) {
      omittedRowCount += 1;
      continue;
    }
    const actor = normalizedOrNull(readTimelineActor(entry, kind));
    const summary = boundedOrNull(readTimelineSubject(entry, kind), bounds.textUtf8Bytes);
    const atMs = readTimelineTimestamp(entry);
    const webUrl = boundedWebUrl(entry['html_url'], bounds);
    const truncated = boundedId.truncated
      || boundedKind.truncated
      || (actor?.truncated ?? false)
      || (summary?.truncated ?? false);
    projectionTruncated = projectionTruncated || truncated;

    ordered.push(Object.freeze({
      row: Object.freeze({
        id: boundedId.value,
        kind,
        rawKind: boundedKind.value,
        ...(atMs === null ? {} : { atMs }),
        ...(actor === null ? {} : { actor: actor.value }),
        ...(summary === null ? {} : { summary: summary.value }),
        ...(webUrl === null ? {} : { webUrl }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      // An event with no readable instant sorts last rather than to the epoch,
      // where it would claim to predate every dated event on the page.
      atMs: atMs ?? Number.MAX_SAFE_INTEGER,
      ordinal: Number(readNativeId(entry['id']) ?? Number.MAX_SAFE_INTEGER),
    }));
  }

  ordered.sort((left, right) => (
    left.atMs - right.atMs
    || left.ordinal - right.ordinal
    || (left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0)
  ));

  return Object.freeze({
    rows: Object.freeze(ordered.map((entry) => entry.row)),
    omittedRowCount,
    projectionTruncated,
  });
}

/* -------------------------------------------------------------- changed files */

export type GithubProjectedChangedFileRowV1 = Readonly<{
  /** The provider path, which is this row's identity within one pull request. */
  path: string;
  /** Present on a rename or copy; the path this file was known by before. */
  previousPath?: string;
  /** GitHub's own status word: `added`, `modified`, `renamed`, `removed`, … */
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** The blob revision of the changed file, when GitHub stated one. */
  blobSha?: string;
  webUrl?: string;
  /**
   * `false` when GitHub omitted this file's `patch` — which it does for very
   * large files. It is a real provider fact and the reason a row can render as
   * *diff unavailable for this file* with its counts rather than as an empty
   * diff. Comparison callers consume `evidence`, not this display boolean.
   */
  diffAvailable: boolean;
  evidence?: GithubPatchEvidenceV1;
  /** Relative static imports observed in the available patch, not a full file graph. */
  importSpecifiers?: readonly string[];
  truncated?: true;
}>;

export function projectGithubChangedFileRows(
  raw: unknown,
  bounds: GithubDetailBoundsV1,
  comparison = false,
): GithubPageProjectionV1<GithubProjectedChangedFileRowV1> {
  if (!Array.isArray(raw)) return emptyPage();

  const rows: GithubProjectedChangedFileRowV1[] = [];
  let omittedRowCount = 0;
  let projectionTruncated = false;

  for (const entry of raw) {
    if (!isRecord(entry)) {
      omittedRowCount += 1;
      continue;
    }
    const rawPath = comparison && typeof entry['filename'] === 'string' && entry['filename'].length > 0
      ? entry['filename'] : readString(entry['filename']);
    const rawStatus = readString(entry['status']);
    if (rawPath === null || rawStatus === null) {
      omittedRowCount += 1;
      continue;
    }
    if (rows.length >= GITHUB_MAX_CHANGED_FILE_ROWS_V1) {
      omittedRowCount += 1;
      projectionTruncated = true;
      continue;
    }

    const path = comparison ? { value: rawPath, truncated: false } : normalizedOrNull(rawPath);
    if (path === null) {
      omittedRowCount += 1;
      continue;
    }
    const status = normalizedOrNull(rawStatus);
    if (status === null) {
      omittedRowCount += 1;
      continue;
    }
    const rawPreviousPath = comparison && typeof entry['previous_filename'] === 'string' && entry['previous_filename'].length > 0
      ? entry['previous_filename'] : readString(entry['previous_filename']);
    const previousPath = comparison && rawPreviousPath !== null
      ? { value: rawPreviousPath, truncated: false }
      : normalizedOrNull(entry['previous_filename']);
    const blobSha = boundedOrNull(entry['sha'], bounds.identifierUtf8Bytes);
    const additions = readCount(entry['additions']) ?? 0;
    const deletions = readCount(entry['deletions']) ?? 0;
    const changes = readCount(entry['changes']) ?? additions + deletions;
    const webUrl = boundedWebUrl(entry['blob_url'], bounds);
    const truncated = path.truncated
      || status.truncated
      || (previousPath?.truncated ?? false)
      || (blobSha?.truncated ?? false);
    projectionTruncated = projectionTruncated || truncated;

    const importSpecifiers = readGithubChangedFileImportSpecifiers(path.value, entry['patch']);
    rows.push(Object.freeze({
      path: path.value,
      ...(importSpecifiers.length === 0 ? {} : { importSpecifiers }),
      ...(previousPath === null ? {} : { previousPath: previousPath.value }),
      status: status.value,
      additions,
      deletions,
      changes,
      ...(blobSha === null ? {} : { blobSha: blobSha.value }),
      ...(webUrl === null ? {} : { webUrl }),
      diffAvailable: typeof entry['patch'] === 'string',
      ...(comparison ? { evidence: projectPatchEvidence(entry['patch'], readCount(entry['additions']), readCount(entry['deletions'])) } : {}),
      ...(truncated ? { truncated: true as const } : {}),
    }));
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    omittedRowCount,
    projectionTruncated,
  });
}

/** Counts provider patch coverage without rewriting its bytes or guessing binary status. */
function projectPatchEvidence(patch: unknown, additions: number | null, deletions: number | null): GithubPatchEvidenceV1 {
  if (typeof patch !== 'string') return Object.freeze({ state: 'unavailable', reason: 'provider_patch_missing' });
  let added = 0;
  let removed = 0;
  let beforeRemaining = 0;
  let afterRemaining = 0;
  let valid = additions !== null && deletions !== null;
  let hasHunk = false;
  const lines = patch.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
    if (header) {
      valid = valid && beforeRemaining === 0 && afterRemaining === 0;
      beforeRemaining = header[1] === undefined ? 1 : Number(header[1]);
      afterRemaining = header[2] === undefined ? 1 : Number(header[2]);
      hasHunk = true;
    } else if (line.startsWith('+') && hasHunk) { added += 1; afterRemaining -= 1; }
    else if (line.startsWith('-') && hasHunk) { removed += 1; beforeRemaining -= 1; }
    else if (line.startsWith(' ') && hasHunk) { beforeRemaining -= 1; afterRemaining -= 1; }
    else if (line === '\\ No newline at end of file' || (line === '' && index === lines.length - 1)) { /* Diff metadata / final newline. */ }
    else valid = false;
    if (beforeRemaining < 0 || afterRemaining < 0) valid = false;
  }
  return valid && beforeRemaining === 0 && afterRemaining === 0 && added === additions && removed === deletions
    ? Object.freeze({ state: 'available', patch })
    : Object.freeze({ state: 'truncated', patch, reason: 'provider_patch_truncated' });
}

/* -------------------------------------------------------------------- checks */

export type GithubProjectedCheckRowV1 = Readonly<{
  /** The resource-kind-qualified provider id `checks.ts` already derived. */
  key: string;
  resourceKind: 'check-run' | 'commit-status';
  name: string;
  status: string;
  conclusion?: string;
  detailsUrl?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  logExcerpt?: string;
  truncated?: true;
}>;

/**
 * Projects the already-decoded check observations into publishable rows.
 *
 * The rollup counts are computed by `checks.ts` over EVERY observation it read,
 * so bounding the listed rows here shortens the list without ever shortening the
 * count a reader is shown.
 */
export function projectGithubCheckRows(
  observations: readonly GithubCheckObservationV1[],
  bounds: GithubDetailBoundsV1,
): GithubPageProjectionV1<GithubProjectedCheckRowV1> {
  const rows: GithubProjectedCheckRowV1[] = [];
  let omittedRowCount = 0;
  let projectionTruncated = false;

  for (const observation of observations) {
    const key = bounded(observation.key, bounds.identifierUtf8Bytes);
    const name = normalizedOrNull(observation.name);
    const status = normalizedOrNull(observation.status);
    if (name === null || status === null) {
      omittedRowCount += 1;
      continue;
    }
    const conclusion = normalizedOrNull(observation.conclusion);
    const detailsUrl = boundedWebUrl(observation.detailsUrl, bounds);
    const logExcerpt = observation.logExcerpt === null || observation.logExcerpt === undefined
      ? null
      : projectGithubCommentBody(observation.logExcerpt);
    const truncated = key.truncated
      || name.truncated
      || status.truncated
      || (conclusion?.truncated ?? false)
      || (logExcerpt?.truncated ?? false);
    projectionTruncated = projectionTruncated || truncated;

    rows.push(Object.freeze({
      key: key.value,
      resourceKind: observation.resourceKind,
      name: name.value,
      status: status.value,
      ...(conclusion === null ? {} : { conclusion: conclusion.value }),
      ...(detailsUrl === null ? {} : { detailsUrl }),
      ...(observation.startedAtMs === null ? {} : { startedAtMs: observation.startedAtMs }),
      ...(observation.completedAtMs === null ? {} : { completedAtMs: observation.completedAtMs }),
      ...(logExcerpt === null ? {} : { logExcerpt: logExcerpt.value }),
      ...(truncated ? { truncated: true as const } : {}),
    }));
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    omittedRowCount,
    projectionTruncated,
  });
}
