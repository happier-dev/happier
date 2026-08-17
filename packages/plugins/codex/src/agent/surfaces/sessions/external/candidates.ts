import {
  decodeIndexCursor,
  encodeIndexCursor,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import type {
  CodexRolloutCandidateScanBoundary,
} from '../../../rollout/discovery/candidates.js';

const DEFAULT_APP_SERVER_LIST_BUDGET_MS = 3_000;

export const encodeCodexExternalSessionIndexCursor = encodeIndexCursor;

export const decodeCodexExternalSessionIndexCursor = (raw: string | undefined): number => decodeIndexCursor(raw) ?? 0;

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
    return record.v === 4
      && record.kind === 'codexRolloutCandidateScan'
      && sourceGeneration
      && containerKey
      && fileName
      && scanned !== null
      ? { sourceGeneration, containerKey, fileName, scanned }
      : null;
  } catch {
    return null;
  }
}

export function resolveCodexExternalSessionAppServerListBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APP_SERVER_LIST_BUDGET_MS;
}
