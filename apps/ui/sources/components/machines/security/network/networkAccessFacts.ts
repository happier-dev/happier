import type {
  MachineIngressCapabilityV1,
  MachineReachabilityObservationV1,
  MachineReachabilityPostureV1,
  MachineReachabilityRecoveryV1,
} from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { accessProviderRefsEqualV1, type AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { MachineReachabilityChangeV1 } from '@happier-dev/protocol';

type NativeSshEndpoints = Extract<MachineReachabilityObservationV1['nativeFirewall'], { status: 'available' }>['retainedSshEndpoints'];
type Input = Readonly<{
  posture: MachineReachabilityPostureV1 | null;
  selections: readonly AccessProviderSelectionV1[] | null;
  observation: MachineReachabilityObservationV1 | null;
}>;

export type MachineNetworkAccessFacts = Readonly<{
  recovery: MachineReachabilityRecoveryV1 | null;
  ssh: Readonly<{
    state: MachineReachabilityObservationV1['management']['publicSsh'];
    desired: MachineReachabilityPostureV1['management']['publicSsh'] | null;
    /** Native endpoints only. null means unanswered, not closed or the saved scalar port. */
    endpoints: NativeSshEndpoints | null;
  }>;
  defaultIngress: Readonly<{
    selection: AccessProviderSelectionV1 | null;
    /** Availability and port requirements, never proof of an installed Domain/service exposure. */
    capability: MachineIngressCapabilityV1 | null;
  }> | null;
  privateNetworks: readonly Readonly<{
    network: MachineReachabilityObservationV1['privateNetworks'][number];
    /** Only this retained exact selection can be echoed to reviewed Leave. */
    selection: AccessProviderSelectionV1 | null;
  }>[] | null;
}>;

/** Joins admitted fields for Network; native and desired authorities remain separate. */
export function projectMachineNetworkAccessFacts({ posture, selections, observation }: Input): MachineNetworkAccessFacts | null {
  if (!posture && !observation && selections === null) return null;
  const state = observation?.management.publicSsh ?? 'unknown';
  const native = observation?.nativeFirewall;
  const ingress = posture?.defaultServiceIngress;
  return {
    recovery: posture?.management.independentRecovery ?? null,
    ssh: {
      state,
      desired: posture?.management.publicSsh ?? null,
      endpoints: state === 'closed' ? []
        : state === 'open' && native?.status === 'available' ? native.retainedSshEndpoints : null,
    },
    defaultIngress: !ingress ? null : ingress.kind === 'none' ? { selection: null, capability: null } : {
      selection: ingress.selection,
      capability: observation?.ingress.find(candidate => accessProviderRefsEqualV1(candidate.provider, ingress.selection.provider)) ?? null,
    },
    privateNetworks: observation?.privateNetworks.map(network => {
      const matching = selections?.filter(candidate => accessProviderRefsEqualV1(candidate.provider, network.provider)) ?? [];
      // Native observations identify a provider, not its config. Several retained
      // selections for that provider cannot authorize choosing one for Leave.
      return { network, selection: matching.length === 1 ? matching[0]! : null };
    }) ?? null,
  };
}

/** The caller supplies the time of the person's explicit confirmation; review/configure owns persistence. */
export function buildNetworkConsoleConfirmationChange(posture: MachineReachabilityPostureV1, confirmedAtMs: number): MachineReachabilityChangeV1 {
  return { kind: 'posture', posture: { ...posture, management: { ...posture.management,
    independentRecovery: { kind: 'providerConsole', evidence: 'userAttested', confirmedAtMs },
  } } };
}
