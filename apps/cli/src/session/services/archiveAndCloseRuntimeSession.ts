import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Credentials } from '@/persistence';
import { resolveSessionArchiveMetadataTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { logger } from '@/ui/logger';

import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';

type RuntimeArchivableSession = Pick<
  ApiSessionClient,
  'sessionId' | 'updateMetadata' | 'sendSessionDeath' | 'flush' | 'close'
>;

async function waitForMetadataWriteOrTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`archive metadata update timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function archiveAndCloseRuntimeSession(
  session: RuntimeArchivableSession | null | undefined,
  credentials: Credentials,
  archiveReason?: string | null,
  options?: Readonly<{
    timeoutMs?: number;
    pollIntervalMs?: number;
    metadataTimeoutMs?: number;
  }>,
): Promise<void> {
  if (!session) return;

  const metadataTimeoutMs = options?.metadataTimeoutMs ?? resolveSessionArchiveMetadataTimeoutMs();
  const metadataWrite = Promise.resolve().then(() => session.updateMetadata(
    (currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'archived',
      lifecycleStateSince: Date.now(),
      archivedBy: 'cli',
      archiveReason: archiveReason ?? 'User terminated',
    }),
  ));
  // Keep this eager catch even though the bounded wait below also catches: if the timeout wins,
  // the metadata promise can still reject later and would otherwise become unhandled.
  metadataWrite.catch(() => {});
  await waitForMetadataWriteOrTimeout(metadataWrite, metadataTimeoutMs).catch((error) => {
    logger.debug('[archiveAndCloseRuntimeSession] Failed to update session metadata (archive) (non-fatal)', error);
  });

  session.sendSessionDeath();
  await session.flush();
  await session.close();

  await archiveSessionOnceInactive({
    token: credentials.token,
    sessionId: session.sessionId,
    timeoutMs: options?.timeoutMs,
    pollIntervalMs: options?.pollIntervalMs,
  });
}
