import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storage';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function resolveServerIdForSessionIdFromLocalState(
  state: Readonly<{
    sessions?: Record<string, { serverId?: unknown } | null> | null | undefined;
    sessionListViewDataByServerId?: Record<string, SessionListViewItem[] | null> | null | undefined;
  }>,
  sessionId: string,
): string | null {
  const sid = normalizeId(sessionId);
  if (!sid) return null;

  const direct = state.sessions?.[sid];
  const serverId = typeof direct?.serverId === 'string' ? normalizeId(direct.serverId) : '';
  if (serverId) return serverId;

  return resolveServerIdForSessionIdFromSessionListCache(state.sessionListViewDataByServerId, sid);
}

export function resolveServerIdForSessionIdFromSessionListCache(
  sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null> | null | undefined,
  sessionId: string,
): string | null {
  const sid = normalizeId(sessionId);
  if (!sid) return null;

  const byServer = sessionListViewDataByServerId ?? {};
  for (const [serverId, items] of Object.entries(byServer)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || item.type !== 'session') continue;
      if (normalizeId((item as any)?.session?.id) === sid) return normalizeId(serverId) || null;
    }
  }
  return null;
}

export function resolveServerIdForSessionIdFromLocalCache(sessionId: string): string | null {
  const state = storage.getState() as any;
  return resolveServerIdForSessionIdFromLocalState(
    {
      sessions: state?.sessions ?? null,
      sessionListViewDataByServerId: state?.sessionListViewDataByServerId ?? null,
    },
    sessionId,
  );
}
