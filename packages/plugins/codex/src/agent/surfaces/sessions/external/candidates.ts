import {
  decodeIndexCursor,
  encodeIndexCursor,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import type {
  CodexRolloutCandidatePageBoundary,
} from '../../../rollout/discovery/candidates.js';

const DEFAULT_APP_SERVER_LIST_BUDGET_MS = 3_000;

export const encodeCodexExternalSessionIndexCursor = encodeIndexCursor;

export const decodeCodexExternalSessionIndexCursor = (raw: string | undefined): number => decodeIndexCursor(raw) ?? 0;

type CodexExternalSessionCandidateCursorV2 = Readonly<{
  v: 2;
  kind: 'codexRolloutCandidatePage';
  sourceGeneration: string;
  containerKey: string;
  fileName: string;
}>;

export function encodeCodexExternalSessionCandidateCursor(
  boundary: CodexRolloutCandidatePageBoundary,
): string {
  const cursor: CodexExternalSessionCandidateCursorV2 = {
    v: 2,
    kind: 'codexRolloutCandidatePage',
    ...boundary,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCodexExternalSessionCandidateCursor(
  raw: string | undefined,
): CodexRolloutCandidatePageBoundary | null {
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
    const containerKey =
      typeof record.containerKey === 'string' ? record.containerKey.trim() : '';
    const fileName =
      typeof record.fileName === 'string' ? record.fileName.trim() : '';
    return record.v === 2
      && record.kind === 'codexRolloutCandidatePage'
      && sourceGeneration
      && containerKey
      && fileName
      ? { sourceGeneration, containerKey, fileName }
      : null;
  } catch {
    return null;
  }
}

export function resolveCodexExternalSessionAppServerListBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APP_SERVER_LIST_BUDGET_MS;
}
