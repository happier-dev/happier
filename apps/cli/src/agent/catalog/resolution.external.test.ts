import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import {
  isCatalogAgentId,
  resolveAgentCliSubcommand,
  resolveCatalogAgentId,
} from './resolution';

describe('external Agent catalog resolution', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme.agent', {
          id: 'acme.agent',
          identity: { pluginId: 'acme.plugin', localId: 'acme.agent' },
        }],
      ]),
      catalogEntriesById: {
        'acme.agent': {
          id: 'acme.agent',
          cliSubcommand: 'acme-agent',
        },
      },
    });
  });

  it('resolves an installed external Agent exactly through the active catalog projection', () => {
    expect(isCatalogAgentId('acme.agent')).toBe(true);
    expect(resolveCatalogAgentId('acme.agent')).toBe('acme.agent');
    expect(resolveAgentCliSubcommand('acme.agent')).toBe('acme-agent');
  });

  it('does not turn a missing external Agent into Claude', () => {
    expect(isCatalogAgentId('missing.agent')).toBe(false);
    expect(resolveCatalogAgentId('missing.agent')).toBeNull();
    expect(resolveAgentCliSubcommand('missing.agent')).toBeNull();
  });
});
