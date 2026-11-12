import type {
  MachineReachabilityPostureV1,
  MachineReachabilityObservationV1,
  MachineReachabilityChangeV1,
  MachineReachabilityPlanV1,
  MachineReachabilityConfigureInputV1,
  MachineReachabilityInspectInputV1,
} from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineNetworkExposureFacts } from './networkExposureFacts';
import { projectMachineNetworkAccessFacts, type MachineNetworkAccessFacts } from './networkAccessFacts';
import { relayAccessProviderDescriptors } from '@happier-dev/cli-common/relayAccess/catalog';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { accessProviderRefsEqualV1, type AccessProviderRefV1, type AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';

export type MachineNetworkProviderTitle = (provider: AccessProviderRefV1) => string | null;

/** Display identity belongs to the declared catalog; absent declarations never become raw ids. */
export function resolveMachineNetworkProviderTitle(
  provider: AccessProviderRefV1,
  projection?: PluginProjectionV2 | null,
  localize?: PluginLocalizedTextResolver,
): string | null {
  if ('kind' in provider) {
    return relayAccessProviderDescriptors.find(entry => accessProviderRefsEqualV1(entry.provider, provider))?.title ?? null;
  }
  const entry = projection?.familiesById.accessProviders?.entriesById[buildQualifiedPluginContributionKey(provider)];
  return entry && localize ? localize(entry.pluginId, entry.definition.title).trim() || null : null;
}

export type MachineNetworkFacts = Readonly<{
  posture: MachineReachabilityPostureV1 | null;
  selections: readonly AccessProviderSelectionV1[] | null;
  observation: MachineReachabilityObservationV1 | null;
  /** Derived once from these admitted fields by useMachineNetworkFacts. */
  access?: MachineNetworkAccessFacts | null;
  /** Admitted, last-observed Domain listeners and effective Docker bindings, with explicit unknowns. */
  exposure?: MachineNetworkExposureFacts | null;
  /** Supplied only for a demanded, exactly bound Account; null means no completed reply in this lifetime. */
  lastAnsweredAtMs?: number | null;
}>;
export type MachineNetworkRead =
  | Readonly<{ kind: 'unrequested' | 'pending' | 'settled' }>
  | Readonly<{ kind: 'failed'; failure: Extract<ActionExecuteResult, { ok: false }> }>;
export type MachineNetworkSurfaceState = 'loading' | 'ready' | 'needsSetup' | 'unavailable' | 'needsManage';

/** Presentation only: field identities, admission and native truth stay with their producers. */
export function presentMachineNetwork(input: Readonly<{
  facts: MachineNetworkFacts;
  read: MachineNetworkRead;
  reachable: boolean | null;
  /** A Use grantee: inspect is Manage-only, so no read is demanded and none is awaited. */
  needsManage?: boolean;
}>) {
  const observation = input.facts.observation;
  const failure = input.read.kind === 'failed' ? input.read.failure : null;
  const coldOffline = input.read.kind === 'unrequested' && input.reachable === false;
  const awaitingFirstRead = !input.needsManage && observation === null && input.read.kind !== 'settled' && !failure && !coldOffline;
  const state: MachineNetworkSurfaceState = input.needsManage ? 'needsManage' : failure ? 'unavailable'
    : awaitingFirstRead ? 'loading'
      : !observation ? 'unavailable'
        : !input.facts.posture ? 'needsSetup' : 'ready';
  // Collection readiness says only whether rows exist. Native membership,
  // source scope, DNS and ingress availability retain their own discriminants.
  const privateNetworkState: 'loading' | 'empty' | 'ready' | 'unavailable' = observation
    ? observation.privateNetworks.length ? 'ready' : 'empty'
    : awaitingFirstRead ? 'loading' : 'unavailable';
  return {
    state,
    facts: input.facts,
    stale: observation !== null && input.reachable !== true,
    refreshing: observation !== null && input.read.kind === 'pending',
    failure,
    privateNetworkState,
  };
}

/**
 * What the page says first: whether the Machine is open to the internet, from the adapter's facts only. `null`
 * when a fact it needs is missing or unknown, so the page keeps its plain purpose instead of guessing.
 */
export type MachineNetworkHeadline =
  /** `ports` is null when something is open on a port the facts do not name. `services`: the ingress provider. */
  | Readonly<{ kind: 'open'; ports: readonly number[] | null; ssh: boolean; services: string | null }>
  /** `services`: a public ingress that needs no inbound port (a tunnel). */
  | Readonly<{ kind: 'closed'; services: string | null }>;

export function presentNetworkHeadline(facts: MachineNetworkFacts, providerTitle?: MachineNetworkProviderTitle): MachineNetworkHeadline | null {
  const access = facts.access ?? projectMachineNetworkAccessFacts(facts);
  const ssh = access?.ssh.state === 'open';
  const servicePorts = facts.exposure?.ports.filter(port => port.audience === 'internet' && port.domainId !== undefined) ?? [];
  if (!ssh && servicePorts.length === 0) return null;
  const endpoints = access?.ssh.endpoints;
  const knownPorts = [...(ssh ? endpoints?.map(endpoint => endpoint.port) ?? [] : []),
    ...servicePorts.flatMap(endpoint => typeof endpoint.port === 'number' ? [endpoint.port] : [])];
  const ports = ssh && !endpoints?.length ? null : [...new Set(knownPorts)].sort((a, b) => a - b);
  const publicDomainIds = new Set(servicePorts.map(port => port.domainId));
  const domain = facts.exposure?.domains?.find(candidate => candidate.provider && publicDomainIds.has(candidate.domainId));
  // The same catalog resolver names rows and the lead; absent declarations remain unnamed.
  const services = domain?.provider ? providerTitle?.(domain.provider) ?? null : null;
  return { kind: 'open', ports, ssh, services };
}

/**
 * What the Security tab's Network row can say from the published observation alone: whether one exists, what is
 * open, whether SSH is observed closed, and Happier's own firewall table. Absent facts stay absent, never "closed".
 */
export type MachineNetworkRowFacts = Readonly<{
  observed: boolean;
  headline: MachineNetworkHeadline | null;
  sshClosed: boolean;
  /** Happier's owned table only; `null` when the Machine publishes no firewall fact. */
  firewall: 'present' | 'absent' | 'unreadable' | null;
}>;

export function presentNetworkRowFacts(facts: MachineNetworkFacts, providerTitle?: MachineNetworkProviderTitle): MachineNetworkRowFacts {
  const observation = facts.observation;
  const firewall = observation?.nativeFirewall;
  return {
    observed: observation !== null,
    headline: observation ? presentNetworkHeadline(facts, providerTitle) : null,
    sshClosed: observation?.management.publicSsh === 'closed',
    firewall: !firewall ? null : firewall.status === 'available' ? firewall.ownedTable : 'unreadable',
  };
}

/** Both preview and refresh use the same host inspect Action. */
export function buildNetworkInspectInput(
  target: Readonly<{ serverId: string; machineId: string }>,
  change?: MachineReachabilityChangeV1,
): MachineReachabilityInspectInputV1 {
  return { ...target, ...(change ? { change } : {}) };
}

/** Only the host-produced reviewed basis supplies mutation inputs, never the live form draft. */
export function buildNetworkConfigureInput(serverId: string, plan: MachineReachabilityPlanV1): MachineReachabilityConfigureInputV1 {
  return {
    serverId, machineId: plan.basis.machineId,
    change: plan.basis.change, reviewedPlanDigest: plan.reviewedPlanDigest, reviewedPlanBasis: plan.basis,
  };
}
