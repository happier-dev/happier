import type { ProcessStartIdentity } from '@/processes/census/processCensus';
import type { SessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { TrackedSession } from '../types';
import type { ExactTrackedRunnerStopWitness, StopSessionOptions } from './stopSession';
import type { StopSessionResult } from './stopSessionContract';
import type { ProcessActionExecution } from '../processes/actions/processActionExecutor';
import { readSessionStopRequestSource } from './stopSessionDiagnostics';

type ExactTarget = Readonly<{ pid: number; start: ProcessStartIdentity }>;
type VerifyCurrent = () => boolean | Promise<boolean>;
type Execution = Readonly<{ signal?: AbortSignal; verifyCurrent?: VerifyCurrent;
  actionContext?: ProcessActionExecution['actionContext']; rpcContext?: ProcessActionExecution['rpcContext'];
  physicalStopEffect?: ProcessActionExecution['physicalStopEffect'] }>;
type BoundRunner = ExactTrackedRunnerStopWitness & Readonly<{
  trackedPid: number;
  sessionId: string | undefined;
  runnerIdentity: TrackedSession['runnerProcessIdentity'];
}>;
export type SessionProcessActionLifecycle = Readonly<{
  prepareKill(input: Readonly<{ targets: readonly ExactTarget[] }> & Execution): Promise<(() => Promise<boolean>) | null>;
  stopExactSession(input: ExactTarget & Readonly<{ sessionId: string }> & Execution): Promise<StopSessionResult>;
}>;

/** Action intent lives on the existing tracked generation and stop/respawn owners. */
export function createSessionProcessActionLifecycle(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  markStopRequested: SessionRunnerRespawnManager['markStopRequested'];
  recordExplicitStopIntent(sessionId: string, execution: Execution): Promise<void>;
  registerPhysicalStopEffect(sessionId: string, completion: Promise<void>): void;
  stopSession(sessionId: string, options?: StopSessionOptions, physicalEffect?: Promise<void>): Promise<StopSessionResult>;
}>): SessionProcessActionLifecycle {
  const executionCurrent = async (input: Execution) => !input.signal?.aborted
    && (!input.verifyCurrent || await input.verifyCurrent()) && !input.signal?.aborted;
  const isAutomaticHostCleanup = (input: Execution) => input.actionContext?.authority === 'account_automation'
    && input.actionContext.actionCaller?.kind !== 'session';
  const isCleanup = (input: Execution, witness: BoundRunner) => {
    if (isAutomaticHostCleanup(input)) return true;
    const target = witness.tracked.requesterWorkAttributionV1;
    const admission = input.rpcContext?.machineAdmission;
    // The Machine custodian may retire a guest process. That physical right
    // does not grant the guest Account's metadata mutation authority.
    return !!target && !!admission && admission.actorAccountId === admission.custodianAccountId
      && admission.machineId === target.machineId && admission.installationId === target.installationId
      && admission.actorAccountId !== target.accountId;
  };
  function bind(target: ExactTarget): BoundRunner | null | undefined {
    const tracked = [...params.pidToTrackedSession.values()].find(row => row.pid === target.pid || row.sessionRunnerPid === target.pid);
    if (!tracked) return undefined;
    const start = tracked.pid === target.pid ? tracked.processStartTimeMs : tracked.runnerProcessIdentity?.processStartTimeMs;
    if (start === undefined || start !== target.start.startTimeMs) return null;
    return { tracked, trackedPid: tracked.pid, sessionId: tracked.happySessionId, runnerIdentity: tracked.runnerProcessIdentity,
      sessionRunnerPid: tracked.sessionRunnerPid, processStartTimeMs: tracked.processStartTimeMs,
      processCommandHash: tracked.processCommandHash };
  }
  function current(witness: BoundRunner): boolean {
    const row = witness.tracked;
    return row.pid === witness.trackedPid && params.pidToTrackedSession.get(witness.trackedPid) === row
      && row.happySessionId === witness.sessionId
      && row.runnerProcessIdentity === witness.runnerIdentity
      && row.sessionRunnerPid === witness.sessionRunnerPid
      && row.processStartTimeMs === witness.processStartTimeMs
      && row.processCommandHash === witness.processCommandHash;
  }
  return {
    async prepareKill(input) {
      let stamped = false;
      const witnesses: BoundRunner[] = [];
      for (const target of input.targets) {
        const witness = bind(target);
        if (witness === null) return null;
        if (witness && !witnesses.some(row => row.tracked === witness.tracked)) witnesses.push(witness);
      }
      const retiredWithoutReplacement = (witness: BoundRunner) => stamped
        && ![...params.pidToTrackedSession.values()].some(row => row === witness.tracked
          || row.pid === witness.trackedPid || row.sessionRunnerPid === witness.sessionRunnerPid && witness.sessionRunnerPid !== undefined
          || witness.sessionId !== undefined && row.happySessionId === witness.sessionId);
      const authorized = async () => await executionCurrent(input)
        && witnesses.every(row => current(row) || retiredWithoutReplacement(row))
        && input.targets.every(target => {
          const now = bind(target);
          return now === undefined || (now !== null && witnesses.some(row => row.tracked === now.tracked));
        });
      if (!await authorized()) return null;
      if (input.physicalStopEffect) for (const witness of witnesses) {
        if (witness.sessionId) params.registerPhysicalStopEffect(witness.sessionId, input.physicalStopEffect.completion);
      }
      const recorded = input.physicalStopEffect?.recordedSessionIds ?? new Set<string>();
      return async () => {
        if (!await authorized()) return false;
        for (const witness of witnesses) {
          if (!current(witness) || !witness.sessionId || isCleanup(input, witness)) continue;
          try {
            if (!recorded.has(witness.sessionId)) {
              await params.recordExplicitStopIntent(witness.sessionId, input);
              recorded.add(witness.sessionId);
            }
          } catch {
            return false;
          }
          if (!await authorized()) return false;
        }
        for (const witness of witnesses) {
          if (!current(witness)) continue;
          const { tracked, sessionId } = witness;
          tracked.stopRequestedAtMs ??= Date.now();
          if (!isCleanup(input, witness)) tracked.stopRequestedReason = 'user_process_kill';
          if (sessionId) params.markStopRequested(sessionId,
            { reason: isCleanup(input, witness) ? 'daemon_stop_session' : 'user_request', requestedAtMs: tracked.stopRequestedAtMs });
        }
        stamped = true;
        return true;
      };
    },
    async stopExactSession(input) {
      const witness = bind(input);
      if (!witness || witness.tracked.happySessionId !== input.sessionId
        || !await executionCurrent(input) || !current(witness)) {
        return { status: 'incomplete', reason: 'runner_signal_incomplete' };
      }
      if (input.physicalStopEffect) params.registerPhysicalStopEffect(input.sessionId, input.physicalStopEffect.completion);
      const recorded = input.physicalStopEffect?.recordedSessionIds ?? new Set<string>();
      return await params.stopSession(input.sessionId, {
        source: readSessionStopRequestSource(input.actionContext), transport: 'process_action',
        expectedTrackedRunner: witness,
        beforeSignalExactTrackedRunner: async () => {
          if (!await executionCurrent(input) || !current(witness)) return false;
          try {
            if (!isCleanup(input, witness) && !recorded.has(input.sessionId)) {
              await params.recordExplicitStopIntent(input.sessionId, input);
              recorded.add(input.sessionId);
            }
          } catch {
            return false;
          }
          if (!await executionCurrent(input) || !current(witness)) return false;
          witness.tracked.stopRequestedAtMs ??= Date.now();
          params.markStopRequested(input.sessionId,
            { reason: 'daemon_stop_session', requestedAtMs: witness.tracked.stopRequestedAtMs });
          return true;
        },
      }, input.physicalStopEffect?.completion);
    },
  };
}
