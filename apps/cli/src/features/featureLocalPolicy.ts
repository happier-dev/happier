import { parseBooleanEnv, type FeatureId } from '@happier-dev/protocol';

type FeatureLocalPolicyResolver = (env: NodeJS.ProcessEnv) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
  automations: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED, true),
  'automations.existingSessionTarget': (env) =>
    parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET, false),
  bugReports: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED, true),
  'execution.runs': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED, true),
  voice: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE__ENABLED, true),
  connectedServices: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED, true),
  'connectedServices.quotas': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED, true),
};

export function resolveCliLocalFeaturePolicyEnabled(featureId: FeatureId, env: NodeJS.ProcessEnv): boolean {
  const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
  if (!resolver) return true;
  return resolver(env);
}
