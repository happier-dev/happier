import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import { inferAgentIdFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { execFileSync } from 'node:child_process';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { readCredentials } from '@/persistence';

import { findHappyProcessByPid } from '../doctor';
import type { TrackedSession } from '../types';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';

const DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS = 1000;
const PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PARENT_PID_LOOKUP_TIMEOUT_MS';

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}

function adoptReportedHappySessionId(tracked: TrackedSession, reportedSessionId: string): string {
  const currentSessionId = normalizeNonEmptyString(tracked.happySessionId);
  if (
    tracked.startedBy === 'daemon'
    && currentSessionId
    && !isPidPlaceholderSessionId(currentSessionId)
    && currentSessionId !== reportedSessionId
  ) {
    logger.infoFile('[DAEMON RUN] Ignoring conflicting session identity for an established daemon session', {
      pid: tracked.pid,
      currentSessionId,
      reportedSessionId,
    });
    return currentSessionId;
  }
  tracked.happySessionId = reportedSessionId;
  return reportedSessionId;
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

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveWindowsTerminalWindowId(metadata: Metadata['terminal'] | undefined): string {
  if (metadata?.mode !== 'windows_terminal') return '';
  if (metadata.windows?.host !== 'windows_terminal') return '';
  return normalizeNonEmptyString(metadata.windows.windowId);
}

function resolveWindowsTerminalTitle(metadata: Metadata['terminal'] | undefined): string {
  if (metadata?.mode !== 'windows_terminal') return '';
  if (metadata.windows?.host !== 'windows_terminal') return '';
  return normalizeNonEmptyString(metadata.windows.title);
}

function findPendingWindowsTerminalTrackedSession(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  webhookPid: number;
  metadata: Metadata;
}>): TrackedSession | null {
  if (params.metadata.startedBy !== 'daemon') return null;

  const webhookWindowId = resolveWindowsTerminalWindowId(params.metadata.terminal);
  if (!webhookWindowId) return null;
  const webhookTitle = resolveWindowsTerminalTitle(params.metadata.terminal);

  const matches: TrackedSession[] = [];
  for (const [trackedPid, tracked] of params.pidToTrackedSession.entries()) {
    if (trackedPid === params.webhookPid) continue;
    if (tracked.startedBy !== 'daemon') continue;
    if (!params.pidToAwaiter.has(trackedPid)) continue;

    const trackedWindowId = resolveWindowsTerminalWindowId(tracked.hostedTerminal);
    if (trackedWindowId !== webhookWindowId) continue;
    const trackedTitle = resolveWindowsTerminalTitle(tracked.hostedTerminal);
    if (webhookTitle && trackedTitle !== webhookTitle) continue;
    matches.push(tracked);
  }

  return matches.length === 1 ? matches[0] : null;
}

export function createOnHappySessionWebhook(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  findHappyProcessByPidFn?: typeof findHappyProcessByPid;
  writeSessionMarkerFn?: typeof writeSessionMarker;
  getParentPidFn?: (pid: number) => number | null;
  readCredentialsFn?: typeof readCredentials;
  onTrackedSessionReady?: (tracked: TrackedSession) => Promise<void> | void;
  onTrackedSessionReported?: (tracked: TrackedSession) => Promise<void> | void;
}>): (sessionId: string, sessionMetadata: Metadata) => Promise<void> {
  const {
    pidToTrackedSession,
    pidToAwaiter,
    findHappyProcessByPidFn = findHappyProcessByPid,
    writeSessionMarkerFn = writeSessionMarker,
    getParentPidFn = getParentPid,
    readCredentialsFn = readCredentials,
    onTrackedSessionReady,
    onTrackedSessionReported,
  } = params;

  return async (sessionId: string, sessionMetadata: Metadata) => {
    const normalizedPath = expandHomeDirPath(sessionMetadata.path, process.env);
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
      adoptReportedHappySessionId(existingSession, sessionId);
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
        adoptReportedHappySessionId(trackedByRunnerPid, sessionId);
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
            adoptReportedHappySessionId(parentSession, sessionId);
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
            const windowsTerminalSession = findPendingWindowsTerminalTrackedSession({
              pidToTrackedSession,
              pidToAwaiter,
              webhookPid: pid,
              metadata: normalizedMetadata,
            });
            if (windowsTerminalSession) {
              const wrapperPid = windowsTerminalSession.pid;
              trackedForPid = windowsTerminalSession;
              windowsTerminalSession.sessionRunnerPid = pid;
              adoptReportedHappySessionId(windowsTerminalSession, sessionId);
              windowsTerminalSession.happySessionMetadataFromLocalWebhook = normalizedMetadata;
              logger.debug(
                `[DAEMON RUN] Matched Windows Terminal webhook PID ${pid} to daemon launch PID ${wrapperPid}`,
              );

              const awaiter = pidToAwaiter.get(wrapperPid);
              if (awaiter) {
                if (isPlaceholderSessionId) {
                  logger.debug(
                    `[DAEMON RUN] Deferred awaiter resolution for Windows Terminal PID ${wrapperPid}; waiting for canonical session id`,
                  );
                } else {
                  pidToAwaiter.delete(wrapperPid);
                  awaiter(windowsTerminalSession);
                  logger.debug(`[DAEMON RUN] Resolved session awaiter via Windows Terminal PID ${wrapperPid}`);
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
    }

    if (trackedForPid) {
      const agentId = inferAgentIdFromSessionMetadata(normalizedMetadata);
      const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, normalizedMetadata);
      if (vendorResumeId) trackedForPid.vendorResumeId = vendorResumeId;
      if (!isPlaceholderSessionId) {
        // Best-effort report observers must not wait on strict startup reconciliation:
        // terminal-host serviceability is produced by this exact report and is independently useful.
        const reportObserverFailure = (error: unknown): void => {
          logger.debug('[DAEMON RUN] Tracked session reported callback failed', error);
        };
        try {
          void Promise.resolve(onTrackedSessionReported?.(trackedForPid)).catch(reportObserverFailure);
        } catch (error) {
          reportObserverFailure(error);
        }
        if (trackedForPid.startedBy === 'daemon' && onTrackedSessionReady) {
          await onTrackedSessionReady(trackedForPid);
        }
      }
    }

    // Best-effort: write/update marker so future daemon restarts can reattach.
    // Also capture a process command hash so reattach/stop can be PID-reuse-safe.
    void (async () => {
      const proc = await findHappyProcessByPidFn(pid);
      const discoveredProcessCommand =
        typeof proc?.command === 'string' && proc.command.trim().length > 0 ? proc.command : undefined;
      const trackedProcessCommand =
        typeof trackedForPid?.processCommand === 'string' && trackedForPid.processCommand.trim().length > 0
          ? trackedForPid.processCommand
          : undefined;
      const daemonChildSpawnArgsCommand =
        trackedForPid?.startedBy === 'daemon' &&
        Array.isArray(trackedForPid.childProcess?.spawnargs) &&
        trackedForPid.childProcess.spawnargs.length > 0
          ? trackedForPid.childProcess.spawnargs
              .filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
              .join(' ')
          : undefined;
      const processCommand = discoveredProcessCommand ?? trackedProcessCommand ?? daemonChildSpawnArgsCommand;
      const processCommandHash = processCommand ? hashProcessCommand(processCommand) : undefined;
      const processInstanceFingerprint = readProcessInstanceFingerprintSync(pid)
        ?? trackedForPid?.processInstanceFingerprint;
      if (processCommandHash) {
        // Store on the tracked session too so stopSession can require a match.
        if (trackedForPid) {
          trackedForPid.processCommandHash = processCommandHash;
          trackedForPid.processCommand = processCommand;
        }
      } else {
        logger.debug(`[DAEMON RUN] Could not determine process command for PID ${pid}; marker will be weaker`);
      }
      if (trackedForPid && processInstanceFingerprint) {
        trackedForPid.processInstanceFingerprint = processInstanceFingerprint;
      }

      const storedCredentials =
        trackedForPid?.startedBy === 'daemon' && trackedForPid.spawnOptions
          ? await readCredentialsFn().catch(() => null)
          : null;
      const trackedVendorResumeId =
        typeof trackedForPid?.vendorResumeId === 'string' && trackedForPid.vendorResumeId.trim().length > 0
          ? trackedForPid.vendorResumeId.trim()
          : undefined;
      const respawn =
        trackedForPid?.startedBy === 'daemon' && trackedForPid.spawnOptions
          ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
            trackedForPid.spawnOptions,
            {
              ...(storedCredentials ? { encryptionMaterial: storedCredentials.encryption } : {}),
              ...(trackedVendorResumeId ? { vendorResumeId: trackedVendorResumeId } : {}),
            },
          )
          : null;
      await writeSessionMarkerFn({
        pid,
        happySessionId: trackedForPid?.happySessionId ?? sessionId,
        startedBy: normalizedMetadata.startedBy ?? 'terminal',
        cwd: normalizedPath,
        processCommandHash,
        processInstanceFingerprint,
        processCommand,
        metadata: normalizedMetadata,
        ...(respawn ? { respawn } : {}),
        ...(trackedForPid?.activeTurnId ? { activeTurnId: trackedForPid.activeTurnId } : {}),
      });
    })().catch((e) => {
      logger.debug('[DAEMON RUN] Failed to write session marker', e);
    });
  };
}
