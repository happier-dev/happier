import { parseBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { PluginProjectionV2 } from '../../daemon/contributionRegistryProjection.js';
import { buildQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import type { PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
import type { ProviderBrokerApplicationBindingV1 } from '../../providers/brokerRouteGrantV1.js';
import type { AgentProviderRequirementsV1 } from '../../providers/compatibility/v1.js';
import type { AccountProviderDeclarationV1 } from '../../providers/catalog/accountModelProjectionV1.js';
import { projectAgentProviderBrokerApplications } from '../../providers/catalog/brokerApplicationProjectionV1.js';
import { parseProviderContributionIdentityV1 } from '../../providers/contributionIdentityV1.js';
import type { TeamCredentialResourceCatalogEntryV1 } from './resourceV1.js';

type ProjectedAgentDeclaration = PluginProjectionV2['agentsById'][string];

/** The Provider declarations an exact Machine's admitted projection carries. */
export function readProjectedProviderDeclarationsV1(projection: PluginProjectionV2): readonly AccountProviderDeclarationV1[] {
  return Object.values(projection.familiesById.providers?.entriesById ?? {}).flatMap(entry =>
    entry.definition && entry.provenance ? [{ contributionKey: entry.id, definition: entry.definition, provenance: entry.provenance }] : []);
}

/** The exact Agent declaration a Machine projection names for a target key; configured definitions have none. */
export function readProjectedAgentDeclarationV1(projection: PluginProjectionV2, agentTargetKey: string): ProjectedAgentDeclaration | null {
  let target: ReturnType<typeof parseBackendTargetKeyV2>;
  try { target = parseBackendTargetKeyV2(agentTargetKey); } catch { return null; }
  if (target.kind === 'agent') {
    if (target.definitionId !== undefined) return null;
    return Object.values(projection.agentsById).find(declaration =>
      declaration.identity?.pluginId === target.identity.pluginId
      && declaration.identity.localId === target.identity.localId) ?? null;
  }
  if (target.configuredBackendId !== undefined || target.sourceKind === 'configured') return null;
  return projection.agentsById[target.backendId] ?? null;
}

/** Qualified Connected Account service keys an Agent declares, deduplicated in declaration order. */
export function readAgentConnectedAccountServiceKeysV1(
  connectedAccounts: ReadonlyArray<Readonly<{ service: { pluginId: string; localId: string } }>>,
): readonly string[] {
  const keys: string[] = [];
  for (const declaration of connectedAccounts) {
    const key = buildQualifiedPluginContributionKey(declaration.service);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export type AgentTeamCredentialDemandV1 = Readonly<{
  /** The Agent's declared Provider requirements; `null` is unknown and admits no model application. */
  requirements: AgentProviderRequirementsV1 | null;
  /** Broker applications this Agent accepts from the admitted Provider declarations. */
  applications: readonly ProviderBrokerApplicationBindingV1[];
  /** Connected Account services the Agent declares (`null`: no declaration resolved, no filter). */
  connectedServiceKeys: readonly string[] | null;
}>;

const UNKNOWN_DEMAND: AgentTeamCredentialDemandV1 = Object.freeze({ requirements: null, applications: Object.freeze([]), connectedServiceKeys: null });

export type AgentTeamCredentialBrokeredUseV1 =
  | Readonly<{ kind: 'supported'; requirements: AgentProviderRequirementsV1 }>
  | Readonly<{ kind: 'native_login_required' | 'unknown' }>;

/** Agent declarations own brokered application support; an unresolved declaration is not native-only. */
export function resolveAgentTeamCredentialBrokeredUseV1(input: Readonly<{
  declarationResolved: boolean;
  requirements: AgentProviderRequirementsV1 | null | undefined;
}>): AgentTeamCredentialBrokeredUseV1 {
  if (!input.declarationResolved) return { kind: 'unknown' };
  return input.requirements ? { kind: 'supported', requirements: input.requirements } : { kind: 'native_login_required' };
}

export type ConnectedAccountAgentDeclarationV1 = Readonly<{
  identity: PluginContributionIdentityV1;
  title: string;
  providerRequirements?: AgentProviderRequirementsV1 | null;
  connectedAccounts?: ReadonlyArray<Readonly<{ service: PluginContributionIdentityV1 }>>;
}>;

/** Presentation of the same brokered-use fact, scoped to the exact Connected Account service. */
export function resolveConnectedAccountNativeLoginConstraintsV1(
  service: PluginContributionIdentityV1,
  agents: readonly ConnectedAccountAgentDeclarationV1[],
): readonly Readonly<{ identity: PluginContributionIdentityV1; title: string }>[] {
  const serviceKey = buildQualifiedPluginContributionKey(service);
  return agents.flatMap(agent => resolveAgentTeamCredentialBrokeredUseV1({ declarationResolved: true,
    requirements: agent.providerRequirements }).kind === 'native_login_required'
    && agent.connectedAccounts?.some(purpose => buildQualifiedPluginContributionKey(purpose.service) === serviceKey)
    ? [{ identity: agent.identity, title: agent.title }] : []);
}

/**
 * The one derivation of which Team credential applications an Agent can use:
 * the admitted Provider declarations narrowed to the protocols the Agent's own
 * declaration accepts, plus the Connected Account services it declares.
 * Missing requirements are unknown, never "every model fits".
 */
export function resolveAgentTeamCredentialDemandV1(input: Readonly<{
  agentTargetKey: string;
  requirements: AgentProviderRequirementsV1 | null | undefined;
  /** The resolved declaration's qualified purposes; `null` when no declaration resolved (no service filter). */
  connectedAccounts: ReadonlyArray<Readonly<{ service: { pluginId: string; localId: string } }>> | null;
  providers: readonly AccountProviderDeclarationV1[];
}>): AgentTeamCredentialDemandV1 {
  const connectedServiceKeys = input.connectedAccounts === null ? null : readAgentConnectedAccountServiceKeysV1(input.connectedAccounts);
  const brokeredUse = resolveAgentTeamCredentialBrokeredUseV1({ declarationResolved: input.connectedAccounts !== null || input.requirements != null,
    requirements: input.requirements });
  if (brokeredUse.kind !== 'supported') return { requirements: null, applications: [], connectedServiceKeys };
  const providers = input.providers.flatMap(declaration => {
    const parsed = parseProviderContributionIdentityV1(declaration.contributionKey);
    return parsed ? [{ identity: parsed.identity, definition: declaration.definition }] : [];
  });
  return {
    requirements: brokeredUse.requirements,
    applications: projectAgentProviderBrokerApplications({ providers, agentTargetKey: input.agentTargetKey,
      acceptedProtocols: brokeredUse.requirements.acceptsProtocols }),
    connectedServiceKeys,
  };
}

/** The same derivation from an exact Machine's admitted projection. */
export function resolveMachineAgentTeamCredentialDemandV1(
  projection: PluginProjectionV2 | null | undefined,
  agentTargetKey: string,
): AgentTeamCredentialDemandV1 {
  const agent = projection ? readProjectedAgentDeclarationV1(projection, agentTargetKey) : null;
  if (!projection || !agent) return UNKNOWN_DEMAND;
  return resolveAgentTeamCredentialDemandV1({ agentTargetKey, requirements: agent.providerRequirements,
    connectedAccounts: agent.connectedAccounts ?? [], providers: readProjectedProviderDeclarationsV1(projection) });
}

function providerModelKey(model: TeamCredentialResourceCatalogEntryV1['providerModels'][number]): string {
  const selection = model.selection;
  return JSON.stringify([selection.teamId, selection.resourceId, selection.expectedResourceRevision,
    selection.agentTargetKey, selection.modelId, selection.deliveryMode,
    model.application.agentTargetKey, model.application.implementationIdentity.pluginId,
    model.application.implementationIdentity.localId, model.application.endpointTemplateId,
    model.application.protocol, model.sourceRevision, model.nativeSource?.providerTicket]);
}

/**
 * Gathers entitled catalog pages (one per Team × application read) into one row
 * per resource. A connected-service credential the Agent never declared is
 * dropped; application/source alternatives of the same model are kept for the
 * Machine's canonical resolver, never preselected here.
 */
export function mergeTeamCredentialCatalogResourcesV1(
  pages: Iterable<readonly TeamCredentialResourceCatalogEntryV1[]>,
  connectedServiceKeys: readonly string[] | null,
  options?: Readonly<{ requireProviderModels: boolean }>,
): Map<string, TeamCredentialResourceCatalogEntryV1> {
  const merged = new Map<string, TeamCredentialResourceCatalogEntryV1>();
  for (const page of pages) {
    for (const resource of page) {
      if (connectedServiceKeys !== null && resource.sourcePresentation?.kind === 'connected_service'
        && !connectedServiceKeys.includes(buildQualifiedPluginContributionKey(resource.sourcePresentation.service))) continue;
      const key = `${resource.teamId}:${resource.id}`;
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, resource);
        continue;
      }
      const modelKeys = new Set<string>();
      const providerModels = [...previous.providerModels, ...resource.providerModels].filter(model => {
        const modelKey = providerModelKey(model);
        if (modelKeys.has(modelKey)) return false;
        modelKeys.add(modelKey);
        return true;
      });
      // A usable application alternative wins. Generic discovery has no
      // application observation, so its available/empty row cannot erase a
      // refusal from an application catalog.
      let basis = previous;
      if (resource.providerModels.some(model => model.availability === 'available')) {
        if (!previous.providerModels.some(model => model.availability === 'available')) basis = resource;
      } else if (previous.providerModels.length === 0 && (resource.providerModels.length > 0
        || (previous.readiness.kind === 'available' && resource.readiness.kind !== 'available'))) {
        basis = resource;
      }
      merged.set(key, {
        ...basis,
        connectedServiceSelections: previous.connectedServiceSelections.length > 0
          ? previous.connectedServiceSelections : resource.connectedServiceSelections,
        providerModels,
      });
    }
  }
  if (options?.requireProviderModels) {
    for (const [key, resource] of merged) {
      if (resource.readiness.kind !== 'available' || !resource.mayBroker || resource.providerModels.length > 0
        || (resource.mayReceiveDirect && resource.directMaterialState === 'current')) continue;
      // A completed model read with no broker catalog is terminal. Generic
      // credential discovery and independently current Direct material do not
      // require a broker model catalog.
      merged.set(key, { ...resource, readiness: { kind: 'broker_unavailable', reason: 'catalog_empty' }, recoveryAction: 'retry' });
    }
  }
  return merged;
}
