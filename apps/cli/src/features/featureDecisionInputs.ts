import type { FeatureId } from '@happier-dev/protocol';

import { getCliFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from './serverFeaturesClient';

export type CliFeatureDecisionInputs = Readonly<{
  featureId: FeatureId;
  buildPolicy: 'allow' | 'deny' | 'neutral';
  localPolicyEnabled: boolean;
  serverSnapshot?: CliServerFeaturesSnapshot;
}>;

export function createCliFeatureDecisionInputs(params: {
  featureId: FeatureId;
  env: NodeJS.ProcessEnv;
  serverSnapshot?: CliServerFeaturesSnapshot;
}): CliFeatureDecisionInputs {
  return {
    featureId: params.featureId,
    buildPolicy: getCliFeatureBuildPolicyDecision(params.featureId, params.env),
    localPolicyEnabled: resolveCliLocalFeaturePolicyEnabled(params.featureId, params.env),
    serverSnapshot: params.serverSnapshot,
  };
}

export async function loadCliFeatureDecisionInputsForServer(params: {
  featureId: FeatureId;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  timeoutMs?: number;
}): Promise<CliFeatureDecisionInputs> {
  const serverSnapshot = await fetchServerFeaturesSnapshot({
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  return createCliFeatureDecisionInputs({
    featureId: params.featureId,
    env: params.env,
    serverSnapshot,
  });
}
