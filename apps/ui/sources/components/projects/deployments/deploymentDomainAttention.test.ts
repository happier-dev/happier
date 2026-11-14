import { describe, expect, it } from 'vitest';

import { deploymentDomainNeedKind } from './deploymentDomainAttention';

const dnsHealth = (reason: string) => ({ status: 'down' as const, evidence: { v: 1 as const,
  items: [{ source: { kind: 'alert' as const, label: 'DNS' }, author: { kind: 'process' as const },
    text: JSON.stringify({ kind: 'dns', reason }) }] } });
const health = (cause: 'dns' | 'network' | 'certificate' | 'http') => ({ availability: 'observed' as const,
  unavailableReason: null, observedAt: 1, vantage: 'outside' as const,
  certificate: { state: 'valid' as const, expiresAt: null }, needsYou: { cause, reason: cause, vantage: 'outside' as const } });

describe('deploymentDomainNeedKind (the Services count line)', () => {
  it('names an address still waiting for its DNS record, one that does not answer, and stays quiet otherwise', () => {
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: dnsHealth('dns_missing') }, health: undefined })).toBe('waitingForDns');
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: health('network') })).toBe('notReachable');
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: health('http') })).toBe('notReachable');
    // A certificate about to expire needs the person, but the address still answers.
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: health('certificate') })).toBeNull();
    expect(deploymentDomainNeedKind({ domain: { dnsHealth: undefined }, health: undefined })).toBeNull();
  });
});
