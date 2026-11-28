import { buildBackendTargetKeyV2, parseBackendTargetKeyV2, PersistedBackendTargetRefV2Schema, resolveBundledAgentRoutingIdV1 } from '../../../backends/targets/backendTargetRefV2.js';
import { buildConfiguredAcpAgentSelectionV1 } from '../../../agents/executionTargetV1.js';
import { buildQualifiedPluginContributionKey } from '../../../plugins/contributionIdentity.js';
import {
  findMachineAgentInventoryItemForTargetV1,
  MachinesAgentsListOutputSchema,
  resolveMachineAgentExecutionStateV1,
  type MachineAgentExecutionStateV1,
  type MachineAgentInventoryTargetV1,
} from '../../../capabilities/machineAgentInventory.js';
import { SPAWN_SESSION_ERROR_CODES } from '../../../sessions/creation/spawnSessionErrorCode.js';
import type { AgentBackendInventoryItem, AgentsBackendsListOutput } from '../../agentBackendInventory.js';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import { withExecutionRunStartFailureDetails } from '../../../execution/runs/responseSchemas.js';

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

type ReadinessDeps = Pick<ActionExecutorDeps, 'machinesAgentsList' | 'agentsConnectedDefaultRoutesRead'>;

/**
 * Readiness for each Agent target on one Machine: the Machine's own inventory
 * facts (installed, platform, dependencies, native sign-in) composed with the
 * Account's connected-service default for that Agent. A connected default
 * satisfies authentication; an unreadable default leaves sign-in to the
 * executable prerequisites. A target whose probe failed is `unknown`; a target
 * the Machine does not list, or an unreadable inventory, gets no entry.
 */
export async function readAgentTargetReadinessV1(
  deps: ReadinessDeps,
  machineId: string,
  targets: readonly (MachineAgentInventoryTargetV1 | null)[],
  ctx: ActionExecutorContext,
): Promise<readonly (MachineAgentExecutionStateV1 | undefined)[] | null> {
  if (!deps.machinesAgentsList) return null;
  // The existing inventory query can select one executable or configured definition.
  // Keep the ordinary batched inventory when several targets are demanded.
  const target = targets.length === 1 ? targets[0] : undefined;
  const definitionId = target?.kind === 'agent' ? target.definitionId : target?.configuredBackendId;
  const agentId = definitionId ? buildConfiguredAcpAgentSelectionV1(definitionId).agentId
    : target?.kind === 'agent' ? resolveBundledAgentRoutingIdV1(target.identity) ?? buildQualifiedPluginContributionKey(target.identity)
    : target?.backendId;
  let inventory;
  try {
    inventory = MachinesAgentsListOutputSchema.safeParse(await deps.machinesAgentsList({ machineId,
      ...(agentId ? { agentId } : {}), ...(definitionId ? { definitionId } : {}),
      ...(ctx.serverId ? { serverId: ctx.serverId } : {}) }, ctx));
  } catch {
    ctx.signal?.throwIfAborted();
    return null;
  }
  if (!inventory.success) return null;
  const facts = inventory.data;
  const rows = targets.map(target => ({ target, fact: target ? findMachineAgentInventoryItemForTargetV1(facts.items, target) : undefined }));
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
  return rows.map(({ target, fact }) => {
    if (!target) return undefined;
    if (!fact) return findMachineAgentInventoryItemForTargetV1(facts.unavailable ?? [], target) ? 'unknown' : undefined;
    const route = routes?.[fact.agentId];
    // Without the Account's connected default, native sign-in cannot decide
    // authentication: the executable prerequisites still do.
    const authentication = route === 'connected' || !routes ? { authenticationRequired: false }
      : route === 'unavailable' ? { credentialRouteReady: false } : {};
    return resolveMachineAgentExecutionStateV1({ ...fact, ...authentication });
  });
}

/**
 * The Agent backends a Machine offers, each with the same readiness the shared
 * picker shows (see `readAgentTargetReadinessV1`). Without a Machine, or when
 * its inventory cannot be read, rows carry no readiness rather than a guess.
 */
export async function listAgentBackendsWithReadinessV1(
  deps: Pick<ActionExecutorDeps, 'agentsBackendsList'> & ReadinessDeps,
  args: Readonly<{ includeDisabled?: boolean; limit?: number; machineId?: string }>,
  ctx: ActionExecutorContext,
): Promise<AgentsBackendsListOutput> {
  const listed = await deps.agentsBackendsList!(args);
  if (!args.machineId || !Array.isArray(listed?.items) || listed.items.length === 0
    || listed.items.every(item => item.readiness !== undefined)) return listed;
  // Hosts with a composed Agent inventory already own credential readiness.
  // Acquire raw prerequisites only for catalog rows whose producer has no answer.
  const readiness = await readAgentTargetReadinessV1(deps, args.machineId,
    listed.items.map(item => item.readiness === undefined ? readInventoryTarget(item) : null), ctx);
  if (!readiness) return listed;
  return {
    ...listed,
    items: listed.items.map((item, index) => readiness[index] === undefined ? item : { ...item, readiness: readiness[index] }),
  };
}

const START_REFUSAL_BY_READINESS = Object.freeze({
  notInstalled: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
  unsupported: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_NOT_READY,
} as const);

export function isAgentStartReadinessBlockingV1(
  readiness: MachineAgentExecutionStateV1 | undefined,
): readiness is keyof typeof START_REFUSAL_BY_READINESS {
  return readiness !== undefined && Object.hasOwn(START_REFUSAL_BY_READINESS, readiness);
}

/**
 * Refuse known executable/platform prerequisites before creating a Run.
 * Authentication belongs to the launch owner: it resolves the request's selected
 * Connected Service (or Session defaults) under the requester's Account. Native
 * sign-in and Account-default discovery cannot decide that selected route.
 */
export async function refuseAgentStartWhenNotReadyV1(
  deps: Pick<ActionExecutorDeps, 'machinesAgentsList'>,
  args: Readonly<{ machineId: string | null | undefined; backendTarget: unknown }>,
  ctx: ActionExecutorContext,
): Promise<ActionExecuteFailure | null> {
  if (!args.machineId) return null;
  const parsed = PersistedBackendTargetRefV2Schema.safeParse(args.backendTarget);
  if (!parsed.success) return null;
  const target = readInventoryTarget({ targetKey: buildBackendTargetKeyV2(parsed.data) } as AgentBackendInventoryItem);
  const [readiness] = await readAgentTargetReadinessV1({ machinesAgentsList: deps.machinesAgentsList }, args.machineId, [target], ctx) ?? [];
  if (!isAgentStartReadinessBlockingV1(readiness)) return null;
  const code = START_REFUSAL_BY_READINESS[readiness];
  // The existing run-start failure contract: a typed code and certain "no Run created" evidence.
  return { ok: false, errorCode: code, error: code, details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
}
