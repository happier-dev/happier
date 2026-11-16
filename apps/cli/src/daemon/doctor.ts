/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import { forceStopKnownDaemonPid, inspectDaemonRunningStateAndCleanupStaleState, requestDaemonSignedRootActionExecution, type DaemonControlRequestOptions } from './controlClient';
import { readSettings } from '@/persistence';
import { MachineProcessesAnswerV1Schema, type MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { normalizeActionExecuteResult, unwrapCliActionSuccessPayload } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export { findWindowsHappyProcessAncestors, indicatesDaemonStartedSessionCommand, classifyDaemonLifecycleProcessByPid, classifyProcessByPid, classifyHappyProcess, findAllHappyProcesses, findHappyProcessByPid } from './processInspection';
export type { DaemonLifecycleProcessByPidClassification, HappyProcessInfo, DaemonOwnershipEnvironmentVariables, ProcessByPidClassification } from './processInspection';

export type DoctorProcessAnswer =
  | Readonly<{ status: 'available'; answer: MachineProcessesAnswerV1 }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

/** Diagnostics read the daemon's canonical Action rather than classify its children. */
export async function readDaemonProcessesForDoctor(options: DaemonControlRequestOptions = {}): Promise<DoctorProcessAnswer> {
  const machineId = (await readSettings()).machineId;
  if (!machineId) return { status: 'unavailable', reason: 'machine_identity_unavailable' };
  const execution = normalizeActionExecuteResult(await requestDaemonSignedRootActionExecution({
    actionId: 'machines.processes.list', input: { machineId, scope: 'happier', view: 'tree' }, surface: 'cli',
  }, options));
  if (!execution.ok) return { status: 'unavailable', reason: execution.errorCode };
  const parsed = MachineProcessesAnswerV1Schema.safeParse(unwrapCliActionSuccessPayload(execution.data));
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid_action_output' };
  return parsed.data.state === 'live'
    ? { status: 'available', answer: parsed.data }
    : { status: 'unavailable', reason: parsed.data.reason ?? 'read_failed' };
}

/** Keep an answering daemon alive; only its recorded, non-answering lifecycle owner may be stopped. */
export async function stopStaleDaemonForDoctor(): Promise<Readonly<{
  stopped: number; errors: readonly Readonly<{ pid: number; error: string }>[];
}>> {
  const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
  if (inspection.status !== 'starting' || !('state' in inspection)) return { stopped: 0, errors: [] };
  try {
    const result = await forceStopKnownDaemonPid(inspection.state.pid);
    return { stopped: result.status === 'stopped' ? 1 : 0, errors: [] };
  } catch (error) {
    return { stopped: 0, errors: [{ pid: inspection.state.pid, error: error instanceof Error ? error.message : 'daemon_stop_failed' }] };
  }
}
