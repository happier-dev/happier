import type { StoredCredentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';
import { requestSessionStop } from './requestSessionStop';
import { isSessionActiveArchiveError, setSessionArchivedStateById } from './sessionArchivedStateById';

export { setSessionArchivedStateById } from './sessionArchivedStateById';

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
  credentials: StoredCredentials;
  idOrPrefix: string;
  archived: boolean;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; archivedAt: number | null }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] }>
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

  let result;
  try {
    result = await setSessionArchivedStateById({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      archived: params.archived,
    });
  } catch (error) {
    if (!params.archived || !isSessionActiveArchiveError(error)) {
      throw error;
    }

    const stopResult = await requestSessionStop({
      credentials: params.credentials,
      idOrPrefix: resolved.sessionId,
    });
    if (!stopResult.ok) {
      return {
        ok: false,
        code: stopResult.code,
        ...(stopResult.candidates ? { candidates: stopResult.candidates } : {}),
      };
    }

    result = await archiveSessionOnceInactive({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
    });
  }

  return {
    ok: true,
    sessionId: resolved.sessionId,
    archivedAt: result.archivedAt,
  };
}
