
import { logger } from '@/ui/logger';
import { sessionStopRequestDiagnostics, type SessionStopRequestDiagnostics } from './stopSessionDiagnostics';
import { configuration } from '@/configuration';
import type { TerminalHostAdapter } from '@happier-dev/agents';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  readTerminalHostAttachmentInfo,
  readTerminalHostAttachmentState,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  removeTerminalHostAttachmentInfo,
  type ExactTerminalHostAttachmentInfo,
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
import { createProcessTreeTerminator, type ProcessTreeTerminationInput, type ProcessTreeTerminationResult } from '@/processes/terminate/terminateProcessTree';
import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import type { OwnerRemainderPort } from '../processes/endOwnerRemainder';

import { isPidSafeHappySessionProcess } from '../pidSafety';
import type { TrackedSession } from '../types';
import {
  incompleteStopSession,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from './stopSessionContract';
import type { ExactTerminalControlServiceabilityRetirement, RetainedPlainRunnerRetirement, retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';
import { resolveTrackedSessionTerminalPresentation } from './resolveTrackedSessionTerminalPresentation';

function mapDispositionFailureReason(
  reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed' | 'retirement_failed' | 'descriptor_retirement_failed',
): StopSessionIncompleteReason {
  return reason === 'retirement_failed'
    ? 'terminal_control_serviceability_retirement_failed'
    : reason === 'descriptor_retirement_failed'
      ? 'terminal_attachment_descriptor_retirement_failed'
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

export type StopSessionOptions = SessionStopRequestDiagnostics & Readonly<{
  /** Captured authenticated metadata authority for this Stop; never transported. */
  metadataContext?: Pick<Parameters<typeof retireExactTerminalControlServiceability>[0],
    'credentials' | 'currentness' | 'resolveAuthorizationHeaders'>;
  expectedTrackedRunner?: ExactTrackedRunnerStopWitness;
  beforeSignalExactTrackedRunner?: (tracked: TrackedSession) => void | boolean | Promise<void | boolean>;
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
  attachmentInfo: ExactTerminalHostAttachmentInfo,
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
    || mode === 'herdr'
    || mode === 'windows_terminal'
    || mode === 'windows_console'
    ? mode
    : undefined;
}

async function forceKillTrackedRunner(params: Readonly<{
  pid: number;
  expectedSession: TrackedSession;
  normalizedSessionId: string;
  claimSignalAuthority(): Promise<boolean>;
  isSignalAuthorityCurrent(): boolean;
  logPidReuseRefusal: (message: string) => void;
  terminateTargets(input: ProcessTreeTerminationInput): Promise<ProcessTreeTerminationResult>;
}>): Promise<boolean> {
  if (!await params.claimSignalAuthority()) return false;
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
  if (!params.isSignalAuthorityCurrent()) return false;

  try {
    if (params.expectedSession.startedBy === 'daemon' && params.expectedSession.childProcess
      && !isTrackedChildStillLiveForPid(params.expectedSession, params.pid)) return false;
    const result = await params.terminateTargets({ targets: [{ pid: params.pid,
      ...(params.expectedSession.processStartTimeMs === undefined ? {} : { start: { startTimeMs: params.expectedSession.processStartTimeMs } }) }], graceMs: 1 });
    if (result.outcomes.some(outcome => outcome.outcome === 'refused' || outcome.outcome === 'survived')) return false;
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
  ownerRemainder?: OwnerRemainderPort;
  processCensusDependencies?: ProcessCensusDependencies;
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
  /** Physical liveness only; the exit wait owns lifecycle and inventory settlement. */
  areTrackedRunnersExited?: (input: Readonly<{
    sessionId: string;
    trackedPids: readonly number[];
  }>) => Promise<boolean>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: ExactTerminalHostAttachmentInfo;
  }>) => Promise<void>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    metadataContext?: StopSessionOptions['metadataContext'];
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: ExactTerminalHostAttachmentInfo;
    terminalMode: TerminalMode;
    stoppedAt: number;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
  retireAbsentTerminalControlServiceability?: (input: Readonly<{
    metadataContext?: StopSessionOptions['metadataContext'];
    sessionId: string;
    trackedSession: TrackedSession;
    stoppedAt: number;
  }>) => Promise<RetainedPlainRunnerRetirement>;
  recoverStrandedTerminalControlServiceability?: (input: Readonly<{
    metadataContext?: StopSessionOptions['metadataContext'];
    sessionId: string;
    expectedAttachmentId?: string;
    stoppedAt: number;
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
  const terminateTargets = createProcessTreeTerminator({ censusDependencies: params.processCensusDependencies,
    platform: params.processCensusDependencies?.platform });
  const logPidReuseRefusal = params.logPidReuseRefusal ?? ((message: string): void => logger.warn(message));
  const logWarning = params.logWarning ?? ((message: string, ...args: unknown[]): void => logger.warn(message, ...args));

  // Stop a session by sessionId or PID fallback
  return async (
    sessionId: string,
    options?: StopSessionOptions,
  ): Promise<StopSessionResult> => {
    const stopStartedAtMs = Date.now();
    const requestDiagnostics = sessionStopRequestDiagnostics(options);
    logger.infoFile('[DAEMON STOP] Attempting Stop', { event: 'session_stop_attempt', sessionId, ...requestDiagnostics });
    logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);
    const observeStopPhase = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
      const startedAtMs = Date.now();
      logger.infoFile('[DAEMON STOP] Physical Stop phase started', { sessionId, phase, ...requestDiagnostics });
      try {
        return await operation();
      } finally {
        logger.infoFile('[DAEMON STOP] Physical Stop phase settled', {
          sessionId, phase, ...requestDiagnostics, elapsedMs: Date.now() - startedAtMs,
          totalElapsedMs: Date.now() - stopStartedAtMs,
        });
      }
    };

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
    const isCapturedTrackedRunnerCurrent = (pid: number): boolean => {
      const expected = expectedTrackedSessionsByPid.get(pid);
      return expected !== undefined
        && pidToTrackedSession.get(pid) === expected
        && isExactTrackedRunner(pid, expected, options?.expectedTrackedRunner);
    };
    const haveTrackedRunnersExited = async (trackedPids: readonly number[]): Promise<boolean> => {
      if (!params.areTrackedRunnersExited) return false;
      try {
        return await params.areTrackedRunnersExited({ sessionId: normalizedSessionId, trackedPids });
      } catch (error) {
        logWarning(`[DAEMON RUN] Failed to check tracked runner exit for session ${normalizedSessionId}`, error);
        return false;
      }
    };

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
        (attachmentInfo?.version !== 2 && attachmentInfo?.version !== 3)
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
    const retiredTerminalMode = attachmentInfo?.version === 2 || attachmentInfo?.version === 3
      ? resolveRetiredTerminalMode(attachmentInfo, actualTerminalModes)
      : null;
    if (!isPidFallback) {
      if (params.requireTerminalTopologyProof && terminalModes.some((mode) => mode === undefined)) {
        logWarning(`[DAEMON RUN] Refusing to stop marker-derived session ${normalizedSessionId} without explicit terminal topology provenance`);
        return incompleteStopSession('missing_topology_proof');
      }
      const matchedTerminalHost = terminalModes.some((mode) =>
        mode === 'tmux' || mode === 'zellij' || mode === 'herdr' || mode === 'windows_terminal' || mode === 'windows_console');
      if (
        !attachmentInfo
        && matchedTerminalHost
        && !predecessorAttachmentHandle
        && !hasExactPredecessorWindowsRunner
      ) {
        for (const [index, mode] of terminalModes.entries()) {
          if (mode !== 'tmux' && mode !== 'zellij' && mode !== 'herdr'
            && mode !== 'windows_terminal' && mode !== 'windows_console') continue;
          const pid = pidsToStop[index]!;
          const expected = expectedTrackedSessionsByPid.get(pid);
          // No unknown host is signalled or disposed. A positively dead runner
          // still proceeds through final presence, remainder and metadata retirement.
          if (await haveTrackedRunnersExited([pid]) && isCapturedTrackedRunnerCurrent(pid)) continue;
          const ownsCurrentRunner = expected?.startedBy === 'daemon'
            && isCapturedTrackedRunnerCurrent(pid)
            && await isPidSafeHappySessionProcess({
              pid,
              expectedProcessCommandHash: expected.processCommandHash,
              expectedProcessStartTimeMs: expected.processStartTimeMs,
            });
          // Only a proven daemon-owned headless runner can outlive its optional client.
          const presentation = ownsCurrentRunner && expected
            ? await resolveTrackedSessionTerminalPresentation(expected,
                mode === 'windows_terminal' ? 'windows_console' : mode)
            : null;
          if (ownsCurrentRunner && expected && isCapturedTrackedRunnerCurrent(pid)
            && presentation?.kind === 'provider_attach') continue;
          logWarning(`[DAEMON RUN] Refusing to destroy terminal host without committed attachment identity for session ${normalizedSessionId}`);
          return incompleteStopSession('missing_attachment_identity');
        }
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
    const retireAbsentRunnerServiceability = async (): Promise<StopSessionResult> => {
      if (!isPidFallback && params.retireAbsentTerminalControlServiceability) {
        try {
          let retired = false;
          for (const trackedSession of expectedTrackedSessionsByPid.values()) {
            const retirement = await observeStopPhase('plain_control_serviceability_retirement', () =>
              params.retireAbsentTerminalControlServiceability!({ sessionId: normalizedSessionId, trackedSession,
                stoppedAt: Date.now(),
                ...(options?.metadataContext ? { metadataContext: options.metadataContext } : {}) }));
            if (retirement === 'deferred' && [...pidToTrackedSession.values()].includes(trackedSession)) {
              return incompleteStopSession('terminal_control_serviceability_retirement_failed');
            }
            if (retirement === 'retired' || retirement === 'deferred') {
              retired = true;
              break;
            }
          }
          if (!retired) {
            // A native runner may publish hostPid before its webhook binds it
            // to the tracked launcher. Reuse recovery's current-Machine and
            // dead-host proof before retiring that different metadata owner.
            const recovered = await params.recoverStrandedTerminalControlServiceability?.({
              sessionId: normalizedSessionId,
              stoppedAt: Date.now(),
              ...(options?.metadataContext ? { metadataContext: options.metadataContext } : {}),
            });
            return recovered ?? incompleteStopSession('terminal_control_serviceability_retirement_failed');
          }
        } catch (error) {
          logWarning('[DAEMON RUN] Failed to publish absent terminal control serviceability after runner Stop', error);
          return incompleteStopSession('terminal_control_serviceability_retirement_failed');
        }
      }
      return { status: 'stopped' };
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
          ? options.trackedPids.length > 0 ? await retireAbsentRunnerServiceability() : { status: 'stopped' }
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
        ? options.trackedPids.length > 0 ? await retireAbsentRunnerServiceability() : { status: 'stopped' }
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
            stoppedAt: Date.now(),
            ...(options?.metadataContext ? { metadataContext: options.metadataContext } : {}),
            ...(attachmentInfo?.version === 2
              ? { expectedAttachmentId: attachmentInfo.attachmentId }
              : {}),
          });
          if (recovered) {
            if (recovered.status !== 'stopped' || attachmentInfo?.version !== 2) return recovered;
            const disposition = await executeTerminalHostDisposition({
              happyHomeDir: configuration.happyHomeDir,
              sessionId: normalizedSessionId,
              expectedAttachmentId: attachmentInfo.attachmentId,
              intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
              readAttachmentInfo: readHostAttachmentInfo,
              removeAttachmentInfo: params.removeHostAttachmentInfo ?? removeTerminalHostAttachmentInfo,
            });
            if (disposition.status !== 'retired') {
              return incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
            }
            await params.onExactTerminalAttachmentRetired?.({
              happyHomeDir: configuration.happyHomeDir,
              sessionId: normalizedSessionId,
              attachmentInfo,
            }).catch((error) => {
              logWarning(`[DAEMON RUN] Failed to record terminal host retirement for session ${normalizedSessionId}`, error);
            });
            return recovered;
          }
        } catch (error) {
          logWarning(`[DAEMON RUN] Failed to inspect stranded terminal control for session ${normalizedSessionId}`, error);
          return incompleteStopSession('missing_topology_proof');
        }
      }
      if (attachmentInfo?.version === 2 || attachmentInfo?.version === 3) {
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

    const runnersAlreadyExited = await observeStopPhase('runner_exit_probe', () => haveTrackedRunnersExited(pidsToStop));
    const signalEligiblePids: number[] = [];
    for (const pid of runnersAlreadyExited ? [] : pidsToStop) {
      if (!isCapturedTrackedRunnerCurrent(pid)) continue;
      if (
        params.retireUpstreamAuthorityBeforeProcessStop
        && !await observeStopPhase('upstream_authority_retirement', () =>
          params.retireUpstreamAuthorityBeforeProcessStop!(pid))
      ) {
        logWarning(
          `[DAEMON RUN] Refusing to signal session ${normalizedSessionId} because upstream authority retirement was incomplete`,
        );
        return incompleteStopSession('runner_signal_incomplete');
      }
      if (!isCapturedTrackedRunnerCurrent(pid)) continue;
      signalEligiblePids.push(pid);
    }
    const remainderOwner = { kind: 'session', sessionId: normalizedSessionId } as const;
    const capturedRemainder = params.ownerRemainder && pidsToStop.length > 0
      ? await observeStopPhase('remainder_capture', () => params.ownerRemainder!.capture(remainderOwner))
      : undefined;
    if (capturedRemainder) {
      // A planned retirement already captured this generation's physical tree.
      // A later logical Session census must not erase its reparented Run children.
      for (const session of expectedTrackedSessionsByPid.values()) session.ownerRemainderCapture ??= capturedRemainder;
    }
    let stoppedAny = false;
    const signaledPids: number[] = [];
    const confirmedExitedPids: number[] = runnersAlreadyExited ? [...pidsToStop] : [];
    for (const pid of runnersAlreadyExited ? [] : signalEligiblePids) {
      const session = pidToTrackedSession.get(pid);
      if (!session || !isCapturedTrackedRunnerCurrent(pid)) continue;
      const isSignalAuthorityCurrent = (): boolean => isCapturedTrackedRunnerCurrent(pid);
      const claimSignalAuthority = async (): Promise<boolean> => {
        const current = pidToTrackedSession.get(pid);
        if (!current || !isCapturedTrackedRunnerCurrent(pid)) return false;
        if (await options?.beforeSignalExactTrackedRunner?.(current) === false) return false;
        return isCapturedTrackedRunnerCurrent(pid);
      };

      try {
        if (!await observeStopPhase('signal_authority', claimSignalAuthority)) continue;
        const safe = await observeStopPhase('runner_identity', () => isPidSafeHappySessionProcess({
          pid, expectedProcessCommandHash: session.processCommandHash,
          expectedProcessStartTimeMs: session.processStartTimeMs,
        }));
        if (!safe) {
          logPidReuseRefusal(`[DAEMON RUN] Refusing to signal PID ${pid} for session ${normalizedSessionId} (PID reuse safety)`);
          continue;
        }
        if (!isSignalAuthorityCurrent()
          || (session.startedBy === 'daemon' && session.childProcess && !isTrackedChildStillLiveForPid(session, pid))) continue;
        if (params.ownerRemainder && session.ownerRemainderCapture?.scope !== 'subtree') {
          // Logical ownership can belong to a child Run or a shared launch fence.
          // Retain this runner's exact native tree before its ancestry disappears.
          const tree = await observeStopPhase('runner_tree_capture', () => params.ownerRemainder!.captureTree(remainderOwner, {
            pid,
            ...(session.processStartTimeMs === undefined ? {} : { start: { startTimeMs: session.processStartTimeMs } }),
          }));
          if (!isSignalAuthorityCurrent()) continue;
          if (!tree) return incompleteStopSession('runner_signal_incomplete');
          session.ownerRemainderCapture = tree;
          delete session.ownerRemainderResult;
        }
        session.stopRequestedAtMs ??= Date.now();
        // The runner lifecycle owns its established exit wait; one terminator owns every signal.
        const result = await observeStopPhase('signal_request', () => terminateTargets({
          targets: [{ pid, ...(session.processStartTimeMs === undefined ? {} : { start: { startTimeMs: session.processStartTimeMs } }) }],
          tree: false, waitForExit: false,
        }));
        if (result.outcomes.some(outcome => outcome.outcome === 'refused')) continue;
        stoppedAny = true;
        signaledPids.push(pid);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to signal session ${normalizedSessionId} (pid=${pid}):`, error);
      }
    }

    const unsignaledPids = pidsToStop.filter((pid) =>
      !signaledPids.includes(pid) && !confirmedExitedPids.includes(pid));
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
    // A dead runner still owns exit settlement and inventory custody. Record
    // explicit Stop before the lifecycle observes it, including runners that
    // needed no signal, so their exit cannot become automatic crash recovery.
    for (const pid of confirmedExitedPids) {
      if (isCapturedTrackedRunnerCurrent(pid)) {
        expectedTrackedSessionsByPid.get(pid)!.stopRequestedAtMs ??= Date.now();
      }
    }
    let runnersExited = await params.waitForTrackedRunnersExit({
      sessionId: normalizedSessionId,
      trackedPids: pidsToStop,
    });
    if (!runnersExited && confirmedExitedPids.length === pidsToStop.length) {
      logWarning(`[DAEMON RUN] Dead runner exit settlement was incomplete for session ${normalizedSessionId}`);
      return incompleteStopSession('runner_exit_timeout');
    }
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
        const claimForceSignalAuthority = async (): Promise<boolean> => {
          const current = pidToTrackedSession.get(pid);
          if (!current || !isCapturedTrackedRunnerCurrent(pid)) return false;
          if (await options?.beforeSignalExactTrackedRunner?.(current) === false) return false;
          return isCapturedTrackedRunnerCurrent(pid);
        };
        forceSignaledAny = await forceKillTrackedRunner({
          pid,
          expectedSession,
          normalizedSessionId,
          claimSignalAuthority: claimForceSignalAuthority,
          isSignalAuthorityCurrent: () => isCapturedTrackedRunnerCurrent(pid),
          logPidReuseRefusal,
          terminateTargets,
        }) || forceSignaledAny;
      }

      if (exitedBeforeForcePids.size === pidsToStop.length || forceSignaledAny) {
        runnersExited = await params.waitForTrackedRunnersExit({
          sessionId: normalizedSessionId,
          trackedPids: pidsToStop,
        });
      } else if (params.areTrackedRunnersExited) {
        // Identity inspection may await OS discovery while the runner exits.
        // Refusing to signal is not liveness evidence; retain the canonical positive-death proof.
        runnersExited = await haveTrackedRunnersExited(pidsToStop)
          && await params.waitForTrackedRunnersExit({
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

    logger.infoFile('[DAEMON STOP] Runner exit proven', {
      sessionId: normalizedSessionId,
      elapsedMs: Date.now() - stopStartedAtMs,
      trackedRunnerCount: pidsToStop.length,
    });
    if (params.ownerRemainder && pidsToStop.length > 0) {
      const expectedSessions = [...expectedTrackedSessionsByPid.values()];
      const completedCaptures = new Set(expectedSessions.filter((session) => session.ownerRemainderResult)
        .map((session) => session.ownerRemainderCapture ?? capturedRemainder));
      const pendingCaptures = new Set(expectedSessions.filter((session) => !session.ownerRemainderResult)
        .map((session) => session.ownerRemainderCapture ?? capturedRemainder)
        .filter((capture) => !completedCaptures.has(capture)));
      const remainders = [
        ...expectedSessions.flatMap((session) => session.ownerRemainderResult ? [session.ownerRemainderResult] : []),
        ...await Promise.all([...pendingCaptures].map((capture) => params.ownerRemainder!.end(remainderOwner, capture))),
      ];
      const incompleteRemainder = remainders.find((remainder) => remainder.status !== 'complete');
      if (incompleteRemainder) {
        logWarning(`[DAEMON RUN] Session remainder cleanup was incomplete for ${normalizedSessionId}`, incompleteRemainder);
        return incompleteStopSession('runner_signal_incomplete');
      }
    }
    const retirementStartedAtMs = Date.now();
    if (legacyRecoveryEvidence) {
      return await retireLegacyAttachmentAfterPositiveDeath(legacyRecoveryEvidence, {
        runnerExitProven: true,
        trackedPids: pidsToStop,
      });
    }

    if (attachmentInfo?.version === 3) {
      const disposition = await executeTerminalHostDisposition({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        expectedAttachmentId: attachmentInfo.attachmentId,
        expectedAttachmentInfo: attachmentInfo,
        intent: { kind: 'release_borrowed_host', reason: 'explicit_user_stop' },
        readAttachmentState: readHostAttachmentState,
        removeAttachmentInfo: params.removeHostAttachmentInfo ?? removeTerminalHostAttachmentInfo,
        beforeDescriptorRetirement: params.retireExactTerminalControlServiceability && retiredTerminalMode
          ? async ({ attachmentInfo: currentAttachmentInfo }) => {
              const serviceabilityStartedAtMs = Date.now();
              await params.retireExactTerminalControlServiceability!({
                ...(options?.metadataContext ? { metadataContext: options.metadataContext } : {}),
                happyHomeDir: configuration.happyHomeDir,
                sessionId: normalizedSessionId,
                attachmentInfo: currentAttachmentInfo,
                terminalMode: retiredTerminalMode,
                stoppedAt: Date.now(),
              });
              logger.infoFile('[DAEMON STOP] Borrowed control serviceability retirement completed', {
                sessionId: normalizedSessionId,
                elapsedMs: Date.now() - serviceabilityStartedAtMs,
              });
            }
          : undefined,
      });
      if (disposition.status !== 'retired') {
        return disposition.status === 'parked'
          ? incompleteStopSession(mapDispositionFailureReason(disposition.reason))
          : incompleteStopSession('terminal_attachment_descriptor_retirement_failed');
      }
      await params.onExactTerminalAttachmentRetired?.({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        attachmentInfo,
      }).catch((error) => {
        logWarning(`[DAEMON RUN] Failed to record terminal host retirement for session ${normalizedSessionId}`, error);
      });
      logger.infoFile('[DAEMON STOP] Borrowed attachment retirement completed', {
        sessionId: normalizedSessionId,
        elapsedMs: Date.now() - retirementStartedAtMs,
        totalElapsedMs: Date.now() - stopStartedAtMs,
      });
      return { status: 'stopped' };
    }

    if (attachmentInfo?.version === 2) {
      if (!terminalHostAdapterForDisposition) {
        return incompleteStopSession('terminal_host_adapter_unavailable');
      }
      const disposition = await executeTerminalHostDisposition({
        happyHomeDir: configuration.happyHomeDir,
        sessionId: normalizedSessionId,
        expectedAttachmentId: attachmentInfo.attachmentId,
        expectedAttachmentInfo: attachmentInfo,
        intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' },
        adapter: terminalHostAdapterForDisposition,
        readAttachmentState: readHostAttachmentState,
        removeAttachmentInfo: params.removeHostAttachmentInfo ?? removeTerminalHostAttachmentInfo,
        beforeDescriptorRetirement: async ({ attachmentInfo: currentAttachmentInfo }) => {
          logger.infoFile('[DAEMON STOP] Exact host disposal proven', {
            sessionId: normalizedSessionId,
            elapsedMs: Date.now() - retirementStartedAtMs,
          });
          const serviceabilityStartedAtMs = Date.now();
          if (params.retireExactTerminalControlServiceability && retiredTerminalMode) {
            await params.retireExactTerminalControlServiceability({
              ...(options?.metadataContext ? { metadataContext: options.metadataContext } : {}),
              happyHomeDir: configuration.happyHomeDir,
              sessionId: normalizedSessionId,
              attachmentInfo: currentAttachmentInfo,
              terminalMode: retiredTerminalMode,
              stoppedAt: Date.now(),
            });
          }
          logger.infoFile('[DAEMON STOP] Control serviceability retirement completed', {
            sessionId: normalizedSessionId,
            elapsedMs: Date.now() - serviceabilityStartedAtMs,
          });
        },
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
      // A concurrent confirmed-dead recovery can own the same exact retirement.
      const attachmentRetired = disposition.status === 'destroyed' || disposition.status === 'retired';
      if (attachmentRetired && params.onExactTerminalAttachmentRetired) {
        await params.onExactTerminalAttachmentRetired({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: normalizedSessionId,
          attachmentInfo,
        }).catch((error) => {
          logWarning(`[DAEMON RUN] Failed to record terminal host retirement for session ${normalizedSessionId}`, error);
        });
      }
      if (attachmentRetired) {
        logger.infoFile('[DAEMON STOP] Exact attachment retirement completed', {
          sessionId: normalizedSessionId,
          elapsedMs: Date.now() - retirementStartedAtMs,
          totalElapsedMs: Date.now() - stopStartedAtMs,
        });
        return { status: 'stopped' };
      }
      return disposition.status === 'parked'
        ? incompleteStopSession(mapDispositionFailureReason(disposition.reason))
        : incompleteStopSession('destroy_failed');
    }
    return await retireAbsentRunnerServiceability();
  };
}
