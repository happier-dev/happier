import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { findHappyProcessByPid } from '../doctor';
import type { TrackedSession } from '../types';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';

const DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS = 1000;
const PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PARENT_PID_LOOKUP_TIMEOUT_MS';

function resolveTildePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return inputPath;
}

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}

function resolveParentPidLookupTimeoutMs(): number {
  const raw = String(process.env[PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY] ?? '').trim();
  if (!raw) return DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS;
  // Keep this intentionally small: this runs on a webhook path.
  return Math.max(50, Math.min(parsed, 5000));
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
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    const stdout = execFileSync(
      'ps',
      ['-o', 'ppid=', '-p', String(pid)],
      { encoding: 'utf-8', timeout: resolveParentPidLookupTimeoutMs(), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const ppid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(ppid) || ppid <= 0) return null;
    return ppid;
  } catch {
    return null;
  }
}

function findTrackedSessionByRunnerPid(
  pidToTrackedSession: Map<number, TrackedSession>,
  runnerPid: number,
): TrackedSession | null {
  for (const tracked of pidToTrackedSession.values()) {
    if (tracked.sessionRunnerPid === runnerPid) return tracked;
  }
  return null;
}

export function createOnHappySessionWebhook(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  findHappyProcessByPidFn?: typeof findHappyProcessByPid;
  writeSessionMarkerFn?: typeof writeSessionMarker;
  getParentPidFn?: (pid: number) => number | null;
}>): (sessionId: string, sessionMetadata: Metadata) => void {
  const {
    pidToTrackedSession,
    pidToAwaiter,
    findHappyProcessByPidFn = findHappyProcessByPid,
    writeSessionMarkerFn = writeSessionMarker,
    getParentPidFn = getParentPid,
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

    const pidRaw = normalizedMetadata.hostPid;
    if (typeof pidRaw !== 'number' || !Number.isInteger(pidRaw) || pidRaw <= 0) {
      logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
      return;
    }
    const pid = pidRaw;

    logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${normalizedMetadata.startedBy || 'unknown'}`);
    logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

    // Check if we already have this PID (daemon-spawned)
    const existingSession = pidToTrackedSession.get(pid);
    const isPlaceholderSessionId = isPidPlaceholderSessionId(sessionId);
    let trackedForPid: TrackedSession | null = null;

    if (existingSession) {
      trackedForPid = existingSession;

      // Update tracked session with latest webhook data.
      existingSession.happySessionId = sessionId;
      existingSession.happySessionMetadataFromLocalWebhook = normalizedMetadata;
      if (existingSession.startedBy === 'daemon') {
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          if (isPlaceholderSessionId) {
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
      // PID not in tracked map. This can happen for:
      // - externally-started sessions, OR
      // - wrapper-script scenarios where the daemon spawned a wrapper PID (parent),
      //   but the webhook reports the actual session binary PID (child).
      //
      // First: check if we already associated this runner PID with a tracked daemon session.
      const trackedByRunnerPid = findTrackedSessionByRunnerPid(pidToTrackedSession, pid);
      if (trackedByRunnerPid) {
        trackedForPid = trackedByRunnerPid;
        trackedByRunnerPid.happySessionId = sessionId;
        trackedByRunnerPid.happySessionMetadataFromLocalWebhook = normalizedMetadata;
        logger.debug(`[DAEMON RUN] Refreshed daemon session via previously recorded runner PID ${pid}`);

        if (trackedByRunnerPid.startedBy === 'daemon') {
          const wrapperPid = trackedByRunnerPid.pid;
          const awaiter = pidToAwaiter.get(wrapperPid);
          if (awaiter) {
            if (isPlaceholderSessionId) {
              logger.debug(
                `[DAEMON RUN] Deferred awaiter resolution for wrapper PID ${wrapperPid}; waiting for canonical session id`,
              );
            } else {
              pidToAwaiter.delete(wrapperPid);
              awaiter(trackedByRunnerPid);
              logger.debug(`[DAEMON RUN] Resolved session awaiter via wrapper PID ${wrapperPid}`);
            }
          }
        }
      } else {
        // Heuristic: only attempt PPID correlation when at least one daemon spawn is in-flight.
        // This keeps the webhook path fast for the common case of externally-started sessions.
        if (pidToAwaiter.size === 0) {
          const trackedSession: TrackedSession = {
            startedBy: 'happy directly - likely by user from terminal',
            happySessionId: sessionId,
            happySessionMetadataFromLocalWebhook: normalizedMetadata,
            pid
          };
          trackedForPid = trackedSession;
          pidToTrackedSession.set(pid, trackedSession);
          logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        } else {
          const ppid = getParentPidFn(pid);
          const parentSession = typeof ppid === 'number' ? (pidToTrackedSession.get(ppid) ?? null) : null;
          const hasAwaiter = typeof ppid === 'number' ? pidToAwaiter.has(ppid) : false;
          const hasChildHandle = typeof ppid === 'number' ? parentSession?.childProcess?.pid === ppid : false;
          const parentEligible =
            typeof ppid === 'number' &&
            parentSession?.startedBy === 'daemon' &&
            (hasAwaiter || hasChildHandle);

          if (parentEligible && ppid && parentSession) {
            trackedForPid = parentSession;
            parentSession.sessionRunnerPid = pid;
            parentSession.happySessionId = sessionId;
            parentSession.happySessionMetadataFromLocalWebhook = normalizedMetadata;
            logger.debug(`[DAEMON RUN] Matched session webhook PID ${pid} to daemon wrapper PID ${ppid}`);

            // Resolve any awaiter that was waiting on the wrapper PID.
            const awaiter = pidToAwaiter.get(ppid);
            if (awaiter) {
              if (isPlaceholderSessionId) {
                logger.debug(
                  `[DAEMON RUN] Deferred awaiter resolution for wrapper PID ${ppid}; waiting for canonical session id`,
                );
              } else {
                pidToAwaiter.delete(ppid);
                awaiter(parentSession);
                logger.debug(`[DAEMON RUN] Resolved session awaiter via wrapper PID ${ppid}`);
              }
            }
          } else {
            // New session started externally (not by this daemon)
            const trackedSession: TrackedSession = {
              startedBy: 'happy directly - likely by user from terminal',
              happySessionId: sessionId,
              happySessionMetadataFromLocalWebhook: normalizedMetadata,
              pid
            };
            trackedForPid = trackedSession;
            pidToTrackedSession.set(pid, trackedSession);
            logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
          }
        }
      }
    }

    // Best-effort: write/update marker so future daemon restarts can reattach.
    // Also capture a process command hash so reattach/stop can be PID-reuse-safe.
    void (async () => {
      const proc = await findHappyProcessByPidFn(pid);
      const processCommandHash = proc?.command ? hashProcessCommand(proc.command) : undefined;
      if (processCommandHash) {
        // Store on the tracked session too so stopSession can require a match.
        if (trackedForPid) trackedForPid.processCommandHash = processCommandHash;
      } else {
        logger.debug(`[DAEMON RUN] Could not determine process command for PID ${pid}; marker will be weaker`);
      }

      const respawn =
        trackedForPid?.startedBy === 'daemon' && trackedForPid.spawnOptions
          ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(trackedForPid.spawnOptions)
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
