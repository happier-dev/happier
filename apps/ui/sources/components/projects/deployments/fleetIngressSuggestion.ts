import type { Machine } from '@/sync/domains/state/storageTypes';
import { MachineReachabilityObservationV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { accessProviderRefsEqualV1, type MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';

// These are the published facts the native Caddy private binding consumes.
const hasPrivateBindingFacts = (network: MachinePrivateNetworkObservationV1) => network.state === 'ready'
  && network.networkIdentity !== null && network.addresses.length > 0
  && network.interfaceName !== null && network.sourceRanges.length > 0;

/** A reviewable suggestion from published Machine facts; Domain setup owns admission. */
export function suggestFleetEdgeMachineId(
  machines: readonly Machine[],
  activeRuntimeMachineIds: readonly string[],
): string | null {
  if (!activeRuntimeMachineIds.length) return null;
  const observations = new Map(machines.map(machine => {
    // Machine's dynamic daemonState crosses into this typed observation here.
    const daemonState: unknown = machine.daemonState;
    const parsed = MachineReachabilityObservationV1Schema.safeParse(
      daemonState !== null && typeof daemonState === 'object' && 'reachability' in daemonState
        ? daemonState.reachability : undefined,
    );
    return [machine.id, parsed.success ? parsed.data : null] as const;
  }));
  const runtimes = activeRuntimeMachineIds.map(id => observations.get(id));
  if (runtimes.some(observation => !observation)) return null;

  for (const machine of machines) {
    if (!machine.installationId) continue;
    const machineId = machine.id;
    const observation = observations.get(machineId);
    if (!observation?.ingress.some(capability => capability.state === 'ready'
      && capability.exposure === 'public' && capability.https
      && accessProviderRefsEqualV1(capability.provider, { kind: 'builtin', id: 'caddy' }))) continue;
    const sharedNetwork = observation.privateNetworks.some(network => hasPrivateBindingFacts(network)
      && runtimes.every(runtime => runtime?.privateNetworks.some(candidate => hasPrivateBindingFacts(candidate)
        && candidate.networkIdentity === network.networkIdentity
        && accessProviderRefsEqualV1(candidate.provider, network.provider))));
    if (sharedNetwork) return machineId;
  }
  return null;
}
