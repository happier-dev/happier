import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  MachineReachabilityObservationV1Schema,
  type MachineReachabilityObservationV1,
} from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { MachinePrivateNetworkObservationV1Schema } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { suggestFleetEdgeMachineId } from './fleetIngressSuggestion';

const network = MachinePrivateNetworkObservationV1Schema.parse({
  provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'team-network', displayName: null,
  dnsName: null, addresses: ['100.64.0.10'], state: 'ready', interfaceName: 'tailscale0',
  sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false,
});
const caddy: MachineReachabilityObservationV1['ingress'][number] = {
  revision: 0, provider: { kind: 'builtin', id: 'caddy' }, state: 'ready', remedies: [],
  exposure: 'public', inboundPorts: [{ port: 443, protocol: 'tcp', exposure: 'public' }],
  https: { hostname: 'custom', ports: [443], paths: true },
};
function machine(id: string, overrides: Partial<MachineReachabilityObservationV1> = {}) {
  return createMachineFixture({ id, installationId: `installation-${id}`, daemonState: { reachability: MachineReachabilityObservationV1Schema.parse({
    revision: 0, management: { daemon: 'ready', providers: [], publicSsh: 'unknown' },
    privateNetworks: [network], ingress: [], ...overrides,
  }) } });
}
const runtimes = ['runtime-a', 'runtime-b'];

describe('fleet ingress suggestion from published Machine observations', () => {
  it('suggests a public HTTPS Caddy edge sharing one ready network with every runtime', () => {
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), machine('runtime-b'), machine('edge', { ingress: [caddy] }),
    ], runtimes)).toBe('edge');
  });

  it.each([
    ['missing runtime', null],
    ['missing network', []],
    ['nonready network', [{ ...network, state: 'needsAuth' as const }]],
    ['different network', [{ ...network, networkIdentity: 'other-network' }]],
    ['unknown identity', [{ ...network, networkIdentity: null }]],
    ['different provider', [{ ...network, provider: { pluginId: 'example.network', localId: 'tailscale' } }]],
  ] as const)('leaves the route unselected for a %s', (_reason, privateNetworks) => {
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), ...(privateNetworks === null ? [] : [machine('runtime-b', { privateNetworks: [...privateNetworks] })]),
      machine('edge', { ingress: [caddy] }),
    ], runtimes)).toBeNull();
  });

  it('requires the same network across the whole fleet rather than pairwise overlaps', () => {
    const other = { ...network, networkIdentity: 'other-network' };
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), machine('runtime-b', { privateNetworks: [other] }),
      machine('edge', { ingress: [caddy], privateNetworks: [network, other] }),
    ], runtimes)).toBeNull();
  });

  it.each([
    { addresses: [] }, { interfaceName: null }, { sourceRanges: [] },
  ])('requires usable published network facts on runtimes and the edge', missingFact => {
    const incompleteNetwork = { ...network, ...missingFact };
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), machine('runtime-b', { privateNetworks: [incompleteNetwork] }),
      machine('edge', { ingress: [caddy] }),
    ], runtimes)).toBeNull();
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), machine('runtime-b'),
      machine('edge', { ingress: [caddy], privateNetworks: [incompleteNetwork] }),
    ], runtimes)).toBeNull();
  });

  it('suggests only an edge with a published installation to select', () => {
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), machine('runtime-b'),
      { ...machine('edge', { ingress: [caddy] }), installationId: null },
    ], runtimes)).toBeNull();
  });

  it.each([
    { ...caddy, state: 'needsSetup' as const, remedies: ['configure' as const] },
    { ...caddy, exposure: 'privateNetwork' as const },
    { ...caddy, https: undefined },
    { ...caddy, provider: { kind: 'builtin' as const, id: 'cloudflareNamed' } },
  ])('does not imply a public Caddy route from another ingress capability', (capability) => {
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), machine('runtime-b'), machine('edge', { ingress: [capability] }),
    ], runtimes)).toBeNull();
  });

  it('treats absent or malformed published observations as unchecked', () => {
    expect(suggestFleetEdgeMachineId([
      machine('runtime-a'), createMachineFixture({ id: 'runtime-b', daemonState: { reachability: { privateNetworks: [network] } } }),
      machine('edge', { ingress: [caddy] }),
    ], runtimes)).toBeNull();
    expect(suggestFleetEdgeMachineId([createMachineFixture({ id: 'edge' })], [])).toBeNull();
  });
});
