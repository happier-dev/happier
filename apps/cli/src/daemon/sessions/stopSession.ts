import { logger } from '@/ui/logger';
import { spawnSync } from 'node:child_process';
import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import type { TerminalHostRegistry } from '@/integrations/terminalHost/registry';
import {
  readTerminalAttachmentInfo,
  readTerminalAttachmentState,
  removeTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type LegacyTerminalAttachmentInfo,
  type TerminalAttachmentReadState,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import { configuration } from '@/configuration';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';
import { recordTerminalHostKillAudit } from '@/daemon/sessionKillAudit';
import {
  incompleteStopSession,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from './stopSessionContract';
import {
  requireExactTerminalControlServiceabilityRetirement,
  type ExactTerminalControlServiceabilityRetirement,
} from './retireTerminalControlServiceability';

function mapDispositionFailureReason(
  reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed' | 'retirement_failed',
): StopSessionIncompleteReason {
  return reason === 'retirement_failed'
    ? 'terminal_control_serviceability_retirement_failed'
    : reason;
}

function isTrackedChildStillLiveForPid(session: TrackedSession, pid: number): boolean {
  const child = session.childProcess;
  if (!child || child.pid !== pid) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return true;
}

async function taskkillWindowsDaemonChild(params: Readonly<{
  pid: number;
  session: TrackedSession;
  normalizedSessionId: string;
  logPidReuseRefusal: (message: string) => void;
}>): Promise<boolean> {
  if (!isTrackedChildStillLiveForPid(params.session, params.pid)) {
    params.logPidReuseRefusal(`[DAEMON RUN] Refusing to taskkill PID ${params.pid} for session ${params.normalizedSessionId} (tracked child is no longer live)`);
    return false;
  }

  const safe = await isPidSafeHappySessionProcess({
    pid: params.pid,
    expectedProcessCommandHash: params.session.processCommandHash,
  });
  if (!safe) {
    params.logPidReuseRefusal(`[DAEMON RUN] Refusing to taskkill PID ${params.pid} for session ${params.normalizedSessionId} (PID reuse safety)`);
    return false;
  }

  recordTerminalHostKillAudit({
    actor: 'daemon.stop-session',
    reason: 'stop-session',
    sessionId: params.normalizedSessionId,
    runnerPid: params.pid,
    zellijName: null,
    signal: 'SIGTERM',
    callSite: 'daemon.sessions.stopSession.pid',
  });
  const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(params.pid)], { stdio: 'ignore' });
  if ((result.status ?? 1) !== 0) {
    logger.debug(`[DAEMON RUN] taskkill failed for daemon-spawned session ${params.normalizedSessionId} (pid=${params.pid})`);
    return false;
  }

  params.session.stopRequestedAtMs = Date.now();
  logger.debug(`[DAEMON RUN] taskkill requested for daemon-spawned session process tree ${params.normalizedSessionId} (pid=${params.pid})`);
  return true;
}

async function resolveLegacyHostAdapter(
  attachmentInfo: LegacyTerminalAttachmentInfo,
  terminalHostAdapters: TerminalHostRegistry | undefined,
  loadTerminalHostAdapters: (() => Promise<TerminalHostRegistry>) | undefined,
  logWarning: (message: string, ...args: unknown[]) => void,
  sessionId: string,
): Promise<TerminalHostAdapter | null> {
  const kind = attachmentInfo.terminal.mode === 'tmux' ? 'tmux'
    : attachmentInfo.terminal.mode === 'zellij' ? 'zellij'
    : attachmentInfo.terminal.mode === 'windows_console' ? 'windows_console'
    : null;
  if (!kind) return null;
  const adapters = terminalHostAdapters
    ?? await loadTerminalHostAdapters?.().catch((error) => {
      logWarning(`[DAEMON RUN] Failed to acquire terminal host cleanup adapters for legacy session ${sessionId}`, error);
      return null;
    });
  return adapters?.[kind] ?? null;
}

/**
 * Attempt to retire a legacy v1 terminal host record by probing the canonical liveness policy.
 * Only retires on positive death (`status === 'dead'`); alive and inconclusive refuse.
 * Returns the disposition result on success, or an incomplete reason on refusal.
 */
async function attemptLegacyHostRetirement(input: Readonly<{
  attachmentInfo: LegacyTerminalAttachmentInfo;
  adapter: TerminalHostAdapter;
  normalizedSessionId: string;
  readAttachmentInfo: typeof readTerminalAttachmentInfo;
  removeAttachmentInfo: typeof removeTerminalAttachmentInfo;
  logWarning: (message: string, ...args: unknown[]) => void;
}>): Promise<StopSessionResult | null> {
  const handle = buildTerminalHostHandleFromAttachmentMetadata(input.attachmentInfo.terminal);
  if (!handle) return null;

  try {
    const probeResult = await evaluateTerminalHostLivenessForRecovery(input.adapter, handle);
    if (probeResult.status === 'dead') {
      const disposition = await executeTerminalHostDisposition({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: input.normalizedSessionId,
        expectedAttachmentId: 'legacy-v1-retirement',
        intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
        provenDeadLegacyTerminal: input.attachmentInfo.terminal,
        readAttachmentInfo: input.readAttachmentInfo,
        removeAttachmentInfo: input.removeAttachmentInfo,
      });
      if (disposition.status === 'retired_legacy') {
        return { status: 'stopped' };
      }
      input.logWarning(`[DAEMON RUN] Legacy attachment retirement failed for session ${input.normalizedSessionId}`);
      return incompleteStopSession('legacy_attachment');
    }
    if (probeResult.status === 'alive') {
      input.logWarning(`[DAEMON RUN] Legacy terminal host is still alive for session ${input.normalizedSessionId}; refusing retirement`);
    } else {
      input.logWarning(`[DAEMON RUN] Legacy terminal host liveness probe was inconclusive for session ${input.normalizedSessionId}; refusing retirement`);
    }
    return incompleteStopSession('legacy_attachment');
  } catch (error) {
    input.logWarning(`[DAEMON RUN] Failed to probe legacy terminal host liveness for session ${input.normalizedSessionId}`, error);
    return incompleteStopSession('legacy_attachment');
  }
}

export function createStopSession(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  logPidReuseRefusal?: (message: string) => void;
  logWarning?: (message: string, ...args: unknown[]) => void;
  terminalHostAdapters?: TerminalHostRegistry;
  loadTerminalHostAdapters?: () => Promise<TerminalHostRegistry>;
  readAttachmentState?: typeof readTerminalAttachmentState;
  readAttachmentInfo?: typeof readTerminalAttachmentInfo;
  removeAttachmentInfo?: typeof removeTerminalAttachmentInfo;
  waitForTrackedRunnersExit?: (input: Readonly<{
    sessionId: string;
    trackedPids: readonly number[];
  }>) => Promise<boolean>;
  /** Immediate positive-death probe used by marker fallback before attempting a signal. */
  areTrackedRunnersExited?: (input: Readonly<{
    sessionId: string;
    trackedPids: readonly number[];
  }>) => Promise<boolean>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
  recoverStrandedTerminalControlServiceability?: (input: Readonly<{
    sessionId: string;
  }>) => Promise<StopSessionResult | null>;
  expectedTerminalAttachmentId?: string;
  /** Marker fallback must positively prove plain topology when no attachment descriptor exists. */
  requireTerminalTopologyProof?: boolean;
  /** Exact persisted topology for reconstructed dead-runner candidates not represented by spawn options. */
  provenTerminalHostKindsByPid?: ReadonlyMap<number, TerminalHostAdapter['kind']>;
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

    const readAttachmentInfo = params.readAttachmentInfo ?? readTerminalAttachmentInfo;
    const readAttachmentState = params.readAttachmentState
      ?? (params.readAttachmentInfo
        ? async (input: Parameters<typeof readTerminalAttachmentInfo>[0]): Promise<TerminalAttachmentReadState> => {
            const info = await params.readAttachmentInfo!(input);
            return info ? { status: 'present', info } : { status: 'absent' };
          }
        : readTerminalAttachmentState);
    const attachmentState: TerminalAttachmentReadState = !isPidFallback
      ? await readAttachmentState({
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
      logWarning(`[DAEMON RUN] Refusing to stop replacement terminal attachment for session ${normalizedSessionId}`);
      return incompleteStopSession('attachment_mismatch');
    }
    const notifyExactTerminalAttachmentRetired = async (
      retiredAttachmentInfo: BoundTerminalAttachmentInfo,
    ): Promise<void> => {
      if (!params.onExactTerminalAttachmentRetired) return;
      await params.onExactTerminalAttachmentRetired({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        attachmentInfo: retiredAttachmentInfo,
      }).catch((error) => {
        logWarning(`[DAEMON RUN] Terminal attachment retired but provider artifacts could not be cleaned for session ${normalizedSessionId}`, error);
      });
    };
    // Track whether a v1 legacy record with a terminal host needs dead-host retirement after runner exit.
    const legacyHostRetirementNeeded = attachmentInfo?.version === 1
      && (attachmentInfo.terminal.mode === 'tmux'
        || attachmentInfo.terminal.mode === 'zellij'
        || attachmentInfo.terminal.mode === 'windows_console');
    if (!isPidFallback) {
      const terminalModes = pidsToStop.map((pid) => {
        const provenTerminalHostKind = params.provenTerminalHostKindsByPid?.get(pid);
        if (provenTerminalHostKind) return provenTerminalHostKind;
        const session = pidToTrackedSession.get(pid);
        if (!session) return undefined;
        if (typeof session.tmuxSessionId === 'string') return 'tmux';
        const terminal = (session.spawnOptions as { terminal?: { mode?: unknown } } | undefined)?.terminal;
        return typeof terminal?.mode === 'string' ? terminal.mode : undefined;
      });
      if (params.requireTerminalTopologyProof && terminalModes.some((mode) => mode === undefined)) {
        logWarning(`[DAEMON RUN] Refusing to stop marker-derived session ${normalizedSessionId} without explicit terminal topology provenance`);
        return incompleteStopSession('missing_topology_proof');
      }
      const matchedTerminalHost = terminalModes.some((mode) =>
        mode === 'tmux'
        || mode === 'zellij'
        || mode === 'windows_terminal'
        || mode === 'windows_console');
      if (!attachmentInfo && matchedTerminalHost) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal host without committed attachment identity for session ${normalizedSessionId}`);
        return incompleteStopSession('missing_attachment_identity');
      }
    }

    if (pidsToStop.length === 0) {
      if (attachmentInfo?.version === 2) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal attachment without exact tracked-runner exit proof for session ${normalizedSessionId}`);
        return incompleteStopSession('tracked_runner_absent');
      }
      if (!isPidFallback && params.recoverStrandedTerminalControlServiceability) {
        try {
          const recovered = await params.recoverStrandedTerminalControlServiceability({
            sessionId: normalizedSessionId,
          });
          if (recovered) return recovered;
        } catch (error) {
          logWarning(`[DAEMON RUN] Failed to inspect stranded terminal control for session ${normalizedSessionId}`, error);
          return incompleteStopSession('missing_topology_proof');
        }
      }
      // A stale v1 record can outlive its runners; retire it only on a provably dead host.
      if (legacyHostRetirementNeeded && attachmentInfo?.version === 1) {
        const legacyAdapter = await resolveLegacyHostAdapter(
          attachmentInfo, params.terminalHostAdapters, params.loadTerminalHostAdapters, logWarning, normalizedSessionId,
        );
        if (legacyAdapter) {
          const retirementResult = await attemptLegacyHostRetirement({
            attachmentInfo,
            adapter: legacyAdapter,
            normalizedSessionId,
            readAttachmentInfo,
            removeAttachmentInfo: params.removeAttachmentInfo ?? removeTerminalAttachmentInfo,
            logWarning,
          });
          if (retirementResult) {
            // On successful retirement, return not_found (truthful: daemon never tracked these runners).
            // On refusal, the retirementResult already carries the incomplete reason.
            return retirementResult.status === 'stopped'
              ? { status: 'not_found' }
              : retirementResult;
          }
        }
        // Cannot probe: refuse with legacy_attachment
        logWarning(`[DAEMON RUN] Cannot probe legacy terminal host for untracked session ${normalizedSessionId}; refusing retirement`);
        return incompleteStopSession('legacy_attachment');
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
      ? await params.areTrackedRunnersExited({
          sessionId: normalizedSessionId,
          trackedPids: pidsToStop,
        }).catch(() => false)
      : false;
    let stoppedAny = false;
    const signaledPids: number[] = runnersAlreadyExited ? [...pidsToStop] : [];
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
            recordTerminalHostKillAudit({
              actor: 'daemon.stop-session',
              reason: 'stop-session',
              sessionId: normalizedSessionId,
              runnerPid: pid,
              zellijName: null,
              signal: 'SIGTERM',
              callSite: 'daemon.sessions.stopSession.pid',
            });
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

          recordTerminalHostKillAudit({
            actor: 'daemon.stop-session',
            reason: 'stop-session',
            sessionId: normalizedSessionId,
            runnerPid: pid,
            zellijName: null,
            signal: 'SIGTERM',
            callSite: 'daemon.sessions.stopSession.pid',
          });
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
        recordTerminalHostKillAudit({
          actor: 'daemon.stop-session',
          reason: 'stop-session',
          sessionId: normalizedSessionId,
          runnerPid: pid,
          zellijName: null,
          signal: 'SIGTERM',
          callSite: 'daemon.sessions.stopSession.pid',
        });
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
      logWarning(`[DAEMON RUN] Timed out waiting for tracked runner exit; preserving terminal attachment for session ${normalizedSessionId}`);
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
        readAttachmentInfo,
        removeAttachmentInfo: params.removeAttachmentInfo ?? removeTerminalAttachmentInfo,
        beforeDescriptorRetirement: params.retireExactTerminalControlServiceability
          ? async ({ attachmentInfo: currentAttachmentInfo }) => {
              const retirement = await params.retireExactTerminalControlServiceability!({
                happyHomeDir: configuration.happyHomeDir,
                sessionId: normalizedSessionId,
                attachmentInfo: currentAttachmentInfo,
              });
              requireExactTerminalControlServiceabilityRetirement(retirement);
            }
          : undefined,
      });
      if (disposition.status === 'destroyed') {
        if (disposition.retirementFailed) {
          logWarning('[DAEMON RUN] Exact terminal host was destroyed but control serviceability retirement failed', {
            sessionId: normalizedSessionId,
            attachmentId: attachmentInfo.attachmentId,
          });
          return incompleteStopSession('terminal_control_serviceability_retirement_failed');
        }
        if (disposition.descriptorRetained) {
          return incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
        }
        await notifyExactTerminalAttachmentRetired(attachmentInfo);
        return { status: 'stopped' };
      }
      return disposition.status === 'parked'
        ? incompleteStopSession(mapDispositionFailureReason(disposition.reason))
        : incompleteStopSession('destroy_failed');
    }

    if (legacyHostRetirementNeeded && attachmentInfo?.version === 1) {
      // After runners have exited, attempt to retire the legacy v1 terminal host record.
      const legacyAdapter = await resolveLegacyHostAdapter(
        attachmentInfo, params.terminalHostAdapters, params.loadTerminalHostAdapters, logWarning, normalizedSessionId,
      );
      if (legacyAdapter) {
        const result = await attemptLegacyHostRetirement({
          attachmentInfo,
          adapter: legacyAdapter,
          normalizedSessionId,
          readAttachmentInfo,
          removeAttachmentInfo: params.removeAttachmentInfo ?? removeTerminalAttachmentInfo,
          logWarning,
        });
        if (result) return result;
      }
      logWarning(`[DAEMON RUN] Cannot probe legacy terminal host for session ${normalizedSessionId}; refusing retirement`);
      return incompleteStopSession('legacy_attachment');
    }

    return { status: 'stopped' };
  };
}
