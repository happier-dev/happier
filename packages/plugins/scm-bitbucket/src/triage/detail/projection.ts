import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  normalizeTriageSingleLineV1,
} from '@happier-dev/triage-protocol/v1';

import { toBoundedDisplayLine } from '../text.js';

/**
 * The Bitbucket Cloud detail boundary projector.
 *
 * Everything a detail read may hand to an Action result or a mounted panel is
 * built here and nowhere else. It runs immediately after the envelope is decoded
 * and before any state exists, so a provider field that is not copied here
 * cannot be reached later by a panel that decides it wants it.
 *
 * Two refusals are deliberate:
 *
 * - **an absent `resolution` key is never projected as unresolved.** Bitbucket
 *   returns comment resolution on deployments that have it and omits the field
 *   where it does not. Rendering the omission as "unresolved" tells a reviewer
 *   that a thread they resolved is still open, on a response that said nothing;
 * - **a build rollup is never computed over a partial page.** Three counts over
 *   the statuses that happened to fit is a wrong answer, not a partial one.
 */

export type BitbucketDetailBoundsV1 = Readonly<{
  identifierUtf8Bytes: number;
  textUtf8Bytes: number;
  locationUtf8Bytes: number;
}>;

export const BITBUCKET_DETAIL_BOUNDS_V1: BitbucketDetailBoundsV1 = Object.freeze({
  identifierUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  textUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  locationUtf8Bytes: MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
});

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

function readPositiveId(value: unknown, maxUtf8Bytes: number): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate === '' || /[^\x21-\x7E]/u.test(candidate)) return null;
  return new TextEncoder().encode(candidate).length <= maxUtf8Bytes ? candidate : null;
}

function boundedWebUrl(value: unknown, bounds: BitbucketDetailBoundsV1): string | null {
  const raw = readString(value);
  if (raw === null || !/^https?:\/\//iu.test(raw.trim())) return null;
  const absolute = raw.trim();
  return new TextEncoder().encode(absolute).length <= bounds.locationUtf8Bytes ? absolute : null;
}

/** Bitbucket nests an actor as `{ display_name, nickname, uuid }`. */
function readActor(
  value: unknown,
): Readonly<{ value: string; truncated: boolean }> | null {
  if (!isRecord(value)) return null;
  const raw = readString(value.display_name) ?? readString(value.nickname);
  if (raw === null) return null;
  const normalized = normalizeTriageSingleLineV1(raw);
  return normalized === '' ? null : { value: normalized, truncated: false };
}

/** C0 controls that are not line structure, plus `U+007F`. */
const NON_STRUCTURAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;
const CARRIAGE_RETURNS = /\r\n?/gu;

/**
 * A comment body keeps its line structure, because its line structure IS its
 * content. Only the control characters that are not line structure are removed.
 */
function projectCommentBody(
  value: unknown,
): Readonly<{ value: string; truncated: boolean }> {
  const raw = isRecord(value) ? value.raw : value;
  if (typeof raw !== 'string') return { value: '', truncated: false };
  const normalized = raw
    .replace(CARRIAGE_RETURNS, '\n')
    .replace(NON_STRUCTURAL_CONTROLS, '')
    .trim();
  return { value: normalized, truncated: false };
}

export type BitbucketPageProjectionV1<TRow> = Readonly<{
  rows: readonly TRow[];
  /** Provider items in this page this projection could not identify. */
  omittedRowCount: number;
  /** True when at least one published value was shortened to fit its bound. */
  projectionTruncated: boolean;
}>;

function projectRows<TRow>(
  values: readonly unknown[],
  projectOne: (row: JsonRecord) => Readonly<{ row: TRow; truncated: boolean }> | null,
): BitbucketPageProjectionV1<TRow> {
  const rows: TRow[] = [];
  let omitted = 0;
  let truncated = false;
  for (const candidate of values) {
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

/* ------------------------------------------------------------------ activity */

export const BITBUCKET_ACTIVITY_KINDS_V1 = [
  'approval',
  'changesRequested',
  'update',
  'comment',
  'unsupported',
] as const;
export type BitbucketActivityKindV1 = (typeof BITBUCKET_ACTIVITY_KINDS_V1)[number];

export type BitbucketProjectedActivityRowV1 = Readonly<{
  /**
   * A PRESENTATION key, not an identity.
   *
   * Bitbucket's activity entries carry no id of their own except the nested
   * comment's, so a list key is derived from what the entry does carry. Nothing
   * downstream may treat it as a provider identity or a dedupe key.
   */
  key: string;
  kind: BitbucketActivityKindV1;
  /** Bitbucket's own word for this entry, carried on EVERY row. */
  rawKind: string;
  actor?: string;
  atMs?: number;
  summary?: string;
  truncated?: true;
}>;

const ACTIVITY_ARM_KINDS: Readonly<Record<string, BitbucketActivityKindV1 | undefined>> =
  Object.freeze({
    approval: 'approval',
    changes_requested: 'changesRequested',
    update: 'update',
    comment: 'comment',
  });

export function projectBitbucketActivityRows(
  values: readonly unknown[],
  bounds: BitbucketDetailBoundsV1,
): BitbucketPageProjectionV1<BitbucketProjectedActivityRowV1> {
  return projectRows(values, (raw) => {
    // The entry is a single-armed object; the arm name IS the event.
    const armName = Object.keys(raw).find((key) => ACTIVITY_ARM_KINDS[key] !== undefined)
      ?? Object.keys(raw)[0];
    if (armName === undefined) return null;
    const kind = ACTIVITY_ARM_KINDS[armName] ?? 'unsupported';
    const arm = isRecord(raw[armName]) ? raw[armName] as JsonRecord : {};

    const actor = readActor(arm.user) ?? readActor(arm.author);
    const atMs = readTimestampMs(arm.date) ?? readTimestampMs(arm.created_on);
    const commentId = readPositiveId(arm.id, bounds.identifierUtf8Bytes);
    const summary = kind === 'comment'
      ? projectCommentBody(arm.content)
      : null;
    const rawKind = normalizeTriageSingleLineV1(armName);
    if (rawKind === '') return null;

    const rawKey = commentId === null
      ? `${armName}:${String(atMs ?? 0)}:${actor?.value ?? ''}`
      : `${armName}:${commentId}`;
    const key = toBoundedDisplayLine(rawKey, bounds.textUtf8Bytes);
    if (key === null) return null;
    const truncated = (actor?.truncated ?? false)
      || (summary?.truncated ?? false)
      || key.truncated;
    return {
      row: Object.freeze({
        key: key.value,
        kind,
        rawKind,
        ...(actor === null ? {} : { actor: actor.value }),
        ...(atMs === null ? {} : { atMs }),
        ...(summary === null || summary.value === '' ? {} : { summary: summary.value }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* -------------------------------------------------------------------- builds */

export type BitbucketProjectedStatusRowV1 = Readonly<{
  key: string;
  name: string;
  state: string;
  description?: string;
  url?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  truncated?: true;
}>;

export function projectBitbucketStatusRows(
  values: readonly unknown[],
  bounds: BitbucketDetailBoundsV1,
): BitbucketPageProjectionV1<BitbucketProjectedStatusRowV1> {
  return projectRows(values, (raw) => {
    const key = readPositiveId(raw.uuid ?? raw.key, bounds.identifierUtf8Bytes);
    const state = readString(raw.state);
    if (key === null || state === null) return null;
    const normalizedState = normalizeTriageSingleLineV1(state);
    if (normalizedState === '') return null;
    const rawName = readString(raw.name) ?? readString(raw.key);
    const name = rawName === null ? null : normalizeTriageSingleLineV1(rawName);
    const description = toBoundedDisplayLine(
      readString(raw.description) ?? '',
      bounds.textUtf8Bytes,
    );
    const url = boundedWebUrl(raw.url, bounds);
    const createdAtMs = readTimestampMs(raw.created_on);
    const updatedAtMs = readTimestampMs(raw.updated_on);
    const truncated = description?.truncated ?? false;
    return {
      row: Object.freeze({
        key,
        name: name === null || name === '' ? key : name,
        state: normalizedState,
        ...(description === null ? {} : { description: description.value }),
        ...(url === null ? {} : { url }),
        ...(createdAtMs === null ? {} : { createdAtMs }),
        ...(updatedAtMs === null ? {} : { updatedAtMs }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

export type BitbucketBuildRollupV1 = Readonly<{
  failingCount: number;
  runningCount: number;
  passingCount: number;
}>;

const FAILING_STATES = new Set(['FAILED', 'ERROR']);
const RUNNING_STATES = new Set(['INPROGRESS']);
const PASSING_STATES = new Set(['SUCCESSFUL']);

/**
 * Rolls a COMPLETE status collection up into three counts, or returns `null`.
 *
 * `complete` is not decoration. Bitbucket paginates this collection, and three
 * counts computed over the statuses that fit one page is a wrong answer rather
 * than a partial one: a reader told `0 failing` acts on it. `STOPPED` is
 * counted in none of the three, because a cancelled build neither failed, ran,
 * nor passed.
 */
export function projectBitbucketBuildRollup(input: Readonly<{
  rows: readonly BitbucketProjectedStatusRowV1[];
  complete: boolean;
}>): BitbucketBuildRollupV1 | null {
  if (!input.complete) return null;
  let failingCount = 0;
  let runningCount = 0;
  let passingCount = 0;
  for (const row of input.rows) {
    const state = row.state.trim().toUpperCase();
    if (FAILING_STATES.has(state)) failingCount += 1;
    else if (RUNNING_STATES.has(state)) runningCount += 1;
    else if (PASSING_STATES.has(state)) passingCount += 1;
  }
  return Object.freeze({ failingCount, runningCount, passingCount });
}

/* ------------------------------------------------------------------ comments */

/**
 * Bitbucket comment resolution, as a genuine tri-state.
 *
 * `unknown` is the value for a response that did not carry the field at all. It
 * is a different answer from `unresolved`, and conflating them tells a reviewer
 * their resolved thread is still open.
 */
export const BITBUCKET_COMMENT_RESOLUTIONS_V1 = ['resolved', 'unresolved', 'unknown'] as const;
export type BitbucketCommentResolutionV1 = (typeof BITBUCKET_COMMENT_RESOLUTIONS_V1)[number];

export type BitbucketProjectedCommentRowV1 = Readonly<{
  id: string;
  author?: string;
  body: string;
  atMs?: number;
  editedAtMs?: number;
  /** The comment this one replies to; its absence makes this a thread root. */
  parentId?: string;
  deleted: boolean;
  resolution: BitbucketCommentResolutionV1;
  /** Present when Bitbucket anchored this comment to a file. */
  path?: string;
  url?: string;
  truncated?: true;
}>;

/**
 * One comment's resolution, as this source reads it — from the projected page or
 * from the confirming read of a resolve or reopen write.
 *
 * It is exported because those two callers must agree: the panel's tri-state and
 * the write's proof are the same fact about the same comment, and a second
 * reader is how one of them starts answering `unresolved` where the other
 * answers `unknown`.
 */
export function readBitbucketCommentResolution(raw: unknown): BitbucketCommentResolutionV1 {
  if (!isRecord(raw)) return 'unknown';
  // `in` rather than a truthiness read: the difference between "the deployment
  // said not resolved" and "the deployment did not say" is exactly the key's
  // presence, and it is the whole point of this tri-state.
  if (!('resolution' in raw)) return 'unknown';
  return isRecord(raw.resolution) ? 'resolved' : 'unresolved';
}

export function projectBitbucketCommentRows(
  values: readonly unknown[],
  bounds: BitbucketDetailBoundsV1,
): BitbucketPageProjectionV1<BitbucketProjectedCommentRowV1> {
  return projectRows(values, (raw) => {
    const id = readPositiveId(raw.id, bounds.identifierUtf8Bytes);
    if (id === null) return null;
    const author = readActor(raw.user);
    const body = projectCommentBody(raw.content);
    const atMs = readTimestampMs(raw.created_on);
    const updatedAtMs = readTimestampMs(raw.updated_on);
    const parentId = isRecord(raw.parent)
      ? readPositiveId(raw.parent.id, bounds.identifierUtf8Bytes)
      : null;
    const inline = isRecord(raw.inline) ? readString(raw.inline.path) : null;
    const path = inline === null ? null : toBoundedDisplayLine(inline, bounds.textUtf8Bytes);
    const url = isRecord(raw.links) && isRecord(raw.links.html)
      ? boundedWebUrl(raw.links.html.href, bounds)
      : null;
    const truncated = body.truncated || (author?.truncated ?? false) || (path?.truncated ?? false);
    return {
      row: Object.freeze({
        id,
        ...(author === null ? {} : { author: author.value }),
        body: body.value,
        ...(atMs === null ? {} : { atMs }),
        ...(updatedAtMs === null || updatedAtMs === atMs ? {} : { editedAtMs: updatedAtMs }),
        ...(parentId === null ? {} : { parentId }),
        deleted: raw.deleted === true,
        resolution: readBitbucketCommentResolution(raw),
        ...(path === null ? {} : { path: path.value }),
        ...(url === null ? {} : { url }),
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}

/* ------------------------------------------------------------------ diffstat */

export type BitbucketProjectedDiffstatRowV1 = Readonly<{
  path: string;
  status: string;
  linesAdded: number;
  linesRemoved: number;
  truncated?: true;
}>;

/** Projects Bitbucket's JSON diffstat companion without interpreting the raw diff text. */
export function projectBitbucketDiffstatRows(
  values: readonly unknown[],
  bounds: BitbucketDetailBoundsV1,
): BitbucketPageProjectionV1<BitbucketProjectedDiffstatRowV1> {
  return projectRows(values, (raw) => {
    const oldPath = isRecord(raw.old) ? readString(raw.old.path) : null;
    const newPath = isRecord(raw.new) ? readString(raw.new.path) : null;
    const rawPath = newPath ?? oldPath;
    const rawStatus = readString(raw.status);
    if (rawPath === null || rawStatus === null) return null;
    const path = toBoundedDisplayLine(rawPath, bounds.textUtf8Bytes);
    const status = normalizeTriageSingleLineV1(rawStatus);
    if (path === null || status === '') return null;
    const linesAdded = typeof raw.lines_added === 'number'
      && Number.isSafeInteger(raw.lines_added) && raw.lines_added >= 0
      ? raw.lines_added : 0;
    const linesRemoved = typeof raw.lines_removed === 'number'
      && Number.isSafeInteger(raw.lines_removed) && raw.lines_removed >= 0
      ? raw.lines_removed : 0;
    const truncated = path.truncated;
    return {
      row: Object.freeze({
        path: path.value,
        status,
        linesAdded,
        linesRemoved,
        ...(truncated ? { truncated: true as const } : {}),
      }),
      truncated,
    };
  });
}
