import {
  evaluateFeatureBuildPolicy,
  parseFeatureBuildPolicy,
  type FeatureBuildPolicyEvaluation,
  type FeatureId,
} from '@happier-dev/protocol';

export function getCliFeatureBuildPolicyDecision(featureId: FeatureId, env: NodeJS.ProcessEnv): FeatureBuildPolicyEvaluation {
  const policy = parseFeatureBuildPolicy({
    allowRaw: env.HAPPIER_BUILD_FEATURES_ALLOW,
    denyRaw: env.HAPPIER_BUILD_FEATURES_DENY,
  });

  return evaluateFeatureBuildPolicy(policy, featureId);
}
