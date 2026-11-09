import { applyFeatureDependencies, evaluateFeatureDecisionBase } from '@happier-dev/protocol/features/featureDecisionEngine';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';
import { getCanonicalFeatureId } from '@happier-dev/protocol/features/catalog';

import { getCliFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';

export function resolveCliGlobalOnlyFeatureDecision(params: {
  featureId: FeatureId;
  env: ProcessEnvInput;
}): FeatureDecision {
  const memo = new Map<FeatureId, FeatureDecision>();

  const resolve = (featureId: FeatureId): FeatureDecision => {
    featureId = getCanonicalFeatureId(featureId);
    const cached = memo.get(featureId);
    if (cached) return cached;

    const base = evaluateFeatureDecisionBase({
      featureId,
      scope: { scopeKind: 'runtime' },
      supportsClient: true,
      buildPolicy: getCliFeatureBuildPolicyDecision(featureId, params.env),
      localPolicyEnabled: resolveCliLocalFeaturePolicyEnabled(featureId, params.env),
      serverSupported: true,
      serverEnabled: true,
    });

    if (base.state !== 'enabled') {
      memo.set(featureId, base);
      return base;
    }

    const out = applyFeatureDependencies({
      featureId,
      baseDecision: base,
      resolveDependencyDecision: resolve,
    });

    memo.set(featureId, out);
    return out;
  };

  return resolve(params.featureId);
}
