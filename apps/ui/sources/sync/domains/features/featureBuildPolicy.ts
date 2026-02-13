import { evaluateFeatureBuildPolicy, parseFeatureBuildPolicy, type FeatureBuildPolicyEvaluation, type FeatureId } from '@happier-dev/protocol';

const buildPolicy = parseFeatureBuildPolicy({
    allowRaw: process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW ?? process.env.HAPPIER_BUILD_FEATURES_ALLOW,
    denyRaw: process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY ?? process.env.HAPPIER_BUILD_FEATURES_DENY,
});

export function getFeatureBuildPolicyDecision(featureId: FeatureId): FeatureBuildPolicyEvaluation {
    return evaluateFeatureBuildPolicy(buildPolicy, featureId);
}
