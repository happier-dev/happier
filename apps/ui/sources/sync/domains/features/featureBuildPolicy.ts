import {
    evaluateFeatureBuildPolicy,
    resolveEmbeddedFeaturePolicyEnv,
    resolveFeatureBuildPolicyFromEnvOrEmbedded,
    type FeatureBuildPolicyEvaluation,
    type FeatureId,
} from '@happier-dev/protocol';

const buildPolicy = resolveFeatureBuildPolicyFromEnvOrEmbedded({
    embeddedEnv: resolveEmbeddedFeaturePolicyEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV) ?? undefined,
    // UI bundles must only read build-time injected public env vars.
    allowRaw: process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW,
    denyRaw: process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY,
});

export function getFeatureBuildPolicyDecision(featureId: FeatureId): FeatureBuildPolicyEvaluation {
    return evaluateFeatureBuildPolicy(buildPolicy, featureId);
}
