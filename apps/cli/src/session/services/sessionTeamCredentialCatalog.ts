import type { ActionExecutorDeps, ProviderBrokerApplicationBindingV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';
import { TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';
import { TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourcePageV1Schema,
  type TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { projectTeamCredentialLaunchFailure, readTeamCredentialLaunchFailureCode,
  SessionTeamCredentialLaunchUnavailableError, type TeamCredentialLaunchFailurePhase } from './sessionTeamCredentialLaunchError';

async function readCatalogPage(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  request: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0];
  phase: TeamCredentialLaunchFailurePhase;
  signal?: AbortSignal;
}>): Promise<unknown> {
  let raw: unknown;
  try { raw = await input.homeDomainAction(input.request); }
  catch (error) {
    input.signal?.throwIfAborted();
    throw projectTeamCredentialLaunchFailure(error, input.phase, 'provider_catalog_unavailable');
  }
  if (raw && typeof raw === 'object' && (('ok' in raw && raw.ok === false) || 'error' in raw)) {
    throw new SessionTeamCredentialLaunchUnavailableError(
      readTeamCredentialLaunchFailureCode(raw) ?? 'provider_catalog_unavailable', input.phase,
    );
  }
  return raw;
}

/** Authenticated custodian selection shares the recipient catalog transport;
 * the Home, not a daemon-wide Team census, selects the affected sources. */
export async function readCustodianTeamCredentialDirectResources(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialResourceSummaryV1[]> {
  const resources: TeamCredentialResourceSummaryV1[] = [];
  let cursor: string | null = null;
  do {
    input.signal?.throwIfAborted();
    const raw = await readCatalogPage({ ...input, phase: 'resource_catalog', request: {
      actionId: 'teams.credentials.list', input: { scope: 'custodian', filter: 'direct', ...(cursor ? { cursor } : {}) },
      context: { surface: 'cli' }, ...(input.signal ? { signal: input.signal } : {}),
    } });
    const parsed = createStoredReadSchema(TeamCredentialResourcePageV1Schema).safeParse(raw);
    if (!parsed.success) throw new SessionTeamCredentialLaunchUnavailableError('provider_rpc_response_invalid', 'resource_catalog');
    resources.push(...parsed.data.resources);
    cursor = parsed.data.nextCursor;
  } while (cursor);
  return resources;
}

/** One paginated recipient transport shared by explicit launch and Account defaults. */
export async function readSpawnConnectedServicesTeamResources(params: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  serverId?: string;
  teamIds: readonly string[];
  resourceId?: string;
  executionMachineId?: string;
  application?: ProviderBrokerApplicationBindingV1;
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialResourceCatalogEntryV1[]> {
  const resources: TeamCredentialResourceCatalogEntryV1[] = [];
  for (const teamId of params.teamIds) {
    let cursor: string | null = null;
    do {
      params.signal?.throwIfAborted();
      const raw = await readCatalogPage({ ...params, phase: 'resource_catalog', request: {
        actionId: 'teams.credentials.entitled.list', input: { teamId, ...(cursor ? { cursor } : {}),
          ...(params.resourceId ? { resourceId: params.resourceId } : {}),
          ...(params.executionMachineId ? { executionMachineId: params.executionMachineId } : {}),
          ...(params.application ? { application: params.application } : {}) },
        context: { surface: 'cli', ...(params.serverId ? { serverId: params.serverId } : {}) },
        ...(params.signal ? { signal: params.signal } : {}),
      } });
      const parsed = TeamCredentialResourceEntitledPageV1Schema.safeParse(raw);
      if (!parsed.success) throw new SessionTeamCredentialLaunchUnavailableError('provider_rpc_response_invalid', 'resource_catalog');
      resources.push(...parsed.data.resources);
      cursor = parsed.data.nextCursor ?? null;
    } while (cursor);
  }
  return resources;
}

/** Reads each admitted application through the same recipient catalog authority. */
export async function readSessionTeamCredentialResourceCatalog(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  applications: readonly ProviderBrokerApplicationBindingV1[];
  teamIds?: readonly string[];
  resourceId?: string;
  executionMachineId?: string;
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialResourceCatalogEntryV1[]> {
  let teamIds = input.teamIds;
  if (!teamIds) {
    const discovered: string[] = [];
    let cursor: string | null = null;
    do {
      input.signal?.throwIfAborted();
      const raw = await readCatalogPage({ ...input, phase: 'teams_catalog', request: {
        actionId: 'teams.list', input: { v: 1, scope: 'member', archived: 'active', ...(cursor ? { cursor } : {}) },
        context: { surface: 'cli' }, ...(input.signal ? { signal: input.signal } : {}),
      } });
      const parsed = TeamsPageV1Schema.safeParse(raw);
      if (!parsed.success) throw new SessionTeamCredentialLaunchUnavailableError('provider_rpc_response_invalid', 'teams_catalog');
      discovered.push(...parsed.data.items.map(team => team.id));
      cursor = parsed.data.nextCursor;
    } while (cursor);
    teamIds = discovered;
  }
  const resourcesById = new Map<string, TeamCredentialResourceCatalogEntryV1>();
  for (const application of input.applications.length > 0 ? input.applications : [undefined]) {
    const resources = await readSpawnConnectedServicesTeamResources({
      homeDomainAction: input.homeDomainAction, teamIds, ...(application ? { application } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.executionMachineId ? { executionMachineId: input.executionMachineId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    for (const resource of resources) {
      const prior = resourcesById.get(resource.id);
      if (prior && (prior.teamId !== resource.teamId || prior.resourceRevision !== resource.resourceRevision)) {
        throw new SessionTeamCredentialLaunchUnavailableError('resource_changed', 'catalog_revision');
      }
      const basis = resource.providerModels.some(model => model.availability === 'available') ? resource : prior ?? resource;
      resourcesById.set(resource.id, { ...basis, providerModels: [...(prior?.providerModels ?? []), ...resource.providerModels] });
    }
  }
  return [...resourcesById.values()];
}
