import { describe, expect, it } from 'vitest';

import { BUILT_IN_CATALOG_DEFINED_ACP_AGENTS } from '@/agent/acp/catalog';
import { requireCatalogEntry } from '@/backends/catalog';

describe('Grok backend catalog entry', () => {
  it('is a direct first-class ACP provider and not a generic built-in ACP entry', async () => {
    expect(BUILT_IN_CATALOG_DEFINED_ACP_AGENTS).not.toHaveProperty('grok');
    const entry = requireCatalogEntry('grok');
    expect(entry.id).toBe('grok');
    expect(entry.getCliCommandHandler).toBeTypeOf('function');
    expect(entry.getCliDetect).toBeTypeOf('function');
    expect(entry.getCliAuthSpec).toBeTypeOf('function');
    expect(entry.getCliCapabilityOverride).toBeTypeOf('function');
    expect(entry.getAcpBackendFactory).toBeTypeOf('function');
    await expect(entry.getCliCapabilityOverride?.()).resolves.toMatchObject({
      descriptor: {
        id: 'cli.grok',
        kind: 'cli',
        title: 'Grok Build CLI',
      },
      detect: expect.any(Function),
    });
    expect(await entry.getAcpBackendFactory?.()).toBeTypeOf('function');
  });
});
