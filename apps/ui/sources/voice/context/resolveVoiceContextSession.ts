import { findSessionListCachedSession } from '@/sync/domains/session/listing/sessionListCacheState';
import type { Session } from '@/sync/domains/state/storageTypes';

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveVoiceContextSessionFromState(sessionId: string, state: unknown): Session | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId || !state || typeof state !== 'object') return null;

  const stateRecord = state as {
    sessions?: Readonly<Record<string, Session | null>> | null | undefined;
  };
  const cachedSession = findSessionListCachedSession(
    state as Parameters<typeof findSessionListCachedSession>[0],
    normalizedSessionId,
  )?.session as Session | null;
  if (cachedSession) return cachedSession;

  return stateRecord.sessions?.[normalizedSessionId] ?? null;
}
