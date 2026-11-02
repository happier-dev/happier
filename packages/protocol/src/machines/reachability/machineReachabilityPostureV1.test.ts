import { describe, expect, it } from 'vitest';
import { PublicActionIdSchema } from '../../actions/actionSpecs.js';
import { MachineIngressCapabilityV1Schema, MachineReachabilityObservationV1Schema, MachineReachabilityPostureV1Schema } from './machineReachabilityPostureV1.js';
import { MachineReachabilityPlanBasisV1Schema } from './actionsV1.js';

describe('Machine ingress and demanded private-network contracts', () => {
  it('retains explicit recovery confirmation through the reviewed posture and accepts older undated recovery', () => {
    const recovery = { kind: 'providerConsole', evidence: 'userAttested', confirmedAtMs: 1_793_610_000_000 };
    const posture = { revision: 2, management: { providers: [], publicSsh: { kind: 'closed' }, independentRecovery: recovery },
      defaultServiceIngress: { kind: 'none' } };
    expect(MachineReachabilityPostureV1Schema.parse(posture)).toEqual(posture);
    const basis = { machineId: 'machine', installationId: 'installation', currentPostureRevision: 1,
      currentSelections: [], change: { kind: 'posture', posture }, occurrences: [], recipePlans: [] };
    expect(MachineReachabilityPlanBasisV1Schema.parse(JSON.parse(JSON.stringify(basis)))).toEqual(basis);
    const { confirmedAtMs: _date, ...undated } = recovery;
    expect(MachineReachabilityPostureV1Schema.parse({ ...posture,
      management: { ...posture.management, independentRecovery: undated } }).management.independentRecovery).toEqual(undated);
  });

  it('admits reachability through the original terminal public Action boundary', () => {
    for (const actionId of ['machines.reachability.inspect', 'machines.reachability.configure']) {
      expect(PublicActionIdSchema.safeParse(actionId).success).toBe(true);
    }
  });

  it('retains the observed builtin native profile as closed nonsecret parent-review evidence', () => {
    const provider = { kind: 'builtin', id: 'tailscale' };
    const selection = { provider, config: {}, credentialRefs: [] };
    const basis: unknown = { machineId: 'machine', installationId: 'installation', currentPostureRevision: null,
      currentSelections: [], change: { kind: 'privateNetwork', intent: 'join', selection }, occurrences: [], recipePlans: [],
      nativeProfiles: [{ provider, profileId: 'actual-selected-profile', networkIdentity: 'example.ts.net' }] };
    const parsed = MachineReachabilityPlanBasisV1Schema.safeParse(basis);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(basis);
    const nativeProfile = { provider, profileId: 'actual-selected-profile', networkIdentity: 'example.ts.net' };
    for (const invalid of [
      { ...nativeProfile, token: 'must-not-enter-review' },
      { ...nativeProfile, provider: { pluginId: 'not-a-builtin', localId: 'profile' } },
    ]) {
      expect(MachineReachabilityPlanBasisV1Schema.safeParse({ ...parsed.data, nativeProfiles: [invalid] }).success).toBe(false);
    }
  });

  const provider = { pluginId: 'example.network', localId: 'network' };
  const capability = {
    revision: 3, provider, exposure: 'privateNetwork', inboundPorts: [],
    https: { hostname: 'providerAssigned', ports: [443], paths: true },
    state: 'needsAuth', remedies: ['authenticate'],
  };
  const network = {
    provider, networkIdentity: 'selected-network', displayName: 'Selected network',
    dnsName: null, addresses: ['100.91.0.2'], state: 'ready', interfaceName: 'observed-network',
    sourceRanges: ['100.91.0.0/16', 'fd00:91::/48'], magicDnsEnabled: null,
  };
  const observation = {
    revision: 3, management: { daemon: 'ready', providers: [], publicSsh: 'unknown' },
    privateNetworks: [network], ingress: [],
  };

  it('carries a stable actionable remedy without accepting an open ingress envelope', () => {
    expect(MachineIngressCapabilityV1Schema.safeParse(capability).success).toBe(true);
    expect(MachineIngressCapabilityV1Schema.safeParse({ ...capability, remedies: ['runShell'] }).success).toBe(false);
    expect(MachineIngressCapabilityV1Schema.safeParse({ ...capability, provider: 'example.network/network' }).success).toBe(false);
    expect(MachineIngressCapabilityV1Schema.safeParse({ ...capability, provider: { ...provider, token: 'raw' } }).success).toBe(false);
    expect(MachineIngressCapabilityV1Schema.safeParse({ ...capability, https: { ...capability.https, arbitrary: true } }).success).toBe(false);
    expect(MachineIngressCapabilityV1Schema.safeParse({ ...capability, state: 'ready', remedies: ['authenticate'] }).success).toBe(false);
    expect(MachineIngressCapabilityV1Schema.safeParse({ ...capability, remedies: [] }).success).toBe(false);
  });

  it('carries native IPv4/IPv6 ranges, never Caddy matcher aliases or arbitrary strings', () => {
    expect(MachineReachabilityObservationV1Schema.safeParse(observation).success).toBe(true);
    for (const sourceRanges of [['private_ranges'], ['*'], ['100.91.0.0/33'], ['fd00:91::/129']]) {
      expect(MachineReachabilityObservationV1Schema.safeParse({
        ...observation, privateNetworks: [{ ...network, sourceRanges }],
      }).success).toBe(false);
    }
    expect(MachineReachabilityObservationV1Schema.safeParse({ ...observation, privateNetworks: [] }).success).toBe(true);
    expect(MachineReachabilityObservationV1Schema.safeParse({
      ...observation, privateNetworks: [{ ...network, state: 'unknown', interfaceName: null, sourceRanges: [] }],
    }).success).toBe(true);
  });
});
