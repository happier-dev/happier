import { spawnSync } from 'node:child_process';

import { windowsSystemToolCommand } from '@happier-dev/cli-common/process';

import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import type { TerminalHostAdapter } from '@happier-dev/agents';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  readTerminalHostAttachmentInfo,
  readTerminalHostAttachmentState,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  removeTerminalHostAttachmentInfo,
  type BoundTerminalHostAttachmentInfo,
  type LegacyTerminalHostAttachmentInfo,
  type TerminalAttachmentInfo,
  type TerminalHostAttachmentReadState,
} from '@/terminal/attachment/terminalAttachmentInfo';
import {
  executeConfirmedDeadTerminalHostAttachmentRetirement,
  executeTerminalHostDisposition,
} from '@/terminal/attachment/terminalHostDisposition';
import { buildLegacyTerminalAttachmentHostHandle } from '@/terminal/attachment/legacyTerminalAttachmentHandle';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';
import { probeTerminalHostForRecovery } from '@/integrations/terminal/host/recoveryLiveness';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';
import {
  incompleteStopSession,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from './stopSessionContract';
import type { ExactTerminalControlServiceabilityRetirement } from './retireTerminalControlServiceability';

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

export type ExactTrackedRunnerStopWitness = Readonly<{
  tracked: TrackedSession;
  sessionRunnerPid?: number;
  processStartTimeMs?: number;
  processCommandHash?: string;
}>;

export type StopSessionOptions = Readonly<{
  expectedTrackedRunner?: ExactTrackedRunnerStopWitness;
  beforeSignalExactTrackedRunner?: (tracked: TrackedSession) => void;
}>;

function isExactTrackedRunner(
  pid: number,
  tracked: TrackedSession | undefined,
  expected: ExactTrackedRunnerStopWitness | undefined,
): tracked is TrackedSession {
  if (!tracked) return false;
  if (!expected) return true;
  return tracked === expected.tracked
    && tracked.pid === pid
    && tracked.sessionRunnerPid === expected.sessionRunnerPid
    && tracked.processStartTimeMs === expected.processStartTimeMs
    && tracked.processCommandHash === expected.processCommandHash;
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
  claimSignalAuthority(): boolean;
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
    expectedProcessStartTimeMs: params.session.processStartTimeMs,
  });
  if (!safe) {
    params.logPidReuseRefusal(
      `[DAEMON RUN] Refusing to taskkill PID ${params.pid} for session ${params.normalizedSessionId} (PID reuse safety)`,
    );
    return false;
  }
  if (!params.claimSignalAuthority()) return false;

  const result = spawnSync(windowsSystemToolCommand('taskkill.exe'), ['/F', '/T', '/PID', String(params.pid)], { stdio: 'ignore' });
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
  normalizedSessionId: string;
  claimSignalAuthority(): boolean;
  logPidReuseRefusal: (message: string) => void;
}>): Promise<boolean> {
  const safe = await isPidSafeHappySessionProcess({
    pid: params.pid,
    expectedProcessCommandHash: params.expectedSession.processCommandHash,
    expectedProcessStartTimeMs: params.expectedSession.processStartTimeMs,
  });
  if (!safe) {
    params.logPidReuseRefusal(
      `[DAEMON RUN] Refusing to SIGKILL PID ${params.pid} for session ${params.normalizedSessionId} (PID reuse safety)`,
    );
    return false;
  }
  if (!params.claimSignalAuthority()) return false;

  try {
    if (params.expectedSession.startedBy === 'daemon' && params.expectedSession.childProcess) {
      if (!isTrackedChildStillLiveForPid(params.expectedSession, params.pid)) return false;
      await killProcessTree(params.expectedSession.childProcess, { graceMs: 1 });
    } else {
      await killProcessTree({ pid: params.pid }, { graceMs: 1 });
    }
    logger.debug(
      `[DAEMON RUN] Forced session runner termination for ${params.normalizedSessionId} (pid=${params.pid})`,
    );
    return true;
  } catch (error) {
    logger.debug(
      `[DAEMON RUN] Failed to force-terminate session ${params.normalizedSessionId} (pid=${params.pid}):`,
      error,
    );
    return false;
  }
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
  readTerminalAttachmentInfo?: typeof readDefaultTerminalAttachmentInfo;
  removeTerminalAttachmentInfo?: typeof removeDefaultTerminalAttachmentInfo;
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
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
  recoverStrandedTerminalControlServiceability?: (input: Readonly<{
    sessionId: string;
    expectedAttachmentId?: string;
  }>) => Promise<StopSessionResult | null>;
  expectedTerminalAttachmentId?: string;
  requireTerminalTopologyProof?: boolean;
  provenTerminalHostKindsByPid?: ReadonlyMap<number, TerminalHostAdapter['kind']>;
  provenTerminalModesByPid?: ReadonlyMap<number, TerminalMode>;
  retireUpstreamAuthorityBeforeProcessStop?: (
    pid: number,
  ) => Promise<boolean>;
}>): (
  sessionId: string,
  options?: StopSessionOptions,
) => Promise<StopSessionResult> {
  const { pidToTrackedSession } = params;
  const logPidReuseRefusal = params.logPidReuseRefusal ?? ((message: string): void => logger.warn(message));
  const logWarning = params.logWarning ?? ((message: string, ...args: unknown[]): void => logger.warn(message, ...args));

  // Stop a session by sessionId or PID fallback
  return async (
    sessionId: string,
    options?: StopSessionOptions,
  ): Promise<StopSessionResult> => {
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
      if (
        matches
        && isExactTrackedRunner(
          pid,
          session,
          options?.expectedTrackedRunner,
        )
      ) {
        pidsToStop.push(pid);
        expectedTrackedSessionsByPid.set(pid, session);
      }
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
    const predecessorAttachmentInfo = !isPidFallback && !attachmentInfo
      ? await (params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo)({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: normalizedSessionId,
        }).catch(() => null)
      : null;
    const predecessorAttachmentHandle = predecessorAttachmentInfo
      ? buildLegacyTerminalAttachmentHostHandle(
          predecessorAttachmentInfo,
          configuration.happyHomeDir,
        )
      : null;
    const predecessorWindowsPid = predecessorAttachmentInfo?.terminal.mode === 'windows_terminal'
      || predecessorAttachmentInfo?.terminal.mode === 'windows_console'
      ? predecessorAttachmentInfo.terminal.windows?.pid
      : undefined;
    const hasExactPredecessorWindowsRunner = typeof predecessorWindowsPid === 'number'
      && Number.isSafeInteger(predecessorWindowsPid)
      && predecessorWindowsPid > 0
      && pidsToStop.includes(predecessorWindowsPid);
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
      if (params.requireTerminalTopologyProof && terminalModes.some((mode) => mode === undefined)) {
        logWarning(`[DAEMON RUN] Refusing to stop marker-derived session ${normalizedSessionId} without explicit terminal topology provenance`);
        return incompleteStopSession('missing_topology_proof');
      }
      const matchedTerminalHost = terminalModes.some((mode) =>
        mode === 'tmux' || mode === 'zellij' || mode === 'windows_terminal' || mode === 'windows_console');
      if (
        !attachmentInfo
        && matchedTerminalHost
        && !predecessorAttachmentHandle
        && !hasExactPredecessorWindowsRunner
      ) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal host without committed attachment identity for session ${normalizedSessionId}`);
        return incompleteStopSession('missing_attachment_identity');
      }
      if (attachmentInfo?.version === 2 && attachmentInfo.handle.kind === 'windows_console' && !retiredTerminalMode) {
        logWarning(`[DAEMON RUN] Refusing to retire Windows terminal topology without a unique actual-mode proof for session ${normalizedSessionId}`);
        return incompleteStopSession('missing_topology_proof');
      }
    }

    const legacyRecoveryEvidence = attachmentInfo?.version === 1
      ? {
          source: 'host_descriptor' as const,
          attachmentInfo,
          handle: attachmentInfo.handle,
        }
      : predecessorAttachmentInfo
        ? {
            source: 'predecessor_metadata' as const,
            attachmentInfo: predecessorAttachmentInfo,
            handle: predecessorAttachmentHandle,
          }
        : null;
    let terminalHostAdaptersPromise: Promise<Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>> | null> | null = null;
    const loadTerminalHostAdapters = async () => {
      if (params.terminalHostAdapters) return params.terminalHostAdapters;
      terminalHostAdaptersPromise ??= params.loadTerminalHostAdapters?.().catch((error) => {
        logWarning(`[DAEMON RUN] Failed to acquire terminal host cleanup adapters for session ${normalizedSessionId}`, error);
        return null;
      }) ?? Promise.resolve(null);
      return await terminalHostAdaptersPromise;
    };
    const retireLegacyAttachmentAfterPositiveDeath = async (
      evidence: NonNullable<typeof legacyRecoveryEvidence>,
      options: Readonly<{ runnerExitProven: boolean; trackedPids: readonly number[] }>,
    ): Promise<StopSessionResult> => {
      if (evidence.handle) {
        const adapters = await loadTerminalHostAdapters();
        const adapter = adapters?.[evidence.handle.kind];
        if (!adapter) return incompleteStopSession('terminal_host_adapter_unavailable');
        const probe = await probeTerminalHostForRecovery({ adapter, handle: evidence.handle });
        if (probe.status === 'alive') return incompleteStopSession('legacy_attachment');
        if (probe.status === 'inconclusive') return incompleteStopSession('missing_topology_proof');
      } else {
        const persistedWindowsPid = evidence.source === 'predecessor_metadata'
          && (
            evidence.attachmentInfo.terminal.mode === 'windows_terminal'
            || evidence.attachmentInfo.terminal.mode === 'windows_console'
          )
          ? evidence.attachmentInfo.terminal.windows?.pid
          : undefined;
        const exactWindowsRunnerExited = options.runnerExitProven
          && typeof persistedWindowsPid === 'number'
          && Number.isSafeInteger(persistedWindowsPid)
          && persistedWindowsPid > 0
          && options.trackedPids.includes(persistedWindowsPid);
        if (
          !exactWindowsRunnerExited
          && (
            evidence.source !== 'predecessor_metadata'
            || evidence.attachmentInfo.terminal.mode !== 'plain'
            || !options.runnerExitProven
          )
        ) {
          return incompleteStopSession('legacy_attachment');
        }
      }

      if (evidence.source === 'host_descriptor') {
        const disposition = await executeConfirmedDeadTerminalHostAttachmentRetirement({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: normalizedSessionId,
          expectedAttachmentInfo: evidence.attachmentInfo,
          readAttachmentInfo: readHostAttachmentInfo,
          removeAttachmentInfo: params.removeHostAttachmentInfo ?? removeTerminalHostAttachmentInfo,
        });
        return disposition.status === 'retired'
          ? { status: 'stopped' }
          : disposition.status === 'parked'
            ? incompleteStopSession(mapDispositionFailureReason(disposition.reason))
            : incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
      }

      const removed = await (
        params.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo
      )({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        expected: evidence.attachmentInfo,
      }).catch(() => false);
      return removed
        ? { status: 'stopped' }
        : incompleteStopSession('attachment_mismatch');
    };

    if (pidsToStop.length === 0) {
      if (legacyRecoveryEvidence) {
        return await retireLegacyAttachmentAfterPositiveDeath(legacyRecoveryEvidence, {
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
          if (recovered) {
            if (recovered.status !== 'stopped' || attachmentInfo?.version !== 2) return recovered;
            const descriptorRemoved = await (
              params.removeHostAttachmentInfo ?? removeTerminalHostAttachmentInfo
            )({
              happyHomeDir: configuration.happyHomeDir,
              sessionId: normalizedSessionId,
              expectedAttachmentId: attachmentInfo.attachmentId,
              expectedHandle: attachmentInfo.handle,
            }).catch(() => false);
            if (!descriptorRemoved) {
              return incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
            }
            await params.onExactTerminalAttachmentRetired?.({
              happyHomeDir: configuration.happyHomeDir,
              sessionId: normalizedSessionId,
              attachmentInfo,
            }).catch((error) => {
              logWarning(`[DAEMON RUN] Terminal host retired but provider artifacts could not be cleaned for session ${normalizedSessionId}`, error);
            });
            return recovered;
          }
        } catch (error) {
          logWarning(`[DAEMON RUN] Failed to inspect stranded terminal control for session ${normalizedSessionId}`, error);
          return incompleteStopSession('missing_topology_proof');
        }
      }
      if (attachmentInfo?.version === 2) {
        logWarning(`[DAEMON RUN] Refusing to destroy terminal host without exact tracked-runner exit proof for session ${normalizedSessionId}`);
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

    const runnersAlreadyExited = params.areTrackedRunnersExited
      ? await params.areTrackedRunnersExited({ sessionId: normalizedSessionId, trackedPids: pidsToStop }).catch(() => false)
      : false;
    const signalEligiblePids: number[] = [];
    for (const pid of runnersAlreadyExited ? [] : pidsToStop) {
      if (!isExactTrackedRunner(
        pid,
        pidToTrackedSession.get(pid),
        options?.expectedTrackedRunner,
      )) continue;
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
      if (!isExactTrackedRunner(
        pid,
        pidToTrackedSession.get(pid),
        options?.expectedTrackedRunner,
      )) continue;
      signalEligiblePids.push(pid);
    }
    let stoppedAny = false;
    const signaledPids: number[] = [];
    const confirmedExitedPids: number[] = runnersAlreadyExited ? [...pidsToStop] : [];
    for (const pid of runnersAlreadyExited ? [] : signalEligiblePids) {
      const session = pidToTrackedSession.get(pid);
      if (!isExactTrackedRunner(
        pid,
        session,
        options?.expectedTrackedRunner,
      )) continue;
      const claimSignalAuthority = (): boolean => {
        const current = pidToTrackedSession.get(pid);
        if (!isExactTrackedRunner(
          pid,
          current,
          options?.expectedTrackedRunner,
        )) return false;
        options?.beforeSignalExactTrackedRunner?.(current);
        return isExactTrackedRunner(
          pid,
          pidToTrackedSession.get(pid),
          options?.expectedTrackedRunner,
        );
      };

      if (session.startedBy === 'daemon' && session.childProcess) {
        if (process.platform === 'win32') {
          if (await taskkillWindowsDaemonChild({
            pid,
            session,
            normalizedSessionId,
            logPidReuseRefusal,
            claimSignalAuthority,
          })) {
            stoppedAny = true;
            signaledPids.push(pid);
          }
          continue;
        }

        const safe = await isPidSafeHappySessionProcess({
          pid,
          expectedProcessCommandHash: session.processCommandHash,
          expectedProcessStartTimeMs: session.processStartTimeMs,
        });
        if (!safe) {
          logPidReuseRefusal(
            `[DAEMON RUN] Refusing to SIGTERM daemon-child PID ${pid} for session ${normalizedSessionId} (PID reuse safety)`,
          );
          continue;
        }

        try {
          if (!claimSignalAuthority()) continue;
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

          const fallbackSafe = await isPidSafeHappySessionProcess({
            pid,
            expectedProcessCommandHash: session.processCommandHash,
            expectedProcessStartTimeMs: session.processStartTimeMs,
          });
          if (!fallbackSafe) {
            logPidReuseRefusal(
              `[DAEMON RUN] Refusing to SIGTERM daemon-child PID ${pid} fallback for session ${normalizedSessionId} (PID reuse safety)`,
            );
            continue;
          }
          if (
            pidToTrackedSession.get(pid) !== session
            || !claimSignalAuthority()
            || pidToTrackedSession.get(pid) !== session
          ) continue;
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
      const safe = await isPidSafeHappySessionProcess({
        pid,
        expectedProcessCommandHash: session.processCommandHash,
        expectedProcessStartTimeMs: session.processStartTimeMs,
      });
      if (!safe) {
        logPidReuseRefusal(`[DAEMON RUN] Refusing to SIGTERM PID ${pid} for session ${normalizedSessionId} (PID reuse safety)`);
        continue;
      }
      if (!claimSignalAuthority()) continue;

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
          params.areTrackedRunnersExited
          && await params.areTrackedRunnersExited({
            sessionId: normalizedSessionId,
            trackedPids: [pid],
          }).catch(() => false)
        ) {
          exitedBeforeForcePids.add(pid);
          continue;
        }
        const expectedSession = expectedTrackedSessionsByPid.get(pid);
        if (!expectedSession) continue;
        const claimForceSignalAuthority = (): boolean => {
          const current = pidToTrackedSession.get(pid);
          if (current !== expectedSession || !isExactTrackedRunner(
            pid,
            current,
            options?.expectedTrackedRunner,
          )) return false;
          options?.beforeSignalExactTrackedRunner?.(current);
          const afterClaim = pidToTrackedSession.get(pid);
          return afterClaim === expectedSession && isExactTrackedRunner(
            pid,
            afterClaim,
            options?.expectedTrackedRunner,
          );
        };
        forceSignaledAny = await forceKillTrackedRunner({
          pid,
          expectedSession,
          normalizedSessionId,
          claimSignalAuthority: claimForceSignalAuthority,
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
          `[DAEMON RUN] Forced termination did not prove tracked runner exit; preserving terminal host for session ${normalizedSessionId}`,
        );
        return incompleteStopSession('runner_exit_timeout');
      }
    }

    if (legacyRecoveryEvidence) {
      return await retireLegacyAttachmentAfterPositiveDeath(legacyRecoveryEvidence, {
        runnerExitProven: true,
        trackedPids: pidsToStop,
      });
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
        beforeDescriptorRetirement: params.retireExactTerminalControlServiceability && retiredTerminalMode
          ? async ({ attachmentInfo: currentAttachmentInfo }) => {
              await params.retireExactTerminalControlServiceability!({
                happyHomeDir: configuration.happyHomeDir,
                sessionId: normalizedSessionId,
                attachmentInfo: currentAttachmentInfo,
                terminalMode: retiredTerminalMode,
              });
            }
          : undefined,
      });
      if (disposition.status === 'destroyed' && disposition.retirementFailed) {
        logWarning('[DAEMON RUN] Exact terminal host was destroyed but control serviceability retirement failed', {
          sessionId: normalizedSessionId,
          attachmentId: attachmentInfo.attachmentId,
        });
        return incompleteStopSession('terminal_control_serviceability_retirement_failed');
      }
      if (disposition.status === 'destroyed' && disposition.descriptorRetained) {
        return incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
      }
      if (disposition.status === 'destroyed' && params.onExactTerminalAttachmentRetired) {
        await params.onExactTerminalAttachmentRetired({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: normalizedSessionId,
          attachmentInfo,
        }).catch((error) => {
          logWarning(`[DAEMON RUN] Terminal host retired but provider artifacts could not be cleaned for session ${normalizedSessionId}`, error);
        });
      }
      if (disposition.status === 'destroyed') return { status: 'stopped' };
      return disposition.status === 'parked'
        ? incompleteStopSession(mapDispositionFailureReason(disposition.reason))
        : incompleteStopSession('destroy_failed');
    }
    return { status: 'stopped' };
  };
}
