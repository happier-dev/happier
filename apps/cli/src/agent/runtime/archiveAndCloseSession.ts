import type { ApiSessionClient } from '@/api/session/sessionClient';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';

export async function archiveAndCloseSession(session: ApiSessionClient | null | undefined): Promise<void> {
  if (!session) return;

  updateMetadataBestEffort(
    session,
    (currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'archived',
      lifecycleStateSince: Date.now(),
      archivedBy: 'cli',
      archiveReason: 'User terminated',
    }),
    '[archiveAndCloseSession]',
    'archive',
  );
  session.sendSessionDeath();
  await session.flush();
  await session.close();
}
