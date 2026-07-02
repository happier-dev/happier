type CodexExternalSessionIndexCursorV1 = Readonly<{
  v: 1;
  kind: 'index';
  offset: number;
}>;

const DEFAULT_APP_SERVER_LIST_BUDGET_MS = 3_000;

export function encodeCodexExternalSessionIndexCursor(offset: number): string {
  const cursor: CodexExternalSessionIndexCursorV1 = {
    v: 1,
    kind: 'index',
    offset: Math.max(0, Math.trunc(offset)),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCodexExternalSessionIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'index') return 0;
    const offset = typeof record.offset === 'number' && Number.isFinite(record.offset)
      ? Math.trunc(record.offset)
      : 0;
    return Math.max(0, offset);
  } catch {
    return 0;
  }
}

export function resolveCodexExternalSessionAppServerListBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APP_SERVER_LIST_BUDGET_MS;
}
