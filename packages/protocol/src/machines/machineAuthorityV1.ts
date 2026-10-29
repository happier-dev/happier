import type { MachineAdminAccessObservationV1, MachineAdminAccessV1 } from './adminAccessV1.js';
import type { MachineAgentIsolationStatusV1 } from './agentIsolationV1.js';

export type MachineAuthorityFreshnessV1 = 'current' | 'stale';
export type MachineHostAuthorityV1 = 'administrator' | 'ordinary' | 'unknown';
export type MachineDaemonRightsV1 = Readonly<{
  observation: MachineAdminAccessObservationV1 | null;
  freshness: MachineAuthorityFreshnessV1;
}>;
export type MachineAuthorityInputV1 = Readonly<{
  observation?: (Omit<MachineAdminAccessObservationV1, 'tailscaledOperator'> &
    Partial<Pick<MachineAdminAccessObservationV1, 'tailscaledOperator'>>) | null;
  freshness?: MachineAuthorityFreshnessV1;
  desiredAdminAccess?: MachineAdminAccessV1 | null;
  isolation?: MachineAgentIsolationStatusV1 | null;
  sharedMachine?: boolean;
  /** Observed target engine, never the client or target OS alone. */
  engine?: 'native' | 'dockerDesktop' | 'unknown';
}>;
export type MachineAuthorityPresentationV1 = Readonly<{
  hostAuthority: MachineHostAuthorityV1;
  lastKnownHostAuthority: MachineHostAuthorityV1;
  agentHostAuthority: MachineHostAuthorityV1;
  freshness: MachineAuthorityFreshnessV1;
  powerSources: readonly ('rootUid' | 'rootEquivalentGroup' | 'passwordlessRoot')[];
  rootEquivalentGroups: readonly string[] | null;
  groupMembership: NonNullable<MachineAdminAccessObservationV1['groupMembership']>;
  desiredAdminAccess: MachineAdminAccessV1 | null;
  isolation: MachineAgentIsolationStatusV1 | null;
  sharedAgentUid: boolean;
  /** Material actually delivered to this Machine, not the requester's entire Account. */
  deliveredMaterial: Readonly<{ ownerVisible: true; sharedUserPeerVisible: boolean }>;
  tailscaledOperator: Readonly<{
    authorization: MachineAdminAccessObservationV1['tailscaledOperator']['authorization'];
    currentAuthorization: MachineAdminAccessObservationV1['tailscaledOperator']['authorization'];
    freshness: MachineAuthorityFreshnessV1;
  }>;
  deployment: Readonly<{
    requiresAwakeComputerAndDockerDesktop: boolean;
    domains: 'unavailableDockerDesktop' | 'notDetermined';
  }>;
}>;

/** Shared display facts only. Privileged admission belongs to the target daemon's resolver. */
export function presentMachineAuthorityV1(input: MachineAuthorityInputV1): MachineAuthorityPresentationV1 {
  const observation = input.observation;
  const powerSources: Array<MachineAuthorityPresentationV1['powerSources'][number]> = [];
  if (observation?.daemonUid === 0) powerSources.push('rootUid');
  if (observation?.rootEquivalentGroups?.length) powerSources.push('rootEquivalentGroup');
  if (observation?.passwordlessSudoToRoot === 'allowed') powerSources.push('passwordlessRoot');
  const provenOrdinary = observation != null && observation.daemonUid != null && observation.daemonUid > 0
    && observation.daemonIdentity === 'nonRoot' && observation.rootEquivalentGroups?.length === 0
    && observation.groupMembership != null && observation.groupMembership.state !== 'unknown'
    && observation.passwordlessSudoToRoot === 'denied';
  const lastKnownHostAuthority = powerSources.length > 0 ? 'administrator' : provenOrdinary ? 'ordinary' : 'unknown';
  const freshness = observation ? input.freshness ?? 'stale' : 'stale';
  const hostAuthority = freshness === 'current' ? lastKnownHostAuthority : 'unknown';
  const isolation = input.isolation ?? null;
  const agentHostAuthority = freshness !== 'current' || isolation === null ? 'unknown'
    : isolation.kind === 'effective' ? 'ordinary' : hostAuthority;
  const authorization = observation?.tailscaledOperator?.authorization ?? 'unknown';
  return {
    hostAuthority, lastKnownHostAuthority, agentHostAuthority, freshness, powerSources,
    rootEquivalentGroups: observation?.rootEquivalentGroups ?? null,
    groupMembership: observation?.groupMembership ?? { state: 'unknown' },
    desiredAdminAccess: input.desiredAdminAccess ?? null,
    isolation, sharedAgentUid: input.sharedMachine === true,
    // Every current effective isolation shape still uses happier-agent. Neither
    // desired policy nor unknown/stale setup proves distinct member identities.
    deliveredMaterial: { ownerVisible: true, sharedUserPeerVisible: input.sharedMachine !== false },
    tailscaledOperator: { authorization, freshness,
      currentAuthorization: freshness === 'current' ? authorization : 'unknown' },
    deployment: { requiresAwakeComputerAndDockerDesktop: input.engine === 'dockerDesktop',
      domains: input.engine === 'dockerDesktop' ? 'unavailableDockerDesktop' : 'notDetermined' },
  };
}
