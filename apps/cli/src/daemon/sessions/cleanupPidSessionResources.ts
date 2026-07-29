import { logger } from '@/ui/logger';

export async function retireUpstreamAuthorityBeforeProcessStop(
  params: Readonly<{
    pid: number;
    spawnResourceCleanupByPid:
      Map<number, () => void | Promise<void>>;
  }>,
): Promise<boolean> {
  const cleanup = params.spawnResourceCleanupByPid.get(params.pid);
  if (!cleanup) return true;
  try {
    await cleanup();
  } catch (error) {
    logger.debug(
      '[DAEMON RUN] Failed to retire upstream authority before process stop',
      error,
    );
    return false;
  }
  if (params.spawnResourceCleanupByPid.get(params.pid) === cleanup) {
    params.spawnResourceCleanupByPid.delete(params.pid);
  }
  return true;
}

export async function cleanupPidSessionResources(params: Readonly<{
  pid: number;
  spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
}>): Promise<boolean> {
  const { pid, spawnResourceCleanupByPid, sessionAttachCleanupByPid } = params;

  const attachCleanup = sessionAttachCleanupByPid.get(pid);
  const authorityRetired =
    await retireUpstreamAuthorityBeforeProcessStop({
      pid,
      spawnResourceCleanupByPid,
    });
  if (!authorityRetired) return false;

  if (attachCleanup && sessionAttachCleanupByPid.get(pid) === attachCleanup) {
    try {
      await attachCleanup();
      if (sessionAttachCleanupByPid.get(pid) === attachCleanup) {
        sessionAttachCleanupByPid.delete(pid);
      }
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to cleanup session attach file', error);
      return false;
    }
  }
  return true;
}
