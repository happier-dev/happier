import type { TrackedSession } from '@/daemon/types';

export function clearTrackedRunnerAgentDaemonServiceAdmission(
  tracked: TrackedSession,
): void {
  // Queue turn settlement does not retire a live native Realtime attempt.
  delete tracked.agentRuntimeDaemonServiceAdmittedTurnId;
  delete tracked.agentRuntimeDaemonServiceAdmittedInputId;
  delete tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq;
  delete tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs;
}
