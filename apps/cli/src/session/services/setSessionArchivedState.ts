import type { Credentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { archiveSession, unarchiveSession } from '@/session/transport/http/sessionsHttp';

export async function setSessionArchivedStateById(params: Readonly<{
  token: string;
  sessionId: string;
  archived: boolean;
}>): Promise<Readonly<{ archivedAt: number | null }>> {
  const result = params.archived
    ? await archiveSession({
        token: params.token,
        sessionId: params.sessionId,
      })
    : await unarchiveSession({
        token: params.token,
        sessionId: params.sessionId,
      });

  return {
    archivedAt: result.archivedAt,
  };
}

export async function archiveSessionByIdBestEffort(params: Readonly<{ token: string; sessionId: string }>): Promise<void> {
  try {
    await setSessionArchivedStateById({
      token: params.token,
      sessionId: params.sessionId,
      archived: true,
    });
  } catch {
    // Best-effort only.
  }
}

export async function setSessionArchivedState(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  archived: boolean;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; archivedAt: number | null }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>
> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  const result = await setSessionArchivedStateById({
    token: params.credentials.token,
    sessionId: resolved.sessionId,
    archived: params.archived,
  });

  return {
    ok: true,
    sessionId: resolved.sessionId,
    archivedAt: result.archivedAt,
  };
}
