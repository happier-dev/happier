import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import { MachineReachabilityObservationV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';

import { presentNetworkRowFacts, resolveMachineNetworkProviderTitle } from './networkSurface';
import { describeNetworkHeadline, describeNetworkRowSummary } from './useMachineNetworkLead';

describe('Network lead provider names', () => {
  it('does not describe unanswered service exposure as SSH only', () => {
    expect(describeNetworkHeadline({ kind: 'open', ports: [22], ssh: true, services: null }, 'shop-prod').detail)
      .toBeNull();
  });

  it('describes an admitted service exposure by its declared title', () => {
    expect(describeNetworkHeadline({ kind: 'open', ports: [443], ssh: false, services: resolveMachineNetworkProviderTitle({ kind: 'builtin', id: 'caddy' }) }, 'shop-prod').detail)
      .toBe('machineDetailPage.network.headlineServices(provider=Caddy)');
    expect(describeNetworkHeadline({ kind: 'open', ports: [443], ssh: false, services: null }, 'shop-prod').detail).toBeNull();
  });
});

describe('Network row summary on the Security tab', () => {
  const observed = { observed: true, sshClosed: false, firewall: null } as const;

  it('states what is open without naming the Machine again, with how its services are reached', () => {
    const caddy = resolveMachineNetworkProviderTitle({ kind: 'builtin', id: 'caddy' });
    expect(describeNetworkRowSummary({ ...observed, headline: { kind: 'open', ports: [22], ssh: true, services: caddy } }))
      .toBe('machineDetailPage.network.rowOpenOn(ports=22) · machineDetailPage.network.headlineSshAndServices(provider=Caddy)');
    expect(describeNetworkRowSummary({ ...observed, headline: { kind: 'open', ports: null, ssh: false, services: null } }))
      .toBe('machineDetailPage.network.rowOpen');
    expect(describeNetworkRowSummary({ ...observed, headline: { kind: 'closed', services: null } })).toBe('machineDetailPage.network.rowClosed');
  });

  it('keeps a Use grantee, who reads no Network facts, silent', () => {
    expect(describeNetworkRowSummary(null)).toBeUndefined();
  });

  it('says the Machine was not checked rather than staying silent when no observation exists', () => {
    expect(describeNetworkRowSummary({ observed: false, headline: null, sshClosed: false, firewall: null }))
      .toBe('machineDetailPage.network.rowNotChecked');
  });

  it('keeps an unknown exposure distinct from a closed SSH port', () => {
    expect(describeNetworkRowSummary({ ...observed, headline: null })).toBe('machineDetailPage.network.rowUnknown');
    expect(describeNetworkRowSummary({ ...observed, headline: null, sshClosed: true })).toBe('machineDetailPage.network.rowSshClosed');
  });

  it("adds Happier's observed firewall table, and says when it could not be read", () => {
    const open = { kind: 'open', ports: [22], ssh: true, services: null } as const;
    expect(describeNetworkRowSummary({ ...observed, headline: open, firewall: 'present' }))
      .toBe('machineDetailPage.network.rowOpenOn(ports=22) · machineDetailPage.network.rowFirewallOn');
    expect(describeNetworkRowSummary({ ...observed, headline: null, sshClosed: true, firewall: 'absent' }))
      .toBe('machineDetailPage.network.rowSshClosed · machineDetailPage.network.rowFirewallOff');
    expect(describeNetworkRowSummary({ ...observed, headline: null, firewall: 'unreadable' }))
      .toBe('machineDetailPage.network.rowUnknown · machineDetailPage.network.rowFirewallUnread');
  });
});

describe('Network row facts', () => {
  const observation = (publicSsh: 'open' | 'closed' | 'unknown', nativeFirewall?: unknown) =>
    MachineReachabilityObservationV1Schema.parse({ revision: 4,
      management: { daemon: 'ready', providers: [], publicSsh }, privateNetworks: [], ingress: [],
      ...(nativeFirewall ? { nativeFirewall } : {}) });
  const available = (ownedTable: 'present' | 'absent') => ({ status: 'available', ownedTable,
    externalInterfaces: ['eth0'], privateInterfaces: [], retainedSshEndpoints: [] });

  it('has nothing observed before the Machine publishes its reachability', () => {
    expect(presentNetworkRowFacts({ posture: null, selections: null, observation: null }))
      .toEqual({ observed: false, headline: null, sshClosed: false, firewall: null });
  });

  it("reads SSH and Happier's firewall table from the published observation", () => {
    expect(presentNetworkRowFacts({ posture: null, selections: null,
      observation: observation('closed', available('absent')) }))
      .toEqual({ observed: true, headline: null, sshClosed: true, firewall: 'absent' });
    expect(presentNetworkRowFacts({ posture: null, selections: null,
      observation: observation('unknown', { status: 'unavailable', requiredFact: 'nftables' }) }))
      .toEqual({ observed: true, headline: null, sshClosed: false, firewall: 'unreadable' });
    // An older Machine that publishes no firewall fact says nothing about it.
    expect(presentNetworkRowFacts({ posture: null, selections: null, observation: observation('unknown') }).firewall)
      .toBeNull();
  });
});

