import {
  AgentSessionRunnerBindingV1Schema,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

export type RunnerAgentNewTurnAdmissionDecision =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{
      status: 'denied';
      reason: 'retained_agent_binding_invalid';
    }>;

export function evaluateRunnerAgentNewTurnAdmission(
  input: Readonly<{
    retainedAgent: unknown;
  }>,
): RunnerAgentNewTurnAdmissionDecision {
  try {
    AgentSessionRunnerBindingV1Schema.parse(input.retainedAgent);
  } catch {
    return Object.freeze({
      status: 'denied',
      reason: 'retained_agent_binding_invalid',
    });
  }

  // A retained Session is admitted by its exact daemon-service authority and
  // tracked runner/turn witness before privileged work reaches this decision.
  // Its direct immutable binding is the structural G maximum; the desired H
  // Agent and its declarations are neither G authority nor evidence that G
  // was revoked.
  // Operation-specific services continue to intersect that maximum with their
  // live trust, resource, account, HostAccess and executable owners.
  return Object.freeze({ status: 'admitted' });
}

export async function authorizeRunnerAgentNewTurn(
  input: Readonly<{
    retainedAgent: unknown;
  }>,
): Promise<RunnerAgentNewTurnAdmissionDecision> {
  return evaluateRunnerAgentNewTurnAdmission({
    retainedAgent: input.retainedAgent,
  });
}
