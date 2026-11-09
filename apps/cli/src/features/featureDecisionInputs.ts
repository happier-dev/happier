import { featureRequiresServerSnapshot, getCanonicalFeatureId } from '@happier-dev/protocol/features/catalog';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { FeatureId } from '@happier-dev/protocol';

import { getCliFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { resolveCliGlobalOnlyFeatureDecision } from './featureDecisionGlobalOnly';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from './serverFeaturesClient';

export type CliFeatureDecisionInputs = Readonly<{
  featureId: FeatureId;
  env: ProcessEnvInput;
  buildPolicy: 'allow' | 'deny' | 'neutral';
  localPolicyEnabled: boolean;
  serverSnapshot?: CliServerFeaturesSnapshot;
}>;

export function createCliFeatureDecisionInputs(params: {
  featureId: FeatureId;
  env: ProcessEnvInput;
  serverSnapshot?: CliServerFeaturesSnapshot;
}): CliFeatureDecisionInputs {
  const featureId = getCanonicalFeatureId(params.featureId);
  return {
    featureId,
    env: params.env,
    buildPolicy: getCliFeatureBuildPolicyDecision(featureId, params.env),
    localPolicyEnabled: resolveCliLocalFeaturePolicyEnabled(featureId, params.env),
    serverSnapshot: params.serverSnapshot,
  };
}

export async function loadCliFeatureDecisionInputsForServer(params: {
  featureId: FeatureId;
  env: ProcessEnvInput;
  serverUrl: string;
  timeoutMs?: number;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET';
    path: string;
  }>) => Readonly<Record<string, string>> | null;
}): Promise<CliFeatureDecisionInputs> {
  const globalDecision = resolveCliGlobalOnlyFeatureDecision({ featureId: params.featureId, env: params.env });
  if (globalDecision.state !== 'enabled') {
    return createCliFeatureDecisionInputs({
      featureId: params.featureId,
      env: params.env,
      serverSnapshot: undefined,
    });
  }

  if (!featureRequiresServerSnapshot(params.featureId)) {
    return createCliFeatureDecisionInputs({
      featureId: params.featureId,
      env: params.env,
      serverSnapshot: undefined,
    });
  }

  const serverSnapshot = await fetchServerFeaturesSnapshot({
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
  });

  return createCliFeatureDecisionInputs({
    featureId: params.featureId,
    env: params.env,
    serverSnapshot,
  });
}
