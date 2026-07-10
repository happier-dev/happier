import {
  decodeIndexCursor,
  encodeIndexCursor,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

const DEFAULT_APP_SERVER_LIST_BUDGET_MS = 3_000;

export const encodeCodexExternalSessionIndexCursor = encodeIndexCursor;

export const decodeCodexExternalSessionIndexCursor = (raw: string | undefined): number => decodeIndexCursor(raw) ?? 0;

export function resolveCodexExternalSessionAppServerListBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APP_SERVER_LIST_BUDGET_MS;
}
