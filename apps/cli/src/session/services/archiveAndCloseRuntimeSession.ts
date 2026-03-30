import type { ApiSessionClient } from '@/api/session/sessionClient';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { Credentials } from '@/persistence';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { delay } from '@/utils/time';

import { setSessionArchivedStateById } from './setSessionArchivedState';

const DEFAULT_ARCHIVE_TIMEOUT_MS = 10_000;
const DEFAULT_ARCHIVE_POLL_INTERVAL_MS = 200;

type RuntimeArchivableSession = Pick<
  ApiSessionClient,
  'sessionId' | 'updateMetadata' | 'sendSessionDeath' | 'flush' | 'close'
>;

function isSessionActiveArchiveError(error: unknown): error is Error & { code: 'session_active' } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'session_active';
}

async function archiveSessionOnceInactive(params: Readonly<{
  token: string;
  sessionId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}>): Promise<void> {
  const deadlineMs = Date.now() + params.timeoutMs;

  while (true) {
    try {
      await setSessionArchivedStateById({
        token: params.token,
        sessionId: params.sessionId,
        archived: true,
      });
      return;
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
      await delay(params.pollIntervalMs);
    }
  }
}

export async function archiveAndCloseRuntimeSession(
  session: RuntimeArchivableSession | null | undefined,
  credentials: Credentials,
  archiveReason?: string | null,
  options?: Readonly<{
    timeoutMs?: number;
    pollIntervalMs?: number;
  }>,
): Promise<void> {
  if (!session) return;

  updateMetadataBestEffort(
    session,
    (currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'archived',
      lifecycleStateSince: Date.now(),
      archivedBy: 'cli',
      archiveReason: archiveReason ?? 'User terminated',
    }),
    '[archiveAndCloseRuntimeSession]',
    'archive',
  );

  session.sendSessionDeath();
  await session.flush();
  await session.close();

  await archiveSessionOnceInactive({
    token: credentials.token,
    sessionId: session.sessionId,
    timeoutMs: options?.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS,
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_ARCHIVE_POLL_INTERVAL_MS,
  });
}
