import { spawnSync } from 'node:child_process';

import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import type { TerminalHostAdapter } from '@happier-dev/agents';
import {
  readTerminalHostAttachmentInfo,
  readTerminalHostAttachmentState,
  removeTerminalHostAttachmentInfo,
  type BoundTerminalHostAttachmentInfo,
  type TerminalHostAttachmentReadState,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';
import {
  incompleteStopSession,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from './stopSessionContract';

function mapDispositionFailureReason(
  reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed',
): StopSessionIncompleteReason {
  return reason;
}

function isTrackedChildStillLiveForPid(session: TrackedSession, pid: number): boolean {
  const child = session.childProcess;
  if (!child || child.pid !== pid) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return true;
}

function resolveRetiredTerminalMode(
  attachmentInfo: BoundTerminalHostAttachmentInfo,
  actualTerminalModes: readonly (TerminalMode | undefined)[],
): TerminalMode | null {
  if (attachmentInfo.handle.kind === 'windows_console') {
    const windowsModes = new Set(
      actualTerminalModes.filter(
        (mode): mode is 'windows_terminal' | 'windows_console' =>
          mode === 'windows_terminal' || mode === 'windows_console',
      ),
    );
    return windowsModes.size === 1 ? Array.from(windowsModes)[0]! : null;
  }
  return attachmentInfo.handle.kind;
}

function readActualTerminalMode(
  session: TrackedSession | undefined,
  expectedAttachmentId: string | undefined,
): TerminalMode | undefined {
  const terminal = session?.happySessionMetadataFromLocalWebhook?.terminal;
  const evidenceAttachmentId = terminal?.controlServiceabilityV1?.attachmentId;
  if (
    expectedAttachmentId
    && typeof evidenceAttachmentId === 'string'
    && evidenceAttachmentId !== expectedAttachmentId
  ) {
    return undefined;
  }
  const mode = terminal?.mode;
  return mode === 'plain'
    || mode === 'tmux'
    || mode === 'zellij'
    || mode === 'windows_terminal'
    || mode === 'windows_console'
    ? mode
    : undefined;
}

async function taskkillWindowsDaemonChild(params: Readonly<{
  pid: number;
  session: TrackedSession;
  normalizedSessionId: string;
  logPidReuseRefusal: (message: string) => void;
}>): Promise<boolean> {
  if (!isTrackedChildStillLiveForPid(params.session, params.pid)) {
    params.logPidReuseRefusal(
      `[DAEMON RUN] Refusing to taskkill PID ${params.pid} for session ${params.normalizedSessionId} (tracked child is no longer live)`,
    );
    return false;
  }

  const safe = await isPidSafeHappySessionProcess({
    pid: params.pid,
    expectedProcessCommandHash: params.session.processCommandHash,
  });
  if (!safe) {
    params.logPidReuseRefusal(
      `[DAEMON RUN] Refusing to taskkill PID ${params.pid} for session ${params.normalizedSessionId} (PID reuse safety)`,
    );
    return false;
  }

  const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(params.pid)], { stdio: 'ignore' });
  if ((result.status ?? 1) !== 0) {
    logger.debug(`[DAEMON RUN] taskkill failed for daemon-spawned session ${params.normalizedSessionId} (pid=${params.pid})`);
    return false;
  }

  params.session.stopRequestedAtMs = Date.now();
  logger.debug(`[DAEMON RUN] taskkill requested for daemon-spawned session process tree ${params.normalizedSessionId} (pid=${params.pid})`);
  return true;
}

export function createStopSession(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  logPidReuseRefusal?: (message: string) => void;
  logWarning?: (message: string, ...args: unknown[]) => void;
  terminalHostAdapters?: Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;
  loadTerminalHostAdapters?: () => Promise<Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>>;
  readHostAttachmentInfo?: typeof readTerminalHostAttachmentInfo;
  readHostAttachmentState?: typeof readTerminalHostAttachmentState;
  removeHostAttachmentInfo?: typeof removeTerminalHostAttachmentInfo;
  waitForTrackedRunnersExit?: (input: Readonly<{
    sessionId: string;
    trackedPids: readonly number[];
  }>) => Promise<boolean>;
  areTrackedRunnersExited?: (input: Readonly<{
    sessionId: string;
    trackedPids: readonly number[];
  }>) => Promise<boolean>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalHostAttachmentInfo;
  }>) => Promise<void>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalHostAttachmentInfo;
    terminalMode: TerminalMode;
  }>) => Promise<void>;
  expectedTerminalAttachmentId?: string;
  requireTerminalTopologyProof?: boolean;
  provenTerminalHostKindsByPid?: ReadonlyMap<number, TerminalHostAdapter['kind']>;
  provenTerminalModesByPid?: ReadonlyMap<number, TerminalMode>;
  retireUpstreamAuthorityBeforeProcessStop?: (
    pid: number,
  ) => Promise<boolean>;
}>): (sessionId: string) => Promise<StopSessionResult> {
  const { pidToTrackedSession } = params;
  const logPidReuseRefusal = params.logPidReuseRefusal ?? ((message: string): void => logger.warn(message));
  const logWarning = params.logWarning ?? ((message: string, ...args: unknown[]): void => logger.warn(message, ...args));

  // Stop a session by sessionId or PID fallback
  return async (sessionId: string): Promise<StopSessionResult> => {
    logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) return incompleteStopSession('invalid_session_id');
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

    const readHostAttachmentInfo = params.readHostAttachmentInfo ?? readTerminalHostAttachmentInfo;
    const readHostAttachmentState = params.readHostAttachmentState
      ?? (params.readHostAttachmentInfo
        ? async (input: Parameters<typeof readTerminalHostAttachmentInfo>[0]): Promise<TerminalHostAttachmentReadState> => {
            const info = await params.readHostAttachmentInfo!(input);
            return info ? { status: 'present', info } : { status: 'absent' };
          }
        : readTerminalHostAttachmentState);
    const attachmentState: TerminalHostAttachmentReadState = !isPidFallback
      ? await readHostAttachmentState({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: normalizedSessionId,
        }).catch(() => ({ status: 'unreadable', reason: 'io_error' } as const))
      : { status: 'absent' };
    if (attachmentState.status === 'unreadable') {
      logWarning(`[DAEMON RUN] Refusing to stop session ${normalizedSessionId} without readable terminal topology evidence`);
      return incompleteStopSession('missing_topology_proof');
    }
    const attachmentInfo = attachmentState.status === 'present' ? attachmentState.info : null;
    if (
      params.expectedTerminalAttachmentId
      && (
        attachmentInfo?.version !== 2
        || attachmentInfo.attachmentId !== params.expectedTerminalAttachmentId
      )
    ) {
      logWarning(`[DAEMON RUN] Refusing to stop replacement terminal host for session ${normalizedSessionId}`);
      return incompleteStopSession('attachment_mismatch');
    }
    const terminalModes: Array<TerminalMode | undefined> = pidsToStop.map((pid) => {
      const provenTerminalHostKind = params.provenTerminalHostKindsByPid?.get(pid);
      if (provenTerminalHostKind) return provenTerminalHostKind;
      const session = pidToTrackedSession.get(pid);
      if (!session) return undefined;
      if (typeof session.tmuxSessionId === 'string') return 'tmux';
      return session.spawnOptions?.terminal?.mode;
    });
    const actualTerminalModes = pidsToStop.map((pid) =>
      params.provenTerminalModesByPid?.get(pid)
        ?? readActualTerminalMode(pidToTrackedSession.get(pid), attachmentInfo?.version === 2 ? attachmentInfo.attachmentId : undefined),
    );
    const retiredTerminalMode = attachmentInfo?.version === 2
      ? resolveRetiredTerminalMode(attachmentInfo, actualTerminalModes)
      : null;
    if (!isPidFallback) {
      if (attachmentInfo?.version === 1) {
        logWarning(`[DAEMON RUN] Refusing to destroy legacy terminal host without immutable identity for session ${normalizedSessionId}`);
        return incompleteStopSession('legacy_attachment');
      }
      if (params.requireTerminalTopologyProof && terminalModes.some((mode) => mode === undefined)) {
        logWarning(`[DAEMON RUN] Refusing to stop marker-derived session ${normalizedSessionId} without explicit terminal topology provenance`);
        return incompleteStopSession('missing_topology_proof');
      }
      const matchedTerminalHost = terminalModes.some((mode) =>
        mode === 'tmux' || mode === 'zellij' || mode === 'windows_terminal' || mode === 'windows_console');
      if (!attachmentInfo && matchedTerminalHost) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal host without committed attachment identity for session ${normalizedSessionId}`);
        return incompleteStopSession('missing_attachment_identity');
      }
      if (attachmentInfo?.version === 2 && attachmentInfo.handle.kind === 'windows_console' && !retiredTerminalMode) {
        logWarning(`[DAEMON RUN] Refusing to retire Windows terminal topology without a unique actual-mode proof for session ${normalizedSessionId}`);
        return incompleteStopSession('missing_topology_proof');
      }
    }

    if (pidsToStop.length === 0) {
      if (attachmentInfo?.version === 2) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal host without exact tracked-runner exit proof for session ${normalizedSessionId}`);
        return incompleteStopSession('tracked_runner_absent');
      }
      logger.debug(`[DAEMON RUN] Session ${normalizedSessionId} not found`);
      return { status: 'not_found' };
    }

    let terminalHostAdapterForDisposition: TerminalHostAdapter | null = null;
    if (attachmentInfo?.version === 2) {
      const adapters = params.terminalHostAdapters
        ?? await params.loadTerminalHostAdapters?.().catch((error) => {
          logWarning(`[DAEMON RUN] Failed to acquire terminal host cleanup adapters for session ${normalizedSessionId}`, error);
          return null;
        });
      terminalHostAdapterForDisposition = adapters?.[attachmentInfo.handle.kind] ?? null;
      if (!terminalHostAdapterForDisposition) {
        return incompleteStopSession('terminal_host_adapter_unavailable');
      }
    }

    const runnersAlreadyExited = params.areTrackedRunnersExited
      ? await params.areTrackedRunnersExited({ sessionId: normalizedSessionId, trackedPids: pidsToStop }).catch(() => false)
      : false;
    for (const pid of runnersAlreadyExited ? [] : pidsToStop) {
      if (
        params.retireUpstreamAuthorityBeforeProcessStop
        && !await params
          .retireUpstreamAuthorityBeforeProcessStop(pid)
      ) {
        logWarning(
          `[DAEMON RUN] Refusing to signal session ${normalizedSessionId} because upstream authority retirement was incomplete`,
        );
        return incompleteStopSession('runner_signal_incomplete');
      }
    }
    let stoppedAny = false;
    const signaledPids: number[] = [];
    const confirmedExitedPids: number[] = runnersAlreadyExited ? [...pidsToStop] : [];
    for (const pid of runnersAlreadyExited ? [] : pidsToStop) {
      const session = pidToTrackedSession.get(pid);
      if (!session) continue;

      if (session.startedBy === 'daemon' && session.childProcess) {
        if (process.platform === 'win32') {
          if (await taskkillWindowsDaemonChild({ pid, session, normalizedSessionId, logPidReuseRefusal })) {
            stoppedAny = true;
            signaledPids.push(pid);
          }
          continue;
        }

        try {
          try {
            // Prefer killing the full process group when the daemon spawned a detached session runner.
            process.kill(-pid, 'SIGTERM');
            session.stopRequestedAtMs = Date.now();
            logger.debug(
              `[DAEMON RUN] Sent SIGTERM to daemon-spawned session process group ${normalizedSessionId} (pid=${pid})`,
            );
            stoppedAny = true;
            signaledPids.push(pid);
            continue;
          } catch {
            // fall through
          }

          session.childProcess.kill('SIGTERM');
          session.stopRequestedAtMs = Date.now();
          logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${normalizedSessionId} (pid=${pid})`);
          stoppedAny = true;
          signaledPids.push(pid);
        } catch (error) {
          logger.debug(`[DAEMON RUN] Failed to kill session ${normalizedSessionId} (pid=${pid}):`, error);
        }
        continue;
      }

      // PID reuse safety: verify the PID still looks like a Happy session process (and matches hash if known).
      const safe = await isPidSafeHappySessionProcess({ pid, expectedProcessCommandHash: session.processCommandHash });
      if (!safe) {
        logPidReuseRefusal(`[DAEMON RUN] Refusing to SIGTERM PID ${pid} for session ${normalizedSessionId} (PID reuse safety)`);
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        session.stopRequestedAtMs = Date.now();
        logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid} (${normalizedSessionId})`);
        stoppedAny = true;
        signaledPids.push(pid);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
      }
    }

    const unsignaledPids = pidsToStop.filter((pid) => !signaledPids.includes(pid));
    if (
      unsignaledPids.length > 0
      && params.areTrackedRunnersExited
      && await params.areTrackedRunnersExited({
        sessionId: normalizedSessionId,
        trackedPids: unsignaledPids,
      }).catch(() => false)
    ) {
      confirmedExitedPids.push(...unsignaledPids);
    }

    if (stoppedAny) {
      logger.debug(`[DAEMON RUN] Stop requested for session ${normalizedSessionId}; waiting for exit observation`);
    }
    const runnersWithStopDisposition = new Set([...signaledPids, ...confirmedExitedPids]);
    if (runnersWithStopDisposition.size !== pidsToStop.length) {
      logWarning(`[DAEMON RUN] Stop signaling was incomplete for session ${normalizedSessionId}`);
      return incompleteStopSession('runner_signal_incomplete');
    }
    if (!params.waitForTrackedRunnersExit) {
      logWarning(`[DAEMON RUN] Stop cannot prove runner exit for session ${normalizedSessionId}`);
      return incompleteStopSession('runner_exit_observer_unavailable');
    }
    const runnersExited = confirmedExitedPids.length === pidsToStop.length
      || await params.waitForTrackedRunnersExit({
        sessionId: normalizedSessionId,
        trackedPids: pidsToStop,
      });
    if (!runnersExited) {
      logWarning(`[DAEMON RUN] Timed out waiting for tracked runner exit; preserving terminal host for session ${normalizedSessionId}`);
      return incompleteStopSession('runner_exit_timeout');
    }

    if (attachmentInfo?.version === 2) {
      if (!terminalHostAdapterForDisposition) {
        return incompleteStopSession('terminal_host_adapter_unavailable');
      }
      const disposition = await executeTerminalHostDisposition({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        expectedAttachmentId: attachmentInfo.attachmentId,
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: terminalHostAdapterForDisposition,
        readAttachmentInfo: readHostAttachmentInfo,
        removeAttachmentInfo: params.removeHostAttachmentInfo ?? removeTerminalHostAttachmentInfo,
      });
      if (disposition.status === 'destroyed' && params.onExactTerminalAttachmentRetired) {
        await params.onExactTerminalAttachmentRetired({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: normalizedSessionId,
          attachmentInfo,
        }).catch((error) => {
          logWarning(`[DAEMON RUN] Terminal host retired but provider artifacts could not be cleaned for session ${normalizedSessionId}`, error);
        });
      }
      if (disposition.status === 'destroyed' && params.retireExactTerminalControlServiceability) {
        if (!retiredTerminalMode) return incompleteStopSession('missing_topology_proof');
        try {
          await params.retireExactTerminalControlServiceability({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: normalizedSessionId,
            attachmentInfo,
            terminalMode: retiredTerminalMode,
          });
        } catch (error) {
          logWarning('[DAEMON RUN] Exact terminal host was destroyed but control serviceability retirement failed', {
            sessionId: normalizedSessionId,
            attachmentId: attachmentInfo.attachmentId,
            error,
          });
          return incompleteStopSession('terminal_control_serviceability_retirement_failed');
        }
      }
      if (disposition.status === 'destroyed' && disposition.descriptorRetained) {
        return incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
      }
      if (disposition.status === 'destroyed') return { status: 'stopped' };
      return disposition.status === 'parked'
        ? incompleteStopSession(mapDispositionFailureReason(disposition.reason))
        : incompleteStopSession('destroy_failed');
    }
    return { status: 'stopped' };
  };
}
