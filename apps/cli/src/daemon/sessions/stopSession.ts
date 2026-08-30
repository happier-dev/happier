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
import {
  executeConfirmedDeadTerminalAttachmentRetirement,
  executeTerminalHostDisposition,
} from '@/terminal/attachment/terminalHostDisposition';
import { buildLegacyTerminalAttachmentHostHandle } from '@/terminal/attachment/legacyTerminalAttachmentHandle';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import { configuration } from '@/configuration';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';
import { recordTerminalHostKillAudit } from '@/daemon/sessionKillAudit';
import {
  incompleteStopSession,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from './stopSessionContract';
import {
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
    expectedProcessInstanceFingerprint: params.session.processInstanceFingerprint,
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

async function forceKillTrackedRunner(params: Readonly<{
  pid: number;
  expectedSession: TrackedSession;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  normalizedSessionId: string;
  logPidReuseRefusal: (message: string) => void;
}>): Promise<boolean> {
  const currentSession = params.pidToTrackedSession.get(params.pid);
  if (currentSession !== params.expectedSession) {
    params.logPidReuseRefusal(
      `[DAEMON RUN] Refusing to SIGKILL PID ${params.pid} for session ${params.normalizedSessionId} (tracked runner identity changed)`,
    );
    return false;
  }

  const safe = await isPidSafeHappySessionProcess({
    pid: params.pid,
    expectedProcessCommandHash: params.expectedSession.processCommandHash,
    expectedProcessInstanceFingerprint: params.expectedSession.processInstanceFingerprint,
  });
  if (!safe || params.pidToTrackedSession.get(params.pid) !== params.expectedSession) {
    params.logPidReuseRefusal(
      `[DAEMON RUN] Refusing to SIGKILL PID ${params.pid} for session ${params.normalizedSessionId} (PID reuse safety)`,
    );
    return false;
  }

  recordTerminalHostKillAudit({
    actor: 'daemon.stop-session',
    reason: 'stop-session-timeout',
    sessionId: params.normalizedSessionId,
    runnerPid: params.pid,
    zellijName: null,
    signal: 'SIGKILL',
    callSite: 'daemon.sessions.stopSession.pid',
  });

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(params.pid)], { stdio: 'ignore' });
    if ((result.status ?? 1) !== 0) {
      logger.debug(
        `[DAEMON RUN] Forced taskkill failed for session ${params.normalizedSessionId} (pid=${params.pid})`,
      );
      return false;
    }
    logger.debug(
      `[DAEMON RUN] Forced taskkill requested for session process tree ${params.normalizedSessionId} (pid=${params.pid})`,
    );
    return true;
  }

  try {
    if (params.expectedSession.startedBy === 'daemon' && params.expectedSession.childProcess) {
      if (!isTrackedChildStillLiveForPid(params.expectedSession, params.pid)) {
        return false;
      }
      await killProcessTree(params.expectedSession.childProcess, { graceMs: 1 });
    } else {
      await killProcessTree({ pid: params.pid }, { graceMs: 1 });
    }
    logger.debug(
      `[DAEMON RUN] Requested forced process-tree termination for session ${params.normalizedSessionId} (pid=${params.pid})`,
    );
    return true;
  } catch (error) {
    logger.debug(
      `[DAEMON RUN] Failed to force-kill session ${params.normalizedSessionId} (pid=${params.pid}):`,
      error,
    );
    return false;
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
    expectedAttachmentId?: string;
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
    const expectedTrackedSessionsByPid = new Map<number, TrackedSession>();
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
      if (matches) {
        pidsToStop.push(pid);
        expectedTrackedSessionsByPid.set(pid, session);
      }
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

    let terminalHostAdaptersPromise: Promise<TerminalHostRegistry | null> | null = null;
    const loadTerminalHostAdapters = async (): Promise<TerminalHostRegistry | null> => {
      if (params.terminalHostAdapters) return params.terminalHostAdapters;
      terminalHostAdaptersPromise ??= params.loadTerminalHostAdapters?.().catch((error) => {
        logWarning(`[DAEMON RUN] Failed to acquire terminal host cleanup adapters for session ${normalizedSessionId}`, error);
        return null;
      }) ?? Promise.resolve(null);
      return await terminalHostAdaptersPromise;
    };
    const retireLegacyAttachmentAfterPositiveDeath = async (
      legacyAttachment: LegacyTerminalAttachmentInfo,
      options: Readonly<{ runnerExitProven: boolean; trackedPids: readonly number[] }>,
    ): Promise<StopSessionResult> => {
      const handle = buildLegacyTerminalAttachmentHostHandle(
        legacyAttachment,
        configuration.happyHomeDir,
      );
      if (!handle) {
        const persistedWindowsPid = legacyAttachment.terminal.mode === 'windows_terminal'
          || legacyAttachment.terminal.mode === 'windows_console'
          ? legacyAttachment.terminal.windows?.pid
          : undefined;
        const exactWindowsRunnerExited = options.runnerExitProven
          && typeof persistedWindowsPid === 'number'
          && Number.isSafeInteger(persistedWindowsPid)
          && persistedWindowsPid > 0
          && options.trackedPids.includes(persistedWindowsPid);
        if (
          !exactWindowsRunnerExited
          && (legacyAttachment.terminal.mode !== 'plain' || !options.runnerExitProven)
        ) {
          return incompleteStopSession('legacy_attachment');
        }
      } else {
        const adapters = await loadTerminalHostAdapters();
        const adapter = adapters?.[handle.kind];
        if (!adapter) return incompleteStopSession('terminal_host_adapter_unavailable');
        const probe = await evaluateTerminalHostLivenessForRecovery(adapter, handle);
        if (probe.status === 'alive') return incompleteStopSession('legacy_attachment');
        if (probe.status === 'inconclusive') return incompleteStopSession('missing_topology_proof');
      }

      const disposition = await executeConfirmedDeadTerminalAttachmentRetirement({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        expectedAttachmentInfo: legacyAttachment,
        readAttachmentInfo,
        removeAttachmentInfo: params.removeAttachmentInfo ?? removeTerminalAttachmentInfo,
      });
      return disposition.status === 'retired'
        ? { status: 'stopped' }
        : incompleteStopSession(
            disposition.status === 'parked'
              ? mapDispositionFailureReason(disposition.reason)
              : 'terminal_attachment_descriptor_retirement_failed',
          );
    };

    if (pidsToStop.length === 0) {
      if (attachmentInfo?.version === 1) {
        return await retireLegacyAttachmentAfterPositiveDeath(attachmentInfo, {
          runnerExitProven: false,
          trackedPids: [],
        });
      }
      if (!isPidFallback && params.recoverStrandedTerminalControlServiceability) {
        try {
          const recovered = await params.recoverStrandedTerminalControlServiceability({
            sessionId: normalizedSessionId,
            ...(attachmentInfo?.version === 2
              ? { expectedAttachmentId: attachmentInfo.attachmentId }
              : {}),
          });
          if (recovered?.status === 'stopped' && attachmentInfo?.version === 2) {
            const removed = await (params.removeAttachmentInfo ?? removeTerminalAttachmentInfo)({
              happyHomeDir: configuration.happyHomeDir,
              sessionId: normalizedSessionId,
              expectedAttachmentId: attachmentInfo.attachmentId,
              expectedTerminal: attachmentInfo.terminal,
            }).catch(() => false);
            if (!removed) {
              return incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
            }
            await notifyExactTerminalAttachmentRetired(attachmentInfo);
          }
          if (recovered) return recovered;
        } catch (error) {
          logWarning(`[DAEMON RUN] Failed to inspect stranded terminal control for session ${normalizedSessionId}`, error);
          return incompleteStopSession('missing_topology_proof');
        }
      }
      if (attachmentInfo?.version === 2) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal attachment without exact tracked-runner exit proof for session ${normalizedSessionId}`);
        return incompleteStopSession('tracked_runner_absent');
      }
      logger.debug(`[DAEMON RUN] Session ${normalizedSessionId} not found`);
      return { status: 'not_found' };
    }

    let terminalHostAdapterForDisposition: TerminalHostAdapter | null = null;
    if (attachmentInfo?.version === 2) {
      const adapters = await loadTerminalHostAdapters();
      terminalHostAdapterForDisposition = adapters?.[attachmentInfo.handle.kind] ?? null;
      if (!terminalHostAdapterForDisposition) {
        return incompleteStopSession('terminal_host_adapter_unavailable');
      }
    }

    const haveTrackedRunnersExited = async (trackedPids: readonly number[]): Promise<boolean> => {
      if (!params.areTrackedRunnersExited) return false;
      try {
        return await params.areTrackedRunnersExited({
          sessionId: normalizedSessionId,
          trackedPids,
        });
      } catch (error) {
        logWarning(
          `[DAEMON RUN] Failed to check tracked runner exit for session ${normalizedSessionId}`,
          error,
        );
        return false;
      }
    };
    const runnersAlreadyExited = await haveTrackedRunnersExited(pidsToStop);
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

      // PID reuse safety: verify the PID is still a Happy runner and matches the strongest persisted identity.
      const safe = await isPidSafeHappySessionProcess({
        pid,
        expectedProcessCommandHash: session.processCommandHash,
        expectedProcessInstanceFingerprint: session.processInstanceFingerprint,
      });
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
      && await haveTrackedRunnersExited(unsignaledPids)
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
    let runnersExited = confirmedExitedPids.length === pidsToStop.length
      || await params.waitForTrackedRunnersExit({
        sessionId: normalizedSessionId,
        trackedPids: pidsToStop,
      });
    if (!runnersExited) {
      logWarning(
        `[DAEMON RUN] Timed out waiting for tracked runner exit; escalating to forced termination for session ${normalizedSessionId}`,
      );
      let forceSignaledAny = false;
      const exitedBeforeForcePids = new Set<number>();
      for (const pid of pidsToStop) {
        if (
          await haveTrackedRunnersExited([pid])
        ) {
          exitedBeforeForcePids.add(pid);
          continue;
        }
        const expectedSession = expectedTrackedSessionsByPid.get(pid);
        if (!expectedSession) continue;
        forceSignaledAny = await forceKillTrackedRunner({
          pid,
          expectedSession,
          pidToTrackedSession,
          normalizedSessionId,
          logPidReuseRefusal,
        }) || forceSignaledAny;
      }

      if (exitedBeforeForcePids.size === pidsToStop.length) {
        runnersExited = true;
      } else if (forceSignaledAny) {
        runnersExited = await params.waitForTrackedRunnersExit({
          sessionId: normalizedSessionId,
          trackedPids: pidsToStop,
        });
      }
      if (!runnersExited) {
        logWarning(
          `[DAEMON RUN] Forced termination did not prove tracked runner exit; preserving terminal attachment for session ${normalizedSessionId}`,
        );
        return incompleteStopSession('runner_exit_timeout');
      }
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
              // A replacement projection already superseded this exact attachment. That is a
              // successful fence for the old host: preserve the replacement and retire only the
              // still-matching local descriptor.
              await params.retireExactTerminalControlServiceability!({
                happyHomeDir: configuration.happyHomeDir,
                sessionId: normalizedSessionId,
                attachmentInfo: currentAttachmentInfo,
              });
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
    if (attachmentInfo?.version === 1) {
      return await retireLegacyAttachmentAfterPositiveDeath(attachmentInfo, {
        runnerExitProven: true,
        trackedPids: pidsToStop,
      });
    }
    return { status: 'stopped' };
  };
}
