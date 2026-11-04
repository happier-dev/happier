import { presentMachineAuthorityV1, type MachineAuthorityInputV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { useMachineField } from '@/sync/store/hooks';

export type UseMachineAuthorityInput = Omit<MachineAuthorityInputV1, 'observation' | 'isolation' | 'desiredAdminAccess' | 'platform' | 'isolationPolicy'> & Readonly<{
  machineId: string;
  serverId?: string | null;
  enabled?: boolean;
}>;

/** Mount for a visible consumer. The existing Action/demand owner supplies freshness; this hook never probes. */
export function useMachineAuthority(input: UseMachineAuthorityInput) {
  const options = { enabled: input.enabled, serverId: input.serverId };
  const observation = useMachineField(input.machineId, 'daemonState', 'adminAccess', options);
  const isolation = useMachineField(input.machineId, 'daemonState', 'agentIsolation', options);
  const desiredAdminAccess = useMachineField(input.machineId, 'metadata', 'adminAccess', options);
  const platform = useMachineField(input.machineId, 'metadata', 'platform', options);
  const isolationPolicy = useMachineField(input.machineId, 'metadata', 'agentIsolation', options);
  const presentation = presentMachineAuthorityV1({ ...input, observation, isolation, desiredAdminAccess, platform, isolationPolicy });
  // The raw observation rides along for facts the presentation doesn't carry (daemon user, typed reason).
  return { ...presentation, observation: observation ?? null };
}
