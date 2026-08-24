import { parseBooleanEnv, type FeatureId } from '@happier-dev/protocol';

type FeatureLocalPolicyResolver = (env: NodeJS.ProcessEnv) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
  automations: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED, true),
  bugReports: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED, true),
  'execution.runs': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED, true),
  voice: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE__ENABLED, true),
  connectedServices: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED, true),
  'connectedServices.quotas': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED, true),
  channelBridges: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED, true),
  'channelBridges.telegram': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CHANNEL_BRIDGES_TELEGRAM__ENABLED, true),
  // Claude Unified TUI runtime-control rides the unified-mode opt-in (unified is itself off by
  // default), so it defaults ON; the env flag is a KILL-SWITCH (=0) if a Claude update breaks the
  // screen verification. The controller fails closed on any unverified control regardless, and the
  // kill-switch restores the legacy restart-notice path.
  'providers.claude.unifiedTerminal.tuiRuntimeControl': (env) =>
    parseBooleanEnv(env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED, true),
};

export function resolveCliLocalFeaturePolicyEnabled(featureId: FeatureId, env: NodeJS.ProcessEnv): boolean {
  const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
  if (!resolver) return true;
  return resolver(env);
}
