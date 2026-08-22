import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readAgentCatalogSnapshot,
  listConfiguredAcpBackendsFromAccountSettingsOrPlugins,
} = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
  listConfiguredAcpBackendsFromAccountSettingsOrPlugins: vi.fn(async () => []),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

vi.mock('@/agent/acp/catalog/configured/resolveBackend', () => ({
  listConfiguredAcpBackendsFromAccountSettingsOrPlugins,
}));

import { buildAgentBackendInventoryItems } from './buildAgentBackendInventoryItems';

describe('buildAgentBackendInventoryItems', () => {
  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme-agent', {
          id: 'acme-agent',
          richDefinition: { definition: { title: 'Acme Agent' } },
          runtimeSpec: null,
        }],
      ]),
      catalogEntriesById: {
        'acme-agent': {
          id: 'acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
    listConfiguredAcpBackendsFromAccountSettingsOrPlugins.mockResolvedValue([]);
  });

  it('lists only active catalog Agents, including a no-CLI external Session Agent', async () => {
    await expect(buildAgentBackendInventoryItems({ includeDisabled: true })).resolves.toEqual([{
      targetKey: buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: 'acme-agent',
        sourceKind: 'built_in',
      }),
      label: 'Acme Agent',
      enabled: true,
      agentId: 'acme-agent',
    }]);
  });
});
