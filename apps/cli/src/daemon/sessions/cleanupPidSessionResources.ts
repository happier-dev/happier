import { logger } from '@/ui/logger';

export async function cleanupPidSessionResources(params: Readonly<{
  pid: number;
  spawnResourceCleanupByPid: Map<number, () => void>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
}>): Promise<void> {
  const { pid, spawnResourceCleanupByPid, sessionAttachCleanupByPid } = params;

  const cleanup = spawnResourceCleanupByPid.get(pid);
  if (cleanup) {
    spawnResourceCleanupByPid.delete(pid);
    try {
      cleanup();
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to cleanup spawn resources', error);
    }
  }

  const attachCleanup = sessionAttachCleanupByPid.get(pid);
  if (attachCleanup) {
    sessionAttachCleanupByPid.delete(pid);
    try {
      await attachCleanup();
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to cleanup session attach file', error);
    }
  }
}
