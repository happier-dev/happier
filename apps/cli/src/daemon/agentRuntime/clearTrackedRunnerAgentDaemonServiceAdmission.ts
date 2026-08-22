import type { TrackedSession } from '@/daemon/types';

export function clearTrackedRunnerAgentDaemonServiceAdmission(
  tracked: TrackedSession,
): void {
  delete tracked.agentRuntimeDaemonServiceAdmittedTurnId;
  delete tracked.agentRuntimeDaemonServiceAdmittedInputId;
  delete tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq;
  delete tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs;
}
