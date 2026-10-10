import { AgentsBackendsListOutputSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentBackendInventoryItems } from './buildAgentBackendInventoryItems';

describe('buildAgentBackendInventoryItems with the bundled catalog', () => {
  it('returns selectable catalog Agents that satisfy the strict Action output contract', async () => {
    const items = await buildAgentBackendInventoryItems({ includeDisabled: true,
      acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } });

    expect(AgentsBackendsListOutputSchema.parse({ items })).toEqual({ items });

    expect(items).toContainEqual(expect.objectContaining({
      agentId: 'antigravity',
      identity: { pluginId: 'happier.agent.antigravity', localId: 'antigravity' },
    }));
  });
});
