import type { FeatureId } from '@happier-dev/protocol';

function parseBooleanEnv(raw: string | null | undefined, fallback: boolean): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  return fallback;
}

type FeatureLocalPolicyResolver = (env: NodeJS.ProcessEnv) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
  automations: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED, true),
  'automations.existingSessionTarget': (env) =>
    parseBooleanEnv(env.HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET, false),
  bugReports: (env) => parseBooleanEnv(env.HAPPIER_FEATURE_BUG_REPORTS__ENABLED, true),
};

export function resolveCliLocalFeaturePolicyEnabled(featureId: FeatureId, env: NodeJS.ProcessEnv): boolean {
  const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
  if (!resolver) return true;
  return resolver(env);
}
