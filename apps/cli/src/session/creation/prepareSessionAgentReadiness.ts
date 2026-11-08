import type { ActionExecutorDeps, SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachinesAgentsListOutputSchema, resolveMachineAgentAcquireIntentV1, resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { SessionAgentUpdateNoticeV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema, type AgentInstallJobConsent } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';

type SpawnArgs = Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0];
type ReadinessResult = Extract<SessionSpawnNewResultV1, { type: 'error' }> | ActionApprovalRequestCreatedResult | ActionExecuteFailure;

/** One pre-birth decision; acquisition and its completion remain owned by ordinary Actions. */
export async function prepareSessionAgentReadiness(input: Readonly<{
  machineId: string;
  serverId: string;
  agentId: string;
  definitionId?: string;
  requestId?: string;
  consent?: AgentInstallJobConsent;
  invoke: SpawnArgs['invokeAgentReadinessAction'];
  signal?: AbortSignal;
}>): Promise<Readonly<{ result: ReadinessResult }> | Readonly<{ agentUpdate: SessionAgentUpdateNoticeV1 }> | null> {
  const refusal = (missing = false): Readonly<{ result: ReadinessResult }> => ({ result: { type: 'error',
    code: missing ? 'agent_cli_missing' : 'agent_cli_not_ready', agentId: input.agentId, retryable: false } });
  const cancelled = (): Readonly<{ result: ReadinessResult }> => ({ result: { type: 'error', code: 'cancelled', retryable: true } });
  if (input.signal?.aborted) return cancelled();
  if (!input.invoke) return refusal();
  const children = SESSION_AGENT_READINESS_CHILDREN_V1;
  const selection = { machineId: input.machineId, agentId: input.agentId,
    ...(input.definitionId === undefined ? {} : { definitionId: input.definitionId }) };
  const inventory = await input.invoke(children.inventory.action, { ...selection, serverId: input.serverId, refresh: true });
  if (input.signal?.aborted) return cancelled();
  // Failure to obtain facts is an Action failure, not evidence about the CLI.
  if (!inventory.ok) return { result: inventory };
  const facts = MachinesAgentsListOutputSchema.safeParse(inventory.result);
  if (!facts.success) return refusal();
  const agent = facts.data.items.find(item => item.agentId === input.agentId && item.definitionId === input.definitionId);
  if (!agent) {
    // An unregistered probe says nothing about the executable. The ordinary
    // native launch resolver still decides whether a runnable CLI exists.
    const unavailable = facts.data.unavailable?.find(item => item.agentId === input.agentId
      && item.definitionId === input.definitionId);
    return unavailable?.reason === 'probe_failed' && unavailable.errorCode === 'unknown-capability'
      ? null : refusal();
  }
  const intent = resolveMachineAgentAcquireIntentV1(agent);
  // Executable prerequisites are independent of the selected credential, which
  // remains owned by native launch. An optional update cannot revoke this executable.
  const runnable = resolveMachineAgentExecutionStateV1({ ...agent, authenticationRequired: false }) === 'ready';
  // Skip the optional update: even starting or reading its job can delay birth.
  if (runnable) return intent ? { agentUpdate: { agentId: input.agentId, status: 'pending',
    ...(input.requestId ? { requestId: input.requestId } : {}) } } : null;
  if (!intent) return refusal();
  const acquired = await input.invoke(children.acquire.action, { ...selection, intent,
    ...(input.consent === undefined ? {} : { consent: input.consent }) });
  if (input.signal?.aborted) return cancelled();
  if (!acquired.ok) return refusal(!agent.installed);
  const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(acquired.result);
  if (deferred.success) return { result: deferred.data };
  const started = DaemonAgentInstallStartResponseSchema.safeParse(acquired.result);
  if (!started.success || !started.data.ok) return refusal();
  const observed = await input.invoke(children.status.action, {
    machineId: input.machineId, jobId: started.data.jobId, waitForTerminal: true,
  });
  if (input.signal?.aborted) return cancelled();
  if (!observed.ok) return refusal();
  const terminal = DaemonAgentInstallReadResponseSchema.safeParse(observed.result);
  return terminal.success && terminal.data.ok && terminal.data.done && terminal.data.outcome?.kind === 'succeeded'
    ? null : refusal();
}
