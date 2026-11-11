import type { DeploymentDomainReadItemV1, DeploymentEnvironmentReadCollectionV1 } from '@happier-dev/deployments';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';
import type { MachineNetworkFacts } from './networkSurface';
import { accessProviderRefsEqualV1, type AccessProviderRefV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import type { DeploymentDomainNetworkExposureV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { projectMachineNetworkAccessFacts } from './networkAccessFacts';

export type MachineNetworkExposureInput = Readonly<{
  machineId: string;
  facts: MachineNetworkFacts;
  environments: DeploymentEnvironmentReadCollectionV1['items'];
  domains: readonly DeploymentDomainReadItemV1[] | null;
  domainEnvironmentId: string | null;
  services: readonly MachineServiceRowV1[] | null;
}>;

type DomainObservation = DeploymentDomainReadItemV1['domain']['networkExposure'];
type DomainFact = Readonly<{
  domainId: string; environmentId: string; installationId: string; nativeServer: string;
  hostname: string; targetService: string; targetPort: number; provider: AccessProviderRefV1 | null;
  observedAtMs: number | null; observation: DeploymentDomainNetworkExposureV1;
}> & (Readonly<{ state: 'ready'; localOrigin: boolean; fallback: boolean }>
  | Readonly<{ state: 'unavailable'; reason: string }>);
export type MachineNetworkPortFact = Readonly<{
  /** Configured/last-observed audience, never an end-to-end reachability or application-health probe. */
  audience: 'internet' | 'privateNetwork' | 'thisMachine' | 'unknown';
  hostAddress: string | null; port: number | string; protocol: string;
  domainId?: string; serviceId?: string; networkIdentity?: string | null;
  interfaceName?: string; sourceCidrs?: readonly string[];
}>;
export type MachineNetworkExposureFacts = Readonly<{
  domains: readonly DomainFact[] | null;
  ports: readonly MachineNetworkPortFact[];
  services: readonly Readonly<{ service: MachineServiceRowV1; bindings: NonNullable<MachineServiceRowV1['configuration']>['ports'] | null;
    domainIds: readonly string[] | null }>[] | null;
}>;

/** Joins owner facts by Environment, runtime-link and installation identity, never display names. */
export function projectMachineNetworkExposureFacts(input: MachineNetworkExposureInput): MachineNetworkExposureFacts {
  const environments = new Map(input.environments.map(item => [item.environment.id, item]));
  const domains: DomainFact[] | null = input.domains === null ? null : [];
  const ports: MachineNetworkPortFact[] = [];
  const privateAddresses = new Map(input.facts.observation?.privateNetworks.filter(network => network.state === 'ready')
    .flatMap(network => network.addresses.map(address => [address, network] as const)));
  const saved = input.facts.posture?.defaultServiceIngress;
  const capability = saved?.kind === 'provider' ? input.facts.observation?.ingress.find(candidate =>
    accessProviderRefsEqualV1(candidate.provider, saved.selection.provider)) : null;
  const classifyBinding = (hostAddress: string | null): Pick<MachineNetworkPortFact, 'audience' | 'networkIdentity'> => {
    if (hostAddress && isLoopbackHostname(hostAddress)) return { audience: 'thisMachine' };
    const network = hostAddress ? privateAddresses.get(hostAddress) : null;
    return network ? { audience: 'privateNetwork', networkIdentity: network.networkIdentity } : { audience: 'unknown' };
  };
  const access = input.facts.access ?? projectMachineNetworkAccessFacts(input.facts);
  if (access?.ssh.state === 'open') for (const endpoint of access.ssh.endpoints ?? []) {
    const binding = classifyBinding(endpoint.hostAddress);
    ports.push({ ...binding, audience: binding.audience === 'unknown' ? 'internet' : binding.audience,
      hostAddress: endpoint.hostAddress, port: endpoint.port, protocol: 'tcp',
      interfaceName: endpoint.interfaceName, sourceCidrs: endpoint.sourceCidrs });
  }
  for (const item of input.domains ?? []) {
    const link = environments.get(item.domain.environmentId)?.runtimeTargetLink;
    if (!link || link.id !== item.domain.targetLinkId) continue;
    const member = link.members.find(candidate => candidate.machineId === input.machineId);
    if (!member) continue;
    const captures: NonNullable<DomainObservation> = item.domain.networkExposure ?? [];
    for (const capture of captures) {
      if (capture.machineId !== input.machineId || capture.installationId !== member.installationId) continue;
      const target = item.content.target;
      if (target.kind === 'provider') continue;
      const observation = capture.observation;
      const provider = item.content.ingress?.provider ?? null;
      domains!.push({ domainId: item.domain.id, environmentId: item.domain.environmentId, installationId: capture.installationId,
        nativeServer: capture.nativeServer, hostname: item.content.hostname, targetService: target.service,
        targetPort: target.containerPort, provider, observedAtMs: item.domain.observedAtMs ?? null, observation,
        ...(observation.kind === 'ready' ? { state: 'ready', localOrigin: observation.localOrigin, fallback: observation.fallback } as const
          : { state: 'unavailable', reason: observation.reason } as const) });
      if (observation.kind !== 'ready') continue;
      // Neither a wildcard socket nor provider port requirements establish installed exposure.
      const publicIngress = capture.listener === 'public' && observation.listener === 'public'
        && saved?.kind === 'provider' && provider && accessProviderRefsEqualV1(saved.selection.provider, provider)
        && capability?.state === 'ready' && capability.exposure === 'public';
      for (const listener of observation.listeners) for (const endpoint of listener.endpoints) {
        const audience = endpoint.audience === 'loopback' ? 'thisMachine'
          : endpoint.audience === 'privateNetwork' ? 'privateNetwork'
            : publicIngress ? 'internet' : 'unknown';
        ports.push({ audience, hostAddress: null, port: endpoint.hostPort, protocol: endpoint.protocol, domainId: item.domain.id });
      }
    }
  }
  const domainIdsByService = new Map<string, Set<string>>();
  for (const domain of domains ?? []) {
    const key = JSON.stringify([domain.environmentId, domain.installationId, domain.targetService]);
    const ids = domainIdsByService.get(key) ?? new Set<string>();
    ids.add(domain.domainId);
    domainIdsByService.set(key, ids);
  }
  const services = input.services?.map(service => {
    const witness = service.deployment;
    const matched = witness && witness.service.machineId === input.machineId ? domainIdsByService.get(JSON.stringify([
      witness.service.environmentId, witness.installationId, witness.service.composeService])) : undefined;
    const bindings = service.configuration?.ports ?? null;
    for (const binding of bindings ?? []) {
      if (binding.published === undefined || binding.published === null) continue;
      const hostAddress = binding.bindAddress ?? null;
      ports.push({ ...classifyBinding(hostAddress), hostAddress, port: binding.published,
        protocol: binding.protocol ?? 'tcp', serviceId: service.serviceId });
    }
    return { service, bindings, domainIds: domains === null || service.environmentId !== input.domainEnvironmentId
      ? null : [...matched ?? []] };
  }) ?? null;
  return { domains, ports, services };
}
