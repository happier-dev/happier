import type { RawSessionListRow } from '@/sessionControl/sessionsHttp';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function readSessionId(row: RawSessionListRow): string | null {
  const id = typeof (row as any)?.id === 'string' ? String((row as any).id) : '';
  const trimmed = id.trim();
  return trimmed ? trimmed : null;
}

function readUpdatedAtMs(row: RawSessionListRow): number {
  const candidates = [(row as any)?.updatedAt, (row as any)?.activeAt, (row as any)?.createdAt];
  for (const raw of candidates) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 0;
}

export function selectSessionsForBackfill(params: Readonly<{
  sessions: ReadonlyArray<RawSessionListRow>;
  backfillPolicy: 'new_only' | 'last_30_days' | 'all_history';
  nowMs: number;
}>): Readonly<{ sessionIds: string[]; shouldStopPaging: boolean }> {
  const now = Number.isFinite(params.nowMs) ? Math.max(0, Math.trunc(params.nowMs)) : 0;
  const threshold = Math.max(0, now - THIRTY_DAYS_MS);
  const sessionIds: string[] = [];

  for (const row of params.sessions) {
    const id = readSessionId(row);
    if (!id) continue;

    if (params.backfillPolicy === 'last_30_days') {
      const updatedAtMs = readUpdatedAtMs(row);
      if (updatedAtMs > 0 && updatedAtMs < threshold) {
        return { sessionIds, shouldStopPaging: true };
      }
    }

    sessionIds.push(id);
  }

  return { sessionIds, shouldStopPaging: false };
}
