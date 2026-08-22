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
    || input.tracked.runnerAgentImmutableGenerationId
      !== input.retainedAgent.immutableGenerationId
    || (
      input.tracked.sessionRunnerPid
      ?? input.tracked.pid
    ) !== input.runner.pid
    || input.tracked.processStartTimeMs
      !== input.runner.processStartTimeMs
    || input.tracked.processCommandHash
      !== input.runner.processCommandHash
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
