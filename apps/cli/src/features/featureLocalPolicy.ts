import { parseBooleanEnv, type FeatureId } from '@happier-dev/protocol';

type FeatureLocalPolicyResolver = (env: NodeJS.ProcessEnv) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
  automations: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED, true),
  bugReports: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED, true),
  'execution.runs': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED, true),
  voice: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE__ENABLED, true),
  'voice.agent': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE_AGENT__ENABLED, true),
  'voice.daemonInference': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED, false),
  connectedServices: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED, true),
  'connectedServices.quotas': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED, true),
  localServices: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED, false),
  'localServices.inventory': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED, true),
  'localServices.managed': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED, true),
  channelBridges: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED, true),
  'channelBridges.telegram': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED, true),
};

export function resolveCliLocalFeaturePolicyEnabled(featureId: FeatureId, env: NodeJS.ProcessEnv): boolean {
  const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
  if (!resolver) return true;
  return resolver(env);
}
