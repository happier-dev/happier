import { useMemo } from 'react';
import { useMachineField } from '@/sync/store/hooks';
import type { MachineNetworkFacts } from './networkSurface';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachineLastAnsweredAt } from '@/sync/domains/machines/reachability/useMachineLastAnsweredAt';
import { projectMachineNetworkAccessFacts } from './networkAccessFacts';

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
  const access = useMemo(() => projectMachineNetworkAccessFacts({
    posture: posture ?? null, selections: selections ?? null, observation: observation ?? null,
  }), [posture, selections, observation]);
  return { posture: posture ?? null, selections: selections ?? null, observation: observation ?? null, access,
    ...(input.scope ? { lastAnsweredAtMs } : {}) };
}
