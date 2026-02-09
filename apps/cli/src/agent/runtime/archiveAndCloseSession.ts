import type { ApiSessionClient } from '@/api/session/sessionClient';

export async function archiveAndCloseSession(session: ApiSessionClient | null | undefined): Promise<void> {
  if (!session) return;

  session.updateMetadata((currentMetadata) => ({
    ...currentMetadata,
    lifecycleState: 'archived',
    lifecycleStateSince: Date.now(),
    archivedBy: 'cli',
    archiveReason: 'User terminated',
  }));
  session.sendSessionDeath();
  await session.flush();
  await session.close();
}
