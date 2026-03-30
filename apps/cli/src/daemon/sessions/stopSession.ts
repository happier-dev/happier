import { logger } from '@/ui/logger';
import { TmuxUtilities } from '@/integrations/tmux/TmuxUtilities';

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

      if (session.startedBy === 'daemon') {
        const terminal = session.spawnOptions?.terminal;
        const tmuxTmpDirFromSpawn =
          terminal?.mode === 'tmux' && typeof terminal.tmux?.tmpDir === 'string' ? terminal.tmux.tmpDir.trim() : '';
        const tmuxTmpDir =
          typeof session.tmuxTmpDir === 'string' && session.tmuxTmpDir.trim().length > 0
            ? session.tmuxTmpDir.trim()
            : tmuxTmpDirFromSpawn;
        const tmuxEnv = tmuxTmpDir ? { TMUX_TMPDIR: tmuxTmpDir } : undefined;
        const uid = typeof (process as any).getuid === 'function' ? ((process as any).getuid() as number) : null;
        const socketPath = tmuxTmpDir && uid !== null ? `${tmuxTmpDir}/tmux-${uid}/default` : undefined;

        const tmux = new TmuxUtilities(undefined, tmuxEnv, socketPath);

        const tmuxWindowTarget = typeof session.tmuxSessionId === 'string' ? session.tmuxSessionId.trim() : '';
        if (tmuxWindowTarget) {
          let killed = await tmux.killWindow(tmuxWindowTarget);
          if (!killed) {
            const direct = await tmux.executeTmuxCommand(['kill-window', '-t', tmuxWindowTarget], undefined, undefined, undefined, socketPath);
            killed = direct !== null && direct.returncode === 0;
            if (!killed) {
              logger.debug(
                `[DAEMON RUN] Failed to kill tmux window for daemon-spawned session ${normalizedSessionId} (${tmuxWindowTarget})`,
              );
            }
          }
          if (killed) {
            session.stopRequestedAtMs = Date.now();
            logger.debug(`[DAEMON RUN] Killed tmux window for daemon-spawned session ${normalizedSessionId} (${tmuxWindowTarget})`);
            stoppedAny = true;
            continue;
          }
        }

        // If we haven't recorded a window target yet (e.g. stop requested during spawn/respawn),
        // fall back to killing the whole tmux session when the spawn was isolated/dedicated.
        const tmuxSessionName =
          terminal?.mode === 'tmux' && typeof terminal.tmux?.sessionName === 'string' ? terminal.tmux.sessionName.trim() : '';
        const isolated = terminal?.mode === 'tmux' && terminal.tmux?.isolated === true;
        if (!tmuxWindowTarget && tmuxSessionName && (isolated || tmuxTmpDir)) {
          const res = await tmux.executeTmuxCommand(['kill-session'], tmuxSessionName, undefined, undefined, socketPath);
          if (res !== null && res.returncode === 0) {
            session.stopRequestedAtMs = Date.now();
            logger.debug(`[DAEMON RUN] Killed isolated tmux session for daemon-spawned session ${normalizedSessionId} (${tmuxSessionName})`);
            stoppedAny = true;
            continue;
          }
          logger.debug(
            `[DAEMON RUN] Failed to kill isolated tmux session for daemon-spawned session ${normalizedSessionId} (${tmuxSessionName})`,
          );
        }
      }

      if (session.startedBy === 'daemon' && session.childProcess) {
        try {
          try {
            // Prefer killing the full process group when the daemon spawned a detached session runner.
            process.kill(-pid, 'SIGTERM');
            session.stopRequestedAtMs = Date.now();
            logger.debug(
              `[DAEMON RUN] Sent SIGTERM to daemon-spawned session process group ${normalizedSessionId} (pid=${pid})`,
            );
            stoppedAny = true;
            continue;
          } catch {
            // fall through
          }

          session.childProcess.kill('SIGTERM');
          session.stopRequestedAtMs = Date.now();
          logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${normalizedSessionId} (pid=${pid})`);
          stoppedAny = true;
        } catch (error) {
          logger.debug(`[DAEMON RUN] Failed to kill session ${normalizedSessionId} (pid=${pid}):`, error);
        }
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
        session.stopRequestedAtMs = Date.now();
        logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid} (${normalizedSessionId})`);
        stoppedAny = true;
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
      }
    }

    if (stoppedAny) {
      logger.debug(`[DAEMON RUN] Stop requested for session ${normalizedSessionId}; waiting for exit observation`);
    }
    return stoppedAny;
  };
}
