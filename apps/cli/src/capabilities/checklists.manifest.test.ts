import { describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/registry', () => ({
  get AGENTS() {
    return { codex: { id: 'codex' } };
  },
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import { resumeChecklistId } from './checklistIds';
import { createCapabilityChecklists } from './checklists';

describe('manifest Agent checklist policy', () => {
  it('adds the closed resume login-status policy at the existing checklist owner', () => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map([[
        'codex',
        {
          richDefinition: {
            provenance: 'first_party',
            definition: {
              catalog: {
                resumeChecklist: { includeLoginStatus: true },
              },
            },
          },
        },
      ]]),
      catalogEntriesById: {},
      executionRunProfiles: [],
    });

    expect(createCapabilityChecklists()[resumeChecklistId('codex')]).toEqual([
      { id: 'cli.codex', params: { includeLoginStatus: true } },
    ]);
  });
});
