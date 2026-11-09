import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { resolveProviderBindingCompatibilityFromSourceFactsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { AgentProviderRequirementsV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionGroupV1, DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';

import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { preserveConnectedAccountSourceHealthFailure } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import { projectManagedProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { isCpxBrokerApplication } from '@/providers/broker/teamCredentialBrokerSourceOwner';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { hasProviderExperimentalConfirmation } from '@/providers/catalog/compatibility';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { getProviderExperimentalConfirmationCatalogSourceKeyV1 } from '@happier-dev/protocol/providers/settings/v1';
import { ProviderModelBindingSourceV1Schema, projectProviderModelSourceStateV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { readProviderConnectionBrokerImplementation } from '@/providers/broker/providerConnectionCpxBridge';
import { projectProviderModelReasoningForAgent } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { observedConnectedAccountDescriptors, type ObserveConnectedAccountModels } from './connectedAccountModelObservation';
import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderSourceModelCatalog } from './sourceCatalog';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

export type ResolveManagedProviderPurposeBindingIntentSelection = ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];

/** One source reader for catalog projection and source-any readiness. No Agent
 * registration, personal Gateway, credential read or compatibility is involved. */
export async function readConnectedAccountCatalogSources(input: Readonly<{
  registry: ProviderContributionRegistryView;
  target: NonNullable<DaemonProviderModelProjectionRequestV1['connectedAccountTarget']>;
  resolveSelection: ResolveManagedProviderPurposeBindingIntentSelection;
  signal?: AbortSignal;
  protocols?: readonly string[];
  endpointTemplateId?: string;
  provider?: ResolvedProviderContribution;
  purpose?: string;
}>) {
  const provider = input.provider ?? readProviderConnectionBrokerImplementation(input.registry);
  if (!provider?.definition.managedRuntime) return [];
  const runtime = resolveProviderManagedRuntimeDeclarationV1({ implementationIdentity: provider.identity,
    managedRuntime: provider.definition.managedRuntime });
  const service = input.target.kind === 'account' ? input.target.account.service : input.target.service;
  const signal = input.signal ?? new AbortController().signal;
  const sources = [];
  const selectionByPurpose = new Map<string, Awaited<ReturnType<ResolveManagedProviderPurposeBindingIntentSelection>> | null>();
  for (const endpoint of provider.definition.endpointTemplates) {
    if (input.protocols && !input.protocols.includes(endpoint.protocol)
      || input.endpointTemplateId && input.endpointTemplateId !== endpoint.id) continue;
    if (!provider.definition.managedRuntime.endpointTemplateIds.includes(endpoint.id)) continue;
    const families = runtime.connectedAccounts.filter(family => (input.purpose === undefined || family.purpose === input.purpose)
      && family.service.pluginId === service.pluginId
      && family.service.localId === service.localId && family.endpointTemplateIds?.includes(endpoint.id));
    const family = families.length === 1 ? families[0] : undefined;
    if (!family) continue;
    let selection = selectionByPurpose.get(family.purpose);
    if (selection === undefined) {
      selection = await input.resolveSelection({ purpose: { consumer: provider.identity, purpose: family.purpose },
        target: input.target, serviceRefs: [family.service], signal }).catch(preserveConnectedAccountSourceHealthFailure);
      if (!selection || signal.aborted || !await selection.isCurrent(signal)) selection = null;
      selectionByPurpose.set(family.purpose, selection);
    }
    if (!selection) continue;
    sources.push({ provider, endpoint, family, selection, requestAuthUses: runtime.requestAuthUses });
  }
  return sources;
}

export type ConnectedAccountCatalogSource = Awaited<ReturnType<typeof readConnectedAccountCatalogSources>>[number];

/** A projection of the exact source's native observation or unverified declarations. The
 * connection-shaped wire envelope is read-only: its identity never creates a
 * Provider connection, binding or grant. Confirmations name its exact source. */
type ConnectedAccountCatalogInput = Readonly<{
  request: Omit<DaemonProviderModelProjectionRequestV1, 'agentTargetKey' | 'application'> & Readonly<{
    agentTargetKey?: string;
    application?: ProviderBrokerSourceApplicationBindingV1;
  }>;
  registry: ProviderContributionRegistryView;
  support?: AgentProviderRequirementsV1;
  adapterVersion?: number;
  providerSettings: ProviderSettingsV1;
  resolveSelection: ResolveManagedProviderPurposeBindingIntentSelection;
  observeModels?: ObserveConnectedAccountModels;
  provider?: ResolvedProviderContribution;
  purpose?: string;
  signal?: AbortSignal;
}>;

type ConnectedAccountSourceGroup = Omit<DaemonProviderModelProjectionGroupV1, 'rows'> & Readonly<{
  application: ProviderBrokerSourceApplicationBindingV1;
  rows: ProviderSourceModelCatalog['rows'];
}>;

export async function readConnectedAccountModelCatalog(input: Omit<ConnectedAccountCatalogInput, 'support' | 'adapterVersion' | 'providerSettings'>): Promise<Readonly<{
  groups: ConnectedAccountSourceGroup[];
  error?: ProviderErrorV1;
  isCurrent(): Promise<boolean>;
}>> {
  const target = input.request.connectedAccountTarget;
  if (!target) throw new TypeError('Connected Account catalog requires an exact target');
  const signal = input.signal ?? new AbortController().signal;
  if (input.request.application && !isCpxBrokerApplication(input.registry, input.request.application)) {
    return { groups: [], error: createProviderErrorV1('provider_incompatible_with_agent'), isCurrent: async () => !signal.aborted };
  }
  const groups: ConnectedAccountSourceGroup[] = [];
  const selections = new Set<Awaited<ReturnType<ResolveManagedProviderPurposeBindingIntentSelection>>>();
  const observations = new Map<NonNullable<Awaited<ReturnType<ResolveManagedProviderPurposeBindingIntentSelection>>>,
    ReturnType<typeof observedConnectedAccountDescriptors>>();
  for (const source of await readConnectedAccountCatalogSources({
    registry: input.registry, target, resolveSelection: input.resolveSelection, signal,
    protocols: input.request.application ? [input.request.application.protocol] : undefined,
    endpointTemplateId: input.request.application?.endpointTemplateId,
    provider: input.provider, purpose: input.purpose,
  })) {
      const { provider, endpoint, family, selection } = source;
      const protocol = endpoint.protocol;
      const application = projectManagedProviderBrokerApplication({
        registry: input.registry,
        implementationIdentity: provider.identity,
        agentTargetKey: input.request.agentTargetKey,
        protocol,
        endpointTemplateId: endpoint.id,
      });
      if (!application || (input.request.application && !pluginJsonValuesEqual(application, input.request.application))) continue;
      if (!input.request.application && !isCpxBrokerApplication(input.registry, application)) continue;
      selections.add(selection);
      if (!observations.has(selection)) {
        const observation = input.observeModels && !input.request.includeDirectMaterialization
          ? await input.observeModels({ account: selection.resolved.account, machineId: input.request.machineId, source,
              currentOnly: input.request.refreshPolicy === 'current_only',
              refresh: input.request.forceRefresh === true, signal }) : null;
        if (signal.aborted || !await selection.isCurrent(signal)) continue;
        observations.set(selection, observedConnectedAccountDescriptors(observation));
      }
      const observed = observations.get(selection) ?? null;
      const connectionId = ProviderConnectionIdSchema.parse(`connected-source:${computeCanonicalDomainSeparatedDigest(
        'happier.connected-source-model-projection.v1', [JSON.stringify(application), JSON.stringify(target)],
      )}`);
      const sourceFacts = ProviderModelBindingSourceV1Schema.parse({ endpoint: {
        id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities,
        ...(endpoint.modelIdPattern !== undefined ? { modelIdPattern: endpoint.modelIdPattern } : {}),
      }, ...(provider.definition.credential ? { credential: provider.definition.credential } : {}),
        compatibilityOverrides: provider.definition.compatibilityOverrides,
      });
      const confirmationSource = { connectionId, catalogSourceKey: getProviderExperimentalConfirmationCatalogSourceKeyV1({
        connectionId, connectedAccountTarget: target,
      }) };
      const rows: ProviderSourceModelCatalog['rows'] = (observed?.descriptors ?? family.staticModels ?? []).map(descriptor => {
          const compatibility = projectProviderModelSourceStateV1(sourceFacts, descriptor);
          return {
            descriptor,
            application, sourceFacts, confirmationSource,
            gatewaySlots: [selection.binding], sources: { manual: false, static: !observed, probe: Boolean(observed) },
            confidence: observed ? 'probe' : 'account_unverified', compatibility: { ...compatibility, confirmed: false },
            endpointHealth: 'not_checked', catalog: { stale: observed?.stale ?? false }, loadState: 'unknown', visibility: 'visible',
          };
        });
      const sourceRevision = computeCanonicalDomainSeparatedDigest('happier.connected-source-model-catalog.v1', [
        JSON.stringify({ implementationIdentity: application.implementationIdentity, endpointTemplateId: application.endpointTemplateId,
          protocol: application.protocol }), JSON.stringify(target), JSON.stringify(rows.map(row => ({
          descriptor: row.descriptor, catalog: row.catalog, compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
          sources: row.sources,
          selectedProtocol: row.compatibility.result.status === 'incompatible' ? null : row.compatibility.result.selectedProtocol,
        }))),
        JSON.stringify({ account: selection.resolved.account, group: selection.resolved.group ?? null }),
        ('sourceRegistryVersion' in provider.definition.catalog ? provider.definition.catalog.sourceRegistryVersion : undefined)
          ?? 'unversioned-provider-catalog',
        input.registry.providerActivationOccurrenceIdsByPluginId?.get(provider.identity.pluginId) ?? 'no-provider-activation-occurrence',
      ]);
      groups.push({
        application,
        connectionId, connectedAccountTarget: target, catalogObserved: observed !== null, providerName: provider.definition.name, connectionName: selection.resolved.displayName,
        connectionRole: 'named', connectionDisplayNameMode: 'automatic', connectionRevision: 0, sourceRevision,
        modelLoadAction: 'descriptor_absent', modelLoadPreflightPolicy: null, authorization: { authorized: true },
        manualModelPolicy: 'catalog-only', supportsFreeformModelIds: false,
        suppressedConnectedServiceIds: [],
        rows,
      });
  }
  return { groups, isCurrent: async () => !signal.aborted
    && (await Promise.all([...selections].map(selection => selection.isCurrent(signal)))).every(Boolean)
    && !signal.aborted };
}

/** Worker presentation wraps the same source observation with its exact ref. */
export async function projectConnectedAccountCatalog(input: ConnectedAccountCatalogInput & Readonly<{
  request: DaemonProviderModelProjectionRequestV1;
}>): Promise<Readonly<{
  groups: DaemonProviderModelProjectionGroupV1[];
  error?: ProviderErrorV1;
  isCurrent(): Promise<boolean>;
}>> {
  const source = await readConnectedAccountModelCatalog(input);
  return { ...source, groups: source.groups.flatMap(group => {
    if (input.support && !input.support.acceptsProtocols.includes(group.application.protocol)) return [];
    const rows = group.rows.flatMap(row => {
      const facts = row.sourceFacts;
      const compatibility = input.support && input.adapterVersion && facts
        ? resolveProviderBindingCompatibilityFromSourceFactsV1({ agentTargetKey: input.request.agentTargetKey,
          agent: input.support, adapterVersion: input.adapterVersion, endpoints: [facts.endpoint],
          credential: facts.credential, compatibilityOverrides: facts.compatibilityOverrides, model: row.descriptor })
        : row.compatibility;
      return [{ ...row, descriptor: input.support ? projectProviderModelReasoningForAgent(row.descriptor, input.support) : row.descriptor,
        application: { ...row.application, agentTargetKey: input.request.agentTargetKey },
        ref: { agentTargetKey: input.request.agentTargetKey, providerConnectionId: group.connectionId, modelId: row.descriptor.id },
        compatibility: { ...compatibility, confirmed: !input.request.sourceCatalog && compatibility.result.status === 'experimental'
          ? hasProviderExperimentalConfirmation({ providerSettings: input.providerSettings, connectionId: group.connectionId,
            connectedAccountTarget: input.request.connectedAccountTarget, agentTargetKey: input.request.agentTargetKey, modelId: row.descriptor.id,
            compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmationScope: compatibility.result.confirmationScope })
          : !input.request.sourceCatalog && compatibility.result.status === 'verified' },
      }];
    });
    const { application: _sourceApplication, ...presentation } = group;
    return [{ ...presentation, rows, suppressedConnectedServiceIds: input.support?.authIsolation.suppressConnectedServiceIds ?? [] }];
  }) };
}
