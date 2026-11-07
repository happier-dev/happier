import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import { resolveMachineNetworkProviderTitle } from './networkSurface';
import { describeNetworkHeadline } from './useMachineNetworkLead';

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
