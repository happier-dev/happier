import { describe, expect, it } from 'vitest';

import { isExecutionRunConnectedServiceGenerationCurrent } from './executionRunGenerationAdmission';

const projection = {
  groups: [{ serviceId: 'openai-codex', groupId: 'default', activeProfileId: 'work', generation: 4 }],
  credentialRevisions: [{ serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }],
  resolveCredentialRevision: (_serviceId: string, _profileId: string) => 'csr_bbbbbbbbbbbbbbbbbbbbbb',
} as any;

describe('isExecutionRunConnectedServiceGenerationCurrent', () => {
  it('accepts only the exact materialized group generation and credential revision', () => {
    const target = {
      materializationKey: 'run-1',
      activeBindings: [{
        serviceId: 'openai-codex', groupId: 'default', profileId: 'work',
        groupGeneration: 4, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }],
    } as any;
    expect(isExecutionRunConnectedServiceGenerationCurrent({ runId: 'run-1', target, projection })).toBe(true);
    expect(isExecutionRunConnectedServiceGenerationCurrent({
      runId: 'run-1',
      target: { ...target, activeBindings: [{ ...target.activeBindings[0], groupGeneration: 3 }] },
      projection,
    })).toBe(false);
  });

  it('rejects a direct profile after its credential revision changes', () => {
    expect(isExecutionRunConnectedServiceGenerationCurrent({
      runId: 'run-direct',
      target: {
        materializationKey: 'run-direct',
        activeBindings: [{
          serviceId: 'openai-codex', groupId: null, profileId: 'work',
          groupGeneration: null, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }],
      } as any,
      projection,
    })).toBe(false);
  });
});
