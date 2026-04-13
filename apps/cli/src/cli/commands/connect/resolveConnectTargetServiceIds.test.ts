import { describe, expect, it, vi } from 'vitest';

vi.mock('@/extensions/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: () => ({
    providerDefinitionsById: new Map([
      ['plugin-target', { definition: { id: 'plugin-target', auth: { connectedServiceCompatibility: ['openai'] } } }],
      ['opencode', { definition: { id: 'opencode', core: { connectedServices: { supportedServiceIds: ['openai'] } } } }],
    ]),
    catalogEntriesById: {
      'plugin-target': {
        id: 'plugin-target',
        cliSubcommand: 'plugin-target',
        vendorResumeSupport: 'unsupported',
        getCloudConnectTarget: async () => ({
          id: 'plugin-target',
          displayName: 'Plugin Target',
          vendorDisplayName: 'Plugin Target',
          vendorKey: 'openai',
          status: 'wired',
          authenticate: async () => ({}),
        }),
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

  it('returns no service ids when the target is not connect-enabled', () => {
    expect(resolveConnectTargetServiceIds('opencode')).toEqual([]);
  });
});
