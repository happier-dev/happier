import {
  AgentSessionRunnerBindingV1Schema,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  TURN_ADMISSION_TEAM_CREDENTIAL_BINDING_NOT_CURRENT,
  type AgentRuntimeDaemonServiceRequestV1,
  type AgentRuntimeDaemonServiceResponseV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

/**
 * Whether a Session runtime's brokered Team endpoint is a current binding of
 * this daemon. The endpoint is a loopback listener of the daemon process that
 * opened it, pinned to the resource revision it opened at.
 */
export type RunnerSessionBrokeredTeamEndpoint = 'not_brokered' | 'current' | 'not_current';

export type RunnerAgentNewTurnAdmissionDecision =
  | Readonly<{ status: 'admitted' }>
  | Readonly<{
      status: 'denied';
      reason: 'retained_agent_binding_invalid' | typeof TURN_ADMISSION_TEAM_CREDENTIAL_BINDING_NOT_CURRENT;
    }>;

export function evaluateRunnerAgentNewTurnAdmission(
  input: Readonly<{
    retainedAgent: unknown;
    brokeredTeamEndpoint?: RunnerSessionBrokeredTeamEndpoint;
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

  // No effect yet: a runtime whose Agent would dial a dead or pinned-stale
  // broker endpoint is refused before input reaches it; reopening it opens a
  // fresh binding through Home admission.
  if (input.brokeredTeamEndpoint === 'not_current') {
    return Object.freeze({ status: 'denied', reason: TURN_ADMISSION_TEAM_CREDENTIAL_BINDING_NOT_CURRENT });
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
    brokeredTeamEndpoint?: RunnerSessionBrokeredTeamEndpoint;
  }>,
): Promise<RunnerAgentNewTurnAdmissionDecision> {
  return evaluateRunnerAgentNewTurnAdmission(input);
}

/** The private service publishes the same retained-Agent decision with its exact input witness. */
export async function authorizeRunnerAgentTurnAdmission(input: Readonly<{
  retainedAgent: unknown;
  brokeredTeamEndpoint?: RunnerSessionBrokeredTeamEndpoint;
  witness: Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'turn.admission.authorize' }>['witness'];
}>): Promise<AgentRuntimeDaemonServiceResponseV1> {
  const decision = await authorizeRunnerAgentNewTurn({ retainedAgent: input.retainedAgent,
    ...(input.brokeredTeamEndpoint ? { brokeredTeamEndpoint: input.brokeredTeamEndpoint } : {}) });
  return { ok: true, result: decision.status === 'admitted'
    ? { kind: 'turn.admission', status: 'admitted', witness: input.witness }
    : { kind: 'turn.admission', status: 'denied', reason: decision.reason } };
}
