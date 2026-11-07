import type { MachineAdminAccessObservationV1, MachineAdminAccessV1 } from './adminAccessV1.js';
import { readMachineAgentIsolationPolicyV1, resolveMachineAgentExecutionPlacementV1, type MachineAgentIsolationStatusV1 } from './agentIsolationV1.js';

export type MachineAuthorityFreshnessV1 = 'current' | 'stale';
export type MachineHostAuthorityV1 = 'administrator' | 'ordinary' | 'unknown';
/** Configuration availability is distinct from the native setup observation.
 * Preview owns the prerequisites for turning a supported target on. */
export type MachineSeparateUsersAvailabilityV1 = Readonly<
  | { kind: 'available' }
  | { kind: 'can_turn_on' }
  | { kind: 'unavailable'; reason: 'unsupported_platform' | 'metadata_unavailable' }
>;
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
  platform?: string | null;
  isolationPolicy?: unknown;
  serviceManaged?: boolean | null;
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
  separateUsers: Readonly<{
    placement: ReturnType<typeof resolveMachineAgentExecutionPlacementV1> | null;
    availability: MachineSeparateUsersAvailabilityV1;
  }>;
  daemonAccount: Readonly<{
    username: string | null;
    passwordLocked: boolean | null;
    loginShell: string | null;
  }>;
  daemonService: Readonly<{
    managed: boolean | null;
    mode: 'system' | 'user' | null;
    startsAtBoot: boolean | null;
  }>;
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
  // A known target platform proves metadata is readable; only then is an absent policy the default.
  const policy = input.platform ? readMachineAgentIsolationPolicyV1(input.isolationPolicy == null
    ? {} : { agentIsolation: input.isolationPolicy }) : null;
  const placement = policy?.status === 'ready' && input.platform
    ? resolveMachineAgentExecutionPlacementV1({ policy: policy.policy, platform: input.platform }) : null;
  const availability: MachineSeparateUsersAvailabilityV1 = !input.platform || placement === null
    ? { kind: 'unavailable', reason: 'metadata_unavailable' }
    : input.platform !== 'linux' ? { kind: 'unavailable', reason: 'unsupported_platform' }
      : { kind: placement === 'member' ? 'available' : 'can_turn_on' };
  const separateUsers = { placement, availability };
  const agentHostAuthority = freshness !== 'current' || isolation === null ? 'unknown'
    : isolation.kind === 'effective' ? 'ordinary' : hostAuthority;
  const authorization = observation?.tailscaledOperator?.authorization ?? 'unknown';
  return {
    hostAuthority, lastKnownHostAuthority, agentHostAuthority, freshness, powerSources,
    rootEquivalentGroups: observation?.rootEquivalentGroups ?? null,
    groupMembership: observation?.groupMembership ?? { state: 'unknown' },
    desiredAdminAccess: input.desiredAdminAccess ?? null,
    isolation, separateUsers, sharedAgentUid: input.sharedMachine === true && placement !== 'member',
    daemonAccount: { username: observation?.daemonUsername ?? null,
      passwordLocked: observation?.daemonAccount?.passwordLocked ?? null, loginShell: observation?.daemonAccount?.loginShell ?? null },
    daemonService: { managed: input.serviceManaged ?? null,
      mode: observation?.daemonService?.mode ?? null, startsAtBoot: observation?.daemonService?.startsAtBoot ?? null },
    // Placement does not retract material delivered before member separation.
    // Keep historical peer exposure distinct from the current execution policy.
    deliveredMaterial: { ownerVisible: true, sharedUserPeerVisible: input.sharedMachine !== false },
    tailscaledOperator: { authorization, freshness,
      currentAuthorization: freshness === 'current' ? authorization : 'unknown' },
    deployment: { requiresAwakeComputerAndDockerDesktop: input.engine === 'dockerDesktop',
      domains: input.engine === 'dockerDesktop' ? 'unavailableDockerDesktop' : 'notDetermined' },
  };
}
