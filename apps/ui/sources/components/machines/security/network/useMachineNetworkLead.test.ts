import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import { resolveMachineNetworkProviderTitle } from './networkSurface';
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
  it('states what is open without naming the Machine again, with how its services are reached', () => {
    const caddy = resolveMachineNetworkProviderTitle({ kind: 'builtin', id: 'caddy' });
    expect(describeNetworkRowSummary({ kind: 'open', ports: [22], ssh: true, services: caddy }))
      .toBe('machineDetailPage.network.rowOpenOn(ports=22) · machineDetailPage.network.headlineSshAndServices(provider=Caddy)');
    expect(describeNetworkRowSummary({ kind: 'open', ports: null, ssh: false, services: null })).toBe('machineDetailPage.network.rowOpen');
    expect(describeNetworkRowSummary({ kind: 'closed', services: null })).toBe('machineDetailPage.network.rowClosed');
    expect(describeNetworkRowSummary(null)).toBeUndefined();
  });
});

