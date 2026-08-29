import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  builtIn: { marker: 'built-in' },
  active: null as null | { contributes: { marker: string } },
  current: false,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: () => mocks.builtIn,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({ activeRegistry: mocks.active }),
    isRuntimeRegistryCurrent: () => mocks.current,
  },
}));

import { readCurrentContributionRegistry } from './snapshot';

describe('readCurrentContributionRegistry', () => {
  it('reads the current active generation and never serves a retired retained generation', () => {
    const first = { contributes: { marker: 'external-generation-1' } };
    const next = { contributes: { marker: 'external-generation-2' } };

    mocks.active = first;
    mocks.current = true;
    expect(readCurrentContributionRegistry()).toBe(first.contributes);

    mocks.current = false;
    expect(readCurrentContributionRegistry()).toBe(mocks.builtIn);

    mocks.active = next;
    mocks.current = true;
    expect(readCurrentContributionRegistry()).toBe(next.contributes);
  });
});
