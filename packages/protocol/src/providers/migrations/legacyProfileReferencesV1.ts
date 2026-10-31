import { readBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { ProviderBoundModelRef } from '../selection/v1.js';
import type { ProviderSettingsMigrationStateV1 } from '../settings/v1.js';

export type LegacyAiLaunchProfileReferenceResolutionV1 = Readonly<{
  status: 'unchanged' | 'retained' | 'default_environment' | 'migrated' | 'review_required';
  legacyAiLaunchProfileId: string | null;
  modelRef: ProviderBoundModelRef | null;
}>;

export function normalizeLegacyAiLaunchProfileReferenceV1(input: Readonly<{
  legacyAiLaunchProfileId: string | null;
  migration: ProviderSettingsMigrationStateV1 | undefined;
  retainedSlimProfileIds: readonly string[];
  /** Current retained row preference; historical model defaults cannot retarget it. */
  retainedProfileTargetKey?: string;
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
    if (input.retainedProfileTargetKey && readBackendTargetKeyV2(input.retainedProfileTargetKey)) {
      return { status: 'retained', legacyAiLaunchProfileId: profileId, modelRef: null };
    }
    return { status: 'default_environment', legacyAiLaunchProfileId: null, modelRef: null };
  }
  if (outcome.kind === 'skipped_disabled') {
    return { status: 'retained', legacyAiLaunchProfileId: profileId, modelRef: null };
  }
  if (profileId === 'deepseek'
    && outcome.modelSelection
    && (outcome.sourceRevision === undefined || outcome.modelSelectionOrigin === undefined)) {
    return { status: 'review_required', legacyAiLaunchProfileId: profileId, modelRef: null };
  }
  const retainedTargetKey = readBackendTargetKeyV2(input.retainedProfileTargetKey);
  if (retainedTargetKey) {
    return {
      status: 'retained',
      legacyAiLaunchProfileId: profileId,
      modelRef: outcome.modelSelection && readBackendTargetKeyV2(outcome.modelSelection.agentTargetKey) === retainedTargetKey
        ? outcome.modelSelection : null,
    };
  }
  return {
    status: 'migrated',
    legacyAiLaunchProfileId: input.retainedSlimProfileIds.includes(profileId) ? profileId : null,
    modelRef: outcome.modelSelection ?? null,
  };
}
