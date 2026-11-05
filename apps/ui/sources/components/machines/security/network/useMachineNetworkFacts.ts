import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useMachineField } from '@/sync/store/hooks';
import type { MachineNetworkFacts } from './networkSurface';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachineLastAnsweredAt } from '@/sync/domains/machines/reachability/useMachineLastAnsweredAt';
import { projectMachineNetworkAccessFacts } from './networkAccessFacts';
import { captureDaemonMergedProjectionReader } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readPublishedDaemonProjectionFamily } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

const ACCESS_PROVIDER_SECTIONS = ['familiesById.accessProviders'] as const;

/** Data-only consumer of P20's admitted fields. The shared inspect loader owns demand and freshness. */
export function useMachineNetworkFacts(input: Readonly<{
  machineId: string;
  serverId: string;
  enabled: boolean;
  scope?: ServerAccountScope | null;
}>): MachineNetworkFacts {
  const options = { enabled: input.enabled, serverId: input.serverId };
  const posture = useMachineField(input.machineId, 'metadata', 'reachabilityPosture', options);
  const selections = useMachineField(input.machineId, 'metadata', 'accessProviderSelections', options);
  const observation = useMachineField(input.machineId, 'daemonState', 'reachability', options);
  const lastAnsweredAtMs = useMachineLastAnsweredAt(input.scope, input.machineId, input.enabled);
  const needsPluginChoices = input.enabled && Boolean(selections?.some(selection => !('kind' in selection.provider)));
  // The visible provider-title reader owns catalog demand. This field projection
  // only observes that same cache; it never starts another Machine read.
  const providerReader = useMemo(() => captureDaemonMergedProjectionReader({
    machineId: needsPluginChoices ? input.machineId : null, serverId: input.serverId, sections: ACCESS_PROVIDER_SECTIONS,
  }), [needsPluginChoices, input.machineId, input.serverId]);
  const readAccessProviders = useCallback(() => {
    const entry = providerReader.readCached();
    return entry?.kind === 'ready' ? readPublishedDaemonProjectionFamily(entry.inputs, 'accessProviders') : null;
  }, [providerReader]);
  const accessProviders = useSyncExternalStore(providerReader.subscribeSummary, readAccessProviders, readAccessProviders);
  const access = useMemo(() => projectMachineNetworkAccessFacts({
    posture: posture ?? null, selections: selections ?? null, observation: observation ?? null, accessProviders,
  }), [posture, selections, observation, accessProviders]);
  return { posture: posture ?? null, selections: selections ?? null, observation: observation ?? null, access,
    ...(input.scope ? { lastAnsweredAtMs } : {}) };
}
