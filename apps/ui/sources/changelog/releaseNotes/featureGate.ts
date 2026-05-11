import type { FeatureId } from '@happier-dev/protocol';

import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

const RELEASE_NOTES_FEATURE_ID = 'app.ui.releaseNotes' as const satisfies FeatureId;

export function isReleaseNotesFeatureEnabled(): boolean {
    return getFeatureBuildPolicyDecision(RELEASE_NOTES_FEATURE_ID) !== 'deny';
}

export function isReleaseNotesStoryCardsEnabled(): boolean {
    return getFeatureBuildPolicyDecision(RELEASE_NOTES_FEATURE_ID) === 'allow';
}
