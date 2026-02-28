import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { findHappyProcessByPid } from '../doctor';
import type { TrackedSession } from '../types';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';

function resolveTildePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return inputPath;
}

/**
 * Get the parent PID of a process.
 *
 * Used to detect wrapper-script scenarios where the daemon spawns a wrapper
 * (e.g. Node.js entrypoint) that in turn spawns the actual session binary.
 * Returns null on Windows or if the lookup fails.
 */
function getParentPid(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const stdout = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 1000 });
    const ppid = parseInt(stdout.trim(), 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

export function createOnHappySessionWebhook(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  findHappyProcessByPidFn?: typeof findHappyProcessByPid;
  writeSessionMarkerFn?: typeof writeSessionMarker;
}>): (sessionId: string, sessionMetadata: Metadata) => void {
  const {
    pidToTrackedSession,
    pidToAwaiter,
    findHappyProcessByPidFn = findHappyProcessByPid,
    writeSessionMarkerFn = writeSessionMarker,
  } = params;

  return (sessionId: string, sessionMetadata: Metadata) => {
    const normalizedPath = resolveTildePath(sessionMetadata.path);
    const normalizedMetadata =
      normalizedPath === sessionMetadata.path ? sessionMetadata : { ...sessionMetadata, path: normalizedPath };

    logger.debugLargeJson(`[DAEMON RUN] Session reported`, normalizedMetadata);

    // Safety: ignore cross-daemon/cross-stack reports.
    if (normalizedMetadata?.happyHomeDir && normalizedMetadata.happyHomeDir !== configuration.happyHomeDir) {
      logger.debug(`[DAEMON RUN] Ignoring session report for different happyHomeDir: ${normalizedMetadata.happyHomeDir}`);
      return;
    }

    const pid = normalizedMetadata.hostPid;
    if (!pid) {
      logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
      return;
    }

    logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${normalizedMetadata.startedBy || 'unknown'}`);
    logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

    // Check if we already have this PID (daemon-spawned)
    const existingSession = pidToTrackedSession.get(pid);

    if (existingSession) {
      const pidPlaceholderSessionId = `PID-${pid}`;
      const isPidPlaceholderSessionId = sessionId === pidPlaceholderSessionId;

      // Update tracked session with latest webhook data.
      existingSession.happySessionId = sessionId;
      existingSession.happySessionMetadataFromLocalWebhook = normalizedMetadata;
      if (existingSession.startedBy === 'daemon') {
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          if (isPidPlaceholderSessionId) {
            logger.debug(
              `[DAEMON RUN] Deferred awaiter resolution for PID ${pid}; waiting for canonical session id`,
            );
          } else {
            pidToAwaiter.delete(pid);
            awaiter(existingSession);
            logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
          }
        }
      } else if (existingSession.reattachedFromDiskMarker) {
        existingSession.startedBy = normalizedMetadata.startedBy ?? existingSession.startedBy;
        logger.debug(`[DAEMON RUN] Refreshed reattached session ${sessionId} metadata`);
      } else {
        existingSession.startedBy = 'happy directly - likely by user from terminal';
        logger.debug(`[DAEMON RUN] Refreshed externally-started session ${sessionId}`);
      }
    } else if (!existingSession) {
      // PID not in tracked map. Check if this is a child of a tracked PID —
      // this happens when a wrapper script (e.g. Node.js entrypoint) spawns
      // the actual session binary as a child process, causing a PID mismatch
      // between what the daemon spawned and what the session reports.
      const ppid = getParentPid(pid);
      const parentSession = ppid ? pidToTrackedSession.get(ppid) : null;

      if (parentSession && parentSession.startedBy === 'daemon') {
        // Re-key the tracked session from wrapper PID to actual session PID
        pidToTrackedSession.delete(ppid);
        parentSession.pid = pid;
        parentSession.happySessionId = sessionId;
        parentSession.happySessionMetadataFromLocalWebhook = normalizedMetadata;
        pidToTrackedSession.set(pid, parentSession);
        logger.debug(`[DAEMON RUN] Re-keyed daemon session from wrapper PID ${ppid} to actual PID ${pid}`);

        // Resolve any awaiter that was waiting on the wrapper PID
        const awaiter = pidToAwaiter.get(ppid);
        if (awaiter) {
          pidToAwaiter.delete(ppid);
          awaiter(parentSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter via parent PID ${ppid}`);
        }
      } else {
        // New session started externally (not by this daemon)
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: normalizedMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    }

    // Best-effort: write/update marker so future daemon restarts can reattach.
    // Also capture a process command hash so reattach/stop can be PID-reuse-safe.
    void (async () => {
      const proc = await findHappyProcessByPidFn(pid);
      const processCommandHash = proc?.command ? hashProcessCommand(proc.command) : undefined;
      if (processCommandHash) {
        // Store on the tracked session too so stopSession can require a match.
        const s = pidToTrackedSession.get(pid);
        if (s) s.processCommandHash = processCommandHash;
      } else {
        logger.debug(`[DAEMON RUN] Could not determine process command for PID ${pid}; marker will be weaker`);
      }

      const tracked = pidToTrackedSession.get(pid) ?? null;
      const respawn =
        tracked?.startedBy === 'daemon' && tracked.spawnOptions
          ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(tracked.spawnOptions)
          : null;

      await writeSessionMarkerFn({
        pid,
        happySessionId: sessionId,
        startedBy: normalizedMetadata.startedBy ?? 'terminal',
        cwd: normalizedPath,
        processCommandHash,
        processCommand: proc?.command,
        metadata: normalizedMetadata,
        ...(respawn ? { respawn } : {}),
      });
    })().catch((e) => {
      logger.debug('[DAEMON RUN] Failed to write session marker', e);
    });
  };
}
