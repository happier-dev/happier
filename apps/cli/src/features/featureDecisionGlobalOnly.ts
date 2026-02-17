import {
  applyFeatureDependencies,
  evaluateFeatureDecisionBase,
  type FeatureDecision,
  type FeatureId,
} from '@happier-dev/protocol';

import { getCliFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';

export function resolveCliGlobalOnlyFeatureDecision(params: {
  featureId: FeatureId;
  env: NodeJS.ProcessEnv;
}): FeatureDecision {
  const memo = new Map<FeatureId, FeatureDecision>();

  const resolve = (featureId: FeatureId): FeatureDecision => {
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

