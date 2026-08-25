import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentToolsDelivery } from './resolveAgentToolsDelivery';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

describe('resolveAgentToolsDelivery', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'com.acme.review/review': {
          id: 'com.acme.review/review',
          cliSubcommand: 'acme-review',
          toolDelivery: 'native_mcp',
        },
        pi: {
          id: 'pi',
          cliSubcommand: 'pi',
          toolDelivery: 'native_extension',
        },
        cursor: {
          id: 'cursor',
          cliSubcommand: 'cursor',
          toolDelivery: 'shell_bridge',
        },
        claude: {
          id: 'claude',
          cliSubcommand: 'claude',
        },
      },
    });
  });

  it('reads the declared delivery for installed and bundled catalog entries', () => {
    expect(resolveAgentToolsDelivery('com.acme.review/review')).toBe('native_mcp');
    expect(resolveAgentToolsDelivery('pi')).toBe('native_extension');
    expect(resolveAgentToolsDelivery('cursor')).toBe('shell_bridge');
  });

  it('fails closed when an entry has no declaration or no exact catalog entry', () => {
    // An Agent identity alone is not tool-delivery authority, even for a
    // familiar bundled id. The catalog fact is the only input to this resolver.
    expect(resolveAgentToolsDelivery('claude')).toBe('unsupported');
    expect(resolveAgentToolsDelivery('customAcp')).toBe('unsupported');
    expect(resolveAgentToolsDelivery('custom-acp')).toBe('unsupported');
    expect(resolveAgentToolsDelivery('acp:review-bot')).toBe('unsupported');
  });
});
