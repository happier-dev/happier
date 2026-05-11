import type { FeatureId } from '@happier-dev/protocol';

import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

const ONBOARDING_SHOWCASE_FEATURE_ID = 'app.ui.onboardingShowcase' as const satisfies FeatureId;

export function isOnboardingShowcaseAutoShowEnabled(): boolean {
    return getFeatureBuildPolicyDecision(ONBOARDING_SHOWCASE_FEATURE_ID) === 'allow';
}
