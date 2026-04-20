import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { delay } from '@/utils/time';

import { setSessionArchivedStateById } from './setSessionArchivedState';

const DEFAULT_ARCHIVE_TIMEOUT_MS = 10_000;
const DEFAULT_ARCHIVE_POLL_INTERVAL_MS = 200;

export function isSessionActiveArchiveError(error: unknown): error is Error & { code: 'session_active' } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'session_active';
}

export async function archiveSessionOnceInactive(params: Readonly<{
  token: string;
  sessionId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>): Promise<Readonly<{ archivedAt: number | null }>> {
  const deadlineMs = Date.now() + (params.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS);
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_ARCHIVE_POLL_INTERVAL_MS;

  while (true) {
    try {
      return await setSessionArchivedStateById({
        token: params.token,
        sessionId: params.sessionId,
        archived: true,
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
      token: params.token,
      sessionId: params.sessionId,
    }).catch(() => null);

    if (!rawSession || rawSession.active === true) {
      await delay(pollIntervalMs);
    }
  }
}
