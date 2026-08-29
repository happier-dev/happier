import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
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
  const directSession = stateRecord.sessions?.[normalizedSessionId] ?? null;
  if (directSession && (
    directSession.metadataLayoutVersion !== undefined
    && directSession.metadataLayoutVersion !== 0
  )) {
    return directSession;
  }

  const lookupSession = findSessionListLookupSession(
    state as Parameters<typeof findSessionListLookupSession>[0],
    normalizedSessionId,
  )?.session as Session | null;
  if (lookupSession) return lookupSession;

  return directSession;
}
