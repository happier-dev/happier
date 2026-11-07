import { AgentModelsProbeObservationSchema, type AgentModelsProbeObservation } from '@happier-dev/protocol/capabilities';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { qualifiedConnectedAccountPreferenceServiceKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';

import type { CapabilitiesInvokeRequest } from '@/capabilities/types';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

export type ObserveConnectedAccountModels = (input: Readonly<{
  account: QualifiedConnectedAccountRef;
  currentOnly: boolean;
  refresh: boolean;
  signal: AbortSignal;
}>) => Promise<AgentModelsProbeObservation | null>;

export type InvokeConnectedAccountNativeModels = (
  request: CapabilitiesInvokeRequest, signal: AbortSignal,
) => Promise<unknown>;

/** Source-kind mapping comes from its installed Agent's service declaration,
 * not the Session's worker Agent or a host table of Provider ids. The existing
 * Machine capability owns isolation, probing, refresh and observation state. */
export function createConnectedAccountModelObserver(input: Readonly<{
  registry: PluginRuntimeRegistryLease['registry'];
  invoke: InvokeConnectedAccountNativeModels;
}>): ObserveConnectedAccountModels {
  return async ({ account, currentOnly, refresh, signal }) => {
    const serviceKey = qualifiedConnectedAccountPreferenceServiceKey(account.service);
    const candidates = [...input.registry.contributes.agentDefinitionsById.values()]
      .filter(agent => agent.identity?.pluginId === account.service.pluginId);
    const matching: string[] = [];
    for (const agent of candidates) {
      signal.throwIfAborted();
      const entry = await input.registry.acquireAgentCatalogEntry?.(agent.id);
      if (entry?.connectedAccountServiceIds?.includes(serviceKey)) matching.push(agent.id);
    }
    if (matching.length !== 1) return null;
    const agentId = matching[0]!;
    const response = await input.invoke({ id: `cli.${agentId}`, method: 'probeModels', params: {
      connectedServices: { v: 2, bindingsByServiceId: {
        [serviceKey]: { source: 'connected', profileId: account.accountId },
      } }, currentOnly, bypassCache: refresh && !currentOnly,
    } }, signal);
    signal.throwIfAborted();
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) return null;
    const parsed = AgentModelsProbeObservationSchema.safeParse(response.result);
    return parsed.success && parsed.data.agentId === agentId ? parsed.data : null;
  };
}

/** Native synthetic `default` is an Agent selector, never a serving model id.
 * A successful empty dynamic list stays empty; static fallback is not merged. */
export function observedConnectedAccountDescriptors(observation: AgentModelsProbeObservation | null) {
  if (observation?.source !== 'dynamic') return null;
  const ids = new Set<string>();
  const descriptors = observation.availableModels.filter(model => model.id !== 'default').map(model => {
    const descriptor = ProviderModelDescriptorV1Schema.parse(Object.fromEntries(
      Object.entries(model).filter(([key]) => Object.hasOwn(ProviderModelDescriptorV1Schema.shape, key)),
    ));
    if (ids.has(descriptor.id)) throw new TypeError('Duplicate observed source model id');
    ids.add(descriptor.id);
    return descriptor;
  });
  return { descriptors, stale: observation.refreshError === true || observation.spawnFailure !== undefined };
}
