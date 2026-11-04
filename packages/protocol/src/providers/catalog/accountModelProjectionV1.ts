import type { AgentProviderRequirementsV1 } from '../compatibility/v1.js';
import type { ProviderContributionV1 } from '../contributions/v1.js';
import type { CustomProviderTemplateV1 } from '../connections/customTemplateV1.js';
import type { ProviderConnectionV1 } from '../connections/v1.js';
import type { ProviderConnectionsCatalogV1 } from '../connections/catalogSchemasV1.js';
import type { ProviderDefaultModelSelectionsByAgentTargetKeyV1 } from '../selection/v1.js';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '../../rpc/providers.js';
import type { DaemonProviderModelsResponseV1 } from '../../rpc/providers.js';
import { createProviderErrorV1 } from '../errors.js';
import { resolveProviderBindingDeclarationCompatibilityV1 } from '../compatibility/resolve.js';
import { mergeProviderCatalogV1, providerCatalogPermitsUnlistedModelIdV1 } from './merge.js';
import { resolveProviderCurrentSelectionRecoveryV1 } from './currentSelectionRecoveryV1.js';
import { projectProviderCatalogForPicker } from './pickerProjectionV1.js';
import type { ProviderConnectionCatalog } from './pickerTypesV1.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import { DaemonProviderModelProjectionGroupV1Schema } from '../../rpc/providers.js';
import { hasProviderExperimentalConfirmation } from '../settings/v1.js';
import { projectProviderModelReasoningForAgent } from './reasoningEffort.js';
import { resolveEffectiveProviderEndpointV1 } from '../connections/effectiveEndpointV1.js';

/** Worker facts stay authoritative; experimental consent belongs to the reading Account. */
export function projectAccountProviderModelConfirmationsV1(input: Readonly<{
  projection: DaemonProviderModelProjectionResponseV1;
  catalog: ProviderConnectionsCatalogV1;
}>): DaemonProviderModelProjectionResponseV1 {
  const projection = input.projection;
  if (projection.status !== 'success') return projection;
  return { ...projection, groups: projection.groups.map(group => ({ ...group, rows: group.rows.map(row => ({
    ...row,
    compatibility: { ...row.compatibility, confirmed: row.compatibility.result.status === 'experimental'
      ? Boolean(row.confirmationSource && hasProviderExperimentalConfirmation({
          providerSettings: input.catalog, ...row.confirmationSource,
          agentTargetKey: row.ref.agentTargetKey, modelId: row.ref.modelId,
          compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
          confirmationScope: row.compatibility.result.confirmationScope,
        }))
      : row.compatibility.result.status === 'verified' },
  })) })) };
}

export type AccountProviderDeclarationV1 = Readonly<{
  contributionKey: string; definition: ProviderContributionV1; provenance: 'first_party' | 'external';
}>;
export type AccountProviderModelProjectionInputV1 = Readonly<{
  catalog: ProviderConnectionsCatalogV1;
  definitions: readonly AccountProviderDeclarationV1[];
  agent: AgentProviderRequirementsV1 | null;
  request: Omit<DaemonProviderModelProjectionRequestV1, 'machineId' | 'forceRefresh'>;
  defaultsByAgentTargetKey?: ProviderDefaultModelSelectionsByAgentTargetKeyV1;
}>;

type AccountConnectionCatalogInputV1 = Readonly<{
  catalog: ProviderConnectionsCatalogV1;
  connection: ProviderConnectionV1;
  source: ProviderContributionV1 | CustomProviderTemplateV1;
}>;

function mergeAccountConnectionCatalog(input: AccountConnectionCatalogInputV1) {
  return mergeProviderCatalogV1({
    staticModels: 'staticModels' in input.source.catalog ? input.source.catalog.staticModels : [],
    manualModels: readOwnRecordValue(input.catalog.manualModelsByConnectionId, input.connection.id) ?? [],
    probeState: { snapshot: null, staleProbeModels: [] },
    ...('membershipPolicy' in input.source.catalog ? { membershipPolicy: input.source.catalog.membershipPolicy } : {}),
  });
}

/** Account management rows; machine probes and runtime availability are separate observations. */
export function projectAccountProviderConnectionModelsV1(input: AccountConnectionCatalogInputV1):
  Extract<DaemonProviderModelsResponseV1, { status: 'success' }>['models'] {
  return mergeAccountConnectionCatalog(input).rows.map(row => ({
    id: row.descriptor.id, name: row.descriptor.name, source: row.sources.manual ? 'manual' : 'static',
    stale: false, loadState: 'unknown',
    visibility: readOwnRecordValue(input.catalog.modelVisibilityByRef, serializeModelVisibilityRefV1({
      scope: 'allAgents', providerConnectionId: input.connection.id, modelId: row.descriptor.id,
    })) === 'hidden' ? 'hidden_all_agents' : 'visible',
  }));
}

export type AccountProviderCatalogCountV1 = Readonly<{ shown: number; total: number }>;

/** One batched summary projection from the admitted Account catalog, without per-connection reads. */
export function projectAccountProviderCatalogCountsV1(input: Readonly<{
  catalog: ProviderConnectionsCatalogV1;
  definitions: readonly AccountProviderDeclarationV1[];
}>): Readonly<Record<string, AccountProviderCatalogCountV1>> {
  const declarations = new Map(input.definitions.map(row => [canonicalizeProviderContributionKeyV1(row.contributionKey), row.definition]));
  const counts: Record<string, AccountProviderCatalogCountV1> = {};
  for (const connection of input.catalog.connections) {
    const source = connection.source.kind === 'custom' ? connection.source.template
      : declarations.get(canonicalizeProviderContributionKeyV1(connection.source.contributionKey));
    if (!source) continue;
    const rows = projectAccountProviderConnectionModelsV1({ catalog: input.catalog, connection, source });
    counts[connection.id] = { shown: rows.filter(row => row.visibility !== 'hidden_all_agents').length, total: rows.length };
  }
  return counts;
}

export function projectAccountProviderModelsV1(input: AccountProviderModelProjectionInputV1): DaemonProviderModelProjectionResponseV1 {
  const agent = input.agent;
  if (!agent) return { status: 'error', error: createProviderErrorV1('provider_agent_runtime_unsupported') };
  const request = input.request;
  // Machine augmentation has a separate authoritative owner. Do not reinterpret
  // Team/broker/application filters as personal static Account model browsing.
  if (request.application || request.providerConnection || request.connectedAccountTarget) {
    return { status: 'error', error: createProviderErrorV1('provider_machine_unavailable') };
  }
  const declarations = new Map(input.definitions.map(entry => [canonicalizeProviderContributionKeyV1(entry.contributionKey), entry]));
  const catalogs: ProviderConnectionCatalog[] = [];
  for (const connection of input.catalog.connections) {
    const declaration = connection.source.kind === 'contribution'
      ? declarations.get(canonicalizeProviderContributionKeyV1(connection.source.contributionKey)) : undefined;
    const source = connection.source.kind === 'custom' ? connection.source.template : declaration?.definition;
    if (!source) continue;
    const merged = mergeAccountConnectionCatalog({ catalog: input.catalog, connection, source });
    const endpoints = source.endpointTemplates.map(endpoint => {
      const effective = resolveEffectiveProviderEndpointV1({ connection, template: endpoint });
      return effective.baseUrl ? { ...endpoint, baseUrl: effective.baseUrl, requiresEndpointOverride: undefined,
        localUrlCandidates: undefined, publicHeaders: effective.publicHeaders } : endpoint;
    });
    const current = request.currentSelection;
    const freeformCurrent = current?.providerConnectionId === connection.id && current.agentTargetKey === request.agentTargetKey
      && !merged.rows.some(row => row.descriptor.id === current.modelId)
      && providerCatalogPermitsUnlistedModelIdV1({ manualModelPolicy: source.catalog.manualModelPolicy,
        agentSupportsFreeformModelIds: agent.supportsFreeformModelIds })
      ? [{ descriptor: { id: current.modelId, name: current.modelId },
          sources: { manual: false, static: false, probe: false }, stale: true }] : [];
    catalogs.push({ agentTargetKey: request.agentTargetKey, connectionId: connection.id,
      providerName: source.name, connectionName: connection.displayName,
      connectionRole: connection.role, connectionDisplayNameMode: connection.displayNameMode,
      manualModelPolicy: source.catalog.manualModelPolicy,
      sourceKind: connection.source.kind === 'custom' ? 'custom' : declaration!.definition.kind,
      authorization: { authorized: false, errorCode: 'provider_machine_unavailable' },
      staleRows: [], rows: [...merged.rows, ...freeformCurrent].map(row => ({
        ref: { agentTargetKey: request.agentTargetKey, providerConnectionId: connection.id, modelId: row.descriptor.id },
        descriptor: projectProviderModelReasoningForAgent(row.descriptor, agent), sources: row.sources, confidence: 'account_unverified',
        presentation: {
          compatibility: resolveProviderBindingDeclarationCompatibilityV1({ agentTargetKey: request.agentTargetKey,
            endpoints, credential: source.credential, agent, model: row.descriptor,
            ...(declaration ? { compatibilityOverrides: declaration.definition.compatibilityOverrides } : {}) }),
          endpointHealth: null, catalog: { stale: row.stale === true }, loadState: 'unknown',
        },
      })),
    });
  }
  const projection = projectProviderCatalogForPicker({ catalogs, observationScope: 'account',
    modelVisibilityByRef: input.catalog.modelVisibilityByRef,
    modelPickerVisibilityByConnectionId: input.catalog.modelPickerVisibilityByConnectionId,
    mode: request.mode, sourceConnectionId: request.sourceConnectionId,
    currentSelection: request.currentSelection, favoriteSelections: request.favoriteSelections,
    defaultSelection: input.defaultsByAgentTargetKey?.[request.agentTargetKey]?.ref,
  });
  const groups = projection.groups.map(group => {
    const catalog = catalogs.find(candidate => candidate.connectionId === group.connectionId)!;
    const connection = input.catalog.connections.find(candidate => candidate.id === group.connectionId)!;
    return DaemonProviderModelProjectionGroupV1Schema.parse({ connectionId: group.connectionId, providerName: group.providerName, connectionName: group.connectionName,
      connectionRole: catalog.connectionRole, connectionDisplayNameMode: catalog.connectionDisplayNameMode,
      connectionRevision: connection.revision, modelLoadAction: 'machine_required',
      authorization: { authorized: false, error: createProviderErrorV1('provider_machine_unavailable', { connectionId: connection.id }) },
      manualModelPolicy: catalog.manualModelPolicy, supportsFreeformModelIds: agent.supportsFreeformModelIds,
      suppressedConnectedServiceIds: [...agent.authIsolation.suppressConnectedServiceIds],
      rows: group.rows.map(row => ({ ref: row.ref, descriptor: row.descriptor, sources: row.sources,
        confidence: row.confidence,
        compatibility: { ...row.presentation.compatibility!, confirmed: false },
        endpointHealth: 'not_checked', catalog: row.presentation.catalog, loadState: 'unknown', visibility: row.visibility,
      })),
    });
  });
  return { status: 'success', agentTargetKey: request.agentTargetKey, groups,
    currentSelectionRecovery: resolveProviderCurrentSelectionRecoveryV1({ currentSelection: request.currentSelection,
      settings: input.catalog, projectedGroups: groups,
      readContribution: key => declarations.get(canonicalizeProviderContributionKeyV1(key))?.definition ?? null }),
    hiddenSources: projection.hiddenSources.map(source => {
      const catalog = catalogs.find(candidate => candidate.connectionId === source.connectionId)!;
      return { ...source, connectionRole: catalog.connectionRole, connectionDisplayNameMode: catalog.connectionDisplayNameMode };
    }),
  };
}
