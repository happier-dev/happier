import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import type { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';

import { isSessionActiveArchiveError, setSessionArchivedStateById } from './sessionArchivedStateById';

const DEFAULT_ARCHIVE_TIMEOUT_MS = 10_000;

export async function archiveSessionOnceInactive(params: Readonly<{
  token: string;
  sessionId: string;
  originRunId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof resolveSessionIdOrPrefix>[0]['resolveAuthorizationHeaders'];
}>): Promise<Readonly<{ archivedAt: number | null }>> {
  params.signal?.throwIfAborted();
  const deadlineMs = Date.now() + (params.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS);
  const events = openSessionEventSource(params);
  let inactiveRetryRevision: number | undefined;
  try {
    while (true) {
      params.signal?.throwIfAborted();
      const revision = events.currentRevision();
      try {
        return await setSessionArchivedStateById({
          token: params.token,
          sessionId: params.sessionId,
          archived: true,
          ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        });
      } catch (error) {
        if (!isSessionActiveArchiveError(error)) {
          throw error;
        }
        if (Date.now() >= deadlineMs) {
          throw error;
        }
      }

      const rawSession = await fetchSessionByIdCompat({
        reason: 'session-control',
        token: params.token,
        sessionId: params.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      }).catch(() => { params.signal?.throwIfAborted(); return null; });

      if (!rawSession || rawSession.active !== false || inactiveRetryRevision === revision) {
        if (!(await events.waitForChange(revision, { deadlineMs, signal: params.signal }))) {
          params.signal?.throwIfAborted();
          throw Object.assign(new Error('Cannot archive an active session'), { code: 'session_active' });
        }
      } else {
        // Retry once for this freshly observed inactive fact, not repeatedly on a stale snapshot.
        inactiveRetryRevision = revision;
      }
    }
  } finally {
    await events.close();
  }
}
