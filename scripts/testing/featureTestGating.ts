import {
  FEATURE_CATALOG,
  FEATURE_IDS,
  evaluateFeatureBuildPolicy,
  isFeatureId,
  resolveEmbeddedFeaturePolicyEnv,
  resolveFeatureBuildPolicyFromEnvOrEmbedded,
  type FeatureId,
} from '@happier-dev/protocol';

function resolveDisabledFeatureIdsBase(env: NodeJS.ProcessEnv): Set<FeatureId> {
  const disabled = new Set<FeatureId>();

  const embeddedEnv = resolveEmbeddedFeaturePolicyEnv(env.HAPPIER_FEATURE_POLICY_ENV ?? env.HAPPIER_EMBEDDED_POLICY_ENV);
  const buildPolicy = resolveFeatureBuildPolicyFromEnvOrEmbedded({
    embeddedEnv: embeddedEnv ?? undefined,
    allowRaw: env.HAPPIER_BUILD_FEATURES_ALLOW ?? null,
    denyRaw: [env.HAPPIER_BUILD_FEATURES_DENY, env.HAPPIER_TEST_FEATURES_DENY].filter(Boolean).join(',') || null,
  });

  for (const featureId of FEATURE_IDS) {
    if (evaluateFeatureBuildPolicy(buildPolicy, featureId) === 'deny') {
      disabled.add(featureId);
    }
  }

  return disabled;
}

function applyDependencyClosure(disabled: Set<FeatureId>): Set<FeatureId> {
  let changed = true;
  while (changed) {
    changed = false;

    for (const featureId of FEATURE_IDS) {
      if (disabled.has(featureId)) continue;

      const deps = FEATURE_CATALOG[featureId].dependencies;
      if (deps.some((dep) => isFeatureId(dep) && disabled.has(dep))) {
        disabled.add(featureId);
        changed = true;
      }
    }
  }

  return disabled;
}

export function resolveDisabledFeatureIdsForTests(env: NodeJS.ProcessEnv = process.env): ReadonlySet<FeatureId> {
  return applyDependencyClosure(resolveDisabledFeatureIdsBase(env));
}

export function resolveVitestFeatureTestExcludeGlobs(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const disabled = resolveDisabledFeatureIdsForTests(env);
  return Object.freeze(Array.from(disabled, (featureId) => `**/*.feat.${featureId}.*`));
}
