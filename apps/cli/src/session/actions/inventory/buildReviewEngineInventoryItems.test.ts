import { describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: registryMocks.getResolvedContributionRegistry,
}));

import { buildReviewEngineInventoryItems } from './buildReviewEngineInventoryItems';

describe('buildReviewEngineInventoryItems', () => {
  it('projects review engines from cold manifest Agents and profiles without executable runtimes', () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
            agentDefinitionsById: new Map([
        ['coderabbit', {
          id: 'coderabbit',
          definition: { id: 'coderabbit', title: 'CodeRabbit' },
          richDefinition: { definition: { id: 'coderabbit', title: 'CodeRabbit' } },
        }],
        ['deepsec', {
          id: 'deepsec',
          definition: { id: 'deepsec', title: 'DeepSec' },
          richDefinition: { definition: { id: 'deepsec', title: 'DeepSec' } },
        }],
      ]),
      executionRunProfiles: [
        { definition: { id: 'review', intent: 'review', compatibleAgents: ['coderabbit'] } },
        { definition: { id: 'security', intent: 'review', compatibleAgents: ['deepsec'] } },
      ],
    });

    expect(buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'coderabbit', value: 'coderabbit', label: 'CodeRabbit' }),
      expect.objectContaining({ engineId: 'deepsec', value: 'deepsec', label: 'DeepSec' }),
    ]);
  });
});
