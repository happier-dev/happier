import { normalizeNonEmptyString } from './shared';
import { collectVoiceSessionRows } from './voiceSessionRows';

function normalizeVoiceSessionLookupTitle(value: string | null | undefined): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return null;
  const withoutQuotes = normalized.replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '').trim();
  const withoutTrailingSentencePunctuation = withoutQuotes.replace(/[.!?,;:]+$/g, '').trim();
  return normalizeNonEmptyString(withoutTrailingSentencePunctuation ?? withoutQuotes);
}

export function resolveVoiceSessionRef(
  sessionId: string | null | undefined,
  state: unknown,
  options?: Readonly<{ serverId?: string | null; serverName?: string | null }>,
): Readonly<{ id: string; title?: string; locationLabel?: string; serverId?: string; serverName?: string }> | null {
  const normalizedSessionId = normalizeNonEmptyString(sessionId);
  if (!normalizedSessionId) return null;

  const row = collectVoiceSessionRows(state).find((candidate) => candidate.id === normalizedSessionId);
  const title = row?.title ?? null;
  const locationLabel = row?.locationLabel ?? null;
  const serverId = normalizeNonEmptyString(options?.serverId) ?? row?.serverId ?? null;
  const serverName = normalizeNonEmptyString(options?.serverName) ?? row?.serverName ?? null;

  return {
    id: normalizedSessionId,
    ...(title ? { title } : {}),
    ...(locationLabel ? { locationLabel } : {}),
    ...(serverId ? { serverId } : {}),
    ...(serverName ? { serverName } : {}),
  };
}

export function resolveVoiceSessionIdFromTitle(
  sessionTitle: string | null | undefined,
  state: unknown,
): Readonly<{ sessionId: string; session: Readonly<{ id: string; title?: string; locationLabel?: string; serverId?: string; serverName?: string }> }> | null {
  const normalizedRequestedTitle = normalizeVoiceSessionLookupTitle(sessionTitle);
  if (!normalizedRequestedTitle) return null;

  const rows = collectVoiceSessionRows(state);
  const exact = rows.find((row) => normalizeNonEmptyString(row.title) === normalizedRequestedTitle);
  if (exact) {
    return {
      sessionId: exact.id,
      session: {
        id: exact.id,
        ...(exact.title ? { title: exact.title } : {}),
        ...(exact.locationLabel ? { locationLabel: exact.locationLabel } : {}),
        ...(exact.serverId ? { serverId: exact.serverId } : {}),
        ...(exact.serverName ? { serverName: exact.serverName } : {}),
      },
    };
  }

  const normalizedMatches = rows.filter(
    (row) => normalizeVoiceSessionLookupTitle(row.title) === normalizedRequestedTitle,
  );
  if (normalizedMatches.length !== 1) return null;
  const match = normalizedMatches[0];
  return {
    sessionId: match.id,
    session: {
      id: match.id,
      ...(match.title ? { title: match.title } : {}),
      ...(match.locationLabel ? { locationLabel: match.locationLabel } : {}),
      ...(match.serverId ? { serverId: match.serverId } : {}),
      ...(match.serverName ? { serverName: match.serverName } : {}),
    },
  };
}
