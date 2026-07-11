import type { ProviderBoundModelRef } from '../selection/v1.js';
import type { ProviderSettingsMigrationStateV1 } from '../settings/v1.js';

export type LegacyAiLaunchProfileReferenceResolutionV1 = Readonly<{
  status: 'unchanged' | 'retained' | 'default_environment' | 'migrated';
  legacyAiLaunchProfileId: string | null;
  modelRef: ProviderBoundModelRef | null;
}>;

export function normalizeLegacyAiLaunchProfileReferenceV1(input: Readonly<{
  legacyAiLaunchProfileId: string | null;
  migration: ProviderSettingsMigrationStateV1 | undefined;
  retainedSlimProfileIds: readonly string[];
}>): LegacyAiLaunchProfileReferenceResolutionV1 {
  const profileId = input.legacyAiLaunchProfileId;
  if (profileId === null) return { status: 'unchanged', legacyAiLaunchProfileId: null, modelRef: null };
  const outcome = input.migration?.completedSources.find((entry) => entry.sourceProfileId === profileId);
  if (!outcome) {
    return {
      status: input.migration?.pendingCustomProfileIds.includes(profileId) ? 'retained' : 'unchanged',
      legacyAiLaunchProfileId: profileId,
      modelRef: null,
    };
  }
  if (outcome.kind === 'default_environment') {
    return { status: 'default_environment', legacyAiLaunchProfileId: null, modelRef: null };
  }
  if (outcome.kind === 'skipped_disabled') {
    return { status: 'retained', legacyAiLaunchProfileId: profileId, modelRef: null };
  }
  return {
    status: 'migrated',
    legacyAiLaunchProfileId: input.retainedSlimProfileIds.includes(profileId) ? profileId : null,
    modelRef: outcome.modelSelection ?? null,
  };
}
