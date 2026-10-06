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

export function authorizeTrackedRunnerAgentDaemonServiceOperation(
  input: Readonly<{
    tracked: TrackedSession;
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
    witness:
      AgentRuntimeDaemonServiceTurnWitnessInputV1 | undefined;
    allowIdleCurrentGeneration: boolean;
  }>,
): boolean {
  if (
    input.tracked.happySessionId !== input.sessionId
    || !input.tracked.runnerAgentSourceCustodyV1
    || !pluginSourceCustodyV1Equal(
      input.tracked.runnerAgentSourceCustodyV1,
      input.retainedAgent.sourceCustody,
    )
    || !processIdentityMatches({
      pid: input.tracked.sessionRunnerPid ?? input.tracked.pid,
      processStartTimeMs: input.tracked.processStartTimeMs,
      processCommandHash: input.tracked.processCommandHash,
    }, input.runner)
  ) {
    return false;
  }
  const admittedTurnId =
    input.tracked
      .agentRuntimeDaemonServiceAdmittedTurnId;
  if (!input.witness) {
    return input.allowIdleCurrentGeneration;
  }
  if (!admittedTurnId) return false;
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
  );
}
