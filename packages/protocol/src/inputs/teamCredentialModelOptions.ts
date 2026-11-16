import type { ActionExecuteFailure, ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionId } from '../actions/actionIds.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';
import { TeamsPageV1Schema } from '../teams/projections.js';
import {
  mergeTeamCredentialCatalogResourcesV1,
  resolveMachineAgentTeamCredentialDemandV1,
} from '../teams/credentials/teamCredentialModelCatalogV1.js';
import {
  TeamCredentialResourceDiscoveryPageV1Schema,
  type TeamCredentialResourceCatalogEntryV1,
} from '../teams/credentials/resourceV1.js';
import type { InputOption } from './inputFields.js';

const AVAILABILITY_DESCRIPTIONS = Object.freeze({
  source_owner_required: 'Needs the credential owner',
  resource_corrupt: 'Credential needs repair',
  policy_denied: 'Not allowed for this agent',
} as const);

/**
 * `teams.credential_models.available`: the Team credential models an Agent can
 * run on the Machine that runs it. Same pipeline as the Session authoring
 * picker: the Machine's broker applications for that Agent
 * (`resolveMachineAgentTeamCredentialDemandV1`), the Home's entitled catalog
 * per Team × application, the shared merge, then the Machine's own model
 * projection, which alone decides each row's availability.
 */
export async function resolveTeamCredentialModelOptionsV1(params: Readonly<{
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  actionId: ActionId | null;
  machineId: string | undefined;
  agentTargetKey: string | undefined;
  executeOwnerAction?: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
  readFailure: (result: unknown) => ActionExecuteFailure | null;
}>): Promise<ActionExecuteFailure | Readonly<{ ok: true; result: readonly InputOption[] }>> {
  const { deps, ctx, machineId, agentTargetKey } = params;
  if (!agentTargetKey) return { ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
    details: { requiredDraftPath: 'backendTargetKeys' } };
  if (!machineId) return { ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
    details: { requiredDraftPath: 'machineId' } };
  if (!deps.machinePluginProjectionRead || !deps.homeDomainAction) {
    return { ok: false, errorCode: 'unsupported_action', error: 'teams.credential_models.available' };
  }
  const projection = await deps.machinePluginProjectionRead({ machineId, ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}) }, ctx);
  const demand = resolveMachineAgentTeamCredentialDemandV1(projection, agentTargetKey);
  // Unknown Agent requirements admit no model application: nothing is offered.
  if (demand.requirements === null || demand.applications.length === 0) return { ok: true, result: [] };

  const home = (actionId: 'teams.list' | 'teams.credentials.entitled.list', input: unknown) => {
    ctx.signal?.throwIfAborted();
    return deps.homeDomainAction!({ actionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  };
  const teamIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page = TeamsPageV1Schema.safeParse(await home('teams.list', { v: 1, scope: 'member', archived: 'active', ...(cursor ? { cursor } : {}) }));
    if (!page.success) break;
    for (const team of page.data.items) teamIds.push(team.id);
    cursor = page.data.nextCursor;
  } while (cursor);
  if (teamIds.length === 0) return { ok: true, result: [] };

  const pages: TeamCredentialResourceCatalogEntryV1[][] = [];
  for (const application of demand.applications) {
    let pageCursor: string | null = null;
    do {
      const page = TeamCredentialResourceDiscoveryPageV1Schema.safeParse(await home('teams.credentials.entitled.list', {
        teamIds, application, executionMachineId: machineId, ...(pageCursor ? { cursor: pageCursor } : {}) }));
      if (!page.success) break;
      pages.push(page.data.resources);
      pageCursor = page.data.nextCursor;
    } while (pageCursor);
  }
  const resources = [...mergeTeamCredentialCatalogResourcesV1(pages, demand.connectedServiceKeys,
    { requireProviderModels: true, providerApplications: demand.applications }).values()]
    .filter(resource => resource.providerModels.length > 0);
  if (resources.length === 0) return { ok: true, result: [] };

  const projectionInput = { machineId, agentTargetKey, mode: 'picker' as const, teamCredentialResources: resources };
  const described = params.executeOwnerAction
    ? await params.executeOwnerAction('providers.models.projection', projectionInput)
    : deps.providerActionExecute
      ? await deps.providerActionExecute({ actionId: 'providers.models.projection', input: projectionInput } as Parameters<NonNullable<ActionExecutorDeps['providerActionExecute']>>[0], ctx)
      : null;
  if (!described) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:providers.models.projection' };
  const failure = params.readFailure(described);
  if (failure) return failure;
  const response = DaemonProviderModelProjectionResponseV1Schema.safeParse(described.ok ? described.result : null);
  if (!response.success || response.data.status !== 'success') return { ok: true, result: [] };

  const openedResources = await Promise.all((response.data.teamCredentialResources ?? []).map(async resource => ({
    resource,
    displayName: await deps.privateLabelOpen?.({
      binding: { entity: 'team_credential_resource', field: 'displayName', id: resource.id },
      label: resource.displayName, readPolicy: { kind: 'team-resource' },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx) ?? null,
  })));
  return { ok: true, result: openedResources.flatMap(({ resource, displayName }) => resource.providerModels
    .filter(model => model.selection.agentTargetKey === agentTargetKey)
    .map((model): InputOption => {
      const description = model.availability === 'available' ? displayName
        : [displayName, AVAILABILITY_DESCRIPTIONS[model.availability]].filter(Boolean).join(' · ');
      return { value: JSON.stringify(model.selection), label: model.descriptor.name,
        ...(description === null ? {} : { description }),
        ...(model.availability === 'available' ? {} : { disabled: true }) };
    })) };
}
