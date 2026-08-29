import type {
  CodexRolloutCandidateScanBoundary,
} from '../../../rollout/discovery/candidates.js';

const DEFAULT_APP_SERVER_LIST_BUDGET_MS = 3_000;

/**
 * Which rollout scan produced the rows a searched page served, and how the
 * next request reproduces or advances that exact scan instead of restarting
 * the corpus from its head:
 *
 * - `auto` — the initial state; the request resolves the producer itself
 *   (filename selection first, bounded chunk scan otherwise) exactly like a
 *   cursor-less request.
 * - `filenameSelection` — the rows are a complete filename-matched selection;
 *   they are reproduced by re-running that selection, never by a corpus scan.
 * - `chunkScan` — the rows are one bounded corpus chunk; `boundary` is the
 *   resume point that reproduces them (null for the corpus head).
 * - `done` — the rollout corpus is fully consumed; no scan runs again.
 *
 * `rolloutOffset` in the enclosing cursor indexes the rows this scan produced,
 * so an unexhausted scan must never change: reproduction is what keeps the
 * offset meaningful across requests.
 */
export type CodexExternalSessionRolloutScanState = Readonly<{
  kind: 'auto' | 'filenameSelection' | 'chunkScan' | 'done';
  boundary: CodexRolloutCandidateScanBoundary | null;
}>;

const INITIAL_CODEX_EXTERNAL_SESSION_ROLLOUT_SCAN: CodexExternalSessionRolloutScanState = Object.freeze({
  kind: 'auto',
  boundary: null,
});

/**
 * Terminal rollout scan state: the corpus is fully consumed, so no further
 * scanned request may run. Exported for the searched-page owner, which returns
 * it verbatim when a request has no rollout rows to serve.
 */
export const DONE_CODEX_EXTERNAL_SESSION_ROLLOUT_SCAN: CodexExternalSessionRolloutScanState =
  Object.freeze({ kind: 'done', boundary: null });

/**
 * Rolls the rollout half of a v6 cursor forward after one searched page. Rows
 * the page did not reach keep the exact scan that produced them, so the next
 * request reproduces those rows and its `rolloutOffset` stays meaningful; an
 * exhausted chunk scan advances to the scan chunk's own continuation boundary
 * (offset restarts at zero inside rows that do not exist yet), and any other
 * exhausted producer is terminal.
 */
export function advanceCodexExternalSessionRolloutScanState(params: Readonly<{
  current: CodexExternalSessionRolloutScanState;
  rowsLength: number;
  rolloutOffset: number;
  nextBoundary: CodexRolloutCandidateScanBoundary | null;
}>): CodexExternalSessionRolloutScanState {
  if (params.rolloutOffset < params.rowsLength) return params.current;
  if (params.current.kind === 'chunkScan' && params.nextBoundary) {
    return Object.freeze({ kind: 'chunkScan', boundary: params.nextBoundary });
  }
  return DONE_CODEX_EXTERNAL_SESSION_ROLLOUT_SCAN;
}

export type CodexExternalSessionNativeCandidateCursorState = Readonly<{
  /** Cursor the next bounded app-server request will use; null is page one. */
  cursor: string | null;
  /** The immediately preceding request cursor, used to reject A → B → A loops. */
  previousCursor: string | null;
  /** Number of rows already consumed from the requested native page. */
  offset: number;
  /** A terminal native stream is not requested again. */
  done: boolean;
}>;

export type CodexExternalSessionIndexCursor = Readonly<{
  v: 6;
  kind: 'codexMergedCandidatePage';
  rolloutOffset: number;
  /** The rollout scan that produced the rows `rolloutOffset` indexes. */
  rolloutScan: CodexExternalSessionRolloutScanState;
  suppressedRolloutIds: readonly string[];
  active: CodexExternalSessionNativeCandidateCursorState;
  archived: CodexExternalSessionNativeCandidateCursorState;
}>;

const INITIAL_NATIVE_CANDIDATE_CURSOR_STATE: CodexExternalSessionNativeCandidateCursorState = Object.freeze({
  cursor: null,
  previousCursor: null,
  offset: 0,
  done: false,
});

export function createInitialCodexExternalSessionIndexCursor(): CodexExternalSessionIndexCursor {
  return Object.freeze({
    v: 6,
    kind: 'codexMergedCandidatePage',
    rolloutOffset: 0,
    rolloutScan: INITIAL_CODEX_EXTERNAL_SESSION_ROLLOUT_SCAN,
    suppressedRolloutIds: Object.freeze([]),
    active: INITIAL_NATIVE_CANDIDATE_CURSOR_STATE,
    archived: INITIAL_NATIVE_CANDIDATE_CURSOR_STATE,
  });
}

export function encodeCodexExternalSessionIndexCursor(
  cursor: CodexExternalSessionIndexCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isCursorToken(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function decodeRolloutCandidateScanBoundary(value: unknown): CodexRolloutCandidateScanBoundary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sourceGeneration =
    typeof record.sourceGeneration === 'string'
      ? record.sourceGeneration.trim()
      : '';
  const containerKey = typeof record.containerKey === 'string' ? record.containerKey : '';
  const fileName = typeof record.fileName === 'string' ? record.fileName : '';
  const scanned =
    typeof record.scanned === 'number'
      && Number.isSafeInteger(record.scanned)
      && record.scanned >= 0
      ? record.scanned
      : null;
  return sourceGeneration && containerKey && fileName && scanned !== null
    ? { sourceGeneration, containerKey, fileName, scanned }
    : null;
}

function decodeRolloutScanState(value: unknown): CodexExternalSessionRolloutScanState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ['kind', 'boundary'])) return null;
  if (record.kind === 'chunkScan') {
    const boundary = record.boundary === null
      ? null
      : decodeRolloutCandidateScanBoundary(record.boundary);
    if (record.boundary !== null && !boundary) return null;
    return Object.freeze({ kind: 'chunkScan', boundary });
  }
  if (
    (record.kind === 'auto' || record.kind === 'filenameSelection' || record.kind === 'done')
    && record.boundary === null
  ) {
    return Object.freeze({ kind: record.kind, boundary: null });
  }
  return null;
}

function decodeNativeCandidateCursorState(
  value: unknown,
): CodexExternalSessionNativeCandidateCursorState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ['cursor', 'previousCursor', 'offset', 'done'])) return null;
  if (!isCursorToken(record.cursor) || !isCursorToken(record.previousCursor)) return null;
  if (
    typeof record.offset !== 'number'
    || !Number.isSafeInteger(record.offset)
    || record.offset < 0
    || typeof record.done !== 'boolean'
  ) {
    return null;
  }
  if (record.done && (record.cursor !== null || record.offset !== 0)) return null;
  return Object.freeze({
    cursor: record.cursor,
    previousCursor: record.previousCursor,
    offset: record.offset,
    done: record.done,
  });
}

/**
 * Full/search candidate browsing has its own strict v6 cursor because one
 * page now owns three independent continuations: the rollout scan (which scan
 * produced the served rows and where it resumes), and the active/archived
 * native app-server lists. It also carries unresolved rollout twins already
 * emitted from a newer native page. Older cursors are rejected so a prior
 * owner cannot silently skip or repeat a row.
 */
export function decodeCodexExternalSessionIndexCursor(
  raw: string | undefined,
): CodexExternalSessionIndexCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!hasOnlyKeys(record, ['v', 'kind', 'rolloutOffset', 'rolloutScan', 'suppressedRolloutIds', 'active', 'archived'])) return null;
    if (
      record.v !== 6
      || record.kind !== 'codexMergedCandidatePage'
      || typeof record.rolloutOffset !== 'number'
      || !Number.isSafeInteger(record.rolloutOffset)
      || record.rolloutOffset < 0
    ) {
      return null;
    }
    const rolloutScan = decodeRolloutScanState(record.rolloutScan);
    if (
      !Array.isArray(record.suppressedRolloutIds)
      || record.suppressedRolloutIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
      || new Set(record.suppressedRolloutIds).size !== record.suppressedRolloutIds.length
    ) {
      return null;
    }
    const active = decodeNativeCandidateCursorState(record.active);
    const archived = decodeNativeCandidateCursorState(record.archived);
    return active && archived && rolloutScan
      ? Object.freeze({
        v: 6,
        kind: 'codexMergedCandidatePage',
        rolloutOffset: record.rolloutOffset,
        rolloutScan,
        suppressedRolloutIds: Object.freeze([...record.suppressedRolloutIds]),
        active,
        archived,
      })
      : null;
  } catch {
    return null;
  }
}

/**
 * v4 continues the bounded corpus scan the host candidate index drives: a
 * traversal position plus the cumulative file count that becomes
 * `preparation.scanned`. It supersedes both the v2 traversal boundary (no scan
 * progress, so the host could not prove a build advanced) and the v3
 * last-activity ordering key (a plugin-local ordered page needs a whole-corpus
 * mtime sweep per page, which does not fit the source head-acquisition budget).
 * Older cursors are rejected on purpose: the surface turns an undecodable cursor
 * into the same typed source-changed refresh used when the rollout set mutates
 * mid-browse.
 */
type CodexExternalSessionCandidateCursorV4 = Readonly<{
  v: 4;
  kind: 'codexRolloutCandidateScan';
  sourceGeneration: string;
  containerKey: string;
  fileName: string;
  scanned: number;
}>;

export function encodeCodexExternalSessionCandidateCursor(
  boundary: CodexRolloutCandidateScanBoundary,
): string {
  const cursor: CodexExternalSessionCandidateCursorV4 = {
    v: 4,
    kind: 'codexRolloutCandidateScan',
    ...boundary,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCodexExternalSessionCandidateCursor(
  raw: string | undefined,
): CodexRolloutCandidateScanBoundary | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return record.v === 4 && record.kind === 'codexRolloutCandidateScan'
      ? decodeRolloutCandidateScanBoundary(record)
      : null;
  } catch {
    return null;
  }
}

export function resolveCodexExternalSessionAppServerListBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APP_SERVER_LIST_BUDGET_MS;
}
