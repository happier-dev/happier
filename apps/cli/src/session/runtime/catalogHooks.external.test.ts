import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import {
  getVendorResumeSupport,
  resolveProviderSessionRuntimePreferences,
} from './catalogHooks';

describe('external session runtime catalog hooks', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
          // An external catalog entry must not be interpreted using a bundled
          // Agent's experimental resume policy.
          vendorResumeSupport: 'experimental',
          resolveSessionRuntimePreferences: () => ({ source: 'acme' }),
        },
      },
    });
  });

  it('fails closed for an external experimental entry with no catalog-owned resume hook', async () => {
    const supportsResume = await getVendorResumeSupport('acme.agent');

    expect(supportsResume({})).toBe(false);
    await expect(resolveProviderSessionRuntimePreferences('acme.agent', {
      settings: {},
      processEnv: {},
      startedBy: 'daemon',
    })).resolves.toEqual({ source: 'acme' });

    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });

    const supportsResumeAfterCatalogReplacement = await getVendorResumeSupport('acme.agent');
    expect(supportsResumeAfterCatalogReplacement({})).toBe(true);
  });
});
