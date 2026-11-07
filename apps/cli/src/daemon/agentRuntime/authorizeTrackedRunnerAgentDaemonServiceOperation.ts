import type { TrackedSession } from '../types';
import type {
  AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type {
  AgentRuntimeDaemonServiceTurnWitnessInputV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import type {
  AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './sessionBridgeAuthorization';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';
import { resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import { nativeRealtimeInputWitnessMatchesV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';

export function authorizeTrackedRunnerAgentDaemonServiceOperation(
  input: Readonly<{
    tracked: TrackedSession;
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
    witness:
      AgentRuntimeDaemonServiceTurnWitnessInputV1 | undefined;
    allowIdleCurrentGeneration: boolean;
    /** The retained Execution Run snapshot owner supplies its current comparison. */
    runSnapshotCurrent?: boolean;
    onRefused?(predicate: 'snapshot' | 'session' | 'source_custody' | 'runner_process' | 'turn_witness'): void;
  }>,
): boolean {
  const refuse = (predicate: Parameters<NonNullable<typeof input.onRefused>>[0]) => {
    input.onRefused?.(predicate);
    return false;
  };
  if (input.runSnapshotCurrent === false) return refuse('snapshot');
  if (input.tracked.happySessionId !== input.sessionId) return refuse('session');
  if (!input.tracked.runnerAgentSourceCustodyV1 || !pluginSourceCustodyV1Equal(
      input.tracked.runnerAgentSourceCustodyV1,
      input.retainedAgent.sourceCustody,
    )) return refuse('source_custody');
  const runnerIdentity = resolveTrackedSessionRunnerIdentity(input.tracked);
  if (!runnerIdentity || !processIdentityMatches(runnerIdentity, input.runner)) return refuse('runner_process');
  const admittedTurnId =
    input.tracked
      .agentRuntimeDaemonServiceAdmittedTurnId;
  if (!input.witness) {
    return input.allowIdleCurrentGeneration || refuse('turn_witness');
  }
  if (input.witness.nativeRealtimeAdmission) {
    const native = input.tracked.agentRuntimeDaemonServiceNativeRealtimeAdmission;
    return Boolean(native
      && processIdentityMatches(native.runner, input.runner)
      && pluginSourceCustodyV1Equal(native.sourceCustody, input.retainedAgent.sourceCustody)
      && nativeRealtimeInputWitnessMatchesV1(native.admission, input.witness, input.sessionId))
      || refuse('turn_witness');
  }
  if (!admittedTurnId) return refuse('turn_witness');
  return Boolean(
    input.witness.turnId === admittedTurnId
    && input.witness.inputId
      === input.tracked
        .agentRuntimeDaemonServiceAdmittedInputId
    && input.witness.userMessageSeq
      === input.tracked
        .agentRuntimeDaemonServiceAdmittedUserMessageSeq
    && input.witness.userMessageSeqs.length
      === (
        input.tracked
          .agentRuntimeDaemonServiceAdmittedUserMessageSeqs
        ?? []
      ).length
    && input.witness.userMessageSeqs.every(
      (sequence, index) =>
        sequence
          === input.tracked
            .agentRuntimeDaemonServiceAdmittedUserMessageSeqs
            ?.[index],
    ),
  ) || refuse('turn_witness');
}
