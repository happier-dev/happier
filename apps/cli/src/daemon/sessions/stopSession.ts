import { logger } from '@/ui/logger';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';

export function createStopSession(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
}>): (sessionId: string) => Promise<boolean> {
  const { pidToTrackedSession } = params;

  // Stop a session by sessionId or PID fallback
  return async (sessionId: string): Promise<boolean> => {
    logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

    const normalizedSessionId = String(sessionId ?? '').trim();
    const isPidFallback = normalizedSessionId.startsWith('PID-');
    const fallbackPid = isPidFallback ? Number.parseInt(normalizedSessionId.replace('PID-', ''), 10) : NaN;

    const pidsToStop: number[] = [];
    for (const [pid, session] of pidToTrackedSession.entries()) {
      const happySessionId = typeof session.happySessionId === 'string' ? session.happySessionId : '';
      const existingSessionId =
        session.spawnOptions && typeof (session.spawnOptions as any).existingSessionId === 'string'
          ? String((session.spawnOptions as any).existingSessionId).trim()
          : '';
      const matches =
        happySessionId === normalizedSessionId ||
        existingSessionId === normalizedSessionId ||
        (isPidFallback && Number.isFinite(fallbackPid) && pid === fallbackPid);
      if (matches) pidsToStop.push(pid);
    }

    if (pidsToStop.length === 0) {
      logger.debug(`[DAEMON RUN] Session ${normalizedSessionId} not found`);
      return false;
    }

    let stoppedAny = false;
    for (const pid of pidsToStop) {
      const session = pidToTrackedSession.get(pid);
      if (!session) continue;

      if (session.startedBy === 'daemon' && session.childProcess) {
        try {
          try {
            // Prefer killing the full process group when the daemon spawned a detached session runner.
            process.kill(-pid, 'SIGTERM');
            logger.debug(
              `[DAEMON RUN] Sent SIGTERM to daemon-spawned session process group ${normalizedSessionId} (pid=${pid})`,
            );
            stoppedAny = true;
            pidToTrackedSession.delete(pid);
            continue;
          } catch {
            // fall through
          }

          session.childProcess.kill('SIGTERM');
          logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${normalizedSessionId} (pid=${pid})`);
          stoppedAny = true;
        } catch (error) {
          logger.debug(`[DAEMON RUN] Failed to kill session ${normalizedSessionId} (pid=${pid}):`, error);
        }
        pidToTrackedSession.delete(pid);
        continue;
      }

      // PID reuse safety: verify the PID still looks like a Happy session process (and matches hash if known).
      const safe = await isPidSafeHappySessionProcess({ pid, expectedProcessCommandHash: session.processCommandHash });
      if (!safe) {
        logger.warn(`[DAEMON RUN] Refusing to SIGTERM PID ${pid} for session ${normalizedSessionId} (PID reuse safety)`);
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid} (${normalizedSessionId})`);
        stoppedAny = true;
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
      }

      pidToTrackedSession.delete(pid);
    }

    if (stoppedAny) {
      logger.debug(`[DAEMON RUN] Removed session ${normalizedSessionId} from tracking`);
    }
    return stoppedAny;
  };
}
