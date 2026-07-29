import { describe, expect, it } from 'vitest';

import { normalizeLegacyAiLaunchProfileReferenceV1 } from './legacyProfileReferencesV1.js';

describe('normalizeLegacyAiLaunchProfileReferenceV1', () => {
  const migration = {
    v: 1 as const,
    completedSources: [
      { sourceProfileId: 'anthropic', kind: 'default_environment' as const },
      {
        sourceProfileId: 'deepseek', kind: 'connection' as const, connectionId: 'pc-deepseek',
        sourceRevision: 2,
        modelSelectionOrigin: 'implicit_default' as const,
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

  it.each([
    { modelId: 'deepseek-v4-flash', sourceRevision: undefined, modelSelectionOrigin: undefined },
    { modelId: 'deepseek-chat', sourceRevision: 2, modelSelectionOrigin: undefined },
    { modelId: 'deepseek-reasoner', sourceRevision: undefined, modelSelectionOrigin: 'implicit_default' as const },
  ])('keeps pre-provenance DeepSeek selection $modelId review-required', (legacyOutcome) => {
    expect(normalizeLegacyAiLaunchProfileReferenceV1({
      legacyAiLaunchProfileId: 'deepseek',
      migration: {
        v: 1,
        completedSources: [{
          sourceProfileId: 'deepseek',
          kind: 'connection',
          connectionId: 'pc-deepseek',
          ...(legacyOutcome.sourceRevision === undefined
            ? {}
            : { sourceRevision: legacyOutcome.sourceRevision }),
          ...(legacyOutcome.modelSelectionOrigin === undefined
            ? {}
            : { modelSelectionOrigin: legacyOutcome.modelSelectionOrigin }),
          modelSelection: {
            agentTargetKey: 'agent:claude',
            providerConnectionId: 'pc-deepseek',
            modelId: legacyOutcome.modelId,
          },
        }],
        pendingCustomProfileIds: [],
      },
      retainedSlimProfileIds: [],
    })).toEqual({
      status: 'review_required',
      legacyAiLaunchProfileId: 'deepseek',
      modelRef: null,
    });
  });
});
