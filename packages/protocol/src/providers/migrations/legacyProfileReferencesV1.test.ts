import { describe, expect, it } from 'vitest';

import { normalizeLegacyAiLaunchProfileReferenceV1 } from './legacyProfileReferencesV1.js';

describe('normalizeLegacyAiLaunchProfileReferenceV1', () => {
  const migration = {
    v: 1 as const,
    completedSources: [
      { sourceProfileId: 'anthropic', kind: 'default_environment' as const },
      {
        sourceProfileId: 'deepseek', kind: 'connection' as const, connectionId: 'pc-deepseek',
        modelSelection: { agentTargetKey: 'agent:claude', providerConnectionId: 'pc-deepseek', modelId: 'deepseek-reasoner' },
      },
      { sourceProfileId: 'disabled', kind: 'skipped_disabled' as const },
    ],
    pendingCustomProfileIds: ['company'],
  };

  it('normalizes placeholders and migrated refs without changing retained/pending/unknown ids', () => {
    expect(normalizeLegacyAiLaunchProfileReferenceV1({ legacyAiLaunchProfileId: 'anthropic', migration, retainedSlimProfileIds: [] }))
      .toEqual({ status: 'default_environment', legacyAiLaunchProfileId: null, modelRef: null });
    expect(normalizeLegacyAiLaunchProfileReferenceV1({ legacyAiLaunchProfileId: 'deepseek', migration, retainedSlimProfileIds: ['deepseek'] }))
      .toEqual({
        status: 'migrated', legacyAiLaunchProfileId: 'deepseek',
        modelRef: { agentTargetKey: 'agent:claude', providerConnectionId: 'pc-deepseek', modelId: 'deepseek-reasoner' },
      });
    expect(normalizeLegacyAiLaunchProfileReferenceV1({ legacyAiLaunchProfileId: 'company', migration, retainedSlimProfileIds: [] }))
      .toEqual({ status: 'retained', legacyAiLaunchProfileId: 'company', modelRef: null });
    expect(normalizeLegacyAiLaunchProfileReferenceV1({ legacyAiLaunchProfileId: 'disabled', migration, retainedSlimProfileIds: [] }))
      .toEqual({ status: 'retained', legacyAiLaunchProfileId: 'disabled', modelRef: null });
  });
});
