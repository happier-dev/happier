import {
  evaluateFeatureBuildPolicy,
  resolveEmbeddedFeaturePolicyEnv,
  resolveFeatureBuildPolicyFromEnvOrEmbedded,
  type FeatureBuildPolicyEvaluation,
  type FeatureId,
} from '@happier-dev/protocol';

export function getCliFeatureBuildPolicyDecision(featureId: FeatureId, env: NodeJS.ProcessEnv): FeatureBuildPolicyEvaluation {
  const embeddedEnv = resolveEmbeddedFeaturePolicyEnv(env.HAPPIER_FEATURE_POLICY_ENV);
  const policy = resolveFeatureBuildPolicyFromEnvOrEmbedded({
    embeddedEnv: embeddedEnv ?? undefined,
    allowRaw: env.HAPPIER_BUILD_FEATURES_ALLOW,
    denyRaw: env.HAPPIER_BUILD_FEATURES_DENY,
  });

  return evaluateFeatureBuildPolicy(policy, featureId);
}
