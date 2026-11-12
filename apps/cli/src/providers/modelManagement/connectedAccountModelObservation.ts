import { randomUUID } from 'node:crypto';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { qualifiedConnectedAccountPreferenceServiceKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-key';

import type { CapabilitiesInvokeRequest } from '@/capabilities/types';
import { resolveContributedAgentRoutingId } from '@/plugins/projection/registry/agentRoutingIdentity';
import type { AgentProviderCatalogObservationResult, AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import type { ResolveContributedProviderCatalogParsers } from '@/providers/probe/runtimeServices';
import type { ConnectedAccountCatalogSource } from './connectedAccountCatalog';

export type ObserveConnectedAccountModels = (input: Readonly<{
  account: QualifiedConnectedAccountRef;
  machineId: string;
  source: ConnectedAccountCatalogSource;
  currentOnly: boolean;
  refresh: boolean;
  signal: AbortSignal;
}>) => Promise<AgentProviderCatalogObservationResult | null>;

export type ObserveConnectedAccountSourceModels = AgentProviderCatalogObservationService['observe'];

export type InvokeConnectedAccountNativeModels = (
  request: CapabilitiesInvokeRequest, signal: AbortSignal,
) => Promise<unknown>;

/** The service declares its exact source. HTTP sources use the shared Provider
 * observation owner; native sources retain the existing Machine capability. */
export function createConnectedAccountModelObserver(input: Readonly<{
  registry: ProviderContributionRegistryView;
  invoke?: InvokeConnectedAccountNativeModels;
  observe?: ObserveConnectedAccountSourceModels;
  resolveContributedCatalogParsers?: ResolveContributedProviderCatalogParsers;
}>): ObserveConnectedAccountModels {
  return async ({ account, machineId, source, currentOnly, refresh, signal }) => {
    const declared = source.family.catalogObservation;
    if (!declared) return null;
    if ('provider' in declared) {
      if (!input.observe) return null;
      const provider = input.registry.providersByContributionKey.get(buildQualifiedPluginContributionKey(declared.provider))?.definition;
      if (provider?.catalog.source !== 'static+probe' || provider.catalog.probes.length !== 1) return null;
      const probe = provider.catalog.probes[0]!;
      const endpoint = provider.endpointTemplates.find(endpoint => endpoint.id === probe.endpointTemplateId);
      if (typeof endpoint?.baseUrl !== 'string') return null;
      const origin = new URL(endpoint.baseUrl).origin;
      const use = source.requestAuthUses.find(use => use.purpose === source.family.purpose
        && use.materialization.kind === 'httpHeaders' && use.materialization.origin === origin);
      if (!use) return null;
      const purpose = { consumer: source.provider.identity, purpose: source.family.purpose };
      return input.observe({ machineId, operationId: randomUUID(), consumer: source.provider.identity,
        purpose, binding: source.selection.binding,
        requestAuthUse: { purpose, materialization: { kind: 'httpHeaders', origin, headerNames: use.materialization.headerNames } },
        provider, trigger: refresh ? 'manual_refresh' : 'picker_open', currentOnly,
        ...(input.resolveContributedCatalogParsers ? {
          resolveContributedCatalogParsers: () => input.resolveContributedCatalogParsers!(declared.provider),
        } : {}),
        isCurrent: () => !signal.aborted, signal });
    }
    if (!input.invoke) return null;
    const agent = (['external', 'first_party'] as const).map(provenance => input.registry.agentDefinitionsById?.get(
      resolveContributedAgentRoutingId({ ...declared.agent, provenance }),
    )).find(agent => agent?.identity?.pluginId === declared.agent.pluginId && agent.identity.localId === declared.agent.localId);
    if (!agent) return null;
    const agentId = agent.id;
    const serviceKey = qualifiedConnectedAccountPreferenceServiceKey(account.service);
    const response = await input.invoke({ id: `cli.${agentId}`, method: 'probeModels', params: {
      connectedServices: { v: 2, bindingsByServiceId: {
        [serviceKey]: { source: 'connected', profileId: account.accountId },
      } }, currentOnly, bypassCache: refresh && !currentOnly,
    } }, signal);
    signal.throwIfAborted();
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) return null;
    const parsed = AgentModelsProbeObservationSchema.safeParse(response.result);
    if (!parsed.success || parsed.data.agentId !== agentId) return null;
    const observation = parsed.data;
    if (observation.source !== 'dynamic') return { source: 'static', models: [], stale: false };
    const ids = new Set<string>();
    const models = observation.availableModels.filter(model => model.id !== 'default'
      && (!declared.modelIdPrefix || model.id.startsWith(declared.modelIdPrefix))).map(model => {
      const descriptor = ProviderModelDescriptorV1Schema.parse(Object.fromEntries(
        Object.entries({ ...model,
          id: declared.modelIdPrefix ? model.id.slice(declared.modelIdPrefix.length) : model.id,
        }).filter(([key]) => Object.hasOwn(ProviderModelDescriptorV1Schema.shape, key)),
      ));
      if (ids.has(descriptor.id)) throw new TypeError('Duplicate observed source model id');
      ids.add(descriptor.id);
      return descriptor;
    });
    return { source: observation.source, models, stale: observation.refreshError === true || observation.spawnFailure !== undefined,
      ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
      ...(observation.refreshError === undefined ? {} : { refreshError: observation.refreshError }) };
  };
}

/** A successful empty dynamic list stays empty; static fallback is not merged. */
export function observedConnectedAccountDescriptors(observation: AgentProviderCatalogObservationResult | null) {
  if (observation?.source !== 'dynamic') return null;
  return { descriptors: observation.models, stale: observation.stale };
}
