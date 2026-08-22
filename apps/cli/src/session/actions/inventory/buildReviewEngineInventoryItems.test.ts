import { beforeEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(),
  getReloadState: vi.fn<() => { activeRegistry: object | null }>(() => ({ activeRegistry: null })),
  isRuntimeRegistryCurrent: vi.fn(() => true),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: registryMocks.getResolvedContributionRegistry,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: registryMocks.getReloadState,
    isRuntimeRegistryCurrent: registryMocks.isRuntimeRegistryCurrent,
  },
}));

import { buildReviewEngineInventoryItems } from './buildReviewEngineInventoryItems';

describe('buildReviewEngineInventoryItems', () => {
  beforeEach(() => {
    registryMocks.getReloadState.mockReturnValue({ activeRegistry: null });
    registryMocks.isRuntimeRegistryCurrent.mockReturnValue(true);
  });

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

  it('labels an installed external review Agent with its own declared title', () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme.reviewer', {
          id: 'acme.reviewer',
          identity: { pluginId: 'acme', localId: 'acme.reviewer' },
          definition: { id: 'acme.reviewer' },
          richDefinition: { definition: { id: 'acme.reviewer', title: { key: 'acme.reviewer.title', fallback: 'Acme Reviewer' } } },
          runtimeSpec: null,
        }],
      ]),
      executionRunProfiles: [
        { pluginId: 'acme', definition: { id: 'review', intent: 'review', compatibleAgents: ['acme.reviewer'] } },
      ],
    });

    expect(buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.reviewer', label: 'Acme Reviewer' }),
    ]);
  });

  it('projects an external review Agent that only the current runtime registry knows about', () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {},
      executionRunProfiles: [],
    });
    registryMocks.getReloadState.mockReturnValue({
      activeRegistry: {
        contributes: {
          agentDefinitionsById: new Map([
            ['acme.reviewer', {
              id: 'acme.reviewer',
              identity: { pluginId: 'acme', localId: 'acme.reviewer' },
              definition: { id: 'acme.reviewer' },
              richDefinition: { definition: { id: 'acme.reviewer', title: 'Acme Reviewer' } },
            }],
          ]),
          catalogEntriesById: { 'acme.reviewer': { id: 'acme.reviewer' } },
          executionRunProfiles: [
            { pluginId: 'acme', definition: { id: 'review', intent: 'review', compatibleAgents: ['acme.reviewer'] } },
          ],
        },
      },
    });

    expect(buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.reviewer', label: 'Acme Reviewer' }),
    ]);
  });

  it('falls back to the declared manifest title when an external Agent ships no CLI descriptor title', () => {
    registryMocks.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map([
        ['acme.reviewer', {
          id: 'acme.reviewer',
          definition: { id: 'acme.reviewer' },
          runtimeSpec: { id: 'acme.reviewer', title: 'Acme Reviewer CLI' },
        }],
      ]),
      executionRunProfiles: [
        { definition: { id: 'review', intent: 'review', compatibleAgents: ['acme.reviewer'] } },
      ],
    });

    expect(buildReviewEngineInventoryItems({})).toEqual([
      expect.objectContaining({ engineId: 'acme.reviewer', label: 'Acme Reviewer CLI' }),
    ]);
  });
});
