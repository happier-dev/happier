import { archiveSession, unarchiveSession } from '@/session/transport/http/sessionsHttp';
import type { SessionStopOutcome } from '@happier-dev/protocol/sessions/control/contract';

export function isSessionActiveArchiveError(error: unknown): error is Error & { code: 'session_active' } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'session_active';
}

export async function setSessionArchivedStateById(params: Readonly<{
  token: string;
  sessionId: string;
  archived: boolean;
  originRunId?: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof archiveSession>[0]['resolveAuthorizationHeaders'];
}>): Promise<Readonly<{ archivedAt: number | null; stopOutcome?: SessionStopOutcome }>> {
  return params.archived
    ? await archiveSession({
        token: params.token,
        sessionId: params.sessionId,
        ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      })
    : await unarchiveSession({
        token: params.token,
        sessionId: params.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      });
}
