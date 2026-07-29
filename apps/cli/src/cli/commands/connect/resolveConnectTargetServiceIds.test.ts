import { describe, expect, it, vi } from 'vitest';

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: () => ({
    agentDefinitionsById: new Map([
      ['plugin-target', { definition: { id: 'plugin-target', auth: { connectedServiceCompatibility: ['openai'] } } }],
      ['opencode', { definition: { id: 'opencode', core: { connectedServices: { supportedServiceIds: ['openai'] } } } }],
    ]),
    catalogEntriesById: {
      'plugin-target': {
        id: 'plugin-target',
        cliSubcommand: 'plugin-target',
        vendorResumeSupport: 'unsupported',
      },
      opencode: {
        id: 'opencode',
        cliSubcommand: 'opencode',
        vendorResumeSupport: 'unsupported',
      },
    },
  }),
}));

import { resolveConnectTargetServiceIds } from './resolveConnectTargetServiceIds';

describe('resolveConnectTargetServiceIds', () => {
  it('returns no service ids for unknown targets', () => {
    expect(resolveConnectTargetServiceIds('unknown-target')).toEqual([]);
  });

  it('reads connected service compatibility from registry-backed provider definitions', () => {
    expect(resolveConnectTargetServiceIds('plugin-target')).toEqual(['openai']);
  });

  it('does not require the retired cloud-connect catalog hook', () => {
    expect(resolveConnectTargetServiceIds('opencode')).toEqual(['openai']);
  });
});
