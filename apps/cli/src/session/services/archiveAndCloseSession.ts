import type { ApiSessionClient } from '@/api/session/sessionClient';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { Credentials } from '@/persistence';
import { archiveSessionOnceInactive } from './archiveSessionOnceInactive';

type RuntimeArchivableSession = Pick<
  ApiSessionClient,
  'sessionId' | 'updateMetadata' | 'sendSessionDeath' | 'flush' | 'close'
>;

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
    timeoutMs: options?.timeoutMs,
    pollIntervalMs: options?.pollIntervalMs,
  });
}
