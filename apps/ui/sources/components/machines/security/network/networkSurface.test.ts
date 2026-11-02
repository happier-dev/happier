import { describe, expect, it } from 'vitest';
import {
  MachineReachabilityObservationV1Schema,
  MachineReachabilityPostureV1Schema,
  MachineReachabilityPlanV1Schema,
  MachineReachabilityConfigureInputV1Schema,
  MachineReachabilityInspectInputV1Schema,
  MachineIngressCapabilityV1Schema,
  getActionSpec,
} from '@happier-dev/protocol';
import { relayAccessProviderDescriptorsById } from '@happier-dev/cli-common/relayAccess/catalog';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { isAgentInitiatedApprovalRequiredByDefault } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import {
  presentMachineNetwork, presentNetworkHeadline, resolveMachineNetworkProviderTitle, buildNetworkConfigureInput, buildNetworkInspectInput,
  type MachineNetworkFacts,
} from './networkSurface';

const posture = MachineReachabilityPostureV1Schema.parse({
  revision: 3,
  management: { providers: [], publicSsh: { kind: 'closed' } },
  defaultServiceIngress: { kind: 'none' },
});
const observation = MachineReachabilityObservationV1Schema.parse({
  revision: 7,
  management: { daemon: 'ready', providers: [], publicSsh: 'unknown' },
  privateNetworks: [], ingress: [],
});
const absent: MachineNetworkFacts = { posture: null, selections: null, observation: null };
const facts: MachineNetworkFacts = { posture, selections: [], observation };

describe('M-P21E Network data preparation', () => {
  it('keeps an unanswered first read loading, distinguishes settled empty from failed', () => {
    expect(presentMachineNetwork({ facts: absent, read: { kind: 'pending' }, reachable: true }))
      .toMatchObject({ state: 'loading', privateNetworkState: 'loading' });
    expect(presentMachineNetwork({ facts, read: { kind: 'settled' }, reachable: true }))
      .toMatchObject({ state: 'ready', privateNetworkState: 'empty' });
    const failure = { ok: false as const, errorCode: 'machine_unavailable', error: 'unavailable',
      details: { machineId: 'controller-c', role: 'controller' } };
    expect(presentMachineNetwork({ facts: absent, read: { kind: 'failed', failure }, reachable: false }))
      .toMatchObject({ state: 'unavailable', privateNetworkState: 'unavailable', failure });
    // Offline demand cannot issue its first read; presence must settle the
    // cold surface instead of waiting for a response with no producer.
    expect(presentMachineNetwork({ facts: absent, read: { kind: 'unrequested' }, reachable: false }))
      .toMatchObject({ state: 'unavailable', privateNetworkState: 'unavailable', refreshing: false });
  });

  it('retains admitted content and unknown native SSH while refreshing and while offline', () => {
    const refreshing = presentMachineNetwork({ facts, read: { kind: 'pending' }, reachable: true });
    expect(refreshing).toMatchObject({ state: 'ready', refreshing: true, stale: false });
    expect(refreshing.facts).toBe(facts);
    const failure = { ok: false as const, errorCode: 'machine_unavailable', error: 'unavailable',
      details: { machineId: 'machine-a', role: 'target' } };
    const offline = presentMachineNetwork({ facts, read: { kind: 'failed', failure }, reachable: false });
    expect(offline).toMatchObject({ state: 'unavailable', stale: true, refreshing: false });
    expect(offline.facts.observation).toBe(observation);
    expect(offline.facts.observation?.management.publicSsh).toBe('unknown');
    expect(offline.failure).toBe(failure);
    expect(presentMachineNetwork({ facts, read: { kind: 'settled' }, reachable: null }).stale).toBe(true);
  });

  it('shows setup need only after a settled observation, without inventing a posture', () => {
    const result = presentMachineNetwork({ facts: { ...facts, posture: null }, read: { kind: 'settled' }, reachable: true });
    expect(result.state).toBe('needsSetup');
    expect(result.facts.posture).toBeNull();
  });

  it('preserves all producer ingress states, remedies, constraints and identity together', () => {
      const states = ['ready', 'needsSetup', 'needsAuth', 'conflict', 'unavailable', 'unknown'] as const;
      const ingress = states.map(state => MachineIngressCapabilityV1Schema.parse({
        revision: 8, provider: { kind: 'builtin', id: `fixture-${state}` },
        exposure: 'privateNetwork', inboundPorts: [], state,
        remedies: state === 'ready' ? [] : ['inspect'],
      }));
      const candidate = MachineReachabilityObservationV1Schema.parse({ ...observation, ingress });
      const result = presentMachineNetwork({ facts: { ...facts, observation: candidate }, read: { kind: 'settled' }, reachable: true });
      expect(result.facts.observation?.ingress).toBe(candidate.ingress);
      expect(result.facts.observation?.ingress.map(capability => capability.state)).toEqual(states);
  });

  it('retains private membership facts without projecting endpoint or firewall health', () => {
    const candidate = MachineReachabilityObservationV1Schema.parse({ ...observation, privateNetworks: [{
      provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'tailnet-a', displayName: 'Tailnet A',
      dnsName: 'machine-a.example.ts.net', addresses: ['100.64.1.2'], state: 'ready',
      interfaceName: null, sourceRanges: [], magicDnsEnabled: null,
    }] });
    const result = presentMachineNetwork({ facts: { ...facts, observation: candidate }, read: { kind: 'settled' }, reachable: true });
    expect(result.privateNetworkState).toBe('ready');
    expect(result.facts.observation).toBe(candidate);
    expect(result.facts.observation?.privateNetworks[0]?.interfaceName).toBeNull();
    expect(result.facts.observation?.management.publicSsh).toBe('unknown');
  });

  it('uses the exact reviewed target, owned field basis, change and digest for configure', () => {
    const plan = MachineReachabilityPlanV1Schema.parse({ reviewedPlanDigest: 'a'.repeat(64), basis: {
      machineId: 'machine-a', installationId: 'installation-a', currentSelections: [],
      currentPostureRevision: 2, change: { kind: 'posture', posture }, occurrences: [], recipePlans: [],
    } });
    const configured = buildNetworkConfigureInput('home-a', plan);
    expect(MachineReachabilityConfigureInputV1Schema.parse(configured)).toMatchObject({
      serverId: 'home-a', machineId: 'machine-a',
      change: plan.basis.change, reviewedPlanBasis: plan.basis, reviewedPlanDigest: plan.reviewedPlanDigest,
    });
    expect(configured.change).toBe(plan.basis.change);
    expect(configured.reviewedPlanBasis).toBe(plan.basis);
    expect(MachineReachabilityInspectInputV1Schema.parse(buildNetworkInspectInput(
      { serverId: 'home-a', machineId: 'machine-a' }, plan.basis.change,
    )).change).toEqual(plan.basis.change);
    for (const intent of ['join', 'leave'] as const) {
      const membership = MachineReachabilityPlanV1Schema.parse({ ...plan, basis: { ...plan.basis,
        change: { kind: 'privateNetwork', intent, selection: {
          provider: { pluginId: 'example.access', localId: 'private' },
          config: { managementUrl: 'https://network.example.test' }, credentialRefs: [],
        } },
      } });
      const input = buildNetworkConfigureInput('home-a', membership);
      expect(MachineReachabilityConfigureInputV1Schema.parse(input).change).toEqual(membership.basis.change);
      expect(input.change).toBe(membership.basis.change);
      expect(input.reviewedPlanBasis).toBe(membership.basis);
    }
  });

  describe('the headline', () => {
    const caddy = { provider: { kind: 'builtin' as const, id: 'caddy' }, config: {}, credentialRefs: [] };
    const tunnel = { provider: { kind: 'builtin' as const, id: 'cloudflareNamed' }, config: {}, credentialRefs: [] };
    const capability = (id: string, state: 'ready' | 'needsSetup' | 'conflict' | 'unknown', ports: number[]) => MachineIngressCapabilityV1Schema.parse({
      revision: 7, provider: { kind: 'builtin', id }, exposure: 'public', state, remedies: state === 'ready' ? [] : ['inspect'],
      inboundPorts: ports.map(port => ({ port, protocol: 'tcp', exposure: 'public' })),
    });
    const scene = (input: Readonly<{
      ssh: 'open' | 'closed' | 'unknown'; savedSsh?: boolean;
      ingress?: typeof caddy | null; capabilities?: ReturnType<typeof capability>[];
    }>): MachineNetworkFacts => ({
      posture: MachineReachabilityPostureV1Schema.parse({ ...posture, management: { ...posture.management,
        publicSsh: input.savedSsh === false ? { kind: 'closed' } : { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0'] } },
      defaultServiceIngress: input.ingress ? { kind: 'provider', selection: input.ingress } : { kind: 'none' } }),
      selections: [],
      observation: MachineReachabilityObservationV1Schema.parse({ ...observation,
        management: { ...observation.management, publicSsh: input.ssh }, ingress: input.capabilities ?? [] }),
    });

    it('does not promote saved SSH ports or ingress requirements to actual listener facts', () => {
      expect(presentNetworkHeadline(scene({ ssh: 'open', ingress: caddy,
        capabilities: [capability('caddy', 'ready', [443, 80]), capability('cloudflareNamed', 'ready', [])] })))
        .toEqual({ kind: 'open', ports: null, ssh: true, services: null });
      // SSH the Machine reports open on a port the posture does not name: open, with no invented port.
      expect(presentNetworkHeadline(scene({ ssh: 'open', savedSsh: false })))
        .toEqual({ kind: 'open', ports: null, ssh: true, services: null });
    });

    it('does not infer complete public closure or tunnel service exposure from SSH and capability state', () => {
      expect(presentNetworkHeadline(scene({ ssh: 'closed', savedSsh: false }))).toBeNull();
      expect(presentNetworkHeadline(scene({ ssh: 'closed', savedSsh: false, ingress: tunnel,
        capabilities: [capability('cloudflareNamed', 'ready', [])] }))).toBeNull();
      // A provider's setup state does not answer joined-service exposure.
      expect(presentNetworkHeadline(scene({ ssh: 'closed', ingress: caddy, capabilities: [capability('caddy', 'needsSetup', [80, 443])] })))
        .toBeNull();
    });

    it('keeps the factual headline without exposing an unavailable provider id', () => {
      const missing = { ...caddy, provider: { kind: 'builtin' as const, id: 'missing-internal-provider' } };
      expect(presentNetworkHeadline(scene({ ssh: 'closed', ingress: missing,
        capabilities: [capability('missing-internal-provider', 'ready', [443])] })))
        .toBeNull();
    });

    it('says nothing when a fact it needs is missing or unknown', () => {
      expect(presentNetworkHeadline(scene({ ssh: 'unknown', savedSsh: false }))).toBeNull();
      expect(presentNetworkHeadline(scene({ ssh: 'closed', ingress: caddy }))).toBeNull();
      expect(presentNetworkHeadline(scene({ ssh: 'open', ingress: caddy, capabilities: [capability('caddy', 'unknown', [80])] })))
        .toEqual({ kind: 'open', ports: null, ssh: true, services: null });
      expect(presentNetworkHeadline(scene({ ssh: 'open', ingress: caddy, capabilities: [capability('caddy', 'conflict', [80])] })))
        .toEqual({ kind: 'open', ports: null, ssh: true, services: null });
      expect(presentNetworkHeadline({ ...scene({ ssh: 'closed' }), posture: null })).toBeNull();
      expect(presentNetworkHeadline(absent)).toBeNull();
    });
  });

  it('uses a contributed title and its declared fallback, scoped to the exact plugin contribution', () => {
    const provider = { pluginId: 'example.network', localId: 'netbird' };
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
      accessProviders: { family: 'accessProviders', entriesById: {
        'example.network/netbird': { id: 'example.network/netbird', pluginId: 'example.network', pluginVersion: '1.0.0',
          definition: { ...relayAccessProviderDescriptorsById.tailscale.definition, id: 'netbird',
            title: { key: 'network.title', fallback: 'NetBird' },
            actions: { inspect: 'inspect', join: 'join', leave: 'leave' } },
        },
      } },
    } });
    const localize = createPluginLocalizedTextResolver({ projection: { ...normalizePluginUiProjection(null, 'web'), translationsByPluginId: {
      'example.network': { id: 'translations:example.network', pluginId: 'example.network', contributionKind: 'translations',
        locales: ['fr'], bundles: { fr: { 'network.title': 'Réseau NetBird' } } },
    } }, locale: 'fr' });
    expect(resolveMachineNetworkProviderTitle(provider, projection, localize)).toBe('Réseau NetBird');
    expect(resolveMachineNetworkProviderTitle(provider, projection,
      createPluginLocalizedTextResolver({ projection: null, locale: 'en' }))).toBe('NetBird');
    expect(resolveMachineNetworkProviderTitle({ ...provider, pluginId: 'other.network' }, projection, localize)).toBeNull();
    expect(resolveMachineNetworkProviderTitle({ kind: 'builtin', id: 'missing-internal-provider' })).toBeNull();
  });

  it('consumes the canonical safe inspect and danger Ask configure policies', () => {
    const inspect = getActionSpec('machines.reachability.inspect');
    const configure = getActionSpec('machines.reachability.configure');
    expect(inspect.sideEffectClass).toBe('read');
    expect(isAgentInitiatedApprovalRequiredByDefault(inspect.id)).toBe(false);
    expect(configure.safety).toBe('danger');
    expect(isAgentInitiatedApprovalRequiredByDefault(configure.id)).toBe(true);
    expect(configure.approvalScope).toBe('machine');
  });
});
