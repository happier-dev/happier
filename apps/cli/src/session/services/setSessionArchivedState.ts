import type { StoredCredentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';
import { requestSessionStop } from './requestSessionStop';
import { isSessionActiveArchiveError, setSessionArchivedStateById } from './sessionArchivedStateById';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';

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
  originRunId?: string;
  signal?: AbortSignal;
  externalAction?: Parameters<typeof requestSessionStop>[0]['externalAction'];
  resolveAuthorizationHeaders?: Parameters<typeof requestSessionStop>[0]['resolveAuthorizationHeaders'];
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; archivedAt: number | null }>
  | Extract<Awaited<ReturnType<typeof requestSessionStop>>, { ok: false }>
> {
  const actionId = params.archived ? 'session.archive' : 'session.unarchive';
  const signal = params.signal ?? params.externalAction?.context.signal;
  signal?.throwIfAborted();
  const rootRequestId = params.externalAction?.context.actionRequestId;
  const resolved = await runTracedExternalActionStage(actionId, rootRequestId, 'session_archive.resolve_session', () => resolveSessionIdOrPrefix({
    reason: 'session-control',
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(signal ? { signal } : {}),
    ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
  }));
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  let result;
  try {
    result = await runTracedExternalActionStage(actionId, rootRequestId, 'session_archive.http', () => setSessionArchivedStateById({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      archived: params.archived,
      ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
      ...(signal ? { signal } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    }));
  } catch (error) {
    if (!params.archived || !isSessionActiveArchiveError(error)) {
      throw error;
    }

    const stopResult = await requestSessionStop({
      credentials: params.credentials,
      idOrPrefix: resolved.sessionId,
      stopIntent: 'lifecycle_control',
      ...(signal ? { signal } : {}),
      ...(params.externalAction ? { externalAction: { ...params.externalAction, effectActionId: 'session.stop' } } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    });
    if (!stopResult.ok) {
      return stopResult;
    }

    result = await archiveSessionOnceInactive({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
      ...(signal ? { signal } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    });
  }

  return {
    ok: true,
    sessionId: resolved.sessionId,
    archivedAt: result.archivedAt,
  };
}
