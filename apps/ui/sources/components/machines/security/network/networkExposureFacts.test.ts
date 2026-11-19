import { describe, expect, it } from 'vitest';
import { MachineServiceRowV1Schema } from '@happier-dev/protocol';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { projectMachineNetworkExposureFacts } from './networkExposureFacts';
import { presentNetworkHeadline, resolveMachineNetworkProviderTitle, type MachineNetworkFacts } from './networkSurface';

const provider = { kind: 'builtin', id: 'caddy' } as const;
const selection = { provider, config: {}, credentialRefs: [] };
const facts: MachineNetworkFacts = { selections: [], posture: { revision: 1,
  management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'provider', selection } },
  observation: { revision: 1, management: { daemon: 'ready', providers: [], publicSsh: 'closed' }, privateNetworks: [],
    ingress: [{ revision: 1, provider, state: 'ready', exposure: 'public', inboundPorts: [{ port: 80, protocol: 'tcp', exposure: 'public' }], remedies: [] }] } };
const environment = createDeploymentEnvironmentHeaderV1();
const runtimeTargetLink = createDeploymentTargetLinkHeaderV1();
const environments = [{ environment, runtimeTargetLink, title: 'Shop', chip: null }];
const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'shop', environmentId: environment.id, targetLinkId: runtimeTargetLink.id,
  revision: 1, state: 'active', contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
  createdByAccountId: 'owner', observedAtMs: 700, createdAtMs: 1, updatedAtMs: 700,
  networkExposure: [{ machineId: 'machine-a', installationId: 'installation-a', nativeServer: 'https', listener: 'public',
    observation: { kind: 'ready', listener: 'public', localOrigin: true, fallback: false,
      listeners: [{ tls: true, automaticHttpsDisabled: false,
        endpoints: [{ audience: 'wildcard', hostPort: 9443, containerPort: 8443, protocol: 'tcp' }] }] } }] });
const content = DeploymentDomainContentV1Schema.parse({ hostname: 'shop.example.test', target: { service: 'web', containerPort: 8080 },
  healthCheck: { path: '/', expectStatus: 200 }, ingress: selection });
const row = MachineServiceRowV1Schema.parse({ serviceId: 'shop/web', name: 'Web', authority: 'project', lifecyclePurpose: 'deployment',
  environmentId: environment.id, generation: 'g', state: 'running',
  capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
  configuration: { ports: [{ target: 8080, published: '49153', bindAddress: '0.0.0.0', protocol: 'tcp' }] },
  deployment: { deploymentId: 'deployment-a', installationId: 'installation-a', service: { kind: 'deployment',
    machineId: 'machine-a', environmentId: environment.id, environmentInstanceId: 'shop', composeService: 'web', serviceId: 'shop/web' } } });
const input = { machineId: 'machine-a', facts, environments, domains: [{ domain, content, title: 'Shop domain' }],
  domainEnvironmentId: environment.id, services: [row] };

describe('Network joins admitted service, membership and installed Domain facts', () => {
  it('uses actual public listener ports, retains observation provenance and joins services by their deployment witness', () => {
    const exposure = projectMachineNetworkExposureFacts(input);
    expect(exposure).toMatchObject({ domains: [{ domainId: 'shop', observedAtMs: 700, localOrigin: true, fallback: false }],
      ports: expect.arrayContaining([{ audience: 'internet', port: 9443, hostAddress: null, protocol: 'tcp', domainId: 'shop' }]),
      services: [{ service: row, domainIds: ['shop'], bindings: row.configuration?.ports }] });
    expect(presentNetworkHeadline({ ...facts, exposure }, resolveMachineNetworkProviderTitle))
      .toEqual({ kind: 'open', ports: [9443], ssh: false, services: resolveMachineNetworkProviderTitle(provider) });
  });

  it('does not promote wildcard bindings, capability requirements or an old installation to Internet exposure', () => {
    expect(projectMachineNetworkExposureFacts({ ...input, domains: [] })).toMatchObject({ domains: [],
      ports: [{ audience: 'unknown', port: '49153' }] });
    const replacement = { ...runtimeTargetLink, members: [{ ...runtimeTargetLink.members[0]!, installationId: 'replacement' }] };
    const exposure = projectMachineNetworkExposureFacts({ ...input, environments: [{ ...environments[0]!, runtimeTargetLink: replacement }] });
    expect(exposure).toMatchObject({ domains: [], services: [{ domainIds: [] }] });
    expect(presentNetworkHeadline({ ...facts, exposure }, resolveMachineNetworkProviderTitle)).toBeNull();
    expect(projectMachineNetworkExposureFacts({ ...input, services: [{ ...row, deployment: undefined }] }))
      .toMatchObject({ services: [{ domainIds: [] }] });
    expect(projectMachineNetworkExposureFacts({ ...input, domainEnvironmentId: 'unread-environment', domains: [] }))
      .toMatchObject({ services: [{ domainIds: null }] });
  });

  it('skips provider domains because they do not publish a native service target', () => {
    const providerContent = DeploymentDomainContentV1Schema.parse({
      hostname: 'shop.example.test',
      target: { kind: 'provider', zone: { zoneId: 'zone', name: 'example.test' } },
      ingress: selection,
    });
    expect(projectMachineNetworkExposureFacts({ ...input, domains: [{ ...input.domains[0]!, content: providerContent }] }))
      .toMatchObject({ domains: [], services: [{ domainIds: [] }] });
  });

  it('retains telemetry Domain exposure without inventing a workload service or port', () => {
    const telemetryContent = DeploymentDomainContentV1Schema.parse({
      hostname: 'collector.example.test', target: { kind: 'telemetry' }, ingress: selection,
    });
    expect(projectMachineNetworkExposureFacts({ ...input, domains: [{ domain, content: telemetryContent, title: 'Collector domain' }] }))
      .toMatchObject({ domains: [{ targetService: null, targetPort: null }], services: [{ domainIds: [] }],
        ports: expect.arrayContaining([expect.objectContaining({ domainId: 'shop', port: 9443 })]) });
  });

  it('retains unavailable and fallback observations without turning local-origin or desired policy into public reachability', () => {
    const unavailable = { ...domain, networkExposure: domain.networkExposure!.map(entry => ({ ...entry,
      observation: { kind: 'unavailable' as const, reason: 'route_absent' } })) };
    expect(projectMachineNetworkExposureFacts({ ...input, domains: [{ ...input.domains[0]!, domain: unavailable }] }))
      .toMatchObject({ domains: [{ state: 'unavailable', reason: 'route_absent' }], ports: [{ audience: 'unknown' }] });
    const privateDomain = { ...domain, networkExposure: domain.networkExposure!.map(entry => ({ ...entry, listener: 'privateOrigin' as const,
      observation: { kind: 'ready' as const, listener: 'privateOrigin' as const, localOrigin: false, fallback: true,
        listeners: [{ tls: false, automaticHttpsDisabled: true,
          endpoints: [{ audience: 'loopback' as const, hostPort: 8081, containerPort: 8080, protocol: 'tcp' as const }] }] } })) };
    const exposure = projectMachineNetworkExposureFacts({ ...input, domains: [{ ...input.domains[0]!, domain: privateDomain }] });
    expect(exposure).toMatchObject({ domains: [{ localOrigin: false, fallback: true }],
      ports: expect.arrayContaining([expect.objectContaining({ audience: 'thisMachine', port: 8081 })]) });
    expect(presentNetworkHeadline({ ...facts, exposure }, resolveMachineNetworkProviderTitle)).toBeNull();
  });

  it('reports exact ready private addresses and literal loopback bindings without promoting a stopped network', () => {
    const network = { provider: { kind: 'builtin' as const, id: 'tailscale' }, networkIdentity: 'work', displayName: null,
      dnsName: null, addresses: ['100.64.1.2'], state: 'ready' as const, interfaceName: null, sourceRanges: [], magicDnsEnabled: null };
    const services = [{ ...row, configuration: { ports: [
      { target: 8080, published: '49153', bindAddress: '100.64.1.2', protocol: 'tcp' as const },
      { target: 9090, published: '49154', bindAddress: '::1', protocol: 'udp' as const },
    ] } }];
    const privateFacts = { ...facts, observation: { ...facts.observation!, privateNetworks: [network] } };
    expect(projectMachineNetworkExposureFacts({ ...input, facts: privateFacts, domains: [], services })).toMatchObject({
      ports: [{ audience: 'privateNetwork', networkIdentity: 'work', port: '49153' }, { audience: 'thisMachine', port: '49154', protocol: 'udp' }] });
    expect(projectMachineNetworkExposureFacts({ ...input, domains: [], services,
      facts: { ...privateFacts, observation: { ...privateFacts.observation, privateNetworks: [{ ...network, state: 'stopped' }] } } }))
      .toMatchObject({ ports: [{ audience: 'unknown' }, { audience: 'thisMachine' }] });
  });

  it('does not turn an unpublished service port into a host listener', () => {
    const unpublished = MachineServiceRowV1Schema.parse({ ...row, configuration: { ports: [
      { target: 8080, published: null, bindAddress: null, protocol: null },
    ] } });
    expect(projectMachineNetworkExposureFacts({ ...input, domains: [], services: [unpublished] }).ports).toEqual([]);
  });

  it('retains SSH source restrictions alongside service ports in the same audience projection', () => {
    const sshFacts = { ...facts, observation: { ...facts.observation!, management: { ...facts.observation!.management, publicSsh: 'open' as const },
      nativeFirewall: { status: 'available' as const, ownedTable: 'present' as const, externalInterfaces: ['eth0'], privateInterfaces: [],
        retainedSshEndpoints: [{ interfaceName: 'eth0', hostAddress: '192.0.2.1', port: 2205, sourceCidrs: ['198.51.100.0/24'] }] } } };
    const exposure = projectMachineNetworkExposureFacts({ ...input, facts: sshFacts });
    expect(exposure.ports).toEqual(expect.arrayContaining([expect.objectContaining({ audience: 'internet', port: 2205,
      hostAddress: '192.0.2.1', sourceCidrs: ['198.51.100.0/24'], interfaceName: 'eth0' })]));
    expect(presentNetworkHeadline({ ...sshFacts, exposure }, resolveMachineNetworkProviderTitle))
      .toEqual({ kind: 'open', ports: [2205, 9443], ssh: true, services: resolveMachineNetworkProviderTitle(provider) });
  });
});
