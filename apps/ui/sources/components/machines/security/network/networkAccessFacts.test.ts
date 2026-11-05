import { describe, expect, it } from 'vitest';
import { MachineReachabilityObservationV1Schema, MachineReachabilityPostureV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { buildNetworkConsoleConfirmationChange, projectMachineNetworkAccessFacts } from './networkAccessFacts';
import { presentNetworkHeadline } from './networkSurface';
import { relayAccessProviderDescriptorsById } from '@happier-dev/cli-common/relayAccess/catalog';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

const selection = { provider: { kind: 'builtin' as const, id: 'tailscale' }, config: { profileId: 'work' }, credentialRefs: [] };
const posture = MachineReachabilityPostureV1Schema.parse({ revision: 2,
  management: { providers: [], publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0'] } },
  defaultServiceIngress: { kind: 'none' },
});
const observation = MachineReachabilityObservationV1Schema.parse({ revision: 4,
  management: { daemon: 'ready', providers: [], publicSsh: 'open' }, privateNetworks: [], ingress: [],
  nativeFirewall: { status: 'available', ownedTable: 'present', externalInterfaces: ['eth0'], privateInterfaces: [],
    retainedSshEndpoints: [{ interfaceName: 'eth0', hostAddress: '192.0.2.3', port: 2205, sourceCidrs: ['198.51.100.0/24'] },
      { interfaceName: 'eth0', hostAddress: '2001:db8::3', port: 2222, sourceCidrs: ['2001:db8:1::/64'] }] },
});

describe('Network admitted access facts', () => {
  it('offers only retained Machine private-network selections for Join when native memberships are empty', () => {
    const network = { ...selection, config: {} };
    const ingress = { ...network, provider: { kind: 'builtin' as const, id: 'tailscaleServe' } };
    const missing = { ...network, provider: { kind: 'builtin' as const, id: 'missing-provider' } };
    const result = projectMachineNetworkAccessFacts({ posture, selections: [ingress, missing, network], observation });
    expect(result?.privateNetworks).toEqual([]);
    expect(result?.joinablePrivateNetworkSelections).toEqual([network]);
    expect(result?.joinablePrivateNetworkSelections?.[0]).toBe(network);
    expect(projectMachineNetworkAccessFacts({ posture, selections: [], observation })?.joinablePrivateNetworkSelections).toEqual([]);
    expect(projectMachineNetworkAccessFacts({ posture, selections: null, observation })?.joinablePrivateNetworkSelections).toBeNull();
  });

  it('uses the exact contributed catalog declaration for retained plugin Join choices without inferring membership', () => {
    const network = { ...selection, provider: { pluginId: 'example.network', localId: 'netbird' }, config: {} };
    const other = { ...network, provider: { ...network.provider, pluginId: 'other.network' } };
    const providerProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
      accessProviders: { family: 'accessProviders', entriesById: {
        'example.network/netbird': { id: 'example.network/netbird', pluginId: 'example.network', pluginVersion: '1.0.0',
          definition: { ...relayAccessProviderDescriptorsById.tailscale!.definition, id: 'netbird',
            actions: { inspect: 'inspect', join: 'join', leave: 'leave' } } },
      } },
    } });
    const input = { posture, selections: [other, network], observation };
    expect(projectMachineNetworkAccessFacts(input)?.joinablePrivateNetworkSelections).toEqual([]);
    const result = projectMachineNetworkAccessFacts({ ...input, accessProviders: providerProjection.familiesById.accessProviders });
    expect(result?.joinablePrivateNetworkSelections).toEqual([network]);
    expect(result?.joinablePrivateNetworkSelections?.[0]).toBe(network);
    expect(result?.privateNetworks).toEqual([]);
  });

  it('builds an explicit user-attested console confirmation for the existing review Action without changing access policy', () => {
    expect(buildNetworkConsoleConfirmationChange(posture, 1_793_610_000_000)).toEqual({ kind: 'posture',
      posture: { ...posture, management: { ...posture.management,
        independentRecovery: { kind: 'providerConsole', evidence: 'userAttested', confirmedAtMs: 1_793_610_000_000 } } } });
  });

  it('preserves every actual SSH endpoint and source rather than substituting the saved port', () => {
    const result = projectMachineNetworkAccessFacts({ posture, selections: [], observation });
    expect(result?.ssh).toEqual({ state: 'open', desired: posture.management.publicSsh,
      endpoints: observation.nativeFirewall?.status === 'available' ? observation.nativeFirewall.retainedSshEndpoints : null });
    expect(result?.ssh.endpoints?.map(endpoint => endpoint.port)).toEqual([2205, 2222]);
    expect(result?.ssh.desired).toBe(posture.management.publicSsh);
  });

  it('keeps missing native evidence unknown, and closed SSH distinct from a stale retained listener', () => {
    const { nativeFirewall: _nativeFirewall, ...withoutNative } = observation;
    expect(projectMachineNetworkAccessFacts({ posture, selections: [], observation: withoutNative })?.ssh.endpoints).toBeNull();
    expect(projectMachineNetworkAccessFacts({ posture, selections: [], observation: { ...observation,
      management: { ...observation.management, publicSsh: 'closed' } } })?.ssh).toMatchObject({ state: 'closed', endpoints: [] });
    expect(projectMachineNetworkAccessFacts({ posture, selections: [], observation: null })?.ssh)
      .toMatchObject({ state: 'unknown', endpoints: null });
    expect(projectMachineNetworkAccessFacts({ posture: null, selections: null, observation: null })).toBeNull();
  });

  it('joins native membership to only the retained Leave selection and keeps its actual on/auth/off states', () => {
    const privateNetworks = ['ready', 'needsAuth', 'stopped'].map((state, index) => ({
      provider: index === 0 ? selection.provider : { kind: 'builtin', id: `other-${index}` },
      networkIdentity: `network-${index}`, displayName: null, dnsName: null, addresses: [],
      state, interfaceName: null, sourceRanges: [], magicDnsEnabled: null,
    }));
    const native = MachineReachabilityObservationV1Schema.parse({ ...observation, privateNetworks });
    const result = projectMachineNetworkAccessFacts({ posture, selections: [selection], observation: native });
    expect(result?.privateNetworks?.map(entry => entry.network.state)).toEqual(['ready', 'needsAuth', 'stopped']);
    expect(result?.privateNetworks?.[0]?.selection).toBe(selection);
    expect(result?.privateNetworks?.[0]?.network).toBe(native.privateNetworks[0]);
    expect(result?.privateNetworks?.[1]?.selection).toBeNull();
    expect(projectMachineNetworkAccessFacts({ posture, selections: [], observation: native })?.privateNetworks?.[0]?.selection).toBeNull();
    expect(projectMachineNetworkAccessFacts({ posture, selections: [selection, { ...selection, config: { profileId: 'another' } }],
      observation: native })?.privateNetworks?.[0]?.selection).toBeNull();
  });

  it('selects the saved ingress with its truthful state and port requirements without asserting service exposure', () => {
    const saved = MachineReachabilityPostureV1Schema.parse({ ...posture,
      defaultServiceIngress: { kind: 'provider', selection: { ...selection, provider: { kind: 'builtin', id: 'caddy' } } } });
    const native = MachineReachabilityObservationV1Schema.parse({ ...observation, ingress: [
      { revision: 0, provider: selection.provider, state: 'ready', exposure: 'privateNetwork', inboundPorts: [], remedies: [] },
      { revision: 1, provider: { kind: 'builtin', id: 'caddy' }, state: 'needsSetup', exposure: 'public',
        inboundPorts: [{ port: 443, protocol: 'tcp', exposure: 'public' }], remedies: ['configure'] },
    ] });
    const result = projectMachineNetworkAccessFacts({ posture: saved, selections: [], observation: native });
    expect(result?.defaultIngress?.capability).toBe(native.ingress[1]);
    expect(result?.defaultIngress?.capability?.state).toBe('needsSetup');
    expect(result?.defaultIngress?.selection).toBe(saved.defaultServiceIngress.kind === 'provider' ? saved.defaultServiceIngress.selection : null);
    expect(projectMachineNetworkAccessFacts({ posture, selections: [], observation: native })?.defaultIngress)
      .toEqual({ selection: null, capability: null });
    expect(projectMachineNetworkAccessFacts({ posture: saved, selections: [], observation })?.defaultIngress?.capability).toBeNull();
  });

  it('uses native ports in the existing headline without promoting capability requirements or SSH closure to complete service exposure', () => {
    expect(presentNetworkHeadline({ posture, selections: [], observation }))
      .toEqual({ kind: 'open', ports: [2205, 2222], ssh: true, services: null });
    expect(presentNetworkHeadline({ posture, selections: [], observation: { ...observation,
      management: { ...observation.management, publicSsh: 'closed' } } })).toBeNull();
  });
});
