import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import { deploymentDomainAttention, deploymentDomainNeedKind } from './deploymentDomainAttention';

const dnsHealth = (reason: string, status: 'up' | 'down' | 'unknown' = 'down') => ({ status,
  cause: { kind: 'dns' as const, reason, observerMachineId: 'machine', vantage: 'sameMachine' as const },
  evidence: { v: 1 as const,
  items: [{ source: { kind: 'alert' as const, label: 'DNS' }, author: { kind: 'process' as const },
    text: 'DNS finite observation' }] } });
const health = (cause: 'dns' | 'network' | 'certificate' | 'http') => ({ availability: 'observed' as const,
  unavailableReason: null, observedAt: 1, vantage: 'outside' as const,
  certificate: { state: 'valid' as const, expiresAt: null }, needsYou: { cause, reason: cause, vantage: 'outside' as const } });

describe('deploymentDomainAttention', () => {
  it.each([
    ['removing', 'neutral', 'projects.deployments.domainStateRemoving'],
    ['failed', 'danger', 'projects.deployments.domainStateFailed'],
    ['outcome_unknown', 'attention', 'projects.deployments.stateUnknown'],
    ['cancelled', 'attention', 'projects.deployments.stateCancelled'],
  ] as const)('keeps an unattached Domain operation observable (%s)', (lifecycle, variant, label) => {
    expect(deploymentDomainAttention({ domain: { dnsHealth: undefined }, health: undefined }, lifecycle, false))
      .toEqual({ variant, label: t(label) });
  });
  it('labels a retained Domain unattached without treating its old health as a current need', () => {
    const item = { domain: { dnsHealth: dnsHealth('dns_missing') }, health: health('network') };
    expect(deploymentDomainAttention(item, 'warning', false)).toMatchObject({ variant: 'neutral', label: 'Unattached', checkAgain: false });
    expect(deploymentDomainNeedKind(item, false)).toBeNull();
  });
  it('explains an unknown DNS warning with its typed reason without claiming failed reachability', () => {
    const item = { domain: { dnsHealth: dnsHealth('resolver_unavailable', 'unknown') }, health: undefined };
    expect(deploymentDomainAttention(item, 'warning', true)).toMatchObject({ variant: 'attention',
      label: expect.stringContaining('resolver_unavailable') });
    expect(deploymentDomainNeedKind(item, true)).toBeNull();
    expect(deploymentDomainAttention({ domain: { dnsHealth: dnsHealth('not_checked', 'unknown') }, health: undefined }, 'active', true)).toBeNull();
    expect(deploymentDomainAttention({ domain: { dnsHealth: dnsHealth('dns_ready', 'up') }, health: undefined }, 'active', true)).toBeNull();
  });
});

describe('deploymentDomainNeedKind (the Services count line)', () => {
  it('names an address still waiting for its DNS record, one that does not answer, and stays quiet otherwise', () => {
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: dnsHealth('dns_missing') }, health: undefined }, true)).toBe('waitingForDns');
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: health('network') }, true)).toBe('notReachable');
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: health('http') }, true)).toBe('notReachable');
    // A certificate about to expire needs the person, but the address still answers.
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: health('certificate') }, true)).toBeNull();
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: undefined }, true)).toBeNull();
  });
});
