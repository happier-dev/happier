import { parseBooleanEnv } from '@happier-dev/protocol/env/parseBooleanEnv';
import type { FeatureId } from '@happier-dev/protocol';

type FeatureLocalPolicyResolver = (env: NodeJS.ProcessEnv) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
  automations: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED, true),
  bugReports: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED, true),
  'execution.runs': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED, true),
  voice: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE__ENABLED, true),
  'voice.agent': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE_AGENT__ENABLED, true),
  'voice.daemonInference': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED, false),
  'connectedServices.quotas': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED, true),
  // Local services is now server-represented + default-allow (see protocol catalog +
  // localServicesFeature.ts): the server is the gate. CLI local policy defaults to allow so it
  // does not pre-empt the server decision; the env key remains an opt-out escape hatch. The
  // destructive terminate action and exposure (preview/publicPreview) are server-gated too.
  localServices: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED, true),
  'localServices.inventory': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_LOCAL_SERVICES_INVENTORY__ENABLED, true),
  'localServices.managed': (env) => parseBooleanEnv(env.HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED, true),
  // Browser automation defers to the server decision and action approval. Dormant
  // injectedPage/eval ids add no local environment opt-in; all use the unlisted-id fallback.
  // The plugin UI tiers (hostedWeb / reactNativeBundles)
  // are now server-represented + default-ALLOW kill-switches (§4.1/§13.5.3): they deliberately have
  // NO local-policy entry so the unlisted-id fallback returns true and the server bit governs. A
  // hardcoded force-close here would override the now-ON server bit (a server-represented decision
  // combines `localPolicyEnabled && serverEnabled`). Per-plugin install/enable/trust/runtime
  // derivation (5.1/5.2) still governs actual render.
};

export function resolveCliLocalFeaturePolicyEnabled(featureId: FeatureId, env: NodeJS.ProcessEnv): boolean {
  const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
  if (!resolver) return true;
  return resolver(env);
}
