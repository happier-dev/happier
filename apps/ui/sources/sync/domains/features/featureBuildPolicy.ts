import { evaluateFeatureBuildPolicy, parseFeatureBuildPolicy, type FeatureBuildPolicyEvaluation, type FeatureId } from '@happier-dev/protocol';

const buildPolicy = parseFeatureBuildPolicy({
    // UI bundles must only read build-time injected public env vars.
    allowRaw: process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW,
    denyRaw: process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY,
});

export function getFeatureBuildPolicyDecision(featureId: FeatureId): FeatureBuildPolicyEvaluation {
    return evaluateFeatureBuildPolicy(buildPolicy, featureId);
}
