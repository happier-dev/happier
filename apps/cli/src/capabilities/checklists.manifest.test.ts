import { describe, expect, it } from 'vitest';

import { resumeChecklistId } from './checklistIds';
import { createCapabilityChecklists } from './checklists';

describe('manifest Agent checklist policy', () => {
  it('adds the closed resume login-status policy at the existing checklist owner', () => {
    const agentRegistrySnapshot = {
      agents: [{ id: 'codex' }],
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
    } as any;

    expect(createCapabilityChecklists(undefined, agentRegistrySnapshot)[resumeChecklistId('codex')]).toEqual([
      { id: 'cli.codex', params: { includeLoginStatus: true } },
    ]);
  });
});
