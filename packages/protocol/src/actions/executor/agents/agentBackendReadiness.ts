import { parseBackendTargetKeyV2 } from '../../../backends/targets/backendTargetRefV2.js';
import {
  findMachineAgentInventoryItemForTargetV1,
  MachinesAgentsListOutputSchema,
  resolveMachineAgentExecutionStateV1,
  type MachineAgentInventoryTargetV1,
} from '../../../capabilities/machineAgentInventory.js';
import type { AgentBackendInventoryItem, AgentsBackendsListOutput } from '../../agentBackendInventory.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../types.js';

function readInventoryTarget(item: AgentBackendInventoryItem): MachineAgentInventoryTargetV1 | null {
  if (item.agentTarget) return item.agentTarget;
  try {
    const target = parseBackendTargetKeyV2(item.targetKey);
    return target.kind === 'agent' ? target
      : { kind: 'backend', backendId: target.backendId,
        ...(target.configuredBackendId ? { configuredBackendId: target.configuredBackendId } : {}) };
  } catch {
    return null;
  }
}

/**
 * The Agent backends a Machine offers, each with the same readiness the shared
 * picker shows: the Machine's own inventory facts (installed, platform,
 * dependencies, native sign-in) composed with the Account's connected-service
 * default for that Agent. A connected default satisfies authentication; an
 * unreadable default leaves sign-in unknown. Without a Machine, or when its
 * inventory cannot be read, rows carry no readiness rather than a guess.
 */
export async function listAgentBackendsWithReadinessV1(
  deps: Pick<ActionExecutorDeps, 'agentsBackendsList' | 'machinesAgentsList' | 'agentsConnectedDefaultRoutesRead'>,
  args: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>,
  ctx: ActionExecutorContext,
): Promise<AgentsBackendsListOutput> {
  const listed = await deps.agentsBackendsList!(args);
  if (!args.machineId || !deps.machinesAgentsList || !Array.isArray(listed?.items) || listed.items.length === 0) return listed;
  let inventory;
  try {
    inventory = MachinesAgentsListOutputSchema.safeParse(await deps.machinesAgentsList({ machineId: args.machineId,
      ...(ctx.serverId ? { serverId: ctx.serverId } : {}) }, ctx));
  } catch {
    ctx.signal?.throwIfAborted();
    return listed;
  }
  if (!inventory.success) return listed;
  const facts = inventory.data;
  const rows = listed.items.map(item => {
    const target = readInventoryTarget(item);
    return { item, target, fact: target ? findMachineAgentInventoryItemForTargetV1(facts.items, target) : undefined };
  });
  const agentIds = [...new Set(rows.flatMap(row => row.fact ? [row.fact.agentId] : []))];
  let routes: Readonly<Record<string, 'connected' | 'unavailable' | 'native'>> | null = null;
  if (deps.agentsConnectedDefaultRoutesRead && agentIds.length > 0) {
    try {
      routes = await deps.agentsConnectedDefaultRoutesRead({ agentIds, ...(ctx.signal ? { signal: ctx.signal } : {}) }, ctx);
    } catch {
      ctx.signal?.throwIfAborted();
      routes = null;
    }
  }
  return {
    ...listed,
    items: rows.map(({ item, target, fact }) => {
      if (!target) return item;
      if (!fact) {
        const failed = findMachineAgentInventoryItemForTargetV1(facts.unavailable ?? [], target);
        return failed ? { ...item, readiness: 'unknown' as const } : item;
      }
      const route = routes?.[fact.agentId];
      // Without the Account's connected default, native sign-in cannot decide
      // authentication: the executable prerequisites still do.
      const authentication = route === 'connected' || !routes ? { authenticationRequired: false }
        : route === 'unavailable' ? { credentialRouteReady: false } : {};
      return { ...item, readiness: resolveMachineAgentExecutionStateV1({ ...fact, ...authentication }) };
    }),
  };
}
