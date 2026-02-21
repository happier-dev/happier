import {
    evaluateFeatureBuildPolicy,
    resolveEmbeddedFeaturePolicyEnv,
    resolveFeatureBuildPolicyFromEnvOrEmbedded,
    type FeatureBuildPolicy,
    type FeatureBuildPolicyEvaluation,
    type FeatureId,
} from '@happier-dev/protocol';

let cachedBuildPolicy: FeatureBuildPolicy | null = null;
let cachedBuildPolicyKey: string | null = null;

function resolveBuildPolicyFromEnv(): FeatureBuildPolicy {
    const embeddedEnv = resolveEmbeddedFeaturePolicyEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV) ?? undefined;
    const allowRaw = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
    const denyRaw = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    const key = `${embeddedEnv ?? ''}::${allowRaw ?? ''}::${denyRaw ?? ''}`;

    if (cachedBuildPolicy && cachedBuildPolicyKey === key) {
        return cachedBuildPolicy;
    }

    const next = resolveFeatureBuildPolicyFromEnvOrEmbedded({
        embeddedEnv,
        // UI bundles must only read build-time injected public env vars.
        allowRaw,
        denyRaw,
    });
    cachedBuildPolicy = next;
    cachedBuildPolicyKey = key;
    return next;
}

export function getFeatureBuildPolicyDecision(featureId: FeatureId): FeatureBuildPolicyEvaluation {
    const buildPolicy = resolveBuildPolicyFromEnv();
    return evaluateFeatureBuildPolicy(buildPolicy, featureId);
}
