import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import {
  inferAgentIdFromSessionMetadata,
  resolveProviderSessionIdForBackendTarget,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { execFileSync } from 'node:child_process';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { readCredentials } from '@/persistence';

import { findHappyProcessByPid } from '../doctor';
import { readProcessRunState } from '../processRunState';
import type { TrackedSession } from '../types';
import { hashProcessCommand, writeSessionMarker } from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';

const DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS = 1000;
const PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PARENT_PID_LOOKUP_TIMEOUT_MS';

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}

export function adoptReportedHappySessionId(tracked: TrackedSession, reportedSessionId: string): string {
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
  metadata: Pick<Metadata, 'startedBy' | 'terminal'>;
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

/** Correlate session identity without publishing webhook readiness or promoting custody. */
export function correlateTrackedSessionReport(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pid: number;
  metadata: Pick<Metadata, 'startedBy' | 'terminal'>;
  getParentPidFn?: (pid: number) => number | null;
}>): TrackedSession | null {
  const { pidToTrackedSession, pidToAwaiter, pid, metadata } = params;
  const direct = pidToTrackedSession.get(pid);
  if (direct) return direct;
  const recordedRunner = findTrackedSessionByRunnerPid(pidToTrackedSession, pid);
  if (recordedRunner) return recordedRunner;
  // Only pending daemon launches perform bounded parent or hosted-tab matching.
  if (pidToAwaiter.size === 0) return null;
  const ppid = (params.getParentPidFn ?? getParentPid)(pid);
  const parent = typeof ppid === 'number' ? pidToTrackedSession.get(ppid) : undefined;
  if (parent?.startedBy === 'daemon' && (pidToAwaiter.has(parent.pid) || parent.childProcess?.pid === parent.pid)) {
    return parent;
  }
  return findPendingWindowsTerminalTrackedSession({ pidToTrackedSession, pidToAwaiter, webhookPid: pid, metadata });
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

  const correlateTrackedReport = (pid: number, metadata: Metadata): TrackedSession | null =>
    correlateTrackedSessionReport({ pidToTrackedSession, pidToAwaiter, pid, metadata, getParentPidFn });

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
    const isPlaceholderSessionId = isPidPlaceholderSessionId(sessionId);
    let trackedForPid = correlateTrackedReport(pid, normalizedMetadata);
    const startReportMarkerWork = (): void => {
      if (!trackedForPid) return;
      const backendTarget = trackedForPid.spawnOptions?.backendTarget;
      const vendorResumeId = backendTarget
        ? resolveProviderSessionIdForBackendTarget(backendTarget, normalizedMetadata)
        : resolveVendorResumeIdFromSessionMetadata(inferAgentIdFromSessionMetadata(normalizedMetadata), normalizedMetadata);
      if (vendorResumeId) trackedForPid.vendorResumeId = vendorResumeId;
      else if (backendTarget?.kind === 'configuredAcpBackend') delete trackedForPid.vendorResumeId;
      const custody = trackedForPid.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: false };
      if (custody.retiring) return;
      const work = persistReportMarker().catch(() => {
        logger.infoFile('[DAEMON RUN] Warning: failed to persist reported session marker', { pid });
      });
      custody.pending = Promise.all([custody.pending, work]).then(() => undefined);
    };
    if (!trackedForPid && normalizedMetadata.startedBy === 'daemon') {
      const state = await readProcessRunState(pid);
      // Acceptance/promotion may arrive during the OS read. Its current custody
      // wins over the earlier absence snapshot (including an obsolete dead sample).
      trackedForPid = correlateTrackedReport(pid, normalizedMetadata);
      if (!trackedForPid && (state === 'dead' || state === 'zombie')) {
        logger.infoFile('[DAEMON RUN] Warning: ignored a positively dead untracked daemon session report', { pid });
        return;
      }
    }
    if (trackedForPid) {
      if (trackedForPid.pid !== pid) trackedForPid.sessionRunnerPid = pid;
      adoptReportedHappySessionId(trackedForPid, sessionId);
      trackedForPid.happySessionMetadataFromLocalWebhook = normalizedMetadata;
      if (trackedForPid.startedBy !== 'daemon' && trackedForPid.reattachedFromDiskMarker) {
        trackedForPid.startedBy = normalizedMetadata.startedBy ?? trackedForPid.startedBy;
      } else if (trackedForPid.startedBy !== 'daemon') {
        trackedForPid.startedBy = 'happy directly - likely by user from terminal';
      }
    } else {
      trackedForPid = { startedBy: 'happy directly - likely by user from terminal', happySessionId: sessionId,
        happySessionMetadataFromLocalWebhook: normalizedMetadata, pid };
      pidToTrackedSession.set(pid, trackedForPid);
      logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
    }

    if (trackedForPid) {
      startReportMarkerWork();
      if (trackedForPid.startedBy === 'daemon' && !isPlaceholderSessionId) {
        const waiterPid = trackedForPid.pid;
        const awaiter = pidToAwaiter.get(waiterPid);
        if (awaiter) {
          pidToAwaiter.delete(waiterPid);
          await awaiter(trackedForPid);
        }
      }
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
    async function persistReportMarker(): Promise<void> {
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
    }
  };
}
