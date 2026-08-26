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
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      environment: {},
      startOrigin: 'daemon',
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

  it('invokes a dynamic vendor-resume predicate only for the normalized experimental level', async () => {
    const predicate = vi.fn(() => true);
    const getPredicate = vi.fn(async () => predicate);
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
          getVendorResumeSupport: getPredicate,
        },
      },
    });

    const supported = await getVendorResumeSupport('acme.agent');
    expect(supported({})).toBe(true);
    expect(getPredicate).not.toHaveBeenCalled();

    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'malformed' as never,
          getVendorResumeSupport: getPredicate,
        },
      },
    });

    const malformed = await getVendorResumeSupport('acme.agent');
    expect(malformed({})).toBe(false);
    expect(getPredicate).not.toHaveBeenCalled();

    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'experimental',
          getVendorResumeSupport: getPredicate,
        },
      },
    });

    const experimental = await getVendorResumeSupport('acme.agent');
    expect(experimental({})).toBe(true);
    expect(getPredicate).toHaveBeenCalledOnce();
    expect(predicate).toHaveBeenCalledWith({});
  });
});
